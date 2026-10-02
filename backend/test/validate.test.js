import test from 'node:test';
import assert from 'node:assert/strict';
import { offline } from './helpers.js';
import { loadSpec, matchOp, requestSchema } from '../src/spec.js';
import { validate } from '../src/validate.js';
import { parseRest, shellWords } from '../src/parse.js';
import { parseJsExpression } from '../src/jsliteral.js';
offline();

async function run(product, method, path, body) {
  const s = await loadSpec(product); const o = matchOp(s.index, method, path);
  return validate(s.spec, requestSchema(s.spec, o).schema, body);
}

test('a valid order body has no errors and no unknown fields', async () => {
  const r = await run('orders', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '10.00' } }] });
  assert.equal(r.errors.length, 0); assert.equal(r.unknown.length, 0);
});
test('enum, type and required errors carry JSON pointers', async () => {
  const r = await run('orders', 'POST', '/v2/checkout/orders', { intent: 'CAPTUR', purchase_units: [{ amount: { currency_code: 'USD', value: 10 } }] });
  const ptrs = r.errors.map((e) => `${e.ptr}:${e.keyword}`);
  assert.ok(ptrs.includes('/intent:enum')); assert.ok(ptrs.includes('/purchase_units/0/amount/value:type'));
  const m = await run('orders', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE' });
  assert.ok(m.errors.some((e) => e.ptr === '/purchase_units' && e.keyword === 'required'));
});
test('unknown fields are reported without being errors', async () => {
  const r = await run('orders', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_unit: [], purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }] });
  assert.equal(r.errors.length, 0); assert.ok(r.unknown.some((u) => u.name === 'purchase_unit'));
});
test('maxLength on invoice_number is 25', async () => {
  const body = { detail: { invoice_number: 'X'.repeat(26) }, invoicer: { business_name: 'a' }, primary_recipients: [{ billing_info: { email_address: 'a@b.co' } }], items: [{ name: 'p', quantity: '1', unit_amount: { currency_code: 'USD', value: '1.00' } }] };
  const r = await run('invoicing', 'POST', '/v2/invoicing/invoices', body);
  assert.ok(r.errors.some((e) => e.keyword === 'maxLength' && e.ptr === '/detail/invoice_number'));
});
test('operation matching prefers literal segments and fills path params', async () => {
  const s = await loadSpec('invoicing');
  assert.equal(matchOp(s.index, 'POST', '/v2/invoicing/generate-next-invoice-number').path, '/v2/invoicing/generate-next-invoice-number');
  assert.equal(matchOp(s.index, 'GET', '/v2/invoicing/invoices/INV2-1').pathParams.invoice_id, 'INV2-1');
  assert.equal(matchOp(s.index, 'PATCH', '/v2/invoicing/invoices/INV2-1'), null);
});
test('payouts schema: recipient_type has no enum in the live schema', async () => {
  const s = await loadSpec('payouts');
  const rt = s.spec.components.schemas.payout_item_request.properties.recipient_type;
  assert.equal(rt.enum, undefined); assert.equal(rt.maxLength, 13); assert.match(rt.description, /USER_HANDLE/);
});

test('curl parsing: quotes, continuations, -u, and the implicit form encoding', () => {
  assert.deepEqual(shellWords("curl -H 'A: b c' \"x y\" \\\n z"), ['curl', '-H', 'A: b c', 'x y', 'z']);
  const r = parseRest(`curl -u id:secret -X POST https://api-m.sandbox.paypal.com/v2/checkout/orders -d '{"a":1}'`);
  assert.equal(r.hadCredentials, true); assert.equal(r.implicitFormContentType, true); assert.deepEqual(r.body, { a: 1 });
  const j = parseRest(`curl https://x.test/v1/customer/disputes?page_size=2 -H "Authorization: Bearer abc"`);
  assert.equal(j.method, 'GET'); assert.equal(j.query.page_size, '2'); assert.equal(j.headers.Authorization, '[redacted]');
});
test('raw HTTP parsing and bad JSON', () => {
  const r = parseRest('POST /v1/payments/payouts HTTP/1.1\nHost: api-m.sandbox.paypal.com\nContent-Type: application/json\n\n{"items": [}');
  assert.equal(r.host, 'api-m.sandbox.paypal.com'); assert.ok(r.bodyError);
  assert.throws(() => parseRest('hello'), /first line/);
});
test('JS literal reader never evaluates and marks variables', () => {
  const v = parseJsExpression("{ a: 1, 'b-c': [true, null], d: someVar, e: JSON.stringify({ x: 2 }), f: `t${1}` }");
  assert.equal(v.a, 1); assert.deepEqual(v['b-c'], [true, null]); assert.deepEqual(v.d, { __ident: 'someVar' }); assert.equal(v.e.__call, 'JSON.stringify');
  assert.throws(() => parseJsExpression('{ a: ; }'));
});
