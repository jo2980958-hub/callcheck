import test from 'node:test';
import assert from 'node:assert/strict';
import { offline, ENV } from './helpers.js';
import { check } from '../src/check.js';
import { TRAPS } from '../src/traps.js';

offline();
const run = (text, extra = {}) => check({ text, ...extra }, { env: ENV, eventTypes: ['PAYMENT.PAYOUTS-ITEM.SUCCEEDED', 'PAYMENT.PAYOUTS-ITEM.FAILED', 'PAYMENT.PAYOUTSBATCH.SUCCESS', 'INVOICING.INVOICE.PAID'], webhookCount: 6 });
const ids = (r) => r.findings.map((f) => f.id);

test('every trap with an example fires its own detector on that example', async () => {
  for (const t of TRAPS.filter((x) => x.example)) {
    const r = await run(t.example.text);
    const hit = r.findings.some((f) => f.trap === t.id || f.id === t.id);
    assert.ok(hit, `trap ${t.id} did not fire on its example. Found: ${ids(r).join(', ')}`);
  }
});

test('payout to an unregistered address is accepted, then held UNCLAIMED', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'payout-unregistered').example.text);
  assert.equal(r.verdict.level, 'trap');
  assert.deepEqual(r.predictions.first.terminal, { batch: 'SUCCESS', item: 'UNCLAIMED', error: 'RECEIVER_UNREGISTERED' });
  assert.equal(r.predictions.first.status, 201);
});

test('duplicate sender_batch_id is predicted as a 400 on the second send only', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'payout-dup-batch-id').example.text);
  assert.equal(r.predictions.second.status, 400);
  assert.equal(r.predictions.second.name, 'USER_BUSINESS_ERROR');
});

test('self pay is predicted as DENIED/FAILED after a 201', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'payout-self-pay').example.text);
  assert.equal(r.verdict.level, 'fail');
  assert.equal(r.verdict.headline, 'This call is accepted, then fails.');
  assert.equal(r.predictions.first.terminal.error, 'SELF_PAY_NOT_ALLOWED');
});

test('invoice number over 25 characters is a schema blocker with the observed issue name', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'invoice-number-length').example.text);
  assert.equal(r.predictions.first.issue, 'INVALID_STRING_MAX_LENGTH');
  assert.ok(r.corrected, 'a corrected call is offered');
  assert.ok(JSON.parse(r.corrected.text.split('\n\n').slice(1).join('\n\n')).detail.invoice_number.length <= 25);
});

test('PATCH on an invoice is not an operation, and the checker says which verbs exist', async () => {
  const r = await run('PATCH /v2/invoicing/invoices/INV2-AAAA-BBBB-CCCC-DDDD\nContent-Type: application/json\n\n[]');
  const f = r.findings.find((x) => x.id === 'method-not-in-schema');
  assert.ok(f);
  assert.match(f.fix, /PUT/);
  assert.equal(r.predictions.first.status, 404);
});

test('order breakdown mismatch is fixed by the corrected call', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'orders-amount-mismatch').example.text);
  assert.equal(r.predictions.first.issue, 'AMOUNT_MISMATCH');
  const body = JSON.parse(r.corrected.text.split('\n\n').slice(1).join('\n\n'));
  assert.equal(body.purchase_units[0].amount.value, '8.00');
  const again = await run(r.corrected.text);
  assert.equal(again.counts.blocker, 0, 'corrected call has no blockers');
});

test('numeric money value is a warning, not a blocker, because the API accepted it', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'orders-value-type').example.text);
  assert.equal(r.counts.blocker, 0);
  assert.ok(ids(r).includes('orders-value-type'));
  assert.ok(ids(r).includes('sdk-rejects-body'), 'and the SDK contract would refuse it');
});

test('orders without a payment source expect 201 and the approve link', async () => {
  const r = await run('POST /v2/checkout/orders\nContent-Type: application/json\n\n{"intent":"CAPTURE","purchase_units":[{"amount":{"currency_code":"USD","value":"10.00"}}]}');
  assert.equal(r.predictions.first.status, 201);
  assert.equal(r.predictions.first.body.status, 'CREATED');
});

test('JPY with decimals and USD with three decimals are separate 422s', async () => {
  const a = await run(TRAPS.find((t) => t.id === 'orders-currency-decimals').example.text);
  assert.equal(a.predictions.first.issue, 'DECIMALS_NOT_SUPPORTED');
  const b = await run('POST /v2/checkout/orders\nContent-Type: application/json\n\n{"intent":"CAPTURE","purchase_units":[{"amount":{"currency_code":"USD","value":"10.005"}}]}');
  assert.equal(b.predictions.first.issue, 'DECIMAL_PRECISION');
});

test('curl -d without a JSON header is a 415', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'generic-content-type').example.text);
  assert.equal(r.predictions.first.status, 415);
  assert.equal(r.request.hadCredentials, false);
});

test('credentials are removed from the request and never echoed', async () => {
  const r = await run('curl -X GET https://api-m.sandbox.paypal.com/v1/customer/disputes -H "Authorization: Bearer A21AAKsecretsecret"');
  assert.ok(!JSON.stringify(r).includes('A21AAKsecretsecret'));
  assert.ok(ids(r).includes('credentials-redacted'));
});

test('live host is flagged and the call is not runnable', async () => {
  const r = await run('curl -X GET https://api-m.paypal.com/v1/customer/disputes -H "Content-Type: application/json"');
  assert.equal(r.runnable.ok, false);
});

test('webhook event names are checked against the event-type list and a nearest name is proposed', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'webhook-event-name').example.text);
  const f = r.findings.find((x) => x.id === 'webhook-event-name');
  assert.ok(f);
  assert.match(f.fix, /PAYMENT\.PAYOUTS-ITEM\.SUCCEEDED/);
});

test('transaction search over 31 days is a 400', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'txn-window').example.text);
  assert.equal(r.predictions.first.status, 400);
});

test('a card payment source is refused as unrunnable and never executed', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'orders-card-source').example.text);
  assert.equal(r.runnable.ok, false);
  assert.match(r.runnable.reason, /Vaulting a card/);
});

test('a path nobody owns gets nearest operations', async () => {
  const r = await run('POST /v2/vault/credit-cards\nContent-Type: application/json\n\n{}');
  assert.ok(ids(r).includes('path-unknown-product'));
  assert.match(r.findings[0].what, /v3\/vault/);
});

test('SDK mode converts camelCase to the REST call and finds dropped snake_case keys', async () => {
  const r = await run(`const { result } = await ordersController.createOrder({\n body: { intent: 'CAPTURE', purchase_units: [{ amount: { currencyCode: 'USD', value: '10.00' } }] },\n paypalRequestId: 'abc' });`, { mode: 'sdk' });
  assert.equal(r.request.method, 'POST');
  assert.equal(r.request.path, '/v2/checkout/orders');
  assert.equal(r.request.headers['PayPal-Request-Id'], 'abc');
  assert.ok(ids(r).includes('sdk-snake-case'));
});

test('SDK mode: a field the SDK model lacks is dropped silently', async () => {
  const r = await run(`await ordersController.createOrder({ body: { intent: 'CAPTURE', purchaseUnits: [{ amount: { currencyCode: 'USD', value: '10.00' } }], paymentSource: { paypal: { brandName: 'Shop', experienceContext: { returnUrl: 'https://e.com/r', cancelUrl: 'https://e.com/c' } } } } });`, { mode: 'sdk' });
  assert.ok(ids(r).includes('sdk-drops-fields'), ids(r).join());
});

test('payouts have no SDK method, and the checker says so', async () => {
  const r = await run(TRAPS.find((t) => t.id === 'payout-dup-batch-id').example.text);
  assert.ok(ids(r).includes('sdk-not-covered'));
});

test('MCP mode: /http path, --tools=all, typo names, absent tools', async () => {
  const a = await check({ mode: 'mcp', text: 'npx mcp-remote https://mcp.sandbox.paypal.com/http' });
  assert.ok(ids(a).includes('mcp-http-path'));
  const b = await check({ mode: 'mcp', text: '{"mcpServers":{"paypal":{"command":"npx","args":["-y","@paypal/mcp","--tools=all"]}}}' });
  assert.ok(ids(b).includes('mcp-tools-all'));
  const c = await check({ mode: 'mcp', text: 'use list_product and list_transaction and create_payout' });
  assert.equal(ids(c).filter((x) => x === 'mcp-doc-typo').length, 2);
  assert.ok(ids(c).includes('mcp-tool-absent'));
});
