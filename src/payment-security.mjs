import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const providerId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const configuredSecret = (value) => typeof value === 'string' && value.trim().length > 0;

function matchesHmac(message, signature, secret) {
  if (!configuredSecret(secret) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(message).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

// The caller MUST obtain storedProviderOrderId from a trusted persisted attempt,
// never from the callback. This primitive does not settle or persist a payment.
export function verifyCheckoutSignature({ storedProviderOrderId, paymentId, signature, keySecret }) {
  if (!providerId(storedProviderOrderId) || !providerId(paymentId)) return false;
  return matchesHmac(`${storedProviderOrderId}|${paymentId}`, signature, keySecret);
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  return Buffer.isBuffer(rawBody) && matchesHmac(rawBody, signature, secret);
}

// Pure comparison only. The caller must fetch payment using authenticated
// Razorpay credentials for the same account/environment as the persisted attempt.
// No HTTP request, capture/refund, PAID transition or inventory write occurs here.
export function validateCapturedPayment(expected, payment) {
  if (!expected || !providerId(expected.providerOrderId) || expected.currency !== 'INR' ||
      !Number.isSafeInteger(expected.amountPaise) || expected.amountPaise <= 0) {
    return { valid: false, reason: 'INVALID_TRUSTED_EXPECTATION' };
  }
  if (!payment || typeof payment !== 'object' || !providerId(payment.id)) return { valid: false, reason: 'INVALID_PAYMENT' };
  if (payment.order_id !== expected.providerOrderId) return { valid: false, reason: 'ORDER_MISMATCH' };
  if (payment.currency !== expected.currency) return { valid: false, reason: 'CURRENCY_MISMATCH' };
  if (!Number.isSafeInteger(payment.amount) || payment.amount !== expected.amountPaise) return { valid: false, reason: 'AMOUNT_MISMATCH' };
  if (payment.status !== 'captured' || payment.captured !== true) return { valid: false, reason: 'NOT_CAPTURED' };
  return { valid: true };
}

function observation(eventId, rawBody, body) {
  const entity = body.payload?.payment?.entity;
  // Deliberate allowlist: no raw payload, signature, customer data or notes enter
  // the persistence boundary. Signed facts still require stored-order matching.
  return Object.freeze({
    eventId,
    bodySha256: createHash('sha256').update(rawBody).digest('hex'),
    eventType: body.event,
    paymentId: providerId(entity?.id) ? entity.id : null,
    providerOrderId: providerId(entity?.order_id) ? entity.order_id : null,
    amountPaise: Number.isSafeInteger(entity?.amount) ? entity.amount : null,
    currency: typeof entity?.currency === 'string' && entity.currency.length <= 8 ? entity.currency : null,
    paymentStatus: typeof entity?.status === 'string' && entity.status.length <= 32 ? entity.status : null,
    captured: entity?.captured === true,
  });
}

// persistVerifiedEvent is a FUTURE trusted database adapter, not an in-memory
// idempotency substitute. It must commit a unique event ID/body-hash association
// and durable processing work before resolving. The current server deliberately
// provides no adapter while PostgreSQL schema/triggers remain unverified.
export function createRazorpayWebhookHandler({ getSecret, persistVerifiedEvent, persistTimeoutMs = 3000, matchesEnvelope = () => true } = {}) {
  if (!Number.isSafeInteger(persistTimeoutMs) || persistTimeoutMs < 1 || persistTimeoutMs > 10000) {
    throw new TypeError('Invalid webhook persistence timeout.');
  }
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const unavailable = () => res.set('Retry-After', '60').status(503).json({ ok: false, error: 'Durable payment processing is unavailable.' });
    let secret;
    try { secret = getSecret?.(); } catch { return unavailable(); }
    if (!configuredSecret(secret)) return unavailable();
    if (!Buffer.isBuffer(req.body)) return res.status(415).json({ ok: false, error: 'A JSON request body is required.' });
    if (!verifyWebhookSignature(req.body, req.get('x-razorpay-signature'), secret)) {
      return res.status(400).json({ ok: false, error: 'Invalid webhook signature.' });
    }
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); }
    catch { return res.status(400).json({ ok: false, error: 'Invalid JSON.' }); }
    try { if (!matchesEnvelope(body)) return res.status(400).json({ ok: false, error: 'Webhook account/mode mismatch.' }); }
    catch { return unavailable(); }
    const eventId = req.get('x-razorpay-event-id');
    if (!body || Array.isArray(body) || typeof body !== 'object' || typeof body.event !== 'string' ||
        !/^[a-z][a-z0-9_.]{0,127}$/.test(body.event) || typeof eventId !== 'string' ||
        !/^[\x21-\x7e]{1,256}$/.test(eventId)) {
      return res.status(400).json({ ok: false, error: 'Invalid event envelope.' });
    }
    if (typeof persistVerifiedEvent !== 'function') return unavailable();
    const event = observation(eventId, req.body, body);
    let timer;
    try {
      // Timeout does not cancel a possible late commit. A future database sink
      // must deduplicate retries by event ID and body hash, including late commits.
      const receipt = await Promise.race([
        Promise.resolve().then(() => persistVerifiedEvent(event)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Persistence timeout.')), persistTimeoutMs); }),
      ]);
      if (receipt?.conflict === true) return res.status(409).json({ ok: false, error: 'Conflicting event identity.' });
      if (receipt?.durable !== true || receipt.eventId !== event.eventId || receipt.bodySha256 !== event.bodySha256) return unavailable();
      return res.status(200).json({ ok: true });
    } catch {
      // Never log adapter errors: they can contain credentials/customer data.
      return unavailable();
    } finally {
      clearTimeout(timer);
    }
  };
}
