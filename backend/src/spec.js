// Live PayPal OpenAPI schemas: fetch from developer.paypal.com, index operations, resolve $refs.
// Source of truth is https://developer.paypal.com/api/<product>/<version>/schema.json. A bundled snapshot is a
// labelled fallback for when that host is unreachable; it is never presented as live.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = process.env.SNAPSHOT_DIR || path.join(here, '../snapshots');
const GH_RAW = 'https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi/';
const TTL_MS = 6 * 3600_000;

/** Products Callcheck understands. `slug` is the live route, `gh` the file in the GitHub mirror (null: not mirrored). */
export const PRODUCTS = {
  orders: { label: 'Orders', slug: 'orders/v2', gh: 'checkout_orders_v2.json' },
  payments: { label: 'Payments', slug: 'payments/v2', gh: 'payments_payment_v2.json' },
  payouts: { label: 'Payouts', slug: 'payments.payouts-batch/v1', gh: 'payments_payouts_batch_v1.json' },
  invoicing: { label: 'Invoicing', slug: 'invoicing/v2', gh: 'invoicing_v2.json' },
  subscriptions: { label: 'Subscriptions', slug: 'subscriptions/v1', gh: 'billing_subscriptions_v1.json' },
  catalog: { label: 'Catalog products', slug: 'catalog-products/v1', gh: 'catalogs_products_v1.json' },
  disputes: { label: 'Disputes', slug: 'customer-disputes/v1', gh: 'customer_disputes_v1.json' },
  webhooks: { label: 'Webhooks', slug: 'webhooks/v1', gh: 'notifications_webhooks_v1.json' },
  vault: { label: 'Vault', slug: 'payment-tokens/v3', gh: 'vault_payment_tokens_v3.json' },
  transactions: { label: 'Transaction search', slug: 'transaction-search/v1', gh: 'reporting_transactions_v1.json' },
};

const mem = new Map();
let fetchImpl = (...a) => fetch(...a);
export function setFetch(f) { fetchImpl = f; }
export function clearSpecCache() { mem.clear(); }

async function getJson(url, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Load one product's schema. Returns { product, spec, index, source, fetchedAt, url }. */
export async function loadSpec(product, { force = false } = {}) {
  const meta = PRODUCTS[product];
  if (!meta) throw new Error(`Unknown product "${product}". Pick one of: ${Object.keys(PRODUCTS).join(', ')}.`);
  const hit = mem.get(product);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.value;
  const url = `https://developer.paypal.com/api/${meta.slug}/schema.json`;
  const tmp = path.join(os.tmpdir(), `callcheck-${product}.json`);
  let spec; let source = 'live'; let fetchedAt = new Date().toISOString(); let note;
  try {
    spec = await getJson(url);
    if (!process.env.SPEC_NO_TMP) try { fs.writeFileSync(tmp, JSON.stringify({ fetchedAt, spec })); } catch { /* /tmp is a cache only */ }
  } catch (e) {
    note = e.message;
    try {
      if (process.env.SPEC_NO_TMP) throw new Error('tmp cache disabled');
      const c = JSON.parse(fs.readFileSync(tmp, 'utf8')); spec = c.spec; fetchedAt = c.fetchedAt; source = 'cached';
    } catch {
      const snapFile = path.join(SNAP_DIR, `${product}.json`);
      const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
      spec = snap.spec; fetchedAt = snap.fetchedAt; source = 'snapshot';
    }
  }
  const value = { product, spec, index: indexOps(spec), source, fetchedAt, url, note, title: spec.info?.title, version: spec.info?.version, pathCount: Object.keys(spec.paths ?? {}).length };
  mem.set(product, { at: Date.now(), value });
  return value;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Flatten paths into [{ method, path, re, params, operationId, summary, op, pathItem }] sorted most-specific first. */
export function indexOps(spec) {
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== 'object') continue;
      const params = [];
      const re = new RegExp('^' + p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{([^}]+)\}/g, (_, n) => { params.push(n); return '([^/]+)'; }) + '/?$');
      ops.push({ method: m.toUpperCase(), path: p, re, params, operationId: op.operationId, summary: op.summary, op, pathItem: item, literal: p.split('/').filter((s) => s && !s.startsWith('{')).length });
    }
  }
  return ops.sort((a, b) => b.literal - a.literal || b.path.length - a.path.length);
}

/** Match a method and path (no host, no query) to an operation, filling `pathParams`. */
export function matchOp(index, method, p) {
  const clean = p.replace(/\/+$/, '') || '/';
  for (const o of index) {
    if (o.method !== method) continue;
    const m = o.re.exec(clean);
    if (m) return { ...o, pathParams: Object.fromEntries(o.params.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

/** Methods that exist on a path template that matches `p`, whatever the verb. */
export function methodsFor(index, p) {
  const clean = p.replace(/\/+$/, '') || '/';
  return [...new Set(index.filter((o) => o.re.test(clean)).map((o) => o.method))];
}

export function resolveRef(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  return ref.slice(2).split('/').reduce((n, k) => (n == null ? n : n[decodeURIComponent(k.replace(/~1/g, '/').replace(/~0/g, '~'))]), spec);
}

/** Follow $ref chains; sibling keys on the referring object are kept (OpenAPI 3.1+ allows them). */
export function deref(spec, node, depth = 0) {
  let cur = node;
  while (cur && typeof cur === 'object' && cur.$ref && depth++ < 20) {
    const target = resolveRef(spec, cur.$ref);
    if (!target) return cur;
    const { $ref, ...siblings } = cur;
    cur = Object.keys(siblings).length ? { ...target, ...siblings } : target;
  }
  return cur;
}

export function opParameters(spec, o) {
  const raw = [...(o.pathItem.parameters ?? []), ...(o.op.parameters ?? [])];
  return raw.map((p) => deref(spec, p)).filter(Boolean);
}

export function requestSchema(spec, o) {
  const content = deref(spec, o.op.requestBody)?.content ?? {};
  const json = content['application/json'] ?? content['application/merge-patch+json'] ?? content['application/json-patch+json'];
  if (json?.schema) return { schema: json.schema, contentType: 'application/json' };
  const [ct] = Object.keys(content);
  return { schema: null, contentType: ct ?? null };
}

/** Nearest operations by path text, for "did you mean". */
export function suggestPaths(index, method, p, n = 3) {
  const norm = (s) => s.toLowerCase().replace(/\{[^}]+\}/g, '{}').replace(/[0-9a-z]{10,}/gi, '{}');
  const target = norm(p);
  const scored = index.map((o) => ({ o, d: editDistance(norm(o.path), target) + (o.method === method ? 0 : 3) }));
  return scored.sort((a, b) => a.d - b.d).slice(0, n).map((s) => s.o);
}

export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export function closest(word, candidates, max = 3) {
  return candidates.map((c) => ({ c, d: editDistance(word.toLowerCase(), c.toLowerCase()) })).sort((a, b) => a.d - b.d).slice(0, max).filter((x) => x.d <= Math.max(3, Math.floor(word.length / 3))).map((x) => x.c);
}

/** Compare the live schema against the GitHub mirror. */
export async function compareWithGithub(product) {
  const meta = PRODUCTS[product];
  const live = await loadSpec(product);
  const base = { product, label: meta.label, live: { title: live.title, version: live.version, paths: live.pathCount, source: live.source, fetchedAt: live.fetchedAt } };
  if (!meta.gh) return { ...base, github: null };
  try {
    const gh = await getJson(GH_RAW + meta.gh, 20000);
    const ghPaths = new Set(Object.keys(gh.paths ?? {}));
    const missingFromGithub = Object.keys(live.spec.paths).filter((p) => !ghPaths.has(p));
    return { ...base, github: { title: gh.info?.title, version: gh.info?.version, paths: ghPaths.size }, missingFromGithub };
  } catch (e) {
    return { ...base, github: { error: e.message } };
  }
}

/** Collect statements about PayPal-Request-Id lifetime from the live schema text. */
export function requestIdLifetimes(spec) {
  const found = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (typeof o.name === 'string' && o.name.toLowerCase() === 'paypal-request-id' && typeof o.description === 'string') found.add(o.description.replace(/<[^>]+>/g, '').trim());
      Object.values(o).forEach(walk);
    }
  };
  walk(spec);
  const out = [];
  for (const d of found) {
    const m = /stores? keys? for (\d+) (hours?|days?)/i.exec(d);
    out.push({ text: d, amount: m ? Number(m[1]) : null, unit: m ? m[2].toLowerCase().replace(/s$/, '') : null });
  }
  return out;
}

/** Words written in capitals inside <code> tags in a description: the values PayPal's prose offers. */
export function codeTokens(description) {
  return [...new Set([...String(description ?? '').matchAll(/<code>([A-Z0-9_]+)<\/code>/g)].map((m) => m[1]))];
}
