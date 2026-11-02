import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import { createRazorpayWebhookHandler, verifyCheckoutSignature, verifyWebhookSignature, validateCapturedPayment } from './payment-security.mjs';

const secret = 'synthetic-unit-test-secret';
const hmac = (body) => createHmac('sha256', secret).update(body).digest('hex');
const expected = { providerOrderId: 'order_stored', amountPaise: 16000, currency: 'INR' };
const captured = { id: 'pay_fixture', order_id: 'order_stored', amount: 16000, currency: 'INR', status: 'captured', captured: true };

test('checkout signature uses the stored order identity', () => {
  assert.equal(verifyCheckoutSignature({ storedProviderOrderId: 'order_stored', paymentId: 'pay_fixture', signature: hmac('order_stored|pay_fixture'), keySecret: secret }), true);
});

test('a signature for another order does not match the stored order', () => {
  assert.equal(verifyCheckoutSignature({ storedProviderOrderId: 'order_stored', paymentId: 'pay_fixture', signature: hmac('order_other|pay_fixture'), keySecret: secret }), false);
});

for (const [label, signature] of [['missing', undefined], ['non-string', {}], ['short', 'ab'], ['non-hex', 'x'.repeat(64)], ['odd-length', 'a'.repeat(63)], ['wrong', '0'.repeat(64)]]) {
  test(`malformed/incorrect signature fails safely: ${label}`, () => {
    assert.equal(verifyCheckoutSignature({ storedProviderOrderId: 'order_stored', paymentId: 'pay_fixture', signature, keySecret: secret }), false);
  });
}

test('missing checkout secret fails closed', () => {
  assert.equal(verifyCheckoutSignature({ storedProviderOrderId: 'order_stored', paymentId: 'pay_fixture', signature: hmac('order_stored|pay_fixture'), keySecret: '' }), false);
});

test('webhook authenticates exact raw bytes, including whitespace', () => {
  const raw = Buffer.from('{ "event": "payment.captured" }');
  assert.equal(verifyWebhookSignature(raw, hmac(raw), secret), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{"event":"payment.captured"}'), hmac(raw), secret), false);
  assert.equal(verifyWebhookSignature(raw.toString(), hmac(raw), secret), false);
});

test('captured payment facts can match a trusted expectation (pure unit comparison)', () => {
  assert.deepEqual(validateCapturedPayment(expected, captured), { valid: true });
});

for (const [label, change, reason] of [
  ['underpayment', { amount: 100 }, 'AMOUNT_MISMATCH'],
  ['overpayment', { amount: 16001 }, 'AMOUNT_MISMATCH'],
  ['fractional amount', { amount: 16000.5 }, 'AMOUNT_MISMATCH'],
  ['string amount', { amount: '16000' }, 'AMOUNT_MISMATCH'],
  ['currency', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
  ['order', { order_id: 'order_other' }, 'ORDER_MISMATCH'],
  ['authorized only', { status: 'authorized', captured: false }, 'NOT_CAPTURED'],
  ['false captured flag', { captured: false }, 'NOT_CAPTURED'],
  ['missing payment identity', { id: '' }, 'INVALID_PAYMENT'],
]) {
  test(`captured-fact mismatch rejected: ${label}`, () => {
    assert.deepEqual(validateCapturedPayment(expected, { ...captured, ...change }), { valid: false, reason });
  });
}

for (const amountPaise of [0, -1, 1.5, '16000', Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid trusted expectation rejected: ${String(amountPaise)}`, () => {
    assert.equal(validateCapturedPayment({ ...expected, amountPaise }, captured).reason, 'INVALID_TRUSTED_EXPECTATION');
  });
}

async function webhookServer(t, options) {
  const app = express();
  app.post('/webhook', express.raw({ type: 'application/json', limit: '64kb', inflate: false }), createRazorpayWebhookHandler(options));
  app.use((error, _req, res, _next) => res.status([400, 413, 415].includes(error.status) ? error.status : 500).json({ ok: false }));
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return (body, overrides = {}) => fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': hmac(body), 'x-razorpay-event-id': 'evt_fixture', ...overrides },
    body,
  });
}

const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { ...captured, email: 'synthetic@example.invalid', notes: { private: 'synthetic-note' } } } } });

test('missing webhook secret returns retryable 503 without persistence', async t => {
  let calls = 0;
  const post = await webhookServer(t, { getSecret: () => '', persistVerifiedEvent: async () => { calls++; } });
  const response = await post(raw);
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('retry-after'));
});

test('invalid signature is rejected before JSON parsing or persistence', async t => {
  let calls = 0;
  const post = await webhookServer(t, { getSecret: () => secret, persistVerifiedEvent: async () => { calls++; } });
  const response = await post('not JSON', { 'x-razorpay-signature': '0'.repeat(64) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Invalid webhook signature.');
  assert.equal(calls, 0);
});

test('signed malformed JSON is rejected', async t => {
  const post = await webhookServer(t, { getSecret: () => secret });
  assert.equal((await post('not JSON')).status, 400);
});

test('missing event ID is rejected', async t => {
  const post = await webhookServer(t, { getSecret: () => secret });
  assert.equal((await post(raw, { 'x-razorpay-event-id': '' })).status, 400);
});

test('signed valid event has no successful acknowledgement without durable storage', async t => {
  const post = await webhookServer(t, { getSecret: () => secret });
  assert.equal((await post(raw)).status, 503);
});

test('only a matching committed receipt permits acknowledgement (mock adapter contract)', async t => {
  let received;
  const post = await webhookServer(t, { getSecret: () => secret, persistVerifiedEvent: async event => {
    received = event;
    return { durable: true, eventId: event.eventId, bodySha256: event.bodySha256 };
  } });
  assert.equal((await post(raw)).status, 200);
  assert.equal(received.providerOrderId, expected.providerOrderId);
  assert.equal(Object.isFrozen(received), true);
  assert.equal('email' in received, false);
  assert.equal('notes' in received, false);
  assert.equal('rawBody' in received, false);
  assert.equal('signature' in received, false);
  assert.equal(JSON.stringify(received).includes('synthetic@example.invalid'), false);
});

test('uncommitted or mismatched receipt fails closed', async t => {
  const post = await webhookServer(t, { getSecret: () => secret, persistVerifiedEvent: async () => ({ durable: false }) });
  assert.equal((await post(raw)).status, 503);
});

for (const field of ['eventId', 'bodySha256']) {
  test(`committed receipt with incorrect ${field} is rejected`, async t => {
    const post = await webhookServer(t, { getSecret: () => secret, persistVerifiedEvent: async event => ({ durable: true, eventId: event.eventId, bodySha256: event.bodySha256, [field]: 'wrong' }) });
    assert.equal((await post(raw)).status, 503);
  });
}

test('nonresponding persistence adapter has a bounded retryable failure', async t => {
  const post = await webhookServer(t, { getSecret: () => secret, persistTimeoutMs: 5, persistVerifiedEvent: () => new Promise(() => {}) });
  assert.equal((await post(raw)).status, 503);
});

test('database timeout is retryable and adapter diagnostics are not exposed', async t => {
  const post = await webhookServer(t, { getSecret: () => secret, persistVerifiedEvent: async () => { throw new Error('synthetic-private-diagnostic'); } });
  const response = await post(raw);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('synthetic-private-diagnostic'), false);
});

test('duplicate committed event can be acknowledged again (mock boundary, not a PostgreSQL idempotency test)', async t => {
  const post = await webhookServer(t, { getSecret: () => secret, persistVerifiedEvent: async event => ({ durable: true, duplicate: true, eventId: event.eventId, bodySha256: event.bodySha256 }) });
  assert.equal((await post(raw)).status, 200);
  assert.equal((await post(raw)).status, 200);
});

test('conflicting event identity is not acknowledged', async t => {
  const post = await webhookServer(t, { getSecret: () => secret, persistVerifiedEvent: async () => ({ conflict: true }) });
  assert.equal((await post(raw)).status, 409);
});

test('oversized webhook is rejected without invoking persistence', async t => {
  let calls = 0;
  const post = await webhookServer(t, { getSecret: () => secret, persistVerifiedEvent: async () => { calls++; } });
  assert.equal((await post('x'.repeat(65537))).status, 413);
  assert.equal(calls, 0);
});

test('wrong content type is rejected', async t => {
  const post = await webhookServer(t, { getSecret: () => secret });
  assert.equal((await post(raw, { 'Content-Type': 'text/plain' })).status, 415);
});
