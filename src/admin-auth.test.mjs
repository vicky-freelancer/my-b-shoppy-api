import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import express from 'express';
import { createAdminAuthRouter } from './admin-auth.mjs';

test('legacy admin requires explicitly configured credentials', async (t) => {
  const originalUsername = process.env.ADMIN_USERNAME;
  const originalHash = process.env.ADMIN_PASSWORD_HASH;
  t.after(() => {
    for (const [key, value] of [['ADMIN_USERNAME', originalUsername], ['ADMIN_PASSWORD_HASH', originalHash]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const hash = `test-salt:${scryptSync('test-password', 'test-salt', 64).toString('hex')}`;
  for (const [username, passwordHash, expectedStatus] of [
    ['', '', 503], ['test-admin', '', 503], ['', hash, 503], ['test-admin', hash, 200],
  ]) {
    process.env.ADMIN_USERNAME = username;
    process.env.ADMIN_PASSWORD_HASH = passwordHash;
    const app = express();
    app.use(createAdminAuthRouter());
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'test-admin', password: 'test-password' }),
      });
      assert.equal(response.status, expectedStatus);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
