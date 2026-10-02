// "Where PayPal's own sources disagree": computed from the live schemas, the GitHub mirror, the SDK and the recorded probes.
import { PRODUCTS, loadSpec, compareWithGithub, requestIdLifetimes, codeTokens, indexOps } from './spec.js';
import { coverage, SDK_MAP } from './sdkcontract.js';
import { mcpSummary } from './mcp.js';
import { probe } from './evidence.js';

let cache = { at: 0, value: null };

export async function sources({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 30 * 60_000) return cache.value;
  const ids = Object.keys(PRODUCTS);
  const rows = await Promise.all(ids.map(async (id) => {
    const live = await loadSpec(id);
    const gh = await compareWithGithub(id);
    const sdk = coverage(live.index);
    return { product: id, label: PRODUCTS[id].label, live: gh.live, github: gh.github, missingFromGithub: gh.missingFromGithub ?? [], sdk: { covered: sdk.covered, total: sdk.total }, requestId: requestIdLifetimes(live.spec).map((x) => x.text) };
  }));
  const payouts = await loadSpec('payouts');
  const rt = payouts.spec.components.schemas.payout_item_request?.properties?.recipient_type;
  const value = {
    fetchedAt: new Date().toISOString(),
    products: rows,
    sdk: { name: SDK_MAP.sdk, version: SDK_MAP.version, operations: SDK_MAP.ops.length, controllers: [...new Set(SDK_MAP.ops.map((o) => o.controller))] },
    contradictions: [
      { topic: 'Payout per-item cap', note: 'Three numbers on three pages, none in the schema, none enforced by the sandbox.', values: [
        { source: 'PayPal Payouts FAQ', value: '$20,000' }, { source: 'PayPal fees page', value: 'USD 60,000 registered, 20,000 unregistered; GBP 50,000 and 15,000' }, { source: 'AI-Toolkit skill file', value: '$20,000 USD' }, { source: 'Live Payouts 1.9 schema', value: 'no cap stated' }, { source: 'Sandbox, 2 Oct 2026', value: '20,000.01 accepted (fee 14.00); sibling logs: 50,000 accepted', probe: probe('payout.cap.20000.01').text } ] },
      { topic: 'Payout recipient_type, the fourth value', note: `The live schema has no enum: recipient_type is a string of at most ${rt?.maxLength ?? 13} characters. Its prose lists ${codeTokens(rt?.description).join(', ')}.`, values: [
        { source: 'Live Payouts schema, prose', value: codeTokens(rt?.description).join(', ') }, { source: 'AI-Toolkit skill file', value: 'EMAIL, PHONE, PAYPAL_ID, VENMO_HANDLE' }, { source: 'Sandbox, VENMO_HANDLE with an email', value: '400 VALIDATION_ERROR', probe: probe('payout.type.venmo-handle').text }, { source: 'Sandbox, USER_HANDLE with a handle', value: '400 VALIDATION_ERROR', probe: probe('payout.user-handle.handle').text } ] },
      { topic: 'PayPal-Request-Id lifetime', note: 'Computed from the live schemas by reading the header description. Orders, Payments and Invoicing state no lifetime.', values: [
        ...rows.filter((r) => r.requestId.length).map((r) => ({ source: `Live ${r.label} schema`, value: [...new Set(r.requestId.map((t) => (/stores keys for/i.test(t) ? t.replace(/^.*(stores keys for [^.]*).*$/i, '$1') : 'no lifetime stated')))].join('; ') })),
        { source: 'APIMatic SDK 2.5.0 doc comment, createOrder', value: 'stores keys for 6 hours, up to 72 hours through an account manager' }, { source: 'PayPal requests page (per research notes)', value: '45 days' },
        { source: 'Sandbox, payouts', value: 'the header did not dedupe a payout at all', probe: probe('payout.request-id-only.second').text }, { source: 'Sandbox, invoices', value: 'the header did not dedupe an invoice either', probe: probe('invoice.request-id.second').text } ] },
      { topic: 'MCP streamable HTTP path', note: 'The quickstart says /http. It is /mcp.', values: [{ source: 'PayPal MCP quickstart', value: '/http' }, { source: 'Probe, sandbox host', value: '404 Not Found on /http, 401 on /mcp and /sse', probe: probe('mcp.mcp.sandbox.paypal.com/http').text }, { source: 'Probe, production host', value: 'the same', probe: probe('mcp.mcp.paypal.com/http').text }] },
      { topic: 'Tools reference', note: 'The docs list 33 tools and misspell two. The toolkit registers 47; the CLI exposes 28 with --tools=all.', values: [{ source: '/ai-tools/agent-tools', value: '33 rows, including list_product and list_transaction' }, { source: 'Toolkit source, shared/tools.ts', value: '47 tools, including list_products and list_transactions' }, { source: '@paypal/mcp 1.8.1 --tools=all', value: '28 tools' }] },
    ],
    mcp: mcpSummary(),
  };
  cache = { at: Date.now(), value };
  return value;
}
