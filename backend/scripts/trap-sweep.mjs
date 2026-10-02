// For every trap that has an example: check it, run it against the sandbox, and print predicted vs observed.
// Output is the proof that the verdicts are tested, not asserted. Usage: node scripts/trap-sweep.mjs [trapId ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '../../../../.env');
for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) { if (l && !l.startsWith('#') && l.includes('=')) { const i = l.indexOf('='); process.env[l.slice(0, i)] ??= l.slice(i + 1); } }
const { check } = await import('../src/check.js');
const { call } = await import('../src/paypal.js');
const lazy = {
  eventTypes: async () => ((await call({ method: 'GET', path: '/v1/notifications/webhooks-event-types' })).body?.event_types ?? []).map((e) => e.name),
  webhookCount: async () => (await call({ method: 'GET', path: '/v1/notifications/webhooks' })).body?.webhooks?.length,
};
const { runRequest } = await import('../src/run.js');
const { TRAPS } = await import('../src/traps.js');
const only = process.argv.slice(2);
const rows = [];
const traps = TRAPS.filter((t) => t.example && (!only.length || only.includes(t.id)));
const work = async (t) => {
  const r = await check({ text: t.example.text }, { lazy, env: { senderEmail: process.env.SENDER_EMAIL ?? 'sb-mixsn53098231@business.example.com' } });
  const row = { trap: t.id, example: t.example.name, verdict: r.verdict.headline, predicted: r.predictions.first?.text ?? '(none)', predicted2: r.predictions.second?.text ?? null, runnable: r.runnable.ok };
  if (!r.runnable.ok || !r.predictions.first) { row.skipped = r.runnable.reason ?? 'no prediction to test'; rows.push(row); return; }
  try {
    const run = await runRequest({ request: { ...r.request }, predictions: r.predictions, repeat: r.predictions.second ? 2 : 1, repeatMode: t.id === 'orders-request-id-reuse' ? 'changed' : 'same' }, {});
    row.verdicts = run.verdicts.map((v) => ({ attempt: v.attempt, predicted: v.predicted, observed: v.observed, ok: v.ok, mismatches: v.checks.filter((c) => !c.ok).map((c) => c.detail) }));
  } catch (e) { row.error = e.message; }
  rows.push(row);
};
// payouts poll for ~20s each, so run them side by side but keep the batch small
for (let i = 0; i < traps.length; i += 3) await Promise.all(traps.slice(i, i + 3).map(work));
for (const r of rows) {
  console.log(`\n${r.trap}  (${r.example})`);
  console.log(`  checker:   ${r.verdict}  Expect ${r.predicted}`);
  if (r.skipped) console.log(`  not run:   ${r.skipped}`);
  if (r.error) console.log(`  ERROR:     ${r.error}`);
  for (const v of r.verdicts ?? []) console.log(`  send ${v.attempt}:    predicted ${v.predicted}\n             observed  ${v.observed}\n             ${v.ok === null ? 'NO PREDICTION' : v.ok ? 'PREDICTION HELD' : 'PREDICTION MISSED: ' + v.mismatches.join('; ')}`);
}
const held = rows.flatMap((r) => r.verdicts ?? []).filter((v) => v.ok === true).length;
const missed = rows.flatMap((r) => r.verdicts ?? []).filter((v) => v.ok === false).length;
console.log(`\n${held} predictions held, ${missed} missed, ${rows.filter((r) => r.skipped).length} examples not run by policy or for lack of a prediction.`);
fs.writeFileSync(path.join(here, '../../evidence/trap-sweep.json'), JSON.stringify(rows, null, 2));
