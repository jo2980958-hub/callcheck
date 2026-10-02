// Checks an MCP client configuration for PayPal: a pasted JSON config, a URL, an `npx @paypal/mcp` command, or tool names.
import { MCP_TOOLS, MCP_COMMERCE_TOOLS, MCP_DOC_TYPOS, MCP_ABSENT } from './data/mcp-tools.js';
import { probe, doc } from './evidence.js';
import { closest } from './spec.js';

const NAMES = MCP_TOOLS.map((t) => t.name);
const TOOL_WORD = /\b[a-z]+(?:_[a-z]+)+\b/g;
const NOISE = new Set(['mcp_servers', 'mcp_remote', 'feature_flags', 'access_token', 'paypal_environment', 'client_id', 'client_secret', 'return_url', 'cancel_url']);

export function checkMcp(text) {
  const t = String(text ?? '');
  if (!t.trim()) throw new Error('Paste an MCP config, a URL, an npx command or a list of tool names.');
  const findings = []; const add = (f) => findings.push({ source: 'mcp', confidence: 'observed', ...f });

  // endpoints
  for (const m of t.matchAll(/https?:\/\/(mcp(?:\.sandbox)?\.paypal\.com)(\/[A-Za-z0-9_\-/.]*)?/g)) {
    const host = m[1]; const p = m[2] || '/';
    if (p === '/http' || p.startsWith('/http/')) add({ id: 'mcp-http-path', severity: 'blocker', title: `${host}${p} does not exist`, what: 'PayPal\'s quickstart documents /http for streamable HTTP. Both the sandbox and production hosts answer it with 404 Not Found. The real path is /mcp, which answers 401 until you send a token.', fix: `Use https://${host}/mcp, or https://${host}/sse for server-sent events.`, evidence: [probe('mcp.mcp.sandbox.paypal.com/http'), probe('mcp.mcp.sandbox.paypal.com/mcp')], predicts: { rank: 3, status: 404 }, patch: (txt) => txt.replace(`${host}/http`, `${host}/mcp`), where: m[0] });
    else if (p === '/' || p === '') add({ id: 'mcp-no-path', severity: 'warning', title: `${host} needs a path`, what: 'The server listens on /mcp (streamable HTTP) and /sse. The bare host has no MCP endpoint.', fix: `Use https://${host}/mcp.`, evidence: [probe('mcp.mcp.sandbox.paypal.com/mcp')], where: m[0], patch: (txt) => txt.replace(m[0], `https://${host}/mcp`) });
    else if (['/mcp', '/sse'].includes(p)) add({ id: 'mcp-endpoint-ok', severity: 'note', title: `${host}${p} exists`, what: 'It answers 401 invalid_token without a bearer token, which is the expected shape.', fix: 'Send Authorization: Bearer <token>. Tokens from client credentials last up to 8 hours; the server also offers OAuth 2.1 with dynamic client registration and refresh tokens at /.well-known/oauth-authorization-server.', evidence: [probe('mcp.mcp.sandbox.paypal.com/sse'), probe('mcp.mcp.sandbox.paypal.com/.well-known/oauth-authorization-server')], where: m[0], predicts: { rank: 9, status: 401 } });
  }
  if (/mcp\.paypal\.com/.test(t) && /sandbox/i.test(t) && !/mcp\.sandbox\.paypal\.com/.test(t)) add({ id: 'mcp-env-mismatch', severity: 'warning', title: 'Sandbox flag with the production host', what: 'The config mentions the sandbox but points at mcp.paypal.com, which is the live server.', fix: 'Use https://mcp.sandbox.paypal.com/mcp while testing.', evidence: [doc('PayPal quickstart: sandbox host mcp.sandbox.paypal.com, production host mcp.paypal.com.')], confidence: 'doc' });

  // the local CLI allowlist
  const cli = /@paypal\/mcp/.test(t);
  const toolsFlag = /--tools[= ]+([A-Za-z0-9_.,*]+)/.exec(t)?.[1];
  const named = [...new Set([...t.matchAll(TOOL_WORD)].map((m) => m[0]).filter((w) => !NOISE.has(w)))];
  if (cli && toolsFlag === 'all') {
    const wanted = named.filter((n) => NAMES.includes(n));
    const hidden = wanted.filter((n) => !MCP_TOOLS.find((x) => x.name === n).local);
    add({ id: 'mcp-tools-all', severity: hidden.length ? 'blocker' : 'warning', title: '--tools=all gives you 28 of 47 tools', what: `@paypal/mcp 1.8.1 checks --tools against a hard-coded list of 28 and expands "all" to those. The toolkit registers 47. ${hidden.length ? `Not reachable from this command: ${hidden.join(', ')}.` : 'The 19 missing include the recurring-invoice, reminder, update_* and delete_* tools.'}`, fix: 'Import @paypal/agent-toolkit directly (no allowlist), or use the remote server at https://mcp.sandbox.paypal.com/mcp, which is not limited by the CLI.', evidence: [doc('research/capability/FINDINGS.md section 1.5: read from the published dist/index.js of @paypal/mcp 1.8.1.'), sibling28()], confidence: 'doc', where: '--tools=all' });
  }
  if (cli && !/PAYPAL_ENVIRONMENT|--paypal-environment/.test(t)) add({ id: 'mcp-env-default', severity: 'note', title: 'The local server defaults to the sandbox, the toolkit to live', what: '@paypal/mcp defaults to SANDBOX when PAYPAL_ENVIRONMENT is unset. @paypal/agent-toolkit defaults its Context.sandbox flag to false, which is production. Opposite defaults in one codebase.', fix: 'Set PAYPAL_ENVIRONMENT=SANDBOX (CLI) or sandbox: true (toolkit) explicitly.', evidence: [doc('research/capability/FINDINGS.md section 2.3.')], confidence: 'doc' });

  // tool names
  for (const n of named) {
    if (MCP_DOC_TYPOS[n]) add({ id: 'mcp-doc-typo', severity: 'blocker', title: `${n} is a typo from PayPal's own docs`, what: `/ai-tools/agent-tools lists "${n}". The tool the server registers is ${MCP_DOC_TYPOS[n]}. A call to the documented spelling does not resolve.`, fix: `Use ${MCP_DOC_TYPOS[n]}.`, evidence: [doc('research/capability/FINDINGS.md section 5: the official page documents 33 of 47 tools and misspells list_products and list_transactions.')], confidence: 'doc', where: n, patch: (txt) => txt.replace(new RegExp(`\\b${n}\\b`, 'g'), MCP_DOC_TYPOS[n]) });
    else if (!NAMES.includes(n) && !MCP_COMMERCE_TOOLS.includes(n)) {
      const absent = MCP_ABSENT.find((a) => a.re.test(n));
      if (absent) add({ id: 'mcp-tool-absent', severity: 'blocker', title: `No MCP tool can ${absent.what}`, what: `${n} does not exist. PayPal's 47 tools (and 3 gated commerce tools) include nothing that could ${absent.what}.`, fix: `Call the REST API directly: ${absent.rest}.`, evidence: [doc('research/capability/FINDINGS.md section 1.6: no Payouts, Vault, FX, webhook or identity tools.')], confidence: 'doc', where: n });
      else {
        const near = closest(n, NAMES, 2);
        if (near.length) add({ id: 'mcp-unknown-tool', severity: 'warning', title: `${n} is not a PayPal tool name`, what: `It matches none of the 47 registered tools.`, fix: `Did you mean ${near.join(' or ')}?`, evidence: [doc('Names taken from typescript/src/shared/tools.ts in paypal/agent-toolkit.')], confidence: 'doc', where: n, patch: (txt) => txt.replace(new RegExp(`\\b${n}\\b`, 'g'), near[0]) });
      }
    } else if (MCP_COMMERCE_TOOLS.includes(n) && !/commerce:\s*true/.test(t)) add({ id: 'mcp-commerce-flag', severity: 'blocker', title: `${n} needs the commerce feature flag`, what: 'search_product, create_cart and checkout_cart exist only on the hosted server and only with the request header x-feature-flags: commerce:true. They sell gift cards, nothing else.', fix: 'Add --header "x-feature-flags: commerce:true" to the mcp-remote args.', evidence: [doc('PayPal /ai-tools/agent-tools: "These tools are for gift cards only for now."')], confidence: 'doc', where: n });
    else if (n === 'get_merchant_insights') add({ id: 'mcp-insights-sandbox', severity: 'blocker', title: 'get_merchant_insights is blocked in the sandbox', what: 'The toolkit throws "get_merchant_insights is not supported in sandbox mode" before any request is made.', fix: 'Do not plan a sandbox demo around it.', evidence: [doc('agent-toolkit shared/api.ts: if (method === \'get_merchant_insights\' && this.context.sandbox === true) throw.')], confidence: 'doc', where: n });
    else if (n === 'pay_order') add({ id: 'mcp-pay-order', severity: 'note', title: 'pay_order captures; it does not authorize', what: 'The tool displays as "Process payment for an authorized order" but calls POST /v2/checkout/orders/{id}/capture. No MCP tool authorizes or voids.', fix: 'Use REST for authorize-then-capture flows.', evidence: [doc('research/capability/FINDINGS.md section 1.4.')], confidence: 'doc', where: n });
  }
  // plain-language asks ("have the agent send a payout")
  const sentence = !/https?:|npx|mcpServers|[{}]/.test(t) && t.length < 400;
  if (sentence && !findings.some((f) => f.id === 'mcp-tool-absent')) {
    for (const a of MCP_ABSENT) {
      if (a.re.test(t) && !named.some((n) => a.re.test(n))) add({ id: 'mcp-tool-absent', severity: 'blocker', title: `No MCP tool can ${a.what}`, what: `PayPal's 47 tools include nothing that could ${a.what}.`, fix: `Call the REST API directly: ${a.rest}.`, evidence: [doc('research/capability/FINDINGS.md section 1.6: no Payouts, Vault, FX, webhook or identity tools.')], confidence: 'doc' });
    }
  }
  if (/mcp-remote|https?:\/\/mcp(?:\.sandbox)?\.paypal\.com/i.test(t) && !/Bearer|access[_-]?token|oauth|authorization/i.test(t)) add({ id: 'mcp-no-auth', severity: 'warning', title: 'No token in the config', what: 'The server answers 401 invalid_token without one. Without OAuth the client has nothing to send.', fix: 'Pass --header "Authorization: Bearer $TOKEN" (client-credentials tokens last up to 8 hours), or let an OAuth 2.1 client self-register and refresh.', evidence: [probe('mcp.mcp.sandbox.paypal.com/mcp')], where: 'config' });
  if (!findings.length) add({ id: 'mcp-nothing', severity: 'note', title: 'No MCP trap found in this text', what: 'No PayPal MCP host, @paypal/mcp command or known tool name was recognised.', fix: 'Paste the whole mcpServers block, the npx command, or the tool names you plan to call.', evidence: [], confidence: 'spec' });
  const order = { blocker: 0, warning: 1, note: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

function sibling28() { return { kind: 'sibling', project: 'dispute-defence', text: '@paypal/mcp with --tools=all and a real sandbox token: tools/list = 28 tools; the 3 dispute tools are list_disputes, get_dispute, accept_dispute_claim.' }; }

export function mcpSummary() {
  return { total: MCP_TOOLS.length, local: MCP_TOOLS.filter((t) => t.local).length, hidden: MCP_TOOLS.filter((t) => !t.local).map((t) => t.name), commerce: MCP_COMMERCE_TOOLS, typos: MCP_DOC_TYPOS };
}
