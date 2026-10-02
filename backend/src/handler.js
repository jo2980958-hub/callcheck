// Lambda Function URL entry. Routes under /api. Long work (sandbox runs, the Bedrock agent) runs as an asynchronous
// self-invocation and is polled, so CloudFront's 60 s origin timeout never sees it. The webhook route answers 200 first
// and finishes its work after the response has been sent.
import crypto from 'node:crypto';
import { check } from './check.js';
import { runRequest, gate, GateError } from './run.js';
import { explain } from './agent.js';
import { trapLibrary, TRAPS } from './traps.js';
import { EXAMPLES } from './examples.js';
import { sources } from './sources.js';
import { PRODUCTS, loadSpec, compareWithGithub } from './spec.js';
import { SDK_MAP } from './sdkcontract.js';
import { makeStore } from './store.js';
import { call as ppCall } from './paypal.js';
import { verify, lowerHeaders, resourceIds } from './webhook.js';

const VERSION = '1.0.0';
let store;
const S = () => (store ??= makeStore());
export function setStore(s) { store = s; }

const J = (statusCode, obj, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }, body: JSON.stringify(obj) });
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const hashIp = (ip) => crypto.createHash('sha256').update(String(ip) + (process.env.IP_SALT ?? 'callcheck')).digest('hex').slice(0, 16);
const hour = () => new Date().toISOString().slice(0, 13);
const day = () => new Date().toISOString().slice(0, 10);
const LIMITS = { check: 240, run: 24, explain: 14 };
const DAILY = { run: 400, explain: 160 };

async function limit(kind, ip) {
  const n = await S().incr(`rl#${kind}#${hashIp(ip)}#${hour()}`, 1, 7200);
  if (n > LIMITS[kind]) throw new HttpError(429, `That is ${LIMITS[kind]} ${kind === 'check' ? 'checks' : kind === 'run' ? 'sandbox runs' : 'explanations'} in the last hour from this address. Wait a little and try again.`);
  if (DAILY[kind]) {
    const d = await S().incr(`day#${kind}#${day()}`, 1, 2 * 86400);
    if (d > DAILY[kind]) throw new HttpError(429, `The daily limit on ${kind === 'run' ? 'sandbox runs' : 'explanations'} has been reached. Checks still work. Try again tomorrow.`);
  }
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > 80_000) throw new HttpError(413, 'That paste is too large. Callcheck reads up to 80 KB.');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'The request body must be JSON.'); }
}

const textOf = (b) => { if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'Paste a request first.'); if (b.text.length > 60_000) throw new HttpError(413, 'That paste is too large.'); return b.text; };
const modeOf = (b) => (['rest', 'sdk', 'mcp'].includes(b.mode) ? b.mode : 'rest');

async function deps() {
  const out = { github: ghCached };
  if (process.env.PAYPAL_CLIENT_ID) out.lazy = { eventTypes, webhookCount };
  return out;
}

let whCount = { at: 0, n: null };
async function webhookCount() {
  if (whCount.n != null && Date.now() - whCount.at < 30_000) return whCount.n;
  const r = await ppCall({ method: 'GET', path: '/v1/notifications/webhooks' });
  const n = r.body?.webhooks?.length;
  if (typeof n === 'number') whCount = { at: Date.now(), n };
  return n;
}

let evCache = { at: 0, list: null };
async function eventTypes() {
  if (evCache.list && Date.now() - evCache.at < 3600_000) return evCache.list;
  const r = await ppCall({ method: 'GET', path: '/v1/notifications/webhooks-event-types' });
  const list = (r.body?.event_types ?? []).map((e) => e.name);
  if (list.length) evCache = { at: Date.now(), list };
  return list.length ? list : null;
}

const ghCache = new Map();
async function ghCached(product) {
  const hit = ghCache.get(product);
  if (hit && Date.now() - hit.at < 3600_000) return hit.v;
  const v = await compareWithGithub(product);
  ghCache.set(product, { at: Date.now(), v });
  return v;
}

async function annotate(result) {
  const g = async (req) => { try { await gate(req); return { ok: true }; } catch (e) { if (e instanceof GateError) return { ok: false, reason: e.message }; return { ok: false, reason: 'Could not decide whether this can run.' }; } };
  if (result.request && result.runnable?.ok) result.runnable = await g(result.request);
  if (result.corrected?.request) result.corrected.runnable = await g(result.corrected.request);
  return result;
}

/* ---------------------------------------------------------------- jobs */

async function dispatch(job) {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME && !process.env.CALLCHECK_INLINE) {
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    await new LambdaClient({ region: process.env.AWS_REGION }).send(new InvokeCommand({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ callcheckJob: job })) }));
  } else {
    setImmediate(() => runJob(job).catch(() => {}));
  }
}

async function patchJob(pk, fn) {
  const rec = (await S().get(pk)) ?? {};
  fn(rec);
  await S().put(pk, rec, 14 * 86400);
  return rec;
}

export async function runJob(job) {
  const pk = `job#${job.id}`;
  await patchJob(pk, (r) => { r.status = 'running'; r.startedAt = new Date().toISOString(); });
  // events are appended one after another: the job record is read, changed and written back each time
  let chain = Promise.resolve();
  const emitQ = (e) => { chain = chain.then(() => patchJob(pk, (r) => { r.events = [...(r.events ?? []), { ...e, at: Date.now() }].slice(-60); })).catch(() => {}); };
  try {
    if (job.kind === 'run') {
      const run = await runRequest({ request: job.request, predictions: job.predictions, repeat: job.repeat, repeatMode: job.repeatMode, text: job.text }, { emit: emitQ });
      await chain;
      const ids = new Set();
      for (const a of run.attempts) for (const id of [a.response.id, a.batchId, ...(a.terminal?.items ?? []).map((i) => i.id)]) if (id) ids.add(id);
      for (const id of ids) await S().put(`link#${id}`, { runId: job.id }, 14 * 86400);
      await patchJob(pk, (r) => { r.status = 'done'; r.result = run; r.finishedAt = new Date().toISOString(); });
      await S().push('meta#runs', { id: job.id, at: new Date().toISOString(), method: job.request.method, path: job.request.path, held: run.verdicts.filter((v) => v.ok === true).length, missed: run.verdicts.filter((v) => v.ok === false).length, product: run.product }, 30);
    } else if (job.kind === 'explain') {
      const d = await deps();
      const result = await check({ text: job.text, mode: job.mode, product: job.product }, d);
      const prior = job.runId ? (await S().get(`job#${job.runId}`))?.result : undefined;
      const out = await explain({ result, runResult: prior }, { ...d, onStep: (s) => emitQ({ t: 'tool', text: `${s.tool}` }) });
      await chain;
      await patchJob(pk, (r) => { r.status = 'done'; r.result = out; r.finishedAt = new Date().toISOString(); });
      if (!job.runId) await S().put(`explain#${job.key}`, out, 3600);
    }
  } catch (e) {
    await chain;
    await patchJob(pk, (r) => { r.status = 'error'; r.error = e instanceof GateError ? e.message : `Something went wrong: ${String(e.message).slice(0, 200)}`; r.finishedAt = new Date().toISOString(); });
  }
}

/* ------------------------------------------------------------- webhook */

async function webhook(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  const headers = lowerHeaders(event.headers);
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  let v;
  try { v = await verify({ headers, rawBody: raw, webhookId }); } catch (e) { v = { ok: false, reason: `verification error: ${e.message}` }; }
  let parsed = null; try { parsed = JSON.parse(raw); } catch { /* handled below */ }
  if (!v.ok || !parsed) {
    await S().push('meta#webhooks', { at: new Date().toISOString(), verified: false, reason: v.reason ?? 'body is not JSON', type: parsed?.event_type ?? null }, 60);
    return { statusCode: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'signature not verified' }) };
  }
  const seen = await S().get(`wh#${parsed.id}`);
  if (!seen) {
    await S().put(`wh#${parsed.id}`, { id: parsed.id, type: parsed.event_type, at: new Date().toISOString(), via: v.via }, 14 * 86400);
    await S().put(`whraw#${parsed.id}`, { headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith('paypal-'))), body: raw }, 86400);
  }
  return {
    statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, duplicate: !!seen }),
    // PayPal has its 200. Linking the event to a run happens after the response.
    after: async () => {
      if (seen) return;
      const ids = resourceIds(parsed); let runId = null;
      for (const id of ids) { const l = await S().get(`link#${id}`); if (l) { runId = l.runId; break; } }
      await S().push('meta#webhooks', { at: new Date().toISOString(), verified: true, via: v.via, id: parsed.id, type: parsed.event_type, summary: parsed.summary ?? null, ids, runId }, 60);
      if (runId) await patchJob(`job#${runId}`, (r) => { r.webhooks = [...(r.webhooks ?? []), { type: parsed.event_type, at: new Date().toISOString() }].slice(-20); });
    },
  };
}

/* -------------------------------------------------------------- router */

export async function route(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  const p = (event.rawPath ?? event.path ?? '/').replace(/\/+$/, '') || '/';
  const ip = event.requestContext?.http?.sourceIp ?? 'unknown';
  if (method === 'OPTIONS') return { statusCode: 204, headers: {}, body: '' };

  if (p === '/api/webhooks/paypal' && method === 'POST') return webhook(event);
  if (p === '/api/health') return J(200, { ok: true, version: VERSION, store: S().kind, paypal: !!process.env.PAYPAL_CLIENT_ID, bedrock: process.env.BEDROCK_MODEL ?? 'default', webhookConfigured: !!process.env.PAYPAL_WEBHOOK_ID });
  if (p === '/api/meta') return J(200, { version: VERSION, traps: TRAPS.length, examples: EXAMPLES.length, products: Object.entries(PRODUCTS).map(([id, x]) => ({ id, label: x.label })), sdk: { name: SDK_MAP.sdk, version: SDK_MAP.version, operations: SDK_MAP.ops.length }, limits: LIMITS, daily: DAILY });
  if (p === '/api/traps' && method === 'GET') return J(200, { traps: trapLibrary() }, { 'cache-control': 'public, max-age=300' });
  if (p === '/api/examples' && method === 'GET') return J(200, { examples: EXAMPLES }, { 'cache-control': 'public, max-age=300' });
  if (p === '/api/sources' && method === 'GET') return J(200, await sources({ fresh: event.queryStringParameters?.fresh === '1' }));
  if (p === '/api/runs' && method === 'GET') return J(200, { runs: await S().list('meta#runs') });
  if (p === '/api/webhooks' && method === 'GET') return J(200, { events: await S().list('meta#webhooks'), configured: !!process.env.PAYPAL_WEBHOOK_ID });

  if (p === '/api/check' && method === 'POST') {
    await limit('check', ip);
    const b = parseBody(event);
    try { return J(200, await annotate(await check({ text: textOf(b), mode: modeOf(b), product: b.product }, await deps()))); }
    catch (e) { if (e instanceof HttpError) throw e; return J(422, { error: e.message }); }
  }

  if (p === '/api/run' && method === 'POST') {
    const b = parseBody(event); const text = textOf(b); const mode = modeOf(b);
    if (mode === 'mcp') throw new HttpError(422, 'MCP setups have no request to run. The check already probes the endpoints.');
    let result;
    try { result = await check({ text, mode, product: b.product }, await deps()); } catch (e) { return J(422, { error: e.message }); }
    if (!result.runnable.ok) throw new HttpError(422, result.runnable.reason);
    const which = b.target === 'corrected' && result.corrected?.request ? result.corrected : null;
    const request = which ? which.request : result.request;
    const predictions = which ? (await check({ text: which.text, mode: 'rest', product: b.product }, await deps())).predictions : result.predictions;
    await limit('run', ip);
    const id = crypto.randomBytes(6).toString('hex');
    const repeat = b.repeat === 2 && (predictions.second || b.force) ? 2 : 1;
    await S().put(`job#${id}`, { id, kind: 'run', status: 'queued', createdAt: new Date().toISOString(), target: which ? 'corrected' : 'original', request: { method: request.method, path: request.path }, predictions, events: [] }, 14 * 86400);
    await dispatch({ id, kind: 'run', request, predictions, repeat, repeatMode: b.repeatMode, text });
    return J(202, { id, status: 'queued' });
  }

  if (p === '/api/explain' && method === 'POST') {
    const b = parseBody(event); const text = textOf(b); const mode = modeOf(b);
    const key = crypto.createHash('sha256').update(`${mode}|${b.product ?? ''}|${text}`).digest('hex').slice(0, 24);
    if (!b.runId && !b.fresh) { const hit = await S().get(`explain#${key}`); if (hit) { const id = 'c' + key.slice(0, 10); await S().put(`job#${id}`, { id, kind: 'explain', status: 'done', result: hit, cached: true, createdAt: new Date().toISOString() }, 3600); return J(200, { id, status: 'done', cached: true }); } }
    await limit('explain', ip);
    const id = crypto.randomBytes(6).toString('hex');
    await S().put(`job#${id}`, { id, kind: 'explain', status: 'queued', createdAt: new Date().toISOString(), events: [] }, 14 * 86400);
    await dispatch({ id, kind: 'explain', text, mode, product: b.product, runId: b.runId, key });
    return J(202, { id, status: 'queued' });
  }

  const m = /^\/api\/(run|job)\/([a-z0-9]{6,24})$/.exec(p);
  if (m && method === 'GET') {
    const rec = await S().get(`job#${m[2]}`);
    if (!rec) throw new HttpError(404, 'No such job. Results are kept for 14 days.');
    return J(200, rec);
  }

  const adm = /^\/api\/admin\/webhook\/([A-Za-z0-9-]+)$/.exec(p);
  if (adm && method === 'GET') {
    if (!process.env.ADMIN_TOKEN || event.headers?.['x-admin-token'] !== process.env.ADMIN_TOKEN) throw new HttpError(403, 'Admin token required.');
    const rec = await S().get(`whraw#${adm[1]}`);
    if (!rec) throw new HttpError(404, 'No stored delivery with that id.');
    return J(200, rec);
  }
  if (p === '/api/admin/webhook-latest' && method === 'GET') {
    if (!process.env.ADMIN_TOKEN || event.headers?.['x-admin-token'] !== process.env.ADMIN_TOKEN) throw new HttpError(403, 'Admin token required.');
    const ev = (await S().list('meta#webhooks')).find((e) => e.verified && e.id);
    return J(200, { id: ev?.id ?? null });
  }
  throw new HttpError(404, 'No such route.');
}

export async function handle(event) {
  if (event.callcheckJob) { await runJob(event.callcheckJob); return { statusCode: 200, body: 'job done' }; }
  try { return await route(event); } catch (e) {
    if (e instanceof HttpError) return J(e.status, { error: e.message });
    if (e instanceof GateError) return J(422, { error: e.message });
    return J(500, { error: 'Something went wrong on the server. Try again in a moment.', detail: String(e.message).slice(0, 160) });
  }
}

const sl = globalThis.awslambda;
export const handler = sl?.streamifyResponse
  ? sl.streamifyResponse(async (event, stream) => {
      if (event.callcheckJob) { await runJob(event.callcheckJob); stream.end(); return; }
      const r = await handle(event);
      stream = sl.HttpResponseStream.from(stream, { statusCode: r.statusCode, headers: r.headers ?? {} });
      stream.write(r.body || ''); stream.end();
      if (r.after) await r.after().catch(() => {});
    })
  : handle;
