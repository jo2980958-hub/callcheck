// Sandbox probes. Each probe records the exact request and response so the trap catalogue cites real output.
// Usage: node scripts/probe.mjs [group ...]   groups: payouts invoices orders vault subs misc mcp
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(fs.readFileSync(path.join(here, '../../../.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = env.PAYPAL_API;
const OUT = path.join(here, '../evidence/probes');
fs.mkdirSync(OUT, { recursive: true });
const stamp = Date.now().toString(36);
let tok;
async function token() {
  if (tok) return tok;
  const r = await fetch(API + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  tok = (await r.json()).access_token; return tok;
}
export async function pp(method, p, body, headers = {}) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json, debug: r.headers.get('paypal-debug-id') };
}
const log = [];
async function probe(id, claim, method, p, body, headers) {
  const res = await pp(method, p, body, headers);
  const rec = { id, claim, request: { method, path: p, headers: headers ?? {}, body }, response: res, at: new Date().toISOString() };
  log.push(rec);
  const brief = typeof res.body === 'object' && res.body ? (res.body.name ? `${res.body.name}${res.body.details?.[0]?.issue ? ' / ' + res.body.details[0].issue : ''}` : (res.body.batch_header?.batch_status || res.body.status || res.body.id || '')) : String(res.body).slice(0, 80);
  console.log(`${String(res.status).padEnd(4)} ${id.padEnd(34)} ${brief}`);
  return rec;
}
async function poll(id, batchId, tries = 14) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await pp('GET', `/v1/payments/payouts/${batchId}`);
    last = r.body; const it = last?.items?.[0];
    const done = last?.batch_header?.batch_status && !['PENDING', 'PROCESSING'].includes(last.batch_header.batch_status) && (!it || !['PENDING', 'ONHOLD'].includes(it.transaction_status));
    if (done) break; await new Promise((r2) => setTimeout(r2, 4000));
  }
  const it = last?.items?.[0];
  const summary = { batch_status: last?.batch_header?.batch_status, item_status: it?.transaction_status, item_errors: it?.errors?.name, fee: last?.batch_header?.fees };
  log.push({ id: id + '.poll', claim: 'terminal state', request: { method: 'GET', path: `/v1/payments/payouts/${batchId}` }, response: { status: 200, body: summary } });
  console.log(`     ${id.padEnd(34)} -> ${JSON.stringify(summary)}`);
  return summary;
}
const payout = (batch, items, extra = {}) => ({ sender_batch_header: { sender_batch_id: batch, email_subject: 'Callcheck probe', ...extra }, items });
const item = (receiver, value = '1.00', currency = 'USD', type = 'EMAIL', note = 'callcheck probe') => ({ recipient_type: type, amount: { value, currency }, receiver, note, sender_item_id: 'it-' + Math.random().toString(36).slice(2, 8) });
const REG = 'sb-patient@personal.example.com';
const groups = {
  async payouts() {
    const b1 = `cc-${stamp}-a`;
    const a = await probe('payout.create.ok', '201 is only acceptance', 'POST', '/v1/payments/payouts', payout(b1, [item(REG)]), { 'PayPal-Request-Id': b1 });
    const batchId = a.response.body?.batch_header?.payout_batch_id;
    await probe('payout.dup-batch-id.same-request-id', 'duplicate sender_batch_id -> 400', 'POST', '/v1/payments/payouts', payout(b1, [item(REG)]), { 'PayPal-Request-Id': b1 });
    await probe('payout.dup-batch-id.new-request-id', 'duplicate sender_batch_id -> 400 regardless of request id', 'POST', '/v1/payments/payouts', payout(b1, [item(REG)]), { 'PayPal-Request-Id': b1 + '-other' });
    const b2 = `cc-${stamp}-b`;
    const r1 = await probe('payout.request-id-only.first', 'Request-Id alone does not dedupe a payout', 'POST', '/v1/payments/payouts', payout(b2, [item(REG)]), { 'PayPal-Request-Id': `rid-${stamp}` });
    const r2 = await probe('payout.request-id-only.second', 'same Request-Id, new sender_batch_id', 'POST', '/v1/payments/payouts', payout(b2 + '-2', [item(REG)]), { 'PayPal-Request-Id': `rid-${stamp}` });
    console.log('     same request id gave', r1.response.body?.batch_header?.payout_batch_id, 'then', r2.response.body?.batch_header?.payout_batch_id);
    const un = await probe('payout.unregistered', 'batch SUCCESS while item UNCLAIMED', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-c`, [item(`callcheck-nobody-${stamp}@example.com`)]));
    const gbp = await probe('payout.gbp', 'GBP settles', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-d`, [item(REG, '1.00', 'GBP')]));
    await probe('payout.brl', 'non-holding currency', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-e`, [item(REG, '1.00', 'BRL')]));
    await probe('payout.mixed-currency', 'mixed currency batch', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-f`, [item(REG, '1.00', 'USD'), item(REG, '1.00', 'GBP')]));
    await probe('payout.type.user-handle', 'USER_HANDLE not in enum', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-g`, [item(REG, '1.00', 'USD', 'USER_HANDLE')]));
    await probe('payout.type.venmo-handle', 'VENMO_HANDLE not in enum', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-h`, [item(REG, '1.00', 'USD', 'VENMO_HANDLE')]));
    await probe('payout.type.bogus', 'bogus type', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-i`, [item(REG, '1.00', 'USD', 'BOGUS')]));
    const sp = await probe('payout.self-pay', 'paying the sender account', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-j`, [item('sb-mixsn53098231@business.example.com')]));
    const cap = await probe('payout.cap.20000.01', 'per-item cap not enforced in sandbox', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-k`, [item(`callcheck-cap-${stamp}@example.com`, '20000.01')]));
    await probe('payout.bad-receiver', 'malformed receiver', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-l`, [item('not-an-email')]));
    await probe('payout.magic.ERRPYO005', 'magic note forces INSUFFICIENT_FUNDS', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-m`, [item(REG, '1.00', 'USD', 'EMAIL', 'ERRPYO005')]));
    await probe('payout.no-batch-id', 'sender_batch_id is optional', 'POST', '/v1/payments/payouts', { sender_batch_header: { email_subject: 'Callcheck probe' }, items: [item(REG)] });
    const polled = {};
    if (batchId) polled.ok = await poll('payout.create.ok', batchId);
    if (un.response.body?.batch_header) polled.un = await poll('payout.unregistered', un.response.body.batch_header.payout_batch_id);
    if (gbp.response.body?.batch_header) polled.gbp = await poll('payout.gbp', gbp.response.body.batch_header.payout_batch_id);
    if (sp.response.body?.batch_header) polled.sp = await poll('payout.self-pay', sp.response.body.batch_header.payout_batch_id);
    if (cap.response.body?.batch_header) {
      const c = await poll('payout.cap.20000.01', cap.response.body.batch_header.payout_batch_id);
      const g = await pp('GET', `/v1/payments/payouts/${cap.response.body.batch_header.payout_batch_id}`);
      const iid = g.body?.items?.[0]?.payout_item_id;
      if (iid && c.item_status === 'UNCLAIMED') await probe('payout.cancel-unclaimed', 'cancel while UNCLAIMED', 'POST', `/v1/payments/payouts-item/${iid}/cancel`, undefined);
    }
  },
  async invoices() {
    const num = `CC-${stamp}`.toUpperCase();
    const inv = (n, extra = {}) => ({ detail: { invoice_number: n, currency_code: 'USD', ...extra }, invoicer: { business_name: 'Callcheck Probe' }, primary_recipients: [{ billing_info: { email_address: REG } }], items: [{ name: 'Probe', quantity: '1', unit_amount: { currency_code: 'USD', value: '5.00' } }] });
    const a = await probe('invoice.create', 'create returns href only', 'POST', '/v2/invoicing/invoices', inv(num));
    await probe('invoice.dup-number', 'duplicate invoice_number -> 422', 'POST', '/v2/invoicing/invoices', inv(num));
    await probe('invoice.number-26', 'invoice_number > 25 chars', 'POST', '/v2/invoicing/invoices', inv('X'.repeat(26)));
    const gen = await probe('invoice.generate-number', 'generated number', 'POST', '/v2/invoicing/generate-next-invoice-number', {});
    const id = a.response.body?.href?.split('/').pop();
    if (id) {
      await probe('invoice.patch', 'no PATCH on invoices', 'PATCH', `/v2/invoicing/invoices/${id}`, [{ op: 'replace', path: '/detail/note', value: 'x' }]);
      await probe('invoice.qr-before-send', 'QR needs a sent invoice', 'POST', `/v2/invoicing/invoices/${id}/generate-qr-code`, { width: 200, height: 200 });
      await probe('invoice.delete-draft', 'draft delete works', 'DELETE', `/v2/invoicing/invoices/${id}`);
    }
    await probe('invoice.mock-header', 'PayPal-Mock-Response is ignored on Invoicing', 'POST', '/v2/invoicing/invoices', inv(`CC-${stamp}-M`.toUpperCase()), { 'PayPal-Mock-Response': '{"mock_application_codes":"DUPLICATE_INVOICE_ID"}' });
    await probe('invoice.too-many-items', 'items > 100', 'POST', '/v2/invoicing/invoices', { ...inv(`CC-${stamp}-N`.toUpperCase()), items: Array.from({ length: 101 }, (_, i) => ({ name: 'i' + i, quantity: '1', unit_amount: { currency_code: 'USD', value: '1.00' } })) });
  },
  async orders() {
    const ord = (extra = {}, pu = {}) => ({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '10.00' }, ...pu }], ...extra });
    const rid = `rid-o-${stamp}`;
    const a = await probe('order.create', 'wallet order needs a browser approval', 'POST', '/v2/checkout/orders', ord(), { 'PayPal-Request-Id': rid });
    const a2 = await probe('order.create.same-rid', 'same Request-Id replays the first response', 'POST', '/v2/checkout/orders', ord(), { 'PayPal-Request-Id': rid });
    console.log('     replay same id?', a.response.body?.id, a2.response.body?.id);
    await probe('order.create.same-rid.diff-body', 'same Request-Id, different body', 'POST', '/v2/checkout/orders', ord({}, { amount: { currency_code: 'USD', value: '11.00' } }), { 'PayPal-Request-Id': rid });
    await probe('order.amount-mismatch', 'breakdown must sum', 'POST', '/v2/checkout/orders', ord({}, { amount: { currency_code: 'USD', value: '10.00', breakdown: { item_total: { currency_code: 'USD', value: '8.00' } } } }));
    await probe('order.jpy-decimals', 'zero-decimal currency', 'POST', '/v2/checkout/orders', ord({}, { amount: { currency_code: 'JPY', value: '10.50' } }));
    await probe('order.value-number', 'value must be a string', 'POST', '/v2/checkout/orders', ord({}, { amount: { currency_code: 'USD', value: 10 } }));
    await probe('order.bad-intent', 'unknown intent', 'POST', '/v2/checkout/orders', ord({ intent: 'CAPTUR' }));
    await probe('order.wallet-source', 'wallet create with payment_source returns 200', 'POST', '/v2/checkout/orders', ord({ payment_source: { paypal: { experience_context: { return_url: 'https://example.com/r', cancel_url: 'https://example.com/c' } } } }), { 'PayPal-Request-Id': rid + '-w' });
    await probe('order.mock-header', 'PayPal-Mock-Response works on Orders', 'POST', '/v2/checkout/orders', ord(), { 'PayPal-Mock-Response': '{"mock_application_codes":"INSTRUMENT_DECLINED"}' });
    if (a.response.body?.id) {
      await probe('order.capture-unapproved', 'capture before approval -> 422', 'POST', `/v2/checkout/orders/${a.response.body.id}/capture`, {}, { 'PayPal-Request-Id': rid + '-cap' });
      await probe('order.authorize-unapproved', 'authorize before approval -> 422', 'POST', `/v2/checkout/orders/${a.response.body.id}/authorize`, {});
    }
    await probe('order.missing-purchase-units', 'required field', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE' });
  },
  async vault() {
    const ps = { payment_source: { paypal: { usage_type: 'MERCHANT', customer_type: 'CONSUMER', experience_context: { return_url: 'https://example.com/r', cancel_url: 'https://example.com/c' } } } };
    const st = await probe('vault.setup-token.wallet', 'wallet setup token works', 'POST', '/v3/vault/setup-tokens', ps, { 'PayPal-Request-Id': `rid-v-${stamp}` });
    await probe('vault.setup-token.missing-urls', 'wallet needs experience_context urls?', 'POST', '/v3/vault/setup-tokens', { payment_source: { paypal: { usage_type: 'MERCHANT' } } });
    await probe('vault.payment-token.patch', 'no update endpoint', 'PATCH', '/v3/vault/payment-tokens/doesnotexist', []);
    await probe('vault.payment-token.get-missing', 'unknown token', 'GET', '/v3/vault/payment-tokens/doesnotexist');
    if (st.response.body?.id) await probe('vault.setup-token.get', 'status PAYER_ACTION_REQUIRED until buyer approves', 'GET', `/v3/vault/setup-tokens/${st.response.body.id}`);
  },
  async subs() {
    await probe('catalog.product.healthcare', 'category restrictions', 'POST', '/v1/catalogs/products', { name: 'Callcheck probe ' + stamp, type: 'SERVICE', category: 'HEALTHCARE' });
    const p = await probe('catalog.product.services', 'category SERVICES accepted', 'POST', '/v1/catalogs/products', { name: 'Callcheck probe ' + stamp, type: 'SERVICE', category: 'SERVICES' }, { 'PayPal-Request-Id': `rid-p-${stamp}` });
    const pid = p.response.body?.id;
    const cyc = (seq, tenure, total) => ({ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: tenure, sequence: seq, total_cycles: total, pricing_scheme: { fixed_price: { value: '5', currency_code: 'USD' } } });
    if (pid) {
      await probe('plan.infinite-trial', 'total_cycles 0 only on REGULAR', 'POST', '/v1/billing/plans', { product_id: pid, name: 'cc trial inf', billing_cycles: [cyc(1, 'TRIAL', 0), cyc(2, 'REGULAR', 0)], payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 } });
      await probe('plan.no-regular', 'exactly one REGULAR', 'POST', '/v1/billing/plans', { product_id: pid, name: 'cc no regular', billing_cycles: [cyc(1, 'TRIAL', 1)], payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 } });
      const pl = await probe('plan.ok', 'plan created', 'POST', '/v1/billing/plans', { product_id: pid, name: 'cc plan ' + stamp, billing_cycles: [cyc(1, 'REGULAR', 0)], payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 } }, { 'PayPal-Request-Id': `rid-pl-${stamp}` });
      if (pl.response.body?.id) {
        await probe('plan.patch-cycles', 'billing_cycles not patchable', 'PATCH', `/v1/billing/plans/${pl.response.body.id}`, [{ op: 'replace', path: '/billing_cycles/0/total_cycles', value: 5 }]);
        const sub = await probe('subscription.create', 'subscription needs buyer approval', 'POST', '/v1/billing/subscriptions', { plan_id: pl.response.body.id, application_context: { return_url: 'https://example.com/r', cancel_url: 'https://example.com/c' } }, { 'PayPal-Request-Id': `rid-s-${stamp}` });
        if (sub.response.body?.id) await probe('subscription.activate-pending', 'activate before approval', 'POST', `/v1/billing/subscriptions/${sub.response.body.id}/activate`, { reason: 'probe' });
      }
    }
  },
  async misc() {
    const iso = (d) => new Date(d).toISOString().replace(/\.\d+Z$/, 'Z').replace('Z', '-0000');
    await probe('txn-search.403', 'reporting 403', 'GET', `/v1/reporting/transactions?start_date=${encodeURIComponent('2026-09-20T00:00:00-0000')}&end_date=${encodeURIComponent('2026-09-25T00:00:00-0000')}`);
    await probe('txn-search.window-32d', 'window > 31 days', 'GET', `/v1/reporting/transactions?start_date=${encodeURIComponent('2026-08-01T00:00:00-0000')}&end_date=${encodeURIComponent('2026-09-25T00:00:00-0000')}`);
    await probe('disputes.list', 'sandbox has zero disputes', 'GET', '/v1/customer/disputes');
    await probe('disputes.invented-id', 'invented id collides', 'GET', '/v1/customer/disputes/PP-D-48201');
    await probe('disputes.unknown-id', 'unknown id 404', 'GET', '/v1/customer/disputes/PP-D-999999999999');
    const ev = await pp('GET', '/v1/notifications/webhooks-event-types');
    const names = (ev.body?.event_types ?? []).map((e) => e.name);
    log.push({ id: 'webhooks.event-types', claim: 'event-type catalogue', response: { status: ev.status, body: { count: names.length, payouts: names.filter((n) => /PAYOUTS/.test(n)), invoicing: names.filter((n) => /^INVOICING/.test(n)) } } });
    console.log(ev.status, 'webhooks.event-types', names.length, 'names;', names.filter((n) => /PAYOUTS/.test(n)).join(','));
    await probe('webhook.bad-event-name', 'PAYMENT.PAYOUTS-ITEM.SUCCESS does not exist', 'POST', '/v1/notifications/webhooks', { url: 'https://example.com/hook', event_types: [{ name: 'PAYMENT.PAYOUTS-ITEM.SUCCESS' }] });
    await probe('webhook.http-url', 'http url rejected', 'POST', '/v1/notifications/webhooks', { url: 'http://example.com/hook', event_types: [{ name: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' }] });
    await probe('webhook.verify-simulator', 'simulator events cannot verify', 'POST', '/v1/notifications/verify-webhook-signature', { auth_algo: 'SHA256withRSA', cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-x', transmission_id: 'x', transmission_sig: 'x', transmission_time: new Date().toISOString(), webhook_id: 'WEBHOOK_ID', webhook_event: {} });
    const list = await pp('GET', '/v1/notifications/webhooks');
    log.push({ id: 'webhooks.count', claim: 'slots used', response: { status: list.status, body: { count: list.body?.webhooks?.length } } });
    console.log('     webhook slots used:', list.body?.webhooks?.length, 'of 10');
  },
  async extra() {
    const b = { sender_batch_header: { email_subject: 'Callcheck probe' }, items: [item(REG)] };
    const n1 = await probe('payout.no-batch-id.first', 'no sender_batch_id: first send', 'POST', '/v1/payments/payouts', { ...b, items: [{ ...b.items[0], sender_item_id: 'same-item' }] });
    const n2 = await probe('payout.no-batch-id.second', 'no sender_batch_id: identical retry creates a second batch', 'POST', '/v1/payments/payouts', { ...b, items: [{ ...b.items[0], sender_item_id: 'same-item' }] });
    console.log('     two batches?', n1.response.body?.batch_header?.payout_batch_id, n2.response.body?.batch_header?.payout_batch_id);
    const ph = await probe('payout.phone', 'PHONE type in sandbox', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-ph`, [item('+14085551234', '1.00', 'USD', 'PHONE')]));
    await probe('payout.item-over-batch-type', 'recipient_type PAYPAL_ID with an email', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-pid`, [item('someone@example.com', '1.00', 'USD', 'PAYPAL_ID')]));
    await probe('order.wallet-source.no-request-id', 'wallet order without PayPal-Request-Id', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '10.00' } }], payment_source: { paypal: { experience_context: { return_url: 'https://example.com/r', cancel_url: 'https://example.com/c' } } } });
    await probe('order.usd-3dp', 'three decimals on USD', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '10.005' } }] });
    const form = await fetch(API + '/v2/checkout/orders', { method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/x-www-form-urlencoded' }, body: '{"intent":"CAPTURE"}' });
    log.push({ id: 'generic.content-type-form', claim: 'curl -d without a JSON content type', request: { method: 'POST', path: '/v2/checkout/orders', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, response: { status: form.status, body: await form.json().catch(() => null) } });
    console.log(form.status, 'generic.content-type-form');
    await probe('invoice.search-by-number', 'adopt an existing invoice by number', 'POST', '/v2/invoicing/search-invoices', { invoice_number: 'CC-DOESNOTEXIST' });
    const sched = await probe('catalog.product.category-list', 'category enum', 'GET', '/v1/catalogs/products?page_size=1');
    const uniq = stamp + 'x';
    const inv = (n) => ({ detail: { invoice_number: n, currency_code: 'USD' }, invoicer: { business_name: 'Callcheck Probe' }, primary_recipients: [{ billing_info: { email_address: REG } }], items: [{ name: 'Probe', quantity: '1', unit_amount: { currency_code: 'USD', value: '5.00' } }] });
    await probe('invoice.no-number', 'invoice number auto-assigned', 'POST', '/v2/invoicing/invoices', { ...inv('x'), detail: { currency_code: 'USD' } });
    await probe('txn-search.no-dates', 'missing dates', 'GET', '/v1/reporting/transactions');
    await probe('txn-search.scope-balances', 'balances endpoint', 'GET', '/v1/reporting/balances');
    if (ph.response.body?.batch_header) await poll('payout.phone', ph.response.body.batch_header.payout_batch_id);
  },
  async more() {
    const pid = await probe('payout.paypal-id.bogus13', 'PAYPAL_ID that looks right but is not an account', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-q`, [item('ABCDEFGHJKLMN', '1.00', 'USD', 'PAYPAL_ID')]));
    await probe('payout.paypal-id.short', 'PAYPAL_ID that is the wrong shape', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-r`, [item('ABC', '1.00', 'USD', 'PAYPAL_ID')]));
    const uh = await probe('payout.user-handle.handle', 'USER_HANDLE with a Venmo-style handle', 'POST', '/v1/payments/payouts', payout(`cc-${stamp}-s`, [item('@callcheck-nobody', '1.00', 'USD', 'USER_HANDLE')]));
    const inv = (n) => ({ detail: { invoice_number: n, currency_code: 'USD' }, invoicer: { business_name: 'Callcheck Probe' }, primary_recipients: [{ billing_info: { email_address: REG } }], items: [{ name: 'Probe', quantity: '1', unit_amount: { currency_code: 'USD', value: '5.00' } }] });
    const rid = `rid-inv-${stamp}`;
    const a = await probe('invoice.request-id.first', 'Request-Id on invoice create', 'POST', '/v2/invoicing/invoices', inv(`CC-${stamp}-R1`.toUpperCase()), { 'PayPal-Request-Id': rid });
    const b = await probe('invoice.request-id.second', 'same Request-Id, new invoice number', 'POST', '/v2/invoicing/invoices', inv(`CC-${stamp}-R2`.toUpperCase()), { 'PayPal-Request-Id': rid });
    console.log('     same request id gave', a.response.body?.href?.split('/').pop(), 'then', b.response.body?.href?.split('/').pop());
    for (const r of [a, b]) { const id = r.response.body?.href?.split('/').pop(); if (id) await pp('DELETE', `/v2/invoicing/invoices/${id}`); }
    if (pid.response.body?.batch_header) await poll('payout.paypal-id.bogus13', pid.response.body.batch_header.payout_batch_id);
    if (uh.response.body?.batch_header) await poll('payout.user-handle.handle', uh.response.body.batch_header.payout_batch_id);
  },
  async mcp() {
    for (const host of ['mcp.sandbox.paypal.com', 'mcp.paypal.com']) {
      for (const p of ['/http', '/mcp', '/sse', '/.well-known/oauth-authorization-server']) {
        const t0 = Date.now(); const r = await fetch(`https://${host}${p}`, { method: p === '/sse' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: p === '/sse' ? undefined : '{}' }).catch((e) => ({ status: 'ERR ' + e.message, text: async () => '' }));
        const txt = (await r.text()).slice(0, 120);
        log.push({ id: `mcp.${host}${p}`, claim: 'mcp path probe', response: { status: r.status, body: txt }, at: new Date().toISOString() });
        console.log(String(r.status).padEnd(4), `${host}${p}`.padEnd(70), txt.replace(/\s+/g, ' ').slice(0, 60), Date.now() - t0 + 'ms');
      }
    }
    const gh = await (await fetch('https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/invoicing_v2.json')).json();
    const live = await (await fetch('https://developer.paypal.com/api/invoicing/v2/schema.json')).json();
    const sum = { github: { version: gh.info.version, paths: Object.keys(gh.paths).length }, live: { version: live.info.version, paths: Object.keys(live.paths).length } };
    log.push({ id: 'spec.invoicing.github-vs-live', response: { status: 200, body: sum } });
    console.log('invoicing github vs live', JSON.stringify(sum));
  },
};
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(groups);
for (const g of want) {
  console.log(`\n## ${g}`);
  try { await groups[g](); } catch (e) { console.log('group failed', g, e.message); }
  fs.writeFileSync(path.join(OUT, `${g}.json`), JSON.stringify(log.splice(0), null, 2));
}
