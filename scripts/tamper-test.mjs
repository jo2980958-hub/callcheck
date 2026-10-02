// Replays a REAL stored PayPal delivery against the deployed listener: once untouched, once with one character changed.
// Usage: node scripts/tamper-test.mjs   (reads deploy-output.json and .deploy-state/admin-token)
import fs from 'node:fs';
const out = JSON.parse(fs.readFileSync('deploy-output.json', 'utf8'));
const admin = fs.readFileSync('.deploy-state/admin-token', 'utf8').trim();
const U = out.functionUrl;
const latest = await (await fetch(`${U}/api/admin/webhook-latest`, { headers: { 'x-admin-token': admin } })).json();
if (!latest.id) throw new Error('No verified delivery stored yet. Run a payout first.');
const raw = await (await fetch(`${U}/api/admin/webhook/${latest.id}`, { headers: { 'x-admin-token': admin } })).json();
const post = async (label, body, headers) => {
  const t0 = Date.now(); const r = await fetch(`${U}/api/webhooks/paypal`, { method: 'POST', headers, body });
  console.log(`${label.padEnd(34)} HTTP ${r.status} in ${Date.now() - t0} ms  ${(await r.text()).slice(0, 80)}`);
  return r.status;
};
console.log(`stored delivery ${latest.id}  ${JSON.parse(raw.body).event_type}`);
const original = await post('1. original, untouched', raw.body, raw.headers);
const tampered = await post('2. one character changed', raw.body.replace('"id"', '"Id"'), raw.headers);
const amount = await post('3. status text edited', raw.body.replace(/SUCCEEDED|SUCCESS/, 'FAILED'), raw.headers);
const stripped = await post('4. signature header removed', raw.body, Object.fromEntries(Object.entries(raw.headers).filter(([k]) => k !== 'paypal-transmission-sig')));
console.log(tampered === 401 && amount === 401 && stripped === 401 ? 'PASS: every altered delivery was rejected with 401' : 'FAIL: an altered delivery was accepted');
console.log(`(the untouched replay answered ${original}: 200 while inside the one-hour replay window, 401 after it)`);
