// The sandbox runner: sends a checked request to the PayPal sandbox, follows it to a terminal state, and compares what
// happened with what the checker predicted. Predicting a failure and then watching it fail is the product.
import { call as ppCall } from './paypal.js';
import { loadSpec, matchOp } from './spec.js';
import { productForPath } from './parse.js';
import { describePrediction } from './check.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL_ITEM = new Set(['SUCCESS', 'FAILED', 'UNCLAIMED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED']);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

export class GateError extends Error { constructor(m) { super(m); this.name = 'GateError'; } }

const DAILY_PAYOUT_CEILING = 60000;

/** What the runner will and will not send. Everything else is a refusal with a reason a person can act on. */
export async function gate(req, { text = '' } = {}) {
  const fail = (m) => { throw new GateError(m); };
  const body = req.body;
  const json = JSON.stringify(body ?? '');
  if (json.length > 64 * 1024) fail('The body is over 64 KB. Callcheck runs small requests only.');
  if (/"card"\s*:|"security_code"|"expiry"\s*:\s*"|"number"\s*:\s*"\d{12,19}"/.test(json)) fail('This request contains card data. Callcheck never sends cards, so it will not run this call.');
  const product = productForPath(req.path);
  if (!product) fail('This path is not one of the ten APIs Callcheck runs.');
  const spec = await loadSpec(product);
  const o = matchOp(spec.index, req.method, req.path);
  const hasFixture = /\{\{new_(order|invoice|plan|product)\}\}/.test(req.path);
  if (!o) {
    // An operation the schema does not define can only fail. It is sent only against a throwaway fixture, to prove it fails.
    if (hasFixture && ['PATCH', 'PUT', 'DELETE'].includes(req.method)) return { product, o: { method: req.method, path: req.path, unknown: true }, total: 0 };
    fail('The live schema has no such operation, so there is nothing to run. Apply the corrected call first.');
  }
  const m = req.method; const p = o.path; const read = m === 'GET';
  const fx = (id) => typeof id === 'string' && /^\{\{new_(order|invoice|plan|product)\}\}$/.test(id);
  if (/^\/v1\/customer\/disputes/.test(p) && !read) fail('Dispute writes are never run: accept-claim refunds the buyer, and the sandbox disputes here belong to other projects.');
  if (/^\/v1\/notifications\/webhooks/.test(p) && !read) {
    const host = (() => { try { return new URL(body?.url).hostname; } catch { return ''; } })();
    if (m === 'POST' && p === '/v1/notifications/webhooks' && /(^|\.)example\.com$/.test(host)) {
      const cnt = (await ppCall({ method: 'GET', path: '/v1/notifications/webhooks' })).body?.webhooks?.length ?? 10;
      if (cnt >= 9) fail(`The app already holds ${cnt} of its 10 webhooks. Callcheck leaves the last slots to the projects that own them.`);
    } else fail('The sandbox app is shared and its webhooks belong to other projects. Callcheck registers a webhook only for an example.com address, to prove PayPal\'s answer, and deletes it at once if PayPal accepts it.');
  }
  if (/^\/v2\/payments\//.test(p) && !read) fail('Captures, refunds and voids are not run: the ids belong to other projects.');
  if (/^\/v3\/vault\/payment-tokens/.test(p) && !read) fail('Payment tokens belong to other projects and are never deleted or created here. Setup tokens can be created.');
  if (/^\/v3\/vault\/setup-tokens$/.test(p) && m === 'POST' && body?.payment_source && !body.payment_source.paypal) fail('Only PayPal-wallet vaulting is run, never a card.');
  if (/^\/v2\/checkout\/orders\/\{id\}/.test(p) && !read && !fx(o.pathParams.id)) fail('Order actions run only on a fresh order. Use {{new_order}} as the id and Callcheck creates one first.');
  if (/^\/v2\/invoicing\/invoices\/\{/.test(p) && !read && !fx(o.pathParams.invoice_id ?? o.pathParams.id)) fail('Invoice actions run only on a fresh draft. Use {{new_invoice}} as the id and Callcheck creates one first.');
  if (/^\/v1\/billing\//.test(p) && !read) {
    const id = o.pathParams.id ?? o.pathParams.plan_id;
    const create = m === 'POST' && /^\/v1\/billing\/(plans|subscriptions)$/.test(p);
    if (!create && !(fx(id) && /^\/v1\/billing\/plans\//.test(p))) fail('Only creating plans and subscriptions is run, and changes to a plan only on a fresh one ({{new_plan}}). Existing objects belong to other projects.');
  }
  if (/^\/v1\/catalogs\/products/.test(p) && !read && !(m === 'POST' && p === '/v1/catalogs/products')) fail('Only creating a product is run.');
  if (/^\/v2\/invoicing\//.test(p) && !read && m !== 'POST' && m !== 'DELETE' && m !== 'PUT') fail('Only creating, deleting a fresh draft, searching and generating numbers run for invoices.');
  if (/^\/v2\/invoicing\/invoices\/\{[^}]+\}\/(send|remind|cancel|payments|refunds|cancel-reminders|conditional-rules)$/.test(p)) fail('Sending, reminding, cancelling and recording payments email sandbox accounts or change real invoices. Callcheck does not run them.');
  if (p === '/v1/payments/payouts-item/{payout_item_id}/cancel') fail('Cancelling is something Callcheck does itself to clean up its own payouts. It does not cancel items it did not create.');
  if (p === '/v1/payments/payouts' && m === 'POST') {
    const items = body?.items ?? [];
    if (items.length > 3) fail('Payout runs are limited to 3 items.');
    let total = 0;
    for (const it of items) {
      const v = Number(it?.amount?.value); total += Number.isFinite(v) ? v : 0;
      const receiver = String(it?.receiver ?? '');
      if (v > 25 && !/^callcheck-[a-z0-9-{}]+@example\.com$/.test(receiver)) fail('Items above 25 run only to a callcheck-...@example.com address, which holds the payment as unclaimed so it can be cancelled afterwards.');
      if (v > 20000.01) fail('Payout runs stop at 20,000.01 per item.');
    }
    if (total > 20100) fail('Payout runs stop at 20,100 in total.');
    return { product, o, total };
  }
  return { product, o, total: 0 };
}

/** Replace {{uniq}} and create the fixtures the placeholders ask for. */
export async function materialise(req, { env, fetchImpl, emit }) {
  const uniq = Math.random().toString(36).slice(2, 10);
  let text = JSON.stringify(req).replace(/\{\{uniq\}\}/g, uniq);
  const out = JSON.parse(text);
  const subst = (needle, val) => { out.path = out.path.replace(needle, val); for (const k of Object.keys(out.query ?? {})) out.query[k] = String(out.query[k]).replace(needle, val); out.body = out.body === undefined ? undefined : JSON.parse(JSON.stringify(out.body).replace(needle, val)); };
  const made = [];
  if (JSON.stringify(out).includes('{{new_order}}')) {
    const r = await ppCall({ method: 'POST', path: '/v2/checkout/orders', headers: { 'PayPal-Request-Id': `cc-fx-${uniq}` }, body: { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }] }, env, fetchImpl });
    if (r.status >= 300) throw new GateError(`Could not create the fresh order the placeholder needs (HTTP ${r.status}).`);
    subst(/\{\{new_order\}\}/g, r.body.id); made.push({ kind: 'order', id: r.body.id });
    emit?.({ t: 'fixture', text: `Created a fresh order ${r.body.id} for {{new_order}} (status ${r.body.status}).` });
  }
  if (JSON.stringify(out).includes('{{new_product}}') || JSON.stringify(out).includes('{{new_plan}}')) {
    const pr = await ppCall({ method: 'POST', path: '/v1/catalogs/products', headers: { 'PayPal-Request-Id': `cc-fxp-${uniq}` }, body: { name: `Callcheck fixture ${uniq}`, type: 'SERVICE', category: 'SERVICES' }, env, fetchImpl });
    if (pr.status >= 300) throw new GateError(`Could not create the fresh product the placeholder needs (HTTP ${pr.status}).`);
    subst(/\{\{new_product\}\}/g, pr.body.id); made.push({ kind: 'product', id: pr.body.id });
    emit?.({ t: 'fixture', text: `Created a fresh product ${pr.body.id} for {{new_product}}.` });
    if (JSON.stringify(out).includes('{{new_plan}}')) {
      const cyc = { frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: '5', currency_code: 'USD' } } };
      const pl = await ppCall({ method: 'POST', path: '/v1/billing/plans', headers: { 'PayPal-Request-Id': `cc-fxpl-${uniq}` }, body: { product_id: pr.body.id, name: `Callcheck fixture plan ${uniq}`, billing_cycles: [cyc], payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 } }, env, fetchImpl });
      if (pl.status >= 300) throw new GateError(`Could not create the fresh plan the placeholder needs (HTTP ${pl.status}).`);
      subst(/\{\{new_plan\}\}/g, pl.body.id); made.push({ kind: 'plan', id: pl.body.id });
      emit?.({ t: 'fixture', text: `Created a fresh plan ${pl.body.id} for {{new_plan}}.` });
    }
  }
  if (JSON.stringify(out).includes('{{new_invoice}}')) {
    const r = await ppCall({ method: 'POST', path: '/v2/invoicing/invoices', body: { detail: { invoice_number: `CCFX-${uniq}`.toUpperCase(), currency_code: 'USD' }, invoicer: { business_name: 'Callcheck fixture' }, primary_recipients: [{ billing_info: { email_address: 'sb-patient@personal.example.com' } }], items: [{ name: 'Fixture', quantity: '1', unit_amount: { currency_code: 'USD', value: '1.00' } }] }, env, fetchImpl });
    if (r.status >= 300) throw new GateError(`Could not create the fresh invoice the placeholder needs (HTTP ${r.status}).`);
    const id = r.body.href.split('/').pop(); subst(/\{\{new_invoice\}\}/g, id); made.push({ kind: 'invoice', id });
    emit?.({ t: 'fixture', text: `Created a draft invoice ${id} for {{new_invoice}}.` });
  }
  return { req: out, uniq, made };
}

export function summariseResponse(res) {
  const b = res.body && typeof res.body === 'object' ? res.body : {};
  const d = Array.isArray(b.details) ? b.details[0] : undefined;
  return { status: res.status, name: b.name, issue: d?.issue, description: d?.description ?? b.message, resourceStatus: b.status ?? b.batch_header?.batch_status, id: b.id ?? b.batch_header?.payout_batch_id ?? (typeof b.href === 'string' ? b.href.split('/').pop() : undefined), ms: res.ms, debugId: res.debugId, links: Array.isArray(b.links) ? b.links.map((l) => l.rel).filter(Boolean) : undefined };
}

/** Poll a payout batch until its item reaches a terminal status. */
async function pollPayout(batchId, { env, fetchImpl, emit, maxMs = 50000, sleepMs = 4000 }) {
  const t0 = Date.now(); let last;
  for (let i = 1; ; i++) {
    const r = await ppCall({ method: 'GET', path: `/v1/payments/payouts/${batchId}`, env, fetchImpl });
    last = r.body;
    const batch = last?.batch_header?.batch_status; const items = last?.items ?? [];
    const item = items[0]?.transaction_status;
    emit?.({ t: 'poll', n: i, text: `GET payouts/${batchId}: batch ${batch ?? '?'}, item ${item ?? '?'}`, batch, item });
    const done = batch && !['PENDING', 'PROCESSING'].includes(batch) && items.length && items.every((x) => TERMINAL_ITEM.has(x.transaction_status));
    if (done || Date.now() - t0 > maxMs) break;
    await sleep(sleepMs);
  }
  const items = last?.items ?? [];
  return { batch: last?.batch_header?.batch_status, item: items[0]?.transaction_status, error: items[0]?.errors?.name, itemId: items[0]?.payout_item_id, items: items.map((x) => ({ id: x.payout_item_id, status: x.transaction_status, error: x.errors?.name })), settled: !!items.length && items.every((x) => TERMINAL_ITEM.has(x.transaction_status)), waitedMs: Date.now() - t0 };
}

export function matchesIssue(expected, res) {
  const issues = [...(Array.isArray(res.body?.details) ? res.body.details : [])].flatMap((d) => [d.issue, d.description]).filter(Boolean);
  if (expected && typeof expected === 'object' && expected.pattern) { const re = new RegExp(expected.pattern, expected.flags); return issues.some((i) => re.test(i)) || re.test(String(res.body?.message ?? '')); }
  return issues.includes(expected);
}

/** Does what happened match what was predicted? */
export function compare(pred, obs, first) {
  if (!pred) return { ok: null, checks: [], note: 'No prediction was made for this step.' };
  const checks = [];
  const add = (what, ok, detail) => checks.push({ what, ok, detail });
  if (pred.status != null) { const want = [].concat(pred.status); add('HTTP status', want.includes(obs.status), `predicted ${want.join(' or ')}, observed ${obs.status}`); }
  if (pred.name) add('error name', obs.name === pred.name, `predicted ${pred.name}, observed ${obs.name ?? 'none'}`);
  if (pred.issue) add('issue', matchesIssue(pred.issue, obs.raw), `predicted ${typeof pred.issue === 'string' ? pred.issue : pred.issue.pattern}, observed ${obs.issue ?? 'none'}`);
  if (pred.body) for (const [k, v] of Object.entries(pred.body)) add(`body.${k}`, obs.raw?.body?.[k] === v, `predicted ${v}, observed ${obs.raw?.body?.[k] ?? 'none'}`);
  if (pred.terminal) {
    const t = obs.terminal;
    if (!t) add('payout outcome', false, 'no terminal state was reached');
    else {
      if (pred.terminal.batch) add('batch status', t.batch === pred.terminal.batch, `predicted ${pred.terminal.batch}, observed ${t.batch}`);
      if (pred.terminal.item) add('item status', t.item === pred.terminal.item, `predicted ${pred.terminal.item}, observed ${t.item}`);
      if (pred.terminal.error) add('item error', t.error === pred.terminal.error, `predicted ${pred.terminal.error}, observed ${t.error ?? 'none'}`);
    }
  }
  if (pred.sameResourceAsAttempt1 !== undefined && first) {
    const same = !!obs.id && obs.id === first.id;
    add(pred.sameResourceAsAttempt1 ? 'same resource as first send' : 'a second resource', pred.sameResourceAsAttempt1 ? same : !!obs.id && !same, `first ${first.id ?? 'none'}, this send ${obs.id ?? 'none'}`);
  }
  return { ok: checks.length ? checks.every((c) => c.ok) : null, checks };
}

/**
 * @param {{ request: object, predictions: {first, second}, repeat?: 1|2, text?: string }} input
 * @param {{ env?: object, fetchImpl?: Function, emit?: (e: object) => void }} deps
 */
export async function runRequest(input, deps = {}) {
  const { env = process.env, fetchImpl = fetch, emit = () => {} } = deps;
  const g = await gate(input.request, { text: input.text });
  const { req, uniq, made } = await materialise(input.request, { env, fetchImpl, emit });
  const repeat = input.repeat === 2 ? 2 : 1;
  const attempts = [];
  const cleanup = [];
  for (let n = 1; n <= repeat; n++) {
    const sendReq = clone(req);
    if (n === 2 && g.product === 'orders' && sendReq.method === 'POST' && sendReq.body?.purchase_units?.[0]?.amount?.value) {
      const v = Number(sendReq.body.purchase_units[0].amount.value);
      if (Number.isFinite(v) && input.repeatMode === 'changed') { sendReq.body.purchase_units[0].amount.value = (v + 1).toFixed(2); emit({ t: 'note', text: 'Second send changes the amount by +1.00 and keeps the same PayPal-Request-Id.' }); }
    }
    const headers = Object.fromEntries(Object.entries(sendReq.headers ?? {}).filter(([k]) => !/^(authorization|host|content-length|connection)$/i.test(k)));
    let sendBody = sendReq.body;
    if (sendReq.implicitForm) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; sendBody = sendReq.rawBody ?? JSON.stringify(sendReq.body); emit({ t: 'note', text: 'curl sends -d bodies as application/x-www-form-urlencoded unless told otherwise, so that is what is sent here.' }); }
    emit({ t: 'send', n, text: `${sendReq.method} ${sendReq.path}` });
    const res = await ppCall({ method: sendReq.method, path: sendReq.path, query: sendReq.query, headers, body: sendBody, env, fetchImpl });
    const sum = summariseResponse(res);
    emit({ t: 'response', n, text: `HTTP ${sum.status}${sum.name ? ' ' + sum.name : ''}${sum.issue ? ' / ' + sum.issue : ''}${sum.resourceStatus ? ' (' + sum.resourceStatus + ')' : ''}`, status: sum.status });
    const attempt = { n, request: { method: sendReq.method, path: sendReq.path, query: sendReq.query, headers, body: sendReq.body }, response: sum, raw: res };
    if (g.o.path === '/v1/payments/payouts' && sendReq.method === 'POST' && res.status >= 200 && res.status < 300 && res.body?.batch_header?.payout_batch_id) {
      attempt.terminal = await pollPayout(res.body.batch_header.payout_batch_id, { env, fetchImpl, emit });
      attempt.batchId = res.body.batch_header.payout_batch_id;
      for (const it of attempt.terminal.items) if (it.status === 'UNCLAIMED' && it.id && !cleanup.includes(it.id)) cleanup.push(it.id);
    }
    attempts.push(attempt);
    if (n === 1 && repeat === 2 && !(res.status >= 200 && res.status < 300)) { emit({ t: 'note', text: 'The first send failed, so a second send would only repeat the failure. It was not made.' }); break; }
    if (g.o.path === '/v1/notifications/webhooks' && sendReq.method === 'POST' && res.status >= 200 && res.status < 300 && res.body?.id) {
      const del = await ppCall({ method: 'DELETE', path: `/v1/notifications/webhooks/${res.body.id}`, env, fetchImpl });
      emit({ t: 'cleanup', text: `PayPal accepted the test webhook, so it was deleted at once (HTTP ${del.status}).` });
    }
  }
  for (const f of made) if (f.kind === 'invoice') {
    const del = await ppCall({ method: 'DELETE', path: `/v2/invoicing/invoices/${f.id}`, env, fetchImpl });
    emit({ t: 'cleanup', text: `Deleted the fixture draft invoice ${f.id} (HTTP ${del.status}).` });
  }
  for (const id of cleanup) {
    const r = await ppCall({ method: 'POST', path: `/v1/payments/payouts-item/${id}/cancel`, env, fetchImpl });
    emit({ t: 'cleanup', text: `Cancelled unclaimed item ${id} so the money returns to the sender (HTTP ${r.status}).` });
  }
  const verdicts = [];
  const v1 = compare(input.predictions?.first, { ...attempts[0].response, raw: attempts[0].raw, terminal: attempts[0].terminal }, null);
  verdicts.push({ attempt: 1, predicted: input.predictions?.first?.text ?? null, observed: observedText(attempts[0]), ...v1 });
  if (attempts.length === 2) {
    const pred2 = input.predictions?.second;
    const v2 = compare(pred2, { ...attempts[1].response, raw: attempts[1].raw, terminal: attempts[1].terminal }, attempts[0].response);
    verdicts.push({ attempt: 2, predicted: pred2?.text ?? null, observed: observedText(attempts[1]), ...v2 });
  }
  const strip = (a) => { const { raw, ...rest } = a; return { ...rest, response: { ...a.response, body: trimBody(raw.body) } }; };
  return { uniq, fixtures: made, attempts: attempts.map(strip), verdicts, cleanedUp: cleanup, product: g.product, op: { method: g.o.method, path: g.o.path } };
}

function trimBody(b) { const s = JSON.stringify(b ?? null); return s.length > 4000 ? { truncated: true, preview: s.slice(0, 4000) } : b; }

export function observedText(a) {
  const r = a.response;
  let s = `HTTP ${r.status}`;
  if (r.name) s += ` ${r.name}`;
  if (r.issue) s += ` (${r.issue})`;
  if (!r.name && r.resourceStatus) s += `, status ${r.resourceStatus}`;
  if (a.terminal) s += `, then item ${a.terminal.item}${a.terminal.error ? ` (${a.terminal.error})` : ''} in batch ${a.terminal.batch}`;
  return s;
}

export { describePrediction };
