# Callcheck

Paste a PayPal API call. Callcheck says what will break in production, then runs the call in the PayPal sandbox to show it was right.

- **Live:** https://dxu7o8jhsy032.cloudfront.net
- **API (Lambda Function URL):** https://rotxuiq2ocpbv44m7zp34g7h2e0xtfui.lambda-url.us-east-1.on.aws/api/health
- **Licence:** MIT. Built for the PayPal AI Hackathon, prize target **Best Use of APIMatic**. Sandbox only: no real money moves and no card data is ever sent.
- Not affiliated with PayPal or APIMatic.

## What it does

1. You paste a **REST call** (curl, raw HTTP or `fetch()`), an **SDK snippet** (`ordersController.createOrder({ ... })`), or an **MCP setup** (an `mcpServers` block, an `npx @paypal/mcp` command, tool names).
2. It reads the call against **PayPal's live OpenAPI schema**, fetched from `https://developer.paypal.com/api/<product>/<version>/schema.json` for ten APIs, with a labelled snapshot only if that host is down. It does not use the GitHub mirror, which is stale: Invoicing is 2.6 with 16 paths there and 2.12.0 with 27 live.
3. It runs the call through **44 known traps**, each with a detector, a testable prediction and its evidence, and through the **APIMatic-generated SDK's own model schemas** as a second contract.
4. The verdict states the HTTP status it expects (the big number), what each finding means, and a corrected call shown as a diff.
5. **Run in the sandbox** sends the call (or the corrected call), follows a payout to its terminal item status, and prints *predicted* against *observed*. A retry-sensitive call can be sent twice to test the duplicate behaviour.
6. **Explain and correct with the agent**: Claude Sonnet 4.5 on Bedrock (Converse, tool use) reads the live definition, looks up traps, checks its own corrected call with the engine and may run it. If Bedrock is throttled it falls back to a rules explanation and says so.

The sibling integrations built in this repository are the **worked examples** (eight of them, each quoting its own build log). The recorded sandbox probes are the evidence.

## Where the traps come from, and how far they are verified

The catalogue was built from failures hit while building the other PayPal integrations in this repository (eight had code; `projects/channel3` was empty), then re-checked against the sandbox for this project. It was not copied from documentation. Where a trap rests on PayPal's docs instead, the entry says so.

- **44 traps. 30 have a runnable example, and the live suite ran those against the sandbox: 27 passed, 0 failed, 3 skipped** (card by policy, and 2 webhook examples because 9 of 10 webhook slots are in use). The sweep that preceded it held 39 of 39 predictions. This is what separates a verified contract from a list of warnings: each of those entries fires on real traffic and its prediction matched what PayPal did.
- The other 14 are not reproduced live. They are recorded from sibling runs (card vaulting, vault-token charges), blocked by policy (dispute writes, live host), or taken from PayPal's docs and source (most MCP entries, the 15,000-item batch limit). Each shows its evidence kind, so "Seen in the sandbox" and "From PayPal's docs" are never mixed up.

## Evidence it works

Full output is in [TEST-RESULTS.md](TEST-RESULTS.md). In short:

| Check | Result |
|---|---|
| Unit and in-process tests (`npm test`) | 65 pass |
| Live sandbox: every trap example run, prediction compared | 39 predictions held, 0 missed (sweep); `npm run test:sandbox` 27 pass, 0 fail, 3 skipped (card by policy, 2 webhook examples because 9 of 10 slots are used) |
| Deployed browser journey (check, run, agent) at 360 and 1280 | passes |
| Webhook: real PayPal delivery verified; 3 altered copies rejected | 401, 401, 401 |
| Accessibility script, local and deployed | 0 failing |
| Contrast, 166 pairs from the real hex values | 0 failing |

## How APIMatic is used, and where the boundary is

APIMatic is a **build-time** tool. The hackathon offer is the **Context Plugin for PayPal**, a set of skills that teach a coding agent to use the APIMatic-generated PayPal Server SDK. It is not a service with an endpoint.

| | When | What happens |
|---|---|---|
| Context Plugin | **Build time** | Installed with `npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview`. Claude Code pulled its TypeScript skills three times while the SDK-facing code and tests were written. Prompts, skills called and results: [BUILD-LOG.md](BUILD-LOG.md), transcripts in `evidence/plugin/`. |
| Generated SDK `@paypal/paypal-server-sdk` 2.5.0 | **Run time** | A dependency of the Lambda. Its generated model schemas are loaded and used to ask "would the SDK accept this body, and what would it put on the wire?", which finds fields the SDK silently drops and types the API forgives but the SDK refuses. An operation map is generated from the SDK source (`backend/scripts/build-sdk-map.mjs`). |
| APIMatic Transformer, validation, code generation, Code Sample API | **Not used** | They need an account Auth Key, and they check API *definitions* and generate code. None of them checks a request against a contract, so there is nothing to call at run time. The hackathon offer says the plugin needs no credentials; the API does. |

**Can APIMatic's API validate a request at run time? No.** I read their documentation, sitemap and API behaviour (`api.apimatic.io/api-entities` answers 405 to a GET, the root 404s), and the services that exist validate spec documents. So the plugin and the generated SDK are the integration, and Callcheck says exactly that.

What the plugin made visible about itself: the SDK has **40 operations** (Orders 8, Payments 7, Subscriptions 17, Transaction Search 2, Vault 6). It has **none** for Payouts, Invoicing, Disputes, Webhooks or Catalog, which is where this repository's integrations hit most of their problems. It is generated from an earlier Orders schema than live 2.36. Every check reports this per call.

Plugin usage evidence, summarised (details in BUILD-LOG.md):

| Run | Prompt asked for | Skills the transcript shows it calling | Outcome |
|---|---|---|---|
| 1 | How to install, construct the client, pass `PayPal-Request-Id`, handle errors | `typescript-getting-started`, then the client-initialization, authentication, calling-endpoints and error-handling skill files | `paypalRequestId` is an operation argument, not a request option; credentials property is `clientCredentialsAuthCredentials`; non-2xx throws `ApiError` or a subclass |
| 2 | `scripts/sdk-vs-rest.mjs` | getting-started, client-initialization, authentication, calling-endpoints, error-handling, models | Script written and run: Request-Id replay returned the first order (200, same id) through the SDK; breakdown mismatch is 422 `AMOUNT_MISMATCH` as a generated `CustomError` |
| 3 | `test/sdk.test.js` | testing, models, calling-endpoints | 6 tests, passing first time, now part of `npm test` |

The Context Plugin installer sends anonymous usage data (plugin id, editor, OS, Node version, approximate location) unless `DO_NOT_TRACK=1`. I left it on and note it here.

## Where PayPal's own sources disagree (computed live on the Sources page)

- Payout per-item cap: $20,000, or USD 60,000 / 20,000, or $20,000; the live schema states none; the sandbox accepted 20,000.01 and, in a sibling run, 50,000.
- `recipient_type`: the live Payouts 1.9 schema has **no enum**. Its prose lists EMAIL, PHONE, PAYPAL_ID, USER_HANDLE; PayPal's AI-Toolkit skill file says VENMO_HANDLE. (An earlier note in this repository said the schema enum was three values; the live schema shows otherwise.)
- `PayPal-Request-Id` lifetime: 30 days (Payouts), 72 hours (Catalog, Subscriptions), 3 hours (Vault), nothing stated (Orders, Payments, Invoicing), 6 hours in the SDK's doc comment. In the sandbox the header did not deduplicate a payout or an invoice at all.
- MCP: the quickstart's `/http` path is a 404; `/mcp` is a 401. `--tools=all` exposes 28 of 47 tools. The docs list 33 and misspell two.

## Findings that corrected my own notes

GBP payouts **settle** here (an older note said they fail). `/v1/reporting/transactions` returned 200, not 403, on 2 October 2026. A DENIED payout batch does **not** hold its `sender_batch_id`. Two sibling logs disagreed on a bogus PAYPAL_ID payout; the recorded run says batch DENIED. All are in BUILD-LOG.md with the probe ids.

## Stack

React 18 + Vite on S3 and CloudFront. One Lambda (Node 22, Function URL, no API Gateway) holds the PayPal secret. DynamoDB on-demand. Bedrock `us.anthropic.claude-sonnet-4-5-20250929-v1:0` through Converse with tool use. Plain `aws` CLI in `deploy.sh`. Geist and Geist Mono, self-hosted (SIL OFL).

```
backend/src/spec.js        live schema loader, operation index, GitHub comparison
backend/src/validate.js    JSON Schema validator for the OpenAPI subset PayPal uses
backend/src/traps.js       the catalogue: detector, prediction, evidence per trap
backend/src/check.js       orchestration, verdict, corrected call
backend/src/sdkcontract.js the APIMatic-generated SDK as a second contract
backend/src/mcp.js         MCP configuration checks
backend/src/run.js         sandbox gate, runner, polling, predicted-against-observed
backend/src/agent.js       Bedrock tool-use agent with a rules fallback
backend/src/webhook.js     signature verification (RSA-SHA256 over id|time|webhookId|crc32)
backend/src/handler.js     routes; jobs run as asynchronous self-invocations
```

## Safety of "run it for me"

The runner holds the PayPal sandbox secret, so it refuses by default. It never sends card data; never runs dispute writes, captures, refunds or voids (those ids belong to other projects); creates and deletes nothing in the shared webhook list except a throwaway example.com webhook that it deletes at once; runs order, invoice and plan actions only on fresh fixtures it creates; limits payouts to 3 items and 20,000.01 each (large amounts only to unregistered `callcheck-*@example.com` addresses, cancelled afterwards so the money returns); and rate-limits per address and per day. Pasted Authorization headers are dropped before anything is stored.

## Webhook

`POST /api/webhooks/paypal` verifies the signature locally (certificate URL must be https on paypal.com, one-hour replay window), stores the event, answers **200 immediately**, and links the event to its run afterwards. Altered deliveries get 401. Registration reuses an existing webhook for this URL and never deletes another project's.

## Idempotency

Callcheck's own sandbox calls use `PayPal-Request-Id` where PayPal honours it, and treat the duplicate refusals as success: payouts answer a repeated `sender_batch_id` with 400 and a link to the original batch; invoices answer a repeated `invoice_number` with 422 `DUPLICATE_INVOICE_NUMBER`. Both are traps in the catalogue, with the sandbox runs that show them.

## Accessibility, measured

Colours are tokens in `frontend/src/styles.css`; `npm run contrast` reads them and checks every pair. Text needs 4.5:1 here (the large-text allowance is never relied on), borders and focus rings 3:1. Selection:

| Pair | Light | Dark |
|---|---|---|
| Body text on surface | #15171c on #ffffff: **17.93:1** | #e8ebf0 on #101216: **15.69:1** |
| Muted text on surface | #4a5160 on #ffffff: **7.96:1** | #a2aaba on #101216: **8.03:1** |
| Muted text on surface2 | #4a5160 on #eef0f5: **6.98:1** | #a2aaba on #171a20: **7.46:1** |
| Link and accent text on surface | #4b35c8 on #ffffff: **7.95:1** | #a99bff on #101216: **7.87:1** |
| Button label on primary button | #ffffff on #4b35c8: **7.95:1** | #0b0a14 on #a99bff: **8.26:1** |
| Selected tab text on accent tint | #4b35c8 on #e9e6fb: **6.50:1** | #a99bff on #211d40: **6.71:1** |
| blocker text on surface | #b3261e on #ffffff: **6.54:1** | #ff8f85 on #101216: **8.50:1** |
| blocker text on its tint | #b3261e on #fcebe9: **5.66:1** | #ff8f85 on #2a1412: **7.89:1** |
| warn text on surface | #8a5300 on #ffffff: **6.33:1** | #f2be5c on #101216: **10.98:1** |
| warn text on its tint | #8a5300 on #fbf0da: **5.60:1** | #f2be5c on #2b2108: **9.29:1** |
| ok text on surface | #0e6b3c on #ffffff: **6.59:1** | #6fdb9f on #101216: **10.99:1** |
| ok text on its tint | #0e6b3c on #e2f4ea: **5.76:1** | #6fdb9f on #0f2a1b: **9.00:1** |
| note text on surface | #3b5a8c on #ffffff: **6.94:1** | #9db6e3 on #101216: **9.14:1** |
| note text on its tint | #3b5a8c on #e8eef8: **5.95:1** | #9db6e3 on #14213a: **7.82:1** |
| Primary text in code block | #15171c on #f0f1f6: **15.90:1** | #e8ebf0 on #0c0e12: **16.16:1** |
| Placeholder (muted) on code block | #4a5160 on #f0f1f6: **7.06:1** | #a2aaba on #0c0e12: **8.27:1** |
| Syntax key on code block | #4b35c8 on #f0f1f6: **7.05:1** | #c4b5ff on #0c0e12: **10.49:1** |
| Syntax str on code block | #0b6b3a on #f0f1f6: **5.86:1** | #8fe3b0 on #0c0e12: **12.68:1** |
| Syntax num on code block | #8a4b00 on #f0f1f6: **6.03:1** | #ffc37d on #0c0e12: **12.28:1** |
| Syntax lit on code block | #a3205e on #f0f1f6: **6.36:1** | #ff9fcb on #0c0e12: **10.19:1** |
| Syntax kw on code block | #0b5e8e on #f0f1f6: **6.19:1** | #7ccbff on #0c0e12: **10.89:1** |
| Syntax verb on code block | #15171c on #f0f1f6: **15.90:1** | #f2f4f8 on #0c0e12: **17.54:1** |
| Syntax url on code block | #1f4fa3 on #f0f1f6: **6.88:1** | #9cc2ff on #0c0e12: **10.65:1** |
| Syntax hdr on code block | #4b35c8 on #f0f1f6: **7.05:1** | #c4b5ff on #0c0e12: **10.49:1** |
| Syntax flag on code block | #0b5e8e on #f0f1f6: **6.19:1** | #7ccbff on #0c0e12: **10.89:1** |
| Syntax com on code block | #5b6272 on #f0f1f6: **5.42:1** | #8f98aa on #0c0e12: **6.66:1** |
| Syntax pun on code block | #4a5160 on #f0f1f6: **7.06:1** | #b8c0ce on #0c0e12: **10.55:1** |
| Syntax str on added line | #0b6b3a on #dff3e7: **5.70:1** | #8fe3b0 on #10291b: **10.17:1** |
| Syntax str on removed line | #0b6b3a on #fbe6e3: **5.52:1** | #8fe3b0 on #2d1613: **11.15:1** |
| Syntax com on added line | #5b6272 on #dff3e7: **5.27:1** | #8f98aa on #10291b: **5.34:1** |
| Syntax com on removed line | #5b6272 on #fbe6e3: **5.10:1** | #8f98aa on #2d1613: **5.86:1** |
| Syntax num on added line | #8a4b00 on #dff3e7: **5.87:1** | #ffc37d on #10291b: **9.86:1** |
| Syntax lit on removed line | #a3205e on #fbe6e3: **5.99:1** | #ff9fcb on #2d1613: **8.96:1** |
| Diff plus mark on added line | #0e6b3c on #dff3e7: **5.68:1** | #6fdb9f on #10291b: **9.08:1** |
| Diff minus mark on removed line | #b3261e on #fbe6e3: **5.46:1** | #ff8f85 on #2d1613: **7.70:1** |
| Input border against surface (UI, 3:1) | #6f7686 on #ffffff: **4.55:1** | #7c8596 on #101216: **5.05:1** |
| Input border against code block (UI, 3:1) | #6f7686 on #f0f1f6: **4.04:1** | #7c8596 on #0c0e12: **5.20:1** |
| Focus ring against page (UI, 3:1) | #4b35c8 on #f5f5f8: **7.30:1** | #c3b8ff on #090a0d: **10.95:1** |
| Focus ring against surface (UI, 3:1) | #4b35c8 on #ffffff: **7.95:1** | #c3b8ff on #101216: **10.37:1** |

All 166 pairs are in `evidence/contrast.md`. `scripts/a11y-check.mjs` also measures, in a real browser: every control at least 28 by 28 px, every control named, smallest text 12 px (floor 10), a 2 px focus outline on every keyboard tab stop, no horizontal scroll at 200% text or 320 px wide, and nothing conveyed by colour alone (severity and diff changes carry words, shapes and +/- marks).

## Run it locally

```
cp ../../.env backend/.env     # PayPal sandbox credentials; never committed
npm --prefix backend install && npm --prefix frontend install
node backend/dev-server.js     # API on :18742, same handler as the Lambda
npm --prefix frontend run dev  # UI on :15742
npm test                       # 65 offline tests
npm run test:sandbox           # live: runs every trap example against the sandbox
./deploy.sh                    # account 854924711083, us-east-1
```

## Left for you

- **Claim the APIMatic subscription**: the Google Form (Company or organisation, domain, which subscription) needs your details; I did not fill it in. Link: https://docs.google.com/forms/d/e/1FAIpQLScc2oCgAFACm7d6H3R4mgzv-O34DdyVnLIBNiwmUNggr_-hhA/viewform
- Submit on Devpost and record the video. Rotate the sandbox credentials afterwards.
- The webhook slots are at 9 of 10. Another project taking the last one will stop new registrations (`deploy.sh` says so rather than failing).

## Honest limits

Sandbox runs use raw REST; the SDK is the second contract, not the transport. The agent can fall back to rules. Eight of nine sibling folders had code (`projects/channel3` was empty). Verdicts marked "recorded" (card vaulting, vault-token charges) are quotes from sibling runs, not re-run, by policy.
