import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTestOrigins, loadDevelopmentEnv, registerLiveness } from './runtime-config.mjs';

const profile = { DEPLOYMENT_PROFILE: 'isolated-test' };
test('exact canonical HTTPS test origins are deduplicated and profile gated', () => {
  assert.deepEqual(parseTestOrigins({}), []);
  assert.deepEqual(parseTestOrigins({ ...profile, TEST_ALLOWED_ORIGINS: 'https://test.example, https://test.example,https://test.example:8443' }), ['https://test.example', 'https://test.example:8443']);
  assert.throws(() => parseTestOrigins({ TEST_ALLOWED_ORIGINS: 'https://test.example' }));
});
for (const value of [' ', ',', 'https://test.example,', '*', 'null', 'http://test.example', 'https://*.example', 'https://user:pass@test.example', 'https://test.example/', 'https://test.example/path', 'https://test.example?x=1', 'https://test.example#x', 'https://test.example?', 'https://test.example#', 'https://test.example\\path', 'https://test.example:443', 'https://TEST.example', 'https://test.example\n.evil']) {
  test('invalid origin fails closed: ' + JSON.stringify(value), () => {
    assert.throws(() => parseTestOrigins({ ...profile, TEST_ALLOWED_ORIGINS: value }), /^Error: Invalid isolated test origin configuration\.$/);
  });
}
test('dotenv cannot populate synthetic credentials in isolated or production environments', () => {
  for (const env of [{ ...profile }, { NODE_ENV: 'production' }, { ...profile, NODE_ENV: 'development' }]) {
    loadDevelopmentEnv({ env, envPath: 'synthetic.env', configure: () => { throw new Error('File access forbidden'); } });
    assert.equal(env.MARIADB_PASSWORD, undefined);
  }
  let calls = 0;
  loadDevelopmentEnv({ env: {}, envPath: 'synthetic.env', configure: options => { calls++; assert.equal(options.path, 'synthetic.env'); } });
  assert.equal(calls, 1);
});
test('liveness bypasses failing database/auth middleware and sends no-store', async t => {
  const app = express();
  registerLiveness(app);
  app.use(() => { throw new Error('Database/auth must not run'); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/live`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true });
});

test('isolated server keeps legacy admin inaccessible and checkout disabled', async t => {
  const port = 25000 + Math.floor(Math.random() * 10000);
  const preload = `globalThis.fetch = () => { throw new Error('External service forbidden'); };`;
  const server = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ...profile, NODE_ENV: 'production', MARIADB_ENABLED: 'false', CHECKOUT_ENABLED: 'true', PORT: String(port), TEST_ALLOWED_ORIGINS: 'https://test.example', ADMIN_PASSWORD_HASH: 'invalid-explicit-value' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (server.exitCode === null) { server.kill(); await once(server, 'exit'); } });
  await Promise.race([
    new Promise(resolve => server.stdout.on('data', data => { if (data.toString().includes('server running')) resolve(); })),
    once(server, 'exit').then(() => { throw new Error('Startup failed'); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Startup timeout')), 10000).unref()),
  ]);
  const base = `http://127.0.0.1:${port}`;
  const live = await fetch(base + '/api/live');
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { ok: true });
  for (const route of ['/api/admin/login', '/api/admin/session', '/api/admin/logout']) {
    const response = await fetch(base + route, { method: route.endsWith('session') ? 'GET' : 'POST' });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.razorpayConfigured, false);
  assert.equal((await (await fetch(base + '/api/checkout/status')).json()).enabled, false);
  assert.equal((await fetch(base + '/api/create-order', { method: 'POST' })).status, 503);
  assert.equal((await fetch(base + '/api/verify-payment', { method: 'POST' })).status, 503);
  for (const origin of ['https://test.example', 'https://mybshoppy.com', 'https://admin.mybshoppy.com', 'http://localhost:3000']) {
    const response = await fetch(base + '/api/live', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  }
  for (const origin of ['https://test.example.evil', 'http://test.example', 'https://test.example:8443', 'null']) {
    const response = await fetch(base + '/api/live', { headers: { Origin: origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});
