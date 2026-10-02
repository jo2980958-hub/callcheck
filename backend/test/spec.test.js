import test from 'node:test';
import assert from 'node:assert/strict';
import { offline } from './helpers.js';
import { loadSpec, clearSpecCache, setFetch, requestIdLifetimes, compareWithGithub, closest, PRODUCTS } from '../src/spec.js';

test('live fetch is used when reachable and labelled live', async () => {
  clearSpecCache();
  setFetch(async (url) => ({ ok: true, json: async () => ({ info: { title: 'Fake', version: '9' }, paths: { '/a': { get: { operationId: 'x' } } } }), url }));
  const s = await loadSpec('webhooks', { force: true });
  assert.equal(s.source, 'live'); assert.equal(s.version, '9'); assert.equal(s.pathCount, 1);
});
test('an unreachable host falls back to the bundled snapshot and says so', async () => {
  offline();
  const s = await loadSpec('payouts', { force: true });
  assert.equal(s.source, 'snapshot'); assert.equal(s.title, 'Payouts'); assert.ok(s.note);
});
test('unknown product names list the valid ones', async () => {
  await assert.rejects(() => loadSpec('nope'), /Pick one of: orders/);
});
test('Request-Id lifetime statements are read from the live schemas', async () => {
  offline();
  const payouts = requestIdLifetimes((await loadSpec('payouts', { force: true })).spec);
  assert.ok(payouts.some((x) => x.amount === 30 && x.unit === 'day'));
  const vault = requestIdLifetimes((await loadSpec('vault', { force: true })).spec);
  assert.ok(vault.some((x) => x.amount === 3 && x.unit === 'hour'));
});
test('GitHub comparison reports missing live paths', async () => {
  offline();
  setFetch(async (url) => {
    if (url.includes('raw.githubusercontent')) return { ok: true, json: async () => ({ info: { title: 'Invoices', version: '2.6' }, paths: { '/v2/invoicing/invoices': {} } }) };
    throw new Error('offline');
  });
  const c = await compareWithGithub('invoicing');
  assert.equal(c.github.version, '2.6'); assert.equal(c.github.paths, 1); assert.ok(c.missingFromGithub.length > 20);
  offline();
});
test('closest suggests near names only', () => {
  assert.deepEqual(closest('list_product', ['list_products', 'get_order'], 1), ['list_products']);
  assert.deepEqual(closest('zzzzzzzz', ['abc'], 1), []);
  assert.equal(Object.keys(PRODUCTS).length, 10);
});
