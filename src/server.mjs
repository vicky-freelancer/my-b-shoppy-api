import express from 'express';
import { createAdminAuthRouter } from './admin-auth.mjs';
import { createRazorpayWebhookHandler } from './payment-security.mjs';
import { createCheckoutControl } from './checkout-control.mjs';
import dotenv from 'dotenv';
import crypto from 'crypto';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { parseTestOrigins, loadDevelopmentEnv, registerLiveness, healthResponse } from './runtime-config.mjs';


const backendDir = fileURLToPath(new URL('..', import.meta.url));
loadDevelopmentEnv({ configure: options => dotenv.config(options), envPath: path.join(backendDir, '.env') });
const testOrigins = parseTestOrigins(process.env);

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_BASE = 'https://api.razorpay.com';
const PORT = Number(process.env.PORT) || 5000;

const app = express();
const checkout = createCheckoutControl();

// CORS — this backend is deployed separately from the frontend (api.mybshoppy.com),
// so browser calls from the storefront domain must be allowed explicitly.
const ALLOWED_ORIGINS = [
  'https://mybshoppy.com',
  'https://admin.mybshoppy.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  ...testOrigins,
];
app.use(cors({
  credentials: true,
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(Object.assign(new Error('Request origin is not allowed.'), { status: 403 }));
    }
  },
}));

app.use((error, _req, res, next) => {
  if (error.status === 403) return res.status(403).json({ error: error.message });
  next(error);
});

// Opt-in local MariaDB architecture. No pool or connection exists in legacy mode.
registerLiveness(app);

// The configured pool refuses remote hosts and every production database.
if (process.env.MARIADB_ENABLED === 'true') {
  const { createDatabase } = await import('./commerce/database.mjs');
  const { createCommerceApp, LOCAL_ORIGINS } = await import('./commerce/app.mjs');
  const database = await createDatabase(process.env);
  app.use(createCommerceApp({ database, env: process.env, allowedOrigins: [...LOCAL_ORIGINS, ...testOrigins] }));
}

// Authenticate exact raw webhook bytes BEFORE JSON parsing. No durable adapter
// is installed until the actual PostgreSQL contract is verified: valid events
// receive retryable 503 instead of a false successful acknowledgement.
app.post('/api/razorpay-webhook', express.raw({ type: 'application/json', limit: '64kb', inflate: false }),
  createRazorpayWebhookHandler({ getSecret: () => process.env.RAZORPAY_WEBHOOK_SECRET }));
// Guard only NEW purchase creation, before body parsing/provider calls. Existing
// verification and webhook requests intentionally do not pass through this guard.
app.get('/api/checkout/status', checkout.status);
app.post('/api/create-order', checkout.guard);
// Isolated catalog runs must never reach legacy signature-only payment handling.
if (process.env.MARIADB_ENABLED === 'true' || process.env.DEPLOYMENT_PROFILE === 'isolated-test') {
  app.post('/api/verify-payment', checkout.guard);
}
app.use(express.json({ limit: '100kb' }));

// The static admin host uses this API for server-validated login.
// Isolated smoke mode exposes no legacy authentication, including fallback credentials.
if (process.env.DEPLOYMENT_PROFILE !== 'isolated-test') {
  app.use(createAdminAuthRouter({ allowedOrigins: ['https://admin.mybshoppy.com', 'http://localhost:3000', 'http://127.0.0.1:3000', ...testOrigins] }));
}

function razorpayHeaders() {
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  return {
    'Content-Type': 'application/json',
    Authorization: `Basic ${auth}`,
  };
}

/** Health check — lets you confirm the server is up and which key mode is active */
app.get('/api/health', (_req, res) => {
  res.json(healthResponse({ RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET }));
});

/**
 * Create a Razorpay order.
 * amount is in the smallest currency unit (paise for INR), e.g. ₹599 = 59900.
 */
app.post('/api/create-order', async (req, res) => {
  try {
    const amount = req.body?.amount;
    const currency = req.body?.currency || 'INR';

    if (!Number.isSafeInteger(amount) || amount < 100) {
      return res.status(400).json({ error: 'Amount must be at least 100 paise (₹1)' });
    }

    if (currency !== 'INR') return res.status(400).json({ error: 'Only INR payments are supported' });
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ error: 'Online payments are not configured. Please contact the store.' });
    }

    const receipt = String(req.body?.receipt || `MBS-${Date.now()}`).slice(0, 40);
    const notes = req.body?.notes || {};

    const upstream = await fetch(`${RAZORPAY_BASE}/v1/orders`, {
      method: 'POST',
      headers: razorpayHeaders(),
      body: JSON.stringify({ amount, currency, receipt, payment_capture: 1, notes }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: data?.error?.description || 'Failed to create Razorpay order' });
    }

    // Send the order back to the browser along with the public key_id only
    res.json({ ...data, key_id: RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(500).json({ error: 'Internal error while creating order' });
  }
});

/**
 * Verify that a payment really came from Razorpay.
 * The signature is an HMAC-SHA256 of "order_id|payment_id" using the key secret.
 * Only the server can compute this, which is why cheating is hard.
 */
app.post('/api/verify-payment', (req, res) => {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return res.status(503).json({ valid: false, error: 'Online payments are not configured' });
  }
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ valid: false, error: 'Missing payment fields' });
  }

  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const valid = typeof razorpay_signature === 'string' && /^[a-f0-9]{64}$/i.test(razorpay_signature) &&
    crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(razorpay_signature, 'hex'));
  if (!valid) {
    return res.status(400).json({ valid: false, error: 'Payment signature verification failed' });
  }
  res.json({ valid: true });
});

// Avoid the default HTML/stack response for raw-body/parser failures. Never
// log a webhook payload, signature or customer fields.
app.use((error, req, res, next) => {
  if (req.path !== '/api/razorpay-webhook') return next(error);
  const status = [400, 413, 415].includes(error.status) ? error.status : 500;
  res.set('Cache-Control', 'no-store').status(status).json({ ok: false, error: 'Webhook request rejected.' });
});

// API-only deployments and a combined storefront deployment are both supported.
app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));
const frontendDist = path.resolve(backendDir, '..', 'frontend', 'dist');
if (existsSync(path.join(frontendDist, 'index.html'))) {
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`my B shoppy server running at http://localhost:${PORT}`);
  console.log(`Razorpay mode: ${RAZORPAY_KEY_ID.startsWith('rzp_test_') ? 'TEST' : 'LIVE'}`);
});
