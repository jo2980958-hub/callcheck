// The second contract. PayPal publishes an OpenAPI schema; APIMatic generates an SDK from an earlier copy of it.
// This module loads the SDK's own model schemas (the code that runs inside `new OrdersController(client).createOrder(...)`)
// and asks: would the SDK accept this body, and what would it actually put on the wire?
// That runs APIMatic-generated code at runtime. It does not call APIMatic: no APIMatic service validates a request.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseJsExpression, extractCall, callNames } from './jsliteral.js';
import { probe, doc } from './evidence.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = path.resolve(here, '../node_modules/@paypal/paypal-server-sdk');
export const SDK_MAP = require('./data/sdk-ops.json');

let schemaLib;
async function lib() { return (schemaLib ??= await import('@apimatic/schema')); }
const modelCache = new Map();
async function loadModel(model, schemaName) {
  const key = `${model}:${schemaName}`;
  if (modelCache.has(key)) return modelCache.get(key);
  const file = path.join(SDK_ROOT, 'dist/esm/models', `${model}.js`);
  if (!fs.existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  const sch = mod[schemaName] ?? null;
  modelCache.set(key, sch);
  return sch;
}

const norm = (p) => p.replace(/\{[^}]+\}/g, '{}');
export function findSdkOp(method, tpl) {
  return SDK_MAP.ops.find((o) => o.http === method && norm(o.path) === norm(tpl)) ?? null;
}
export function sdkControllers() { return [...new Set(SDK_MAP.ops.map((o) => o.controller))]; }

/** Which live operations the SDK covers, per product. */
export function coverage(index) {
  const covered = index.filter((o) => findSdkOp(o.method, o.path));
  return { total: index.length, covered: covered.length, missing: index.filter((o) => !findSdkOp(o.method, o.path)).map((o) => `${o.method} ${o.path}`) };
}

function missingKeys(a, b, ptr = '', out = []) {
  if (Array.isArray(a)) { a.forEach((v, i) => missingKeys(v, b?.[i], `${ptr}/${i}`, out)); return out; }
  if (a && typeof a === 'object') {
    for (const [k, v] of Object.entries(a)) {
      if (b == null || typeof b !== 'object' || !(k in b)) out.push(`${ptr}/${k}`);
      else missingKeys(v, b[k], `${ptr}/${k}`, out);
    }
  }
  return out;
}

function errText(e) { return String(e.message ?? '').split('\n')[0].replace(/\.$/, ''); }

/**
 * Check a REST-shaped body against the SDK model for an operation.
 * @returns {Promise<{ errors: Array, dropped: string[], skipped?: string }>}
 */
export async function sdkBodyCheck(sdkOp, body) {
  const bodyArg = Object.values(sdkOp.args).find((a) => a.kind === 'body');
  if (!bodyArg?.schema || !bodyArg.model) return { errors: [], dropped: [], skipped: 'no body model' };
  const schema = await loadModel(bodyArg.model, bodyArg.schema);
  if (!schema) return { errors: [], dropped: [], skipped: 'model not found' };
  const { validateAndMap, validateAndUnmap } = await lib();
  const mapped = validateAndMap(body, schema);
  if (mapped.errors) return { errors: mapped.errors.map((e) => ({ ptr: '/' + (e.path ?? []).join('/'), message: errText(e) })), dropped: [] };
  const back = validateAndUnmap(mapped.result, schema);
  return { errors: [], dropped: back.errors ? [] : missingKeys(body, back.result) };
}

/** Check an SDK-shaped (camelCase) body and return the REST body the SDK would send. */
export async function sdkUnmap(sdkOp, sdkBody) {
  const bodyArg = Object.values(sdkOp.args).find((a) => a.kind === 'body');
  if (!bodyArg?.schema) return { rest: sdkBody, errors: [], dropped: [] };
  const schema = await loadModel(bodyArg.model, bodyArg.schema);
  if (!schema) return { rest: sdkBody, errors: [], dropped: [] };
  const { validateAndUnmap, validateAndMap } = await lib();
  const un = validateAndUnmap(sdkBody, schema);
  if (un.errors) return { rest: sdkBody, errors: un.errors.map((e) => ({ ptr: '/' + (e.path ?? []).join('/'), message: errText(e) })), dropped: [] };
  const back = validateAndMap(un.result, schema);
  // keys the caller wrote that do not survive a round trip through the SDK's own model: the SDK would never send them
  return { rest: un.result, errors: [], dropped: back.errors ? [] : missingKeys(sdkBody, back.result) };
}

/** Findings from running the SDK's own validation over a pasted REST request. */
export async function sdkFindings(c) {
  const o = c.o; if (!o) return [];
  const sdkOp = findSdkOp(c.req.method, o.path);
  const out = [];
  if (!sdkOp) {
    const covered = sdkControllers().map((n) => n.replace(/Controller$/, '')).join(', ');
    out.push({ id: 'sdk-not-covered', severity: 'note', title: 'No APIMatic SDK method for this call', what: `@paypal/paypal-server-sdk ${SDK_MAP.version} has controllers for ${covered} only. The Context Plugin teaches that SDK, so it has nothing to say about ${c.req.method} ${o.path}.`, fix: 'Call this endpoint over REST. The live schema is the only contract you have for it.', evidence: [doc(`SDK ${SDK_MAP.version} exposes ${SDK_MAP.ops.length} operations; this surface is not among them.`)], confidence: 'spec' });
    return out;
  }
  if (c.body !== undefined && c.body !== null && typeof c.body === 'object') {
    const r = await sdkBodyCheck(sdkOp, c.body);
    if (r.errors.length) out.push({ id: 'sdk-rejects-body', severity: 'warning', where: r.errors[0].ptr, title: 'The SDK would refuse this body before sending it', what: `${sdkOp.controller}.${sdkOp.method} validates the body with its own generated schema and throws on: ${r.errors.slice(0, 3).map((e) => `${e.ptr} (${e.message})`).join('; ')}. A raw HTTP call is not so strict, so this can work today and break when you adopt the SDK.`, fix: 'Fix the field types so both the live API and the SDK accept the body.', evidence: [probe('order.value-number')], confidence: 'observed' });
    if (r.dropped.length) out.push({ id: 'sdk-drops-fields', severity: 'warning', where: r.dropped[0], title: `The SDK would silently drop ${r.dropped.length} field${r.dropped.length > 1 ? 's' : ''}`, what: `${sdkOp.controller}.${sdkOp.method} only keeps fields its model knows. ${r.dropped.slice(0, 4).join(', ')}${r.dropped.length > 4 ? ' and more' : ''} would never reach PayPal. The SDK is generated from ${SDK_MAP.version === '2.5.0' ? 'an earlier copy of the schema (SDK 2.5.0 against live Orders 2.36)' : 'an earlier schema'}, so newer fields are missing, and so are typos.`, fix: 'If a field matters, send the request over raw HTTP, or check that the SDK version models it. A typo drops the same way a missing field does.', evidence: [doc(`@paypal/paypal-server-sdk ${SDK_MAP.version}: models are generated by APIMatic from the schema as it was at generation time.`)], confidence: 'spec' });
  }
  out.push({ id: 'sdk-method', severity: 'note', title: `SDK equivalent: ${sdkOp.controller}.${sdkOp.method}`, what: `${sdkOp.controller.replace(/Controller$/, '').toLowerCase()}Controller.${sdkOp.method}(${argsHint(sdkOp)}). Headers such as PayPal-Request-Id are method arguments, not request options, and bodies use camelCase.`, fix: 'Use the SDK method when you can; the Context Plugin skills describe it.', evidence: [], confidence: 'spec', sdk: { controller: sdkOp.controller, method: sdkOp.method } });
  return out;
}

function argsHint(op) {
  const names = Object.entries(op.args).filter(([, a]) => a.kind).map(([n, a]) => (a.optional ? `${n}?` : n));
  return `{ ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''} }`;
}

const CONTROLLER_HINTS = { orders: 'OrdersController', payments: 'PaymentsController', vault: 'VaultController', subscriptions: 'SubscriptionsController', transaction: 'TransactionSearchController' };

/** Read `ordersController.createOrder({ ... })` and return a REST-shaped request. */
export async function parseSdkSnippet(text) {
  const names = callNames(text);
  const known = SDK_MAP.ops.map((o) => o.method);
  const hit = names.find((n) => known.includes(n.name));
  if (!hit) {
    const tried = names.map((n) => n.name).join(', ');
    throw new Error(`No @paypal/paypal-server-sdk method found${tried ? ` (saw ${tried})` : ''}. Paste a call such as ordersController.createOrder({ body: {...} }).`);
  }
  const cands = SDK_MAP.ops.filter((o) => o.method === hit.name);
  const recv = (hit.receiver || '').toLowerCase();
  const op = cands.find((o) => Object.entries(CONTROLLER_HINTS).some(([k, v]) => recv.includes(k) && v === o.controller)) ?? cands[0];
  const call = extractCall(text, new RegExp(hit.name));
  const arg = call?.args?.[0] ?? {};
  const unresolved = [];
  const val = (v, label) => { if (v && typeof v === 'object' && v.__ident) { unresolved.push(`${label} uses the variable "${v.__ident}"`); return `<${v.__ident}>`; } return v; };
  const cleanse = (x, label) => Array.isArray(x) ? x.map((v, i) => cleanse(v, `${label}[${i}]`)) : (x && typeof x === 'object' && !x.__ident && !x.__call && !x.__template) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, cleanse(v, `${label}.${k}`)])) : (x && x.__template) ? x.__template : val(x, label);
  const clean = cleanse(arg, 'argument');
  let p = op.path; const headers = {}; const query = {}; let body;
  for (const [name, spec] of Object.entries(op.args)) {
    const v = clean[name];
    if (v === undefined) continue;
    if (spec.kind === 'path') p = p.replace(`{${name}}`, encodeURIComponent(String(v)));
    else if (spec.kind === 'header') headers[spec.wire] = String(v);
    else if (spec.kind === 'query') query[spec.wire] = String(v);
    else if (spec.kind === 'body') body = v;
  }
  const un = body !== undefined ? await sdkUnmap(op, body) : { rest: undefined, errors: [], dropped: [] };
  return { op, rawBody: body, req: { source: 'sdk', method: op.http, host: 'api-m.sandbox.paypal.com', proto: 'https', path: p, query, headers: { 'Content-Type': 'application/json', ...headers }, body: un.rest, hadCredentials: false, notes: unresolved }, sdk: { controller: op.controller, method: op.method, errors: un.errors, dropped: un.dropped, unresolved } };
}
