// Live: every trap that has an example is checked, run against the PayPal sandbox, and its prediction compared with what happened.
// Needs ../../../.env. Run with: npm run test:sandbox
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
for (const l of fs.readFileSync(path.join(here, '../../../../.env'), 'utf8').split('\n')) if (l && !l.startsWith('#') && l.includes('=')) { const i = l.indexOf('='); process.env[l.slice(0, i)] ??= l.slice(i + 1); }
const { check } = await import('../src/check.js');
const { runRequest } = await import('../src/run.js');
const { TRAPS } = await import('../src/traps.js');
const { call } = await import('../src/paypal.js');
const lazy = { eventTypes: async () => ((await call({ method: 'GET', path: '/v1/notifications/webhooks-event-types' })).body?.event_types ?? []).map((e) => e.name), webhookCount: async () => (await call({ method: 'GET', path: '/v1/notifications/webhooks' })).body?.webhooks?.length };

for (const t of TRAPS.filter((x) => x.example)) {
  test(`${t.id}: ${t.example.name}`, { timeout: 150000 }, async (ctx) => {
    const r = await check({ text: t.example.text }, { lazy, env: { senderEmail: 'sb-mixsn53098231@business.example.com' } });
    if (!r.runnable.ok || !r.predictions.first) return ctx.skip(r.runnable.reason ?? 'no prediction to test');
    let run;
    try { run = await runRequest({ request: r.request, predictions: r.predictions, repeat: r.predictions.second ? 2 : 1, repeatMode: t.id === 'orders-request-id-reuse' ? 'changed' : 'same' }, {}); }
    catch (e) { if (e.name === 'GateError') return ctx.skip(e.message); throw e; }
    for (const v of run.verdicts) assert.equal(v.ok, true, `send ${v.attempt}: predicted ${v.predicted}; observed ${v.observed}; ${v.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`);
  });
}
