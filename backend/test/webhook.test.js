import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { crc32, certUrlAllowed, signedString, verifyLocal, resourceIds } from '../src/webhook.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const WH = '7WJ53361D1798092F';
function delivery(body, { time = new Date().toISOString(), certUrl = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1' } = {}) {
  const h = { 'paypal-transmission-id': 'tid-1', 'paypal-transmission-time': time, 'paypal-cert-url': certUrl, 'paypal-auth-algo': 'SHA256withRSA' };
  const sig = crypto.createSign('RSA-SHA256').update(signedString(h, body, WH)).sign(privateKey, 'base64');
  return { ...h, 'paypal-transmission-sig': sig };
}
const getKey = async () => publicKey;
const body = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_item_id: 'ITEM1', payout_batch_id: 'B1' } });

test('crc32 matches the known check value', () => { assert.equal(crc32('123456789'), 0xcbf43926); });
test('a correctly signed delivery verifies', async () => {
  const r = await verifyLocal({ headers: delivery(body), rawBody: body, webhookId: WH, getKey });
  assert.deepEqual(r, { ok: true, via: 'local' });
});
test('TAMPERED payload is rejected: one changed character', async () => {
  const h = delivery(body);
  const r = await verifyLocal({ headers: h, rawBody: body.replace('SUCCEEDED', 'SUCCEEDEd'), webhookId: WH, getKey });
  assert.equal(r.ok, false); assert.match(r.reason, /signature does not match/);
});
test('wrong webhook id, wrong key, stale time, foreign cert host and missing headers are all rejected', async () => {
  const h = delivery(body);
  assert.equal((await verifyLocal({ headers: h, rawBody: body, webhookId: 'OTHER', getKey })).ok, false);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  assert.equal((await verifyLocal({ headers: h, rawBody: body, webhookId: WH, getKey: async () => other })).ok, false);
  const old = delivery(body, { time: new Date(Date.now() - 3 * 3600_000).toISOString() });
  assert.match((await verifyLocal({ headers: old, rawBody: body, webhookId: WH, getKey })).reason, /replay/);
  const evil = delivery(body, { certUrl: 'https://paypal.com.evil.example/cert' });
  assert.match((await verifyLocal({ headers: evil, rawBody: body, webhookId: WH, getKey })).reason, /paypal\.com/);
  assert.match((await verifyLocal({ headers: {}, rawBody: body, webhookId: WH, getKey })).reason, /missing headers/);
});
test('cert URL check accepts only https on paypal.com', () => {
  assert.ok(certUrlAllowed('https://api.paypal.com/x')); assert.ok(!certUrlAllowed('http://api.paypal.com/x')); assert.ok(!certUrlAllowed('https://notpaypal.com/x')); assert.ok(!certUrlAllowed('garbage'));
});
test('resource ids are pulled from payout and invoice events', () => {
  assert.deepEqual(resourceIds(JSON.parse(body)).sort(), ['B1', 'ITEM1']);
});
