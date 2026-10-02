import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMcp, mcpSummary } from '../src/mcp.js';
import { MCP_TOOLS } from '../src/data/mcp-tools.js';

const ids = (t) => checkMcp(t).map((f) => f.id);
test('47 tools, 28 reachable from the local CLI, 19 hidden', () => {
  const s = mcpSummary(); assert.equal(s.total, 47); assert.equal(s.local, 28); assert.equal(s.hidden.length, 19);
  assert.ok(s.hidden.includes('create_recurring_series')); assert.ok(!MCP_TOOLS.find((t) => t.name === 'list_products').local === false);
});
test('/http is a blocker with a patch to /mcp', () => {
  const f = checkMcp('npx mcp-remote https://mcp.sandbox.paypal.com/http').find((x) => x.id === 'mcp-http-path');
  assert.equal(f.severity, 'blocker'); assert.equal(f.patch('https://mcp.sandbox.paypal.com/http'), 'https://mcp.sandbox.paypal.com/mcp');
});
test('--tools=all warns, and blocks when a hidden tool is named', () => {
  const a = checkMcp('npx -y @paypal/mcp --tools=all').find((x) => x.id === 'mcp-tools-all'); assert.equal(a.severity, 'warning');
  const b = checkMcp('npx -y @paypal/mcp --tools=all and then create_recurring_series').find((x) => x.id === 'mcp-tools-all'); assert.equal(b.severity, 'blocker');
});
test('documentation typos, absent tools and gated commerce tools', () => {
  assert.deepEqual(ids('list_product list_transaction').filter((x) => x === 'mcp-doc-typo').length, 2);
  assert.ok(ids('the agent should create_payout').includes('mcp-tool-absent'));
  assert.ok(ids('call search_product').includes('mcp-commerce-flag'));
  assert.ok(!ids('call search_product with x-feature-flags: commerce:true').includes('mcp-commerce-flag'));
  assert.ok(ids('get_merchant_insights').includes('mcp-insights-sandbox'));
});
test('empty input is an error that says what to paste', () => { assert.throws(() => checkMcp('  '), /Paste an MCP config/); });
