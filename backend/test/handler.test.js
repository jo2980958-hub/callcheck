import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { offline } from './helpers.js';
process.env.CALLCHECK_INLINE = '1';
process.env.PAYPAL_WEBHOOK_ID = 'WHTEST1234';
process.env.ADMIN_TOKEN = 'adm';
const { handle, setStore } = await import('../src/handler.js');
const { memoryStore } = await import('../src/store.js');
const { setCertKeyGetter, signedString } = await import('../src/webhook.js');
offline();
setStore(memoryStore());

const ev = (method, path, body, headers = {}) => ({ rawPath: path, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), requestContext: { http: { method, sourceIp: '203.0.113.9' } } });
const json = (r) => JSON.parse(r.body);

test('health, meta, traps and examples answer', async () => {
  assert.equal(json(await handle(ev('GET', '/api/health'))).ok, true);
  assert.ok(json(await handle(ev('GET', '/api/meta'))).traps >= 40);
  const t = json(await handle(ev('GET', '/api/traps')));
  assert.ok(t.traps.every((x) => x.evidence.length));
  assert.equal(json(await handle(ev('GET', '/api/examples'))).examples.length, 8);
});

test('check answers 200 with a verdict, 400 for an empty paste, and never echoes a pasted token', async () => {
  const r = await handle(ev('POST', '/api/check', { text: 'curl https://api-m.sandbox.paypal.com/v1/customer/disputes -H "Authorization: Bearer SECRETTOKEN123"' }));
  assert.equal(r.statusCode, 200); assert.ok(!r.body.includes('SECRETTOKEN123'));
  const e = await handle(ev('POST', '/api/check', { text: '  ' }));
  assert.equal(e.statusCode, 400); assert.match(json(e).error, /Paste a request/);
  const bad = await handle(ev('POST', '/api/check', { text: 'not a request' }));
  assert.equal(bad.statusCode, 422); assert.match(json(bad).error, /first line/);
});

test('run refuses what the gate refuses, with a reason', async () => {
  const card = await handle(ev('POST', '/api/run', { text: 'POST /v3/vault/setup-tokens\nContent-Type: application/json\n\n{"payment_source":{"card":{"number":"4111111111111111"}}}' }));
  assert.equal(card.statusCode, 422); assert.match(json(card).error, /card/i);
  const live = await handle(ev('POST', '/api/run', { text: 'GET https://api-m.paypal.com/v1/customer/disputes' }));
  assert.equal(live.statusCode, 422);
  const mcp = await handle(ev('POST', '/api/run', { text: 'x', mode: 'mcp' }));
  assert.equal(mcp.statusCode, 422);
});

test('check rate limit answers 429 in words', async () => {
  setStore(memoryStore());
  let last; for (let i = 0; i < 241; i++) last = await handle(ev('POST', '/api/check', { text: 'GET /v1/customer/disputes' }));
  assert.equal(last.statusCode, 429); assert.match(json(last).error, /Wait a little/);
  setStore(memoryStore());
});

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function signed(bodyStr, id = 'WH-T1') {
  const h = { 'paypal-transmission-id': 'tid-' + id, 'paypal-transmission-time': new Date().toISOString(), 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-T', 'paypal-auth-algo': 'SHA256withRSA' };
  h['paypal-transmission-sig'] = crypto.createSign('RSA-SHA256').update(signedString(h, bodyStr, 'WHTEST1234')).sign(privateKey, 'base64');
  return h;
}
test('webhook: 200 at once for a verified delivery, work happens after, duplicates are 200, tampering is 401', async () => {
  setCertKeyGetter(async () => publicKey);
  const body = JSON.stringify({ id: 'WH-T1', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_item_id: 'ITEM-X', payout_batch_id: 'BATCH-X' } });
  const t0 = Date.now();
  const ok = await handle(ev('POST', '/api/webhooks/paypal', body, signed(body)));
  assert.equal(ok.statusCode, 200); assert.equal(typeof ok.after, 'function');
  assert.ok(Date.now() - t0 < 1000, 'answered without waiting for follow-up work');
  await ok.after();
  const list = json(await handle(ev('GET', '/api/webhooks'))).events;
  assert.ok(list.some((e) => e.id === 'WH-T1' && e.verified));
  const dup = await handle(ev('POST', '/api/webhooks/paypal', body, signed(body)));
  assert.equal(dup.statusCode, 200); assert.equal(json(dup).duplicate, true);
  const tampered = body.replace('SUCCEEDED', 'FAILED');
  const bad = await handle(ev('POST', '/api/webhooks/paypal', tampered, signed(body, 'WH-T2')));
  assert.equal(bad.statusCode, 401);
  const rejected = json(await handle(ev('GET', '/api/webhooks'))).events.find((e) => e.verified === false);
  assert.match(rejected.reason, /signature does not match/);
  const noHeaders = await handle(ev('POST', '/api/webhooks/paypal', body, {}));
  assert.equal(noHeaders.statusCode, 401);
});

test('admin routes need the token and unknown routes are 404', async () => {
  assert.equal((await handle(ev('GET', '/api/admin/webhook-latest'))).statusCode, 403);
  assert.equal((await handle(ev('GET', '/api/admin/webhook-latest', undefined, { 'x-admin-token': 'adm' }))).statusCode, 200);
  assert.equal((await handle(ev('GET', '/api/nope'))).statusCode, 404);
});
