import test from 'node:test';
import assert from 'node:assert/strict';
import { offline, ENV } from './helpers.js';
import { check } from '../src/check.js';
import { explain, rulesExplanation } from '../src/agent.js';
import { TRAPS } from '../src/traps.js';
offline();

const example = (id) => TRAPS.find((t) => t.id === id).example.text;
const tu = (name, input, id = name + '1') => ({ message: { role: 'assistant', content: [{ toolUse: { toolUseId: id, name, input } }] }, stopReason: 'tool_use' });

test('the agent calls real tools, then submits; its corrected call is re-checked by the engine', async () => {
  const result = await check({ text: example('invoice-number-length') }, { env: ENV });
  const calls = [];
  const script = [
    tu('get_operation', { method: 'POST', path: '/v2/invoicing/invoices' }),
    tu('lookup_trap', { id: 'invoice-number-length' }),
    tu('check_request', { method: 'POST', path: '/v2/invoicing/invoices', headers: { 'Content-Type': 'application/json' }, body: { detail: { invoice_number: 'SHORT-1', currency_code: 'USD' }, invoicer: { business_name: 'a' }, primary_recipients: [{ billing_info: { email_address: 'a@b.co' } }], items: [{ name: 'p', quantity: '1', unit_amount: { currency_code: 'USD', value: '1.00' } }] } }),
    tu('submit_explanation', { summary: 'The invoice number is too long.', items: [{ id: 'invoice-number-length', text: 'Shorten it.' }], corrected_request: { method: 'POST', path: '/v2/invoicing/invoices', headers: { 'Content-Type': 'application/json' }, body: { detail: { invoice_number: 'SHORT-1', currency_code: 'USD' }, invoicer: { business_name: 'a' }, primary_recipients: [{ billing_info: { email_address: 'a@b.co' } }], items: [{ name: 'p', quantity: '1', unit_amount: { currency_code: 'USD', value: '1.00' } }] } } }),
  ];
  let i = 0;
  const converse = async ({ messages }) => { calls.push(messages.length); return script[i++]; };
  const out = await explain({ result }, { converse, env: ENV });
  assert.equal(out.source, 'model');
  assert.deepEqual(out.steps.map((s) => s.tool), ['get_operation', 'lookup_trap', 'check_request']);
  assert.match(out.steps[0].result, /invoice_number/);
  assert.equal(out.corrected.verified.blockers, 0);
});

test('a model that claims a fix the engine still rejects is told so', async () => {
  const result = await check({ text: example('invoice-number-length') }, { env: ENV });
  const bad = { method: 'POST', path: '/v2/invoicing/invoices', headers: { 'Content-Type': 'application/json' }, body: { detail: { invoice_number: 'X'.repeat(30) }, invoicer: { business_name: 'a' }, primary_recipients: [{ billing_info: { email_address: 'a@b.co' } }], items: [{ name: 'p', quantity: '1', unit_amount: { currency_code: 'USD', value: '1.00' } }] } };
  const out = await explain({ result }, { converse: async () => tu('submit_explanation', { summary: 'Fixed.', items: [], corrected_request: bad }), env: ENV });
  assert.ok(out.corrected.verified.blockers >= 1);
});

test('throttling falls back to a rules explanation that says so', async () => {
  const result = await check({ text: example('payout-self-pay') }, { env: ENV });
  const err = Object.assign(new Error('Too many requests'), { throttled: true, name: 'ThrottlingException' });
  const out = await explain({ result }, { converse: async () => { throw err; }, env: ENV });
  assert.equal(out.source, 'rules'); assert.match(out.reason, /rate limited/); assert.ok(out.items.length);
});

test('a model that never submits also falls back, with the reason', async () => {
  const result = await check({ text: example('payout-self-pay') }, { env: ENV });
  const out = await explain({ result }, { converse: async () => ({ message: { role: 'assistant', content: [{ text: 'done' }] }, stopReason: 'end_turn' }), env: ENV });
  assert.equal(out.source, 'rules'); assert.match(out.reason, /submit_explanation/);
});

test('the run tool refuses requests the gate refuses, and the budget caps runs at two', async () => {
  const result = await check({ text: example('payout-dup-batch-id') }, { env: ENV });
  const runs = [];
  const runRequest = async (inp) => { runs.push(inp); return { verdicts: [{ attempt: 1, predicted: 'x', observed: 'y', ok: true }], attempts: [{ response: { status: 201 } }] }; };
  const run = { method: 'POST', path: '/v1/payments/payouts', headers: { 'Content-Type': 'application/json' }, body: { sender_batch_header: { sender_batch_id: 'a' }, items: [{ recipient_type: 'EMAIL', amount: { value: '1.00', currency: 'USD' }, receiver: 'sb-patient@personal.example.com' }] } };
  const script = [tu('run_sandbox', run, 'a'), tu('run_sandbox', run, 'b'), tu('run_sandbox', run, 'c'), tu('submit_explanation', { summary: 's', items: [] })];
  let i = 0;
  const out = await explain({ result }, { converse: async () => script[i++], env: ENV, runRequest });
  assert.equal(runs.length, 2);
  assert.match(out.steps[2].result, /budget/);
});

test('rulesExplanation lists blockers and warnings, not notes', async () => {
  const result = await check({ text: example('payout-mixed-currency') }, { env: ENV });
  const r = rulesExplanation(result, 'because');
  assert.ok(r.items.every((i) => result.findings.find((f) => f.id === i.id)?.severity !== 'note'));
});
