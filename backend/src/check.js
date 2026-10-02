// The checker. Takes pasted text, resolves it against the live PayPal schema, runs the trap catalogue and the SDK
// contract, and returns findings, a verdict, predictions that can be tested against the sandbox, and a corrected call.
import { loadSpec, matchOp, methodsFor, opParameters, requestSchema, suggestPaths, closest, deref, PRODUCTS } from './spec.js';
import { validate } from './validate.js';
import { parseRest, productForPath } from './parse.js';
import { TRAPS, hdr, _internal } from './traps.js';
import { sdkFindings, parseSdkSnippet } from './sdkcontract.js';
import { checkMcp } from './mcp.js';
import { probe, doc } from './evidence.js';

const SANDBOX_HOST = 'api-m.sandbox.paypal.com';
const SEV = { blocker: 0, warning: 1, note: 2 };
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

const normOp = (m, p) => `${m} ${p.replace(/\{[^}]+\}/g, '{}')}`;

/** Placeholders usable in pasted requests so examples can be re-run: {{uniq}} and the fixtures the runner creates. */
export function forValidation(v) {
  if (typeof v === 'string') return v.replace(/\{\{uniq\}\}/g, 'a1b2c3d4').replace(/\{\{new_order\}\}/g, 'a1b2c3d4-order').replace(/\{\{new_invoice\}\}/g, 'INV2-AAAA-BBBB-CCCC-DDDD').replace(/\{\{new_product\}\}/g, 'PROD-XXXXXXXXXXXXXXXXX').replace(/\{\{new_plan\}\}/g, 'P-XXXXXXXXXXXXXXXXXXXXXXXX');
  if (Array.isArray(v)) return v.map(forValidation);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, forValidation(x)]));
  return v;
}

export function formatRequest(r) {
  const host = r.host && r.host !== SANDBOX_HOST ? r.host : SANDBOX_HOST;
  const q = Object.entries(r.query ?? {}).map(([k, v]) => `${k}=${v}`).join('&');
  const lines = [`${r.method} https://${host}${r.path}${q ? '?' + q : ''}`];
  for (const [k, v] of Object.entries(r.headers ?? {})) if (!/^authorization$/i.test(k)) lines.push(`${k}: ${v}`);
  if (r.body !== undefined) lines.push('', typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2));
  return lines.join('\n');
}

function publicRequest(r) {
  return { ...(r.implicitFormContentType ? { implicitForm: true, rawBody: r.rawBody } : {}), method: r.method, host: r.host || SANDBOX_HOST, path: r.path, query: r.query ?? {}, headers: r.headers ?? {}, body: r.body, source: r.source, hadCredentials: !!r.hadCredentials };
}

const camelOf = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
function snakeKeys(v, ptr = '', out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => snakeKeys(x, `${ptr}/${i}`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(k)) out.push({ name: k, camel: camelOf(k), ptr: `${ptr}/${k}` }); snakeKeys(x, `${ptr}/${k}`, out); }
  return out;
}

function strip(f) { const { patch, ...rest } = f; return rest; }

/**
 * @param {{ text: string, mode?: 'rest'|'sdk'|'mcp', product?: string }} input
 * @param {{ eventTypes?: string[], webhookCount?: number, env?: object, github?: Function }} [deps]
 */
export async function check(input, deps = {}) {
  const mode = input.mode ?? 'rest';
  if (mode === 'mcp') return checkMcpMode(input.text);
  const env = { senderEmail: process.env.SENDER_EMAIL ?? 'sb-mixsn53098231@business.example.com', registered: (process.env.REGISTERED_RECIPIENTS ?? 'sb-patient@personal.example.com').split(',').filter(Boolean), ...(deps.env ?? {}) };
  let req; let sdkInfo = null; let sdkFs = [];
  if (mode === 'sdk') {
    const s = await parseSdkSnippet(input.text);
    req = s.req; sdkInfo = s.sdk;
    if (s.sdk.errors.length && !snakeKeys(s.rawBody).length) sdkFs.push({ id: 'sdk-rejects-body', severity: 'blocker', where: s.sdk.errors[0].ptr, title: 'The SDK would throw on this body', what: `${s.sdk.controller}.${s.sdk.method} validates with its generated schema before sending: ${s.sdk.errors.slice(0, 3).map((e) => `${e.ptr} (${e.message})`).join('; ')}.`, fix: 'Fix the types. SDK bodies use camelCase keys and strings for money.', evidence: [probe('order.value-number')], confidence: 'observed' });
    const snake = snakeKeys(s.rawBody);
    if (snake.length) sdkFs.push({ id: 'sdk-snake-case', severity: 'blocker', where: snake[0].ptr, title: 'SDK bodies use camelCase, and this one has REST keys', what: `${snake.slice(0, 4).map((k) => `${k.name} (the SDK model calls it ${k.camel})`).join('; ')}. The SDK maps camelCase properties to the snake_case wire names. A snake_case key is not a property of the model, so it is dropped, and a required one then fails validation.`, fix: snake.slice(0, 4).map((k) => `${k.name} -> ${k.camel}`).join('; '), evidence: [doc('Context Plugin skill typescript-models: property names are camelCase; the schema maps them to the wire names.')], confidence: 'observed' });
    if (s.sdk.dropped.length && !snake.length) sdkFs.push({ id: 'sdk-drops-fields', severity: 'warning', where: s.sdk.dropped[0], title: `The SDK would drop ${s.sdk.dropped.length} field${s.sdk.dropped.length > 1 ? 's' : ''} you wrote`, what: `${s.sdk.dropped.slice(0, 5).join(', ')} ${s.sdk.dropped.length === 1 ? 'is' : 'are'} not in the SDK's ${s.sdk.method} model, so ${s.sdk.dropped.length === 1 ? 'it' : 'they'} never reach PayPal. The usual cause is snake_case keys (the SDK expects camelCase) or a field newer than SDK ${'2.5.0'}.`, fix: 'Rename to the camelCase key the model uses, or send the call over raw HTTP if the SDK predates the field.', evidence: [doc('Context Plugin skill typescript-models: SDK models map camelCase properties to snake_case wire names; unknown properties are not serialised.')], confidence: 'observed' });
    for (const u of s.sdk.unresolved) sdkFs.push({ id: 'unresolved-variable', severity: 'note', title: 'A variable cannot be read here', what: `${u}. It was replaced with a placeholder, so values it holds are not checked.`, fix: 'Paste the literal value to have it checked.', evidence: [], confidence: 'spec' });
  } else {
    req = parseRest(input.text);
  }
  const findings = [...sdkFs];
  const add = (f) => findings.push({ confidence: 'spec', evidence: [], ...f });

  const warnings = [];
  for (const n of req.notes ?? []) if (!sdkInfo) warnings.push(n);
  if (req.bodyError) add({ id: 'body-not-json', severity: 'blocker', title: 'The body is not valid JSON', what: `${req.bodyError}. PayPal answers 400 MALFORMED_REQUEST_JSON.`, fix: 'Fix the JSON. Single quotes, trailing commas and unquoted keys are not JSON.', confidence: 'spec', where: 'body' });
  if (req.hadCredentials) add({ id: 'credentials-redacted', severity: 'note', title: 'Credentials were removed from your paste', what: 'An Authorization header or -u option was found and discarded in the browser-bound copy. Callcheck sends its own sandbox token when it runs a call and never stores yours.', fix: 'Do not paste live credentials anywhere.', confidence: 'policy' });
  for (const w of warnings) add({ id: 'paste-note', severity: 'note', title: w, what: w, fix: '', confidence: 'spec' });

  const body0 = req.body;
  const v = { ...req, body: forValidation(body0), headers: req.headers ?? {} };
  const headers = Object.fromEntries(Object.entries(v.headers).map(([k, x]) => [k.toLowerCase(), x]));
  const product = input.product && PRODUCTS[input.product] ? input.product : productForPath(req.path);
  if (product === 'webhooks' && deps.lazy) {
    deps = { ...deps };
    try { deps.eventTypes ??= await deps.lazy.eventTypes?.(); } catch { /* optional */ }
    try { deps.webhookCount ??= await deps.lazy.webhookCount?.(); } catch { /* optional */ }
  }
  const ctx = { req: v, body: v.body, headers, product, o: null, env, deps };
  let specInfo = null;

  if (!product) {
    const hint = req.path.startsWith('/v2/vault') ? ' PayPal has no /v2/vault; vaulting is /v3/vault/setup-tokens and /v3/vault/payment-tokens.' : '';
    add({ id: 'path-unknown-product', severity: 'blocker', where: 'path', title: `${req.path} is not a path Callcheck knows`, what: `It does not belong to any of the ten PayPal APIs checked here (${Object.values(PRODUCTS).map((p) => p.label).join(', ')}).${hint}`, fix: 'Check the path against https://developer.paypal.com/api/rest/ or pick the product by hand.', confidence: 'spec', predicts: { rank: 3, status: 404 } });
  } else {
    const spec = await loadSpec(product);
    specInfo = { product, label: PRODUCTS[product].label, title: spec.title, version: spec.version, paths: spec.pathCount, source: spec.source, fetchedAt: spec.fetchedAt, url: spec.url };
    ctx.o = matchOp(spec.index, req.method, req.path);
    if (!ctx.o) {
      const verbs = methodsFor(spec.index, req.path);
      if (verbs.length) {
        const f = { id: 'method-not-in-schema', severity: 'blocker', where: 'method', title: `${req.method} is not an operation on ${req.path}`, what: `The live ${spec.title} ${spec.version} schema defines ${verbs.join(', ')} on this path. A ${req.method} gets 404 or 405, often with an empty body that looks like a wrong id.`, fix: `Use ${verbs.join(' or ')}.${product === 'invoicing' && req.method === 'PATCH' ? ' Invoices update with PUT and the whole invoice; there is no PATCH.' : ''}`, evidence: product === 'invoicing' && req.method === 'PATCH' ? [probe('invoice.patch')] : [], confidence: product === 'invoicing' && req.method === 'PATCH' ? 'observed' : 'spec', predicts: product === 'invoicing' && req.method === 'PATCH' ? { rank: 3, status: 404 } : { rank: 3, status: [404, 405] }, patch: (r) => { r.method = verbs[0]; } };
        if (product === 'invoicing' && req.method === 'PATCH') f.trap = 'invoice-update-is-put';
        add(f);
      } else {
        const sug = suggestPaths(spec.index, req.method, req.path, 3);
        add({ id: 'path-not-in-schema', severity: 'blocker', where: 'path', title: `${req.path} is not in the live ${spec.title} schema`, what: `The schema at ${spec.url} has ${spec.pathCount} paths and none matches. PayPal answers 404.`, fix: sug.length ? `Closest operations: ${sug.map((s) => `${s.method} ${s.path}`).join('; ')}.` : 'Check the path.', confidence: 'spec', predicts: { rank: 3, status: 404 }, patch: sug[0] ? (r) => { r.path = sug[0].path.replace(/\{[^}]+\}/g, 'ID'); r.method = sug[0].method; } : undefined });
      }
    } else {
      validateParams(spec, ctx, add);
      validateBody(spec, ctx, add, body0);
    }
  }

  // traps
  const opKey = ctx.o ? normOp(ctx.o.method, ctx.o.path) : null;
  const trapFindings = [];
  for (const t of TRAPS) {
    if (!(t.products.includes('*') || (product && t.products.includes(product)))) continue;
    if (t.ops?.length && (!opKey || !t.ops.some((x) => x.replace(/\{[^}]+\}/g, '{}') === opKey))) continue;
    let res = [];
    try { res = t.detect.call(t, ctx) ?? []; } catch (e) { res = []; findings.push({ id: `${t.id}-error`, severity: 'note', title: `Detector for "${t.title}" failed`, what: e.message, fix: '', evidence: [], confidence: 'spec' }); }
    for (const f of res) trapFindings.push({ trap: t.id, id: t.id, group: t.group, ...f });
  }
  const trapPtrs = new Set(trapFindings.map((f) => f.where).filter(Boolean));
  findings.push(...trapFindings);
  // generic schema findings that a trap already explains are dropped
  const kept = findings.filter((f) => !(f.generic && f.where && trapPtrs.has(f.where)));

  // GitHub staleness for this operation
  if (ctx.o && deps.github) {
    try {
      const g = await deps.github(product);
      if (g?.missingFromGithub?.includes(ctx.o.path)) kept.push({ id: 'github-stale', severity: 'note', title: 'This operation is missing from PayPal\'s GitHub OpenAPI repo', what: `${ctx.o.method} ${ctx.o.path} exists in the live ${g.live.title} ${g.live.version} schema. The GitHub copy is ${g.github.title} ${g.github.version} with ${g.github.paths} paths against ${g.live.paths} live. Tools that read GitHub will not know this endpoint.`, fix: 'Generate from https://developer.paypal.com/api/<product>/<version>/schema.json, not from GitHub.', evidence: [doc('Invoicing on GitHub is 2.6 with 16 paths; live is 2.12.0 with 27.')], confidence: 'observed' });
    } catch { /* GitHub is optional */ }
  }

  // SDK contract
  if (ctx.o) {
    try { for (const f of await sdkFindings(ctx)) { if (sdkInfo && ['sdk-rejects-body', 'sdk-drops-fields'].includes(f.id)) continue; kept.push(f); } } catch (e) { kept.push({ id: 'sdk-contract-error', severity: 'note', title: 'SDK contract check skipped', what: e.message, fix: '', evidence: [], confidence: 'spec' }); }
  }

  const sorted = kept.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  const corrected = buildCorrected(req, sorted, ctx);
  const verdict = buildVerdict(sorted);
  const out = {
    mode, request: publicRequest(req), requestText: formatRequest(req), product: product ?? null, spec: specInfo,
    op: ctx.o ? { method: ctx.o.method, path: ctx.o.path, operationId: ctx.o.operationId, summary: ctx.o.summary } : null,
    sdk: sdkInfo ? { controller: sdkInfo.controller, method: sdkInfo.method } : null,
    findings: sorted.map(strip), verdict, predictions: predictions(sorted),
    counts: { blocker: sorted.filter((f) => f.severity === 'blocker').length, warning: sorted.filter((f) => f.severity === 'warning').length, note: sorted.filter((f) => f.severity === 'note').length },
    runnable: runnableOf(sorted, req),
  };
  if (corrected) out.corrected = corrected;
  return out;
}

function runnableOf(findings, req) {
  const stop = findings.find((f) => f.runnable === false);
  if (stop) return { ok: false, reason: stop.title };
  if (req.bodyError) return { ok: false, reason: 'The body is not valid JSON.' };
  return { ok: true };
}

function validateParams(spec, ctx, add) {
  const params = opParameters(spec.spec, ctx.o);
  for (const p of params) {
    if (p.in === 'query') {
      const val = ctx.req.query?.[p.name];
      if (p.required && val === undefined) add({ id: 'query-missing', generic: true, severity: 'blocker', where: `query/${p.name}`, title: `Query parameter ${p.name} is required`, what: `The schema marks ${p.name} as required. PayPal answers 400 INVALID_REQUEST.`, fix: `Add ?${p.name}=...`, confidence: 'spec', predicts: { rank: 3, status: 400, name: 'INVALID_REQUEST' } });
      else if (val !== undefined) {
        const sch = deref(spec.spec, p.schema);
        if (sch?.enum && !sch.enum.includes(val)) add({ id: 'query-enum', generic: true, severity: 'blocker', where: `query/${p.name}`, title: `${p.name}=${val} is not an allowed value`, what: `Allowed: ${sch.enum.join(', ')}.`, fix: `Use one of ${sch.enum.join(', ')}.`, confidence: 'spec', predicts: { rank: 3, status: 400, name: 'INVALID_REQUEST' } });
      }
    }
    if (p.in === 'header' && p.required && !ctx.headers[p.name.toLowerCase()]) add({ id: 'header-missing', generic: true, severity: 'blocker', where: `header:${p.name}`, title: `Header ${p.name} is required`, what: `The schema marks the ${p.name} header as required.`, fix: `Add ${p.name}.`, confidence: 'spec', predicts: { rank: 3, status: 400, name: 'INVALID_REQUEST' } });
  }
}

const ISSUE_BY_KEYWORD = { required: 'MISSING_REQUIRED_PARAMETER', enum: 'INVALID_PARAMETER_VALUE', maxLength: 'INVALID_STRING_MAX_LENGTH', minLength: 'INVALID_STRING_MIN_LENGTH', maxItems: 'INVALID_ARRAY_MAX_ITEMS', minItems: 'INVALID_ARRAY_MIN_ITEMS', pattern: 'INVALID_PARAMETER_SYNTAX', type: 'INVALID_PARAMETER_SYNTAX' };

function validateBody(spec, ctx, add, original) {
  const { schema, contentType } = requestSchema(spec.spec, ctx.o);
  const sends = ['POST', 'PUT', 'PATCH'].includes(ctx.req.method);
  if (!schema) {
    if (contentType && /multipart/.test(contentType)) add({ id: 'body-multipart', severity: 'note', title: 'This operation takes multipart/form-data', what: 'The schema describes a multipart body; JSON bodies are not validated here.', fix: 'Send multipart.', confidence: 'spec' });
    return;
  }
  if (ctx.body === undefined) {
    if (sends && deref(spec.spec, ctx.o.op.requestBody)?.required) add({ id: 'body-missing', generic: true, severity: 'blocker', where: 'body', title: 'This operation needs a request body', what: 'The schema marks the body as required. PayPal answers 400 INVALID_REQUEST.', fix: 'Send a JSON body.', confidence: 'spec', predicts: { rank: 3, status: 400, name: 'INVALID_REQUEST' } });
    return;
  }
  const unresolved = JSON.stringify(original ?? '').includes('"__ident"');
  const { errors, unknown } = validate(spec.spec, schema, ctx.body);
  const seen = new Set();
  for (const e of dedupe(errors)) {
    const key = `${e.ptr}|${e.keyword}`; if (seen.has(key)) continue; seen.add(key);
    if (e.keyword === 'type' && e.expected === 'string' && e.got === 'number' && /\/value$/.test(e.ptr)) {
      add({ id: 'type-number-for-string', generic: true, severity: 'warning', where: e.ptr, title: `${e.ptr} should be a string`, what: 'The schema types this as a string. PayPal accepted a number in the sandbox, but the SDK refuses it.', fix: 'Send it as a string.', confidence: 'spec', patch: (r) => { setAt(r.body, e.ptr, String(e.value)); } });
      continue;
    }
    if (unresolved && typeof e.value === 'object' && e.value?.__ident) continue;
    const issue = ISSUE_BY_KEYWORD[e.keyword];
    add({ id: `schema-${e.keyword}`, generic: true, severity: 'blocker', where: e.ptr, title: `${e.ptr} ${e.message}`.replace('//', '/'), what: `The live ${spec.title} ${spec.version} schema rejects this. PayPal answers 400 INVALID_REQUEST${issue ? ` with issue ${issue}` : ''} and does nothing.`, fix: fixFor(e), confidence: 'spec', predicts: { rank: 3, status: 400, name: 'INVALID_REQUEST', issue }, patch: patchFor(e) });
  }
  if (unknown.length) {
    const typo = unknown.map((u) => ({ u, near: closest(u.name, u.known, 1)[0] })).filter((x) => x.near);
    if (typo.length) add({ id: 'schema-unknown-field', generic: true, severity: 'warning', where: typo[0].u.ptr, title: `${typo.length === 1 ? 'A field' : typo.length + ' fields'} may be misspelled`, what: `${typo.slice(0, 4).map((x) => `${x.u.ptr} is not in the schema (did you mean ${x.near}?)`).join('; ')}. PayPal ignores properties it does not know, so the intended field is silently unset.`, fix: typo.slice(0, 4).map((x) => `${x.u.name} -> ${x.near}`).join('; '), confidence: 'spec', patch: (r) => { for (const x of typo) renameAt(r.body, x.u.ptr, x.near); } });
    const rest = unknown.filter((u) => !closest(u.name, u.known, 1)[0]);
    if (rest.length) add({ id: 'schema-unknown-other', generic: true, severity: 'note', where: rest[0].ptr, title: `${rest.length} field${rest.length > 1 ? 's are' : ' is'} not in the live schema`, what: `${rest.slice(0, 5).map((u) => u.ptr).join(', ')}. PayPal usually ignores unknown properties; the schema can also lag the API.`, fix: 'Remove them unless you are sure the API accepts them.', confidence: 'spec' });
  }
}

function dedupe(errors) { const m = new Map(); for (const e of errors) { const k = `${e.ptr}|${e.keyword}`; if (!m.has(k)) m.set(k, e); } return [...m.values()]; }

function fixFor(e) {
  if (e.keyword === 'required') return `Add ${e.missing}.`;
  if (e.keyword === 'enum') return `Use one of: ${[].concat(e.expected).slice(0, 8).join(', ')}${[].concat(e.expected).length > 8 ? ', ...' : ''}.`;
  if (e.keyword === 'maxLength') return `Shorten to ${e.expected} characters or fewer.`;
  if (e.keyword === 'minLength') return `Use at least ${e.expected} characters.`;
  if (e.keyword === 'maxItems') return `Send ${e.expected} items or fewer.`;
  if (e.keyword === 'minItems') return `Send at least ${e.expected}.`;
  if (e.keyword === 'type') return `Send a ${e.expected}.`;
  return 'Match the schema.';
}

function patchFor(e) {
  if (e.keyword === 'maxLength') return (r) => { const s = getAt(r.body, e.ptr); if (typeof s === 'string') setAt(r.body, e.ptr, s.slice(0, e.expected)); };
  if (e.keyword === 'enum' && typeof e.value === 'string') { const near = closest(e.value, [].concat(e.expected), 1)[0]; if (near) return (r) => setAt(r.body, e.ptr, near); }
  return undefined;
}

function getAt(o, ptr) { return ptr.split('/').filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), o); }
function setAt(o, ptr, v) { const ks = ptr.split('/').filter(Boolean); const last = ks.pop(); const parent = ks.reduce((n, k) => (n == null ? n : n[k]), o); if (parent && last !== undefined) parent[last] = v; }
function renameAt(o, ptr, to) { const ks = ptr.split('/').filter(Boolean); const last = ks.pop(); const parent = ks.reduce((n, k) => (n == null ? n : n[k]), o); if (parent && last in parent && !(to in parent)) { parent[to] = parent[last]; delete parent[last]; } }

const plist = (f) => (f.predicts ? [].concat(f.predicts).map((p) => ({ ...p, finding: f })) : []);

function buildVerdict(f) {
  const blockers = f.filter((x) => x.severity === 'blocker');
  const warnings = f.filter((x) => x.severity === 'warning');
  const first = f.flatMap(plist).filter((p) => !p.attempt || p.attempt === 1).sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9));
  const top = first.find((p) => p.finding.severity === 'blocker') ?? first[0];
  if (blockers.length) {
    const p = first.find((x) => x.finding.severity === 'blocker');
    const accepted = p && p.status >= 200 && p.status < 300;
    return { level: 'fail', headline: accepted ? 'This call is accepted, then fails.' : 'This call will fail.', detail: p ? `Expect ${describePrediction(p)}.` : `${blockers.length} problem${blockers.length > 1 ? 's' : ''} PayPal will not accept.` };
  }
  if (warnings.length) return { level: 'trap', headline: 'This call goes through, then bites.', detail: top ? `Expect ${describePrediction(top)}. ${warnings.length} thing${warnings.length > 1 ? 's' : ''} to fix before this ships.` : `${warnings.length} thing${warnings.length > 1 ? 's' : ''} to fix before this ships.` };
  return { level: 'clear', headline: 'No known problems.', detail: top ? `Expect ${describePrediction(top)}.` : 'Nothing in the live schema or the trap catalogue applies.' };
}

export function describePrediction(p) {
  const code = Array.isArray(p.status) ? p.status.join(' or ') : p.status;
  let s = `HTTP ${code}`;
  if (p.name) s += ` ${p.name}`;
  if (typeof p.issue === 'string') s += ` (${p.issue})`;
  else if (p.issue instanceof RegExp) s += ` (${String(p.issue).replace(/^\/|\/i?$/g, '').replace(/\\/g, '')})`;
  if (p.terminal) s += `, then item ${p.terminal.item}${p.terminal.error ? ` (${p.terminal.error})` : ''}${p.terminal.batch ? ` in batch ${p.terminal.batch}` : ''}`;
  if (p.body?.status) s += `, status ${p.body.status}`;
  if (p.sameResourceAsAttempt1 === true) s += ', the same resource as the first send';
  if (p.sameResourceAsAttempt1 === false) s += ', a second resource';
  return s;
}

/** Predictions in a form the runner can test. Regex issues become strings so they survive JSON. */
export function predictions(f) {
  const ser = (p) => { const { finding, ...rest } = p; return { ...rest, issue: p.issue instanceof RegExp ? { pattern: p.issue.source, flags: p.issue.flags } : p.issue }; };
  const all = f.flatMap(plist);
  const first = all.filter((p) => !p.attempt || p.attempt === 1).sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9));
  const second = all.filter((p) => p.attempt === 2).sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9));
  const merge = (list) => {
    if (!list.length) return null;
    const lead = list.find((x) => x.finding.severity === 'blocker') ?? list[0];
    const merged = { ...lead };
    if (merged.status >= 200 && merged.status < 300) {
      if (!merged.terminal) { const t = list.find((x) => x.terminal); if (t) merged.terminal = t.terminal; }
      if (!merged.body) { const b = list.find((x) => x.body); if (b) merged.body = b.body; }
    }
    return { by: lead.finding.id, ...ser(merged), text: describePrediction(merged) };
  };
  const p1 = merge(first);
  let p2 = merge(second);
  const ok1 = p1 && !Array.isArray(p1.status) && p1.status >= 200 && p1.status < 300;
  if (!ok1) p2 = null; // a second send only teaches something when the first one was accepted
  else if (p1.terminal?.batch === 'DENIED') p2 = { by: 'payout-denied-frees-id', status: 201, terminal: p1.terminal, text: 'HTTP 201 again: a DENIED batch does not hold its sender_batch_id' };
  return { first: p1, second: p2 };
}

function buildCorrected(req, findings, ctx) {
  const fixable = findings.filter((f) => f.patch);
  if (!fixable.length) return null;
  const r = clone({ ...req, body: req.body });
  for (const f of fixable) { try { f.patch(r); } catch { /* a patch that cannot apply is skipped */ } }
  const before = JSON.stringify([req.method, req.host, req.path, req.headers, req.body]);
  const after = JSON.stringify([r.method, r.host, r.path, r.headers, r.body]);
  if (before === after) return null;
  return { request: publicRequest(r), text: formatRequest(r), applied: fixable.map((f) => f.id), by: 'rules' };
}

async function checkMcpMode(text) {
  const raw = checkMcp(text);
  const findings = raw.map((f) => { const { patch, ...rest } = f; return rest; });
  const blockers = findings.filter((f) => f.severity === 'blocker'); const warnings = findings.filter((f) => f.severity === 'warning');
  const verdict = blockers.length ? { level: 'fail', headline: 'This setup will not work as written.', detail: `${blockers.length} problem${blockers.length > 1 ? 's' : ''} to fix first.` } : warnings.length ? { level: 'trap', headline: 'This setup connects, then falls short.', detail: `${warnings.length} thing${warnings.length > 1 ? 's' : ''} to fix.` } : { level: 'clear', headline: 'No known problems.', detail: 'No known MCP trap applies.' };
  let fixed = String(text); let changed = false;
  for (const f of raw) if (f.patch) { const n = f.patch(fixed); if (n !== fixed) { fixed = n; changed = true; } }
  return { mode: 'mcp', product: 'mcp', spec: null, op: null, request: null, requestText: String(text).trim(), findings, verdict, predictions: { first: null, second: null }, counts: { blocker: blockers.length, warning: warnings.length, note: findings.length - blockers.length - warnings.length }, runnable: { ok: false, reason: 'MCP setups are checked against recorded endpoint probes and the tool list; there is no request to run.' }, corrected: changed ? { text: fixed, applied: raw.filter((f) => f.patch).map((f) => f.id), by: 'rules' } : undefined, probes: await liveMcpProbes(text) };
}

/** Live endpoint probes for any PayPal MCP URL in the text. These are real requests made at check time. */
export async function liveMcpProbes(text) {
  const urls = [...new Set([...String(text).matchAll(/https:\/\/mcp(?:\.sandbox)?\.paypal\.com(\/[A-Za-z0-9_\-/.]*)?/g)].map((m) => m[0]))].slice(0, 4);
  const out = [];
  for (const u of urls) {
    const t0 = Date.now();
    try {
      const r = await fetch(u, { method: u.endsWith('/sse') ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: u.endsWith('/sse') ? undefined : '{}', signal: AbortSignal.timeout(6000) });
      out.push({ url: u, status: r.status, ms: Date.now() - t0, body: (await r.text()).slice(0, 90) });
    } catch (e) { out.push({ url: u, error: e.message }); }
  }
  return out;
}

export { _internal };
