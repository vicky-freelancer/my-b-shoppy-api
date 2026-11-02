import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHmac } from 'node:crypto';
import { createCheckoutControl, CHECKOUT_UNAVAILABLE_CODE } from './checkout-control.mjs';
import { createRazorpayWebhookHandler } from './payment-security.mjs';

const disabledFlags = [undefined, null, false, true, 0, 1, '', 'false', 'FALSE', 'TRUE', 'True', '1', 'yes', ' true', 'true ', 'true\n'];
for (const [index, flag] of disabledFlags.entries()) {
  test(`checkout flag fails closed: case ${index} (${String(flag)})`, () => {
    assert.equal(createCheckoutControl({ readFlag: () => flag, isReady: () => true }).isEnabled(), false);
  });
}

test('exact true is necessary but cannot bypass the current secure-checkout interlock', () => {
  assert.equal(createCheckoutControl({ readFlag: () => 'true' }).isEnabled(), false);
  assert.equal(createCheckoutControl({ readFlag: () => 'true', isReady: () => true }).isEnabled(), true);
  assert.equal(createCheckoutControl({ readFlag: () => 'true', isReady: () => 'true' }).isEnabled(), false);
});

test('configuration failure disables without exposing diagnostics', () => {
  assert.equal(createCheckoutControl({ readFlag: () => { throw new Error('private-fixture'); } }).isEnabled(), false);
});

async function listen(t, app) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('disabled HTTP guard runs before JSON parsing and never reaches the payment provider', async t => {
  let flag;
  let providerCalls = 0;
  const control = createCheckoutControl({ readFlag: () => flag, isReady: () => true });
  const app = express();
  app.get('/api/checkout/status', control.status);
  app.post('/api/create-order', control.guard);
  app.use(express.json());
  app.post('/api/create-order', (_req, res) => { providerCalls++; res.json({ id: 'synthetic-only' }); });
  const base = await listen(t, app);
  for (flag of disabledFlags) {
    const response = await fetch(`${base}/api/create-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-checkout-enabled': 'true' }, body: 'invalid JSON',
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, CHECKOUT_UNAVAILABLE_CODE);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const status = await fetch(`${base}/api/checkout/status`);
    const body = await status.json();
    assert.equal(body.enabled, false);
    assert.equal(JSON.stringify(body).includes('CHECKOUT_ENABLED'), false);
  }
  assert.equal(providerCalls, 0);
  // Only a synthetic, injected ready implementation can be enabled in this test.
  flag = 'true';
  assert.equal((await fetch(`${base}/api/create-order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  assert.equal(providerCalls, 1);
});

test('webhook retries are outside new-purchase containment (mock durable receipt only)', async t => {
  const app = express();
  const control = createCheckoutControl({ readFlag: () => 'false' });
  const secret = 'synthetic-webhook-secret';
  app.post('/api/create-order', control.guard, (_req, res) => res.sendStatus(500));
  app.post('/api/razorpay-webhook', express.raw({ type: 'application/json' }), createRazorpayWebhookHandler({
    getSecret: () => secret,
    persistVerifiedEvent: async event => ({ durable: true, eventId: event.eventId, bodySha256: event.bodySha256 }),
  }));
  const base = await listen(t, app);
  const raw = '{"event":"payment.captured"}';
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  const response = await fetch(`${base}/api/razorpay-webhook`, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'evt_synthetic',
  }, body: raw });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});
