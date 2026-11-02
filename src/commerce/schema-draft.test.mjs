import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { REQUIRED_COLUMNS } from './database.mjs';

const sql = await readFile(new URL('../../schema/001_production_draft.sql', import.meta.url), 'utf8');
const definitions = [...sql.matchAll(/CREATE TABLE\s+(\w+)\s*\(([\s\S]*?)\)\s*ENGINE=InnoDB/gi)];
const tables = new Map(definitions.map(([, name, body]) => [name, body]));

test('draft contains catalog requirements and checkout tables in dependency order', () => {
  const checkout = ['checkout_requests','inventory_reservations','reservation_items','payment_attempts','payment_events','payment_receipts','outbox_jobs'];
  assert.equal(tables.size, 22);
  for (const [name, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const body = tables.get(name);
    assert.ok(body, `missing ${name}`);
    for (const column of columns.split(' ')) assert.match(body, new RegExp(`\\b${column}\\b`, 'i'), `${name}.${column}`);
  }
  for (const name of checkout) assert.ok(tables.has(name), `missing ${name}`);
  const created = new Set();
  for (const [, name, body] of definitions) {
    for (const [, referenced] of body.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) assert.ok(created.has(referenced), `${name} references ${referenced} before creation`);
    created.add(name);
  }
});

test('draft expresses flat shipping and durable uniqueness without seeding', () => {
  assert.match(tables.get('orders'), /shipping_paise\s*=\s*6000/i);
  assert.match(tables.get('checkout_requests'), /PRIMARY KEY\s*\(scope_hash,\s*idempotency_key\)/i);
  assert.match(tables.get('payment_events'), /UNIQUE KEY\s+\w+\s*\(account_ref,environment,provider_event_id\)/i);
  assert.match(tables.get('payment_receipts'), /UNIQUE KEY\s+\w+\s*\(account_ref,environment,provider_payment_id\)/i);
  assert.match(tables.get('inventory_movements'), /UNIQUE KEY\s+\w+\s*\(reservation_item_id,kind\)/i);
  assert.doesNotMatch(sql, /^\s*(?:INSERT|UPDATE|DELETE|DROP|ALTER|USE)\b/im);
});
