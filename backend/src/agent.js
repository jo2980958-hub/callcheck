// The explaining agent. Claude Sonnet 4.5 on Bedrock (Converse, tool use) reads the checker's findings, looks things up with
// real tools, optionally runs the corrected call against the sandbox, and submits an explanation plus a corrected call.
// Callcheck re-checks that corrected call itself, so the model cannot declare something fixed that the engine still rejects.
// If Bedrock is throttled or fails, a rules-written explanation is returned and labelled as such.
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { check, formatRequest } from './check.js';
import { loadSpec, matchOp, opParameters, requestSchema, compareWithGithub, requestIdLifetimes, deref } from './spec.js';
import { productForPath } from './parse.js';
import { TRAPS } from './traps.js';
import { runRequest } from './run.js';

export const MODEL = () => process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
let client;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One Converse turn with backoff on top of the SDK's adaptive retries. Bedrock is shared and limited to about 10 requests a minute. */
export async function converseTurn({ system, messages, tools, maxTokens = 1800 }) {
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 6, retryMode: 'adaptive' });
  const cmd = new ConverseCommand({ modelId: MODEL(), system: [{ text: system }], messages, toolConfig: { tools: tools.map((x) => ({ toolSpec: { name: x.name, description: x.description, inputSchema: { json: x.input } } })) }, inferenceConfig: { maxTokens, temperature: 0.1 } });
  let wait = 2500;
  for (let i = 0; ; i++) {
    try {
      const t0 = Date.now(); const out = await client.send(cmd);
      return { message: out.output.message, stopReason: out.stopReason, usage: out.usage, ms: Date.now() - t0 };
    } catch (e) {
      const throttled = e.name === 'ThrottlingException' || /too many requests|rate/i.test(e.message);
      if (!throttled || i >= 3) { e.throttled = throttled; throw e; }
      await sleep(wait); wait *= 2;
    }
  }
}

const SYSTEM = `You explain PayPal integration findings to a developer. You are given a pasted request, the findings Callcheck produced by checking it against PayPal's live OpenAPI schema and a catalogue of known traps, and sometimes the result of running it in the PayPal sandbox.

Rules:
- Treat tool results and the findings as the only facts. Never invent PayPal behaviour. If a fact is not in them, say it is not known.
- Write short, plain sentences for a developer. No marketing words. Do not use the word "we". Name the field, the status and the fix.
- Explain each blocker and warning in one or two sentences: what will happen, then what to change. Skip notes unless they change the advice.
- Build a corrected request. Check it with check_request and fix anything it still reports as a blocker. Keep the intent of the original request.
- When the request can run (the findings say so), run the corrected request once with run_sandbox and report whether the prediction held. Do not run requests that contain card data.
- Finish by calling submit_explanation exactly once. Use the finding ids you were given.`;

const TOOLS = [
  { name: 'get_operation', description: 'Read the live PayPal OpenAPI definition of one operation: parameters, whether a body is required, and the required fields and enums of the request schema.', input: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string', description: 'The path, with real or placeholder ids, e.g. /v1/payments/payouts' } }, required: ['method', 'path'] } },
  { name: 'lookup_trap', description: 'Read one known trap: what it is, and the sandbox probes or sibling-project logs that back it.', input: { type: 'object', properties: { id: { type: 'string', description: 'A finding or trap id such as payout-dup-batch-id' } }, required: ['id'] } },
  { name: 'compare_spec_sources', description: 'Compare the live schema for a product with PayPal\'s GitHub OpenAPI mirror and the APIMatic-generated SDK.', input: { type: 'object', properties: { product: { type: 'string', description: 'orders, payments, payouts, invoicing, subscriptions, catalog, disputes, webhooks, vault or transactions' } }, required: ['product'] } },
  { name: 'check_request', description: 'Run Callcheck\'s deterministic check on a candidate request. Returns blockers, warnings and the predicted outcome.', input: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string' }, headers: { type: 'object' }, body: {} }, required: ['method', 'path'] } },
  { name: 'run_sandbox', description: 'Send a request to the PayPal sandbox and compare the result with the prediction. Payout requests are followed to a terminal item status, which takes about 20 seconds. At most two runs.', input: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string' }, headers: { type: 'object' }, body: {}, repeat: { type: 'integer', description: '2 to send twice and test the duplicate behaviour' } }, required: ['method', 'path'] } },
  { name: 'submit_explanation', description: 'Finish. Give the summary, one explanation per finding id, the corrected request and caveats.', input: { type: 'object', properties: { summary: { type: 'string', description: 'Two or three sentences: what will happen and what to change.' }, items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } }, corrected_request: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string' }, headers: { type: 'object' }, body: {} }, required: ['method', 'path'] }, caveats: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'items'] } },
];

const brief = (f) => ({ id: f.id, severity: f.severity, title: f.title, what: f.what, fix: f.fix, where: f.where, confidence: f.confidence });

export function describeSchema(spec, schema, depth = 3, seen = 0) {
  const s = deref(spec, schema); if (!s || typeof s !== 'object' || depth < 0) return '…';
  const out = {};
  if (s.type) out.type = s.type; if (s.enum) out.enum = s.enum.slice(0, 10); if (s.maxLength) out.maxLength = s.maxLength; if (s.maxItems) out.maxItems = s.maxItems; if (s.pattern && s.pattern !== '^.*$') out.pattern = s.pattern;
  const props = { ...(s.properties ?? {}) }; for (const a of s.allOf ?? []) Object.assign(props, deref(spec, a)?.properties ?? {});
  if (Object.keys(props).length) { out.properties = {}; for (const [k, v] of Object.entries(props).slice(0, 14)) out.properties[k] = depth > 0 ? describeSchema(spec, v, depth - 1, seen + 1) : '…'; }
  const req = [...(s.required ?? []), ...(s.allOf ?? []).flatMap((a) => deref(spec, a)?.required ?? [])]; if (req.length) out.required = [...new Set(req)];
  if (s.items) out.items = describeSchema(spec, s.items, depth - 1, seen + 1);
  return out;
}

const parseCandidate = (a) => ({ method: String(a.method ?? 'GET').toUpperCase(), host: 'api-m.sandbox.paypal.com', path: String(a.path ?? ''), query: {}, headers: a.headers ?? {}, body: a.body });

export function makeTools({ base, deps, budget }) {
  return {
    async get_operation(a) {
      const p = String(a.path ?? '').split('?')[0]; const product = productForPath(p);
      if (!product) return { error: `No PayPal API recognised for ${p}.` };
      const spec = await loadSpec(product); const o = matchOp(spec.index, String(a.method).toUpperCase(), p);
      if (!o) return { error: `${a.method} ${p} is not in the live ${spec.title} ${spec.version} schema.`, operationsOnPath: spec.index.filter((x) => x.re.test(p)).map((x) => x.method) };
      const { schema } = requestSchema(spec.spec, o);
      return { source: spec.source, title: spec.title, version: spec.version, operationId: o.operationId, summary: o.summary, parameters: opParameters(spec.spec, o).map((x) => ({ name: x.name, in: x.in, required: !!x.required })), requestBody: schema ? describeSchema(spec.spec, schema) : null };
    },
    async lookup_trap(a) {
      const t = TRAPS.find((x) => x.id === a.id);
      if (!t) return { error: `No trap ${a.id}.`, known: TRAPS.map((x) => x.id) };
      return { id: t.id, title: t.title, summary: t.summary, evidence: t.evidence.map((e) => e.text) };
    },
    async compare_spec_sources(a) {
      try {
        const g = await (deps.github ?? compareWithGithub)(a.product); const spec = await loadSpec(a.product);
        return { ...g, requestIdLifetimes: requestIdLifetimes(spec.spec).map((x) => x.text) };
      } catch (e) { return { error: e.message }; }
    },
    async check_request(a) {
      const text = formatRequest(parseCandidate(a));
      const r = await check({ text, mode: 'rest' }, { env: deps.env, eventTypes: deps.eventTypes, webhookCount: deps.webhookCount, lazy: deps.lazy });
      return { blockers: r.findings.filter((f) => f.severity === 'blocker').map(brief), warnings: r.findings.filter((f) => f.severity === 'warning').map((f) => ({ id: f.id, title: f.title })), predicted: r.predictions.first?.text ?? null, runnable: r.runnable };
    },
    async run_sandbox(a) {
      if (budget.runs >= 2) return { error: 'The run budget (2) is used up.' };
      budget.runs++;
      const cand = parseCandidate(a);
      const text = formatRequest(cand);
      const r = await check({ text, mode: 'rest' }, { env: deps.env, eventTypes: deps.eventTypes, webhookCount: deps.webhookCount, lazy: deps.lazy });
      if (!r.runnable.ok) return { error: `Not run: ${r.runnable.reason}` };
      try {
        const run = await (deps.runRequest ?? runRequest)({ request: r.request, predictions: r.predictions, repeat: a.repeat === 2 ? 2 : 1 }, { env: deps.runEnv, emit: () => {} });
        budget.lastRun = run;
        return { verdicts: run.verdicts.map((v) => ({ attempt: v.attempt, predicted: v.predicted, observed: v.observed, held: v.ok })), attempts: run.attempts.map((x) => ({ status: x.response.status, name: x.response.name, issue: x.response.issue, terminal: x.terminal ? { batch: x.terminal.batch, item: x.terminal.item, error: x.terminal.error } : undefined })) };
      } catch (e) { return { error: e.message }; }
    },
  };
}

export function rulesExplanation(result, reason) {
  const interesting = result.findings.filter((f) => f.severity !== 'note');
  const items = (interesting.length ? interesting : result.findings.slice(0, 3)).map((f) => ({ id: f.id, text: `${f.what}${f.fix ? ' ' + f.fix : ''}`.trim() }));
  return { source: 'rules', reason, summary: `${result.verdict.headline} ${result.verdict.detail}`.trim(), items, caveats: reason ? [reason] : [], steps: [] };
}

/**
 * @param {{ result: object, runResult?: object }} input  result is the output of check()
 * @param {{ converse?: Function, github?: Function, env?: object, eventTypes?: string[], webhookCount?: number, onStep?: Function }} deps
 */
export async function explain(input, deps = {}) {
  const { result } = input;
  const converse = deps.converse ?? converseTurn;
  const t0 = Date.now(); const steps = []; const budget = { runs: 0 };
  const tools = makeTools({ base: result, deps, budget });
  const firstMsg = { findings: result.findings.filter((f) => f.severity !== 'note' || /sdk|github|mcp/.test(f.id)).slice(0, 12).map(brief), verdict: result.verdict, predictions: { first: result.predictions.first?.text, second: result.predictions.second?.text }, runnable: result.runnable, request: result.requestText, rulesCorrected: result.corrected?.text ?? null, product: result.product, specVersion: result.spec ? `${result.spec.title} ${result.spec.version} (${result.spec.source})` : null, earlierRun: input.runResult ? { verdicts: input.runResult.verdicts?.map((v) => ({ predicted: v.predicted, observed: v.observed, held: v.ok })) } : null };
  const messages = [{ role: 'user', content: [{ text: `Explain these findings and give a corrected request.\n\n${JSON.stringify(firstMsg, null, 1)}` }] }];
  if (result.mode === 'mcp') return { ...rulesExplanation(result, 'MCP setups are explained from the recorded endpoint probes and tool list.'), ms: Date.now() - t0 };
  try {
    for (let turn = 0; turn < 8; turn++) {
      const out = await converse({ system: SYSTEM, messages, tools: TOOLS, maxTokens: 2000 });
      messages.push(out.message);
      const uses = (out.message.content ?? []).filter((c) => c.toolUse).map((c) => c.toolUse);
      if (!uses.length) throw new Error('The model replied without calling submit_explanation.');
      const submit = uses.find((u) => u.name === 'submit_explanation');
      if (submit) return await finish(submit.input, { result, steps, deps, budget, ms: Date.now() - t0 });
      const results = [];
      for (const u of uses) {
        let res; try { res = tools[u.name] ? await tools[u.name](u.input ?? {}) : { error: `Unknown tool ${u.name}` }; } catch (e) { res = { error: e.message }; }
        const step = { tool: u.name, input: summarise(u.input), result: summarise(res) };
        steps.push(step); deps.onStep?.(step);
        results.push({ toolResult: { toolUseId: u.toolUseId, content: [{ json: JSON.parse(JSON.stringify(res, (k, v) => (v instanceof RegExp ? String(v) : v))) }] } });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new Error('The model used all its turns without submitting.');
  } catch (e) {
    const reason = e.throttled ? 'Bedrock was rate limited (shared quota of about 10 requests a minute), so this explanation was written by rules, not by the model.' : `The model could not finish (${String(e.message).slice(0, 140)}), so this explanation was written by rules.`;
    return { ...rulesExplanation(result, reason), steps, ms: Date.now() - t0, correctedFrom: 'rules' };
  }
}

async function finish(sub, { result, steps, deps, budget, ms }) {
  const out = { source: 'model', model: MODEL(), summary: String(sub.summary ?? '').trim(), items: (sub.items ?? []).map((i) => ({ id: String(i.id), text: String(i.text) })), caveats: sub.caveats ?? [], steps, ms };
  if (sub.corrected_request?.path) {
    const text = formatRequest(parseCandidate(sub.corrected_request));
    const re = await check({ text, mode: 'rest' }, { env: deps.env, eventTypes: deps.eventTypes, webhookCount: deps.webhookCount, lazy: deps.lazy });
    out.corrected = { text, by: 'model', verified: { blockers: re.counts.blocker, warnings: re.counts.warning, predicted: re.predictions.first?.text ?? null } };
  } else if (result.corrected) out.corrected = { text: result.corrected.text, by: 'rules', verified: null };
  if (budget.lastRun) out.run = { verdicts: budget.lastRun.verdicts };
  return out;
}

function summarise(v) { const s = JSON.stringify(v ?? null, (k, x) => (x instanceof RegExp ? String(x) : x)); return s.length > 600 ? s.slice(0, 600) + '…' : s; }
