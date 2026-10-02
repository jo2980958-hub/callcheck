import test from 'node:test';
import assert from 'node:assert/strict';
import { findSdkOp, sdkBodyCheck, parseSdkSnippet, coverage } from '../src/sdkcontract.js';

// Everything here runs the SDK's own generated schemas in-process: no HTTP, no credentials.
const ORDER = { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '10.00' } }] };

test('the live Orders create path maps to OrdersController.createOrder', () => {
  const op = findSdkOp('POST', '/v2/checkout/orders');
  assert.equal(op.controller, 'OrdersController');
  assert.equal(op.method, 'createOrder');
  assert.equal(op.http, 'POST');
  assert.equal(op.args.body.model, 'orderRequest');
});

test('a valid REST-shaped order body passes the SDK model untouched', async () => {
  const r = await sdkBodyCheck(findSdkOp('POST', '/v2/checkout/orders'), ORDER);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.skipped, undefined);
});

test('a numeric amount.value is a type error the SDK would throw on', async () => {
  const body = { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: 10 } }] };
  const r = await sdkBodyCheck(findSdkOp('POST', '/v2/checkout/orders'), body);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].ptr, '/purchase_units/0/amount/value');
  assert.match(r.errors[0].message, /Expected value to be of type 'string' but found 'number'/);
  assert.deepEqual(r.dropped, []);
});

test('a field the model never heard of is reported as dropped, not rejected', async () => {
  const r = await sdkBodyCheck(findSdkOp('POST', '/v2/checkout/orders'), { ...ORDER, favourite_colour: 'teal' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.dropped, ['/favourite_colour']);
});

test('a createOrder snippet becomes a POST with the request-id header and a snake_case body', async () => {
  const parsed = await parseSdkSnippet(`const { result } = await ordersController.createOrder({
    body: { intent: 'CAPTURE', purchaseUnits: [{ amount: { currencyCode: 'USD', value: '10.00' } }] },
    paypalRequestId: 'order-2026-0001',
  });`);
  assert.equal(parsed.req.method, 'POST');
  assert.equal(parsed.req.path, '/v2/checkout/orders');
  assert.equal(parsed.req.headers['PayPal-Request-Id'], 'order-2026-0001');
  assert.deepEqual(parsed.req.body, ORDER);
  assert.equal(parsed.sdk.controller, 'OrdersController');
  assert.equal(parsed.sdk.method, 'createOrder');
  assert.deepEqual(parsed.sdk.errors, []);
  assert.deepEqual(parsed.sdk.dropped, []);
});

test('Payouts is outside the SDK 2.5.0 surface, so coverage lists it as missing', () => {
  const c = coverage([
    { method: 'POST', path: '/v1/payments/payouts' },
    { method: 'GET', path: '/v1/payments/payouts/{payout_batch_id}' },
    { method: 'POST', path: '/v2/checkout/orders' },
  ]);
  assert.equal(c.total, 3);
  assert.equal(c.covered, 1);
  assert.deepEqual(c.missing, ['POST /v1/payments/payouts', 'GET /v1/payments/payouts/{payout_batch_id}']);
});
