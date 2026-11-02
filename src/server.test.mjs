import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
// Keep deployment checks in the existing backend test command.
import './runtime-config.test.mjs';

test('payment validation and production routing', async () => {
  const port = 15000 + Math.floor(Math.random() * 10000);
  const secret = 'local-test-secret';
  const server = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { throw new Error("Outbound network forbidden in test"); };'), fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, NODE_ENV: 'production', MARIADB_ENABLED: 'false', PORT: String(port), RAZORPAY_KEY_ID: 'rzp_test_local', RAZORPAY_KEY_SECRET: secret, RAZORPAY_WEBHOOK_SECRET: '', CHECKOUT_ENABLED: 'false', ADMIN_USERNAME: 'qa-admin', ADMIN_PASSWORD_HASH: `test-salt:${crypto.scryptSync('test-auth-password', 'test-salt', 64).toString('hex')}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await Promise.race([
      new Promise((resolve) => server.stdout.on('data', (data) => {
        if (data.toString().includes('server running')) resolve();
      })),
      once(server, 'exit').then(() => { throw new Error('Server exited before startup'); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Startup timed out')), 10000).unref()),
    ]);
    const base = `http://127.0.0.1:${port}`;
    const post = (route, body) => fetch(`${base}/api/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.mode, 'TEST');
    assert.equal(health.durableCheckoutReady, false);
    assert.equal((await post('razorpay-webhook', {})).status, 503);
    for (const amount of [0, -100, 99, 100.5, '100', null]) {
      assert.equal((await post('create-order', { amount })).status, 503);
    }
    assert.equal((await post('create-order', { amount: 100, currency: 'USD' })).status, 503);
    const unavailable = await post('create-order', { amount: 100, currency: 'INR' });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, 'CHECKOUT_TEMPORARILY_UNAVAILABLE');
    const availability = await fetch(`${base}/api/checkout/status`);
    assert.equal((await availability.json()).enabled, false);
    assert.equal(availability.headers.get('cache-control'), 'no-store');
    const payment = { razorpay_order_id: 'order_local', razorpay_payment_id: 'pay_local' };
    const signature = crypto.createHmac('sha256', secret).update('order_local|pay_local').digest('hex');
    assert.equal((await post('verify-payment', { ...payment, razorpay_signature: signature })).status, 200);
    assert.equal((await post('verify-payment', { ...payment, razorpay_signature: 'invalid' })).status, 400);
    // The separately hosted admin must receive JSON with credentialed CORS.
    const adminOrigin = 'https://admin.mybshoppy.com';
    const preflight = await fetch(`${base}/api/admin/login`, { method: 'OPTIONS', headers: { Origin: adminOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), adminOrigin);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { Origin: adminOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'qa-admin', password: 'test-auth-password' }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('content-type'), /application\/json/);
    assert.equal(login.headers.get('access-control-allow-origin'), adminOrigin);
    assert.equal(login.headers.get('access-control-allow-credentials'), 'true');
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/);
    const headers = { Origin: adminOrigin, Cookie: cookie.split(';')[0] };
    const session = await fetch(`${base}/api/admin/session`, { headers });
    assert.equal(session.status, 200); assert.equal((await session.json()).user.name, 'qa-admin');
    assert.equal((await fetch(`${base}/api/admin/logout`, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/session`, { headers })).status, 401);
    const wrongLogin = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { Origin: adminOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'qa-admin', password: 'wrong' }) });
    assert.equal(wrongLogin.status, 401);
    assert.match(wrongLogin.headers.get('content-type'), /application\/json/);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    assert.match(cookie, /SameSite=Strict/);
    const forgedSession = await fetch(`${base}/api/admin/session`, { headers: { Cookie: `${cookie.split('=')[0]}=forged` } });
    assert.equal(forgedSession.status, 401);
    const blockedOrigin = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'qa-admin', password: 'test-auth-password' }) });
    assert.equal(blockedOrigin.status, 403);
    assert.equal(blockedOrigin.headers.get('access-control-allow-origin'), null);
    // The wrong login above counts toward the five-attempt limit.
    for (let i = 0; i < 4; i++) {
      const failure = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'qa-admin', password: 'wrong' }) });
      assert.equal(failure.status, 401);
    }
    const limited = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'qa-admin', password: 'test-auth-password' }) });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  } finally {
    server.kill();
    await once(server, 'exit');
  }
});
