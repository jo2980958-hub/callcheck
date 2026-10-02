# BUILD-LOG: Callcheck

Project 10 of 10, PayPal AI Hackathon (deadline 12 Nov 2026). Prize target: Best Use of APIMatic. Newest entries at the bottom.

## 2026-10-02 start: what APIMatic is, read before designing

- The hackathon page offers the **Context Plugin for PayPal**: `npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview`. No credentials needed.
- The plugin is **skills for the APIMatic-generated PayPal Server SDK** (`@paypal/paypal-server-sdk` 2.5.0), one skill set per language (csharp, java, php, python, ruby, typescript), 8 skills each: getting-started, client-initialization, authentication, calling-endpoints, models, error-handling, configuration-resilience, testing. It is knowledge for a coding agent. It is not a service and has no endpoint.
- The SDK has **40 operations in five controllers**: Orders (8), Payments (7), Subscriptions (17), Transaction Search (2), Vault (6). No Payouts, no Invoicing, no Disputes, no Webhooks, no Catalog. The plugin cannot help with those surfaces. Callcheck reports this per call (`sdk-not-covered`).
- Installed with `npx context-plugins install ...` into Claude Code (user scope, `paypal@context-plugins-local` 0.1.0), VS Code and Codex. The installer sends anonymous usage data (plugin id, editor, OS, Node version, approximate location) unless `DO_NOT_TRACK=1`; I left it on and say so here. Output: `evidence/plugin/install.txt`.
- The claim form (`docs.google.com/forms/.../viewform`) asks for company or organisation name, domain, and which subscription is being claimed. It needs details about Roger and I will not invent them, so **the form is not submitted** and is listed under "left for Roger" in the README.

### Can APIMatic be called at runtime to validate a request? No.

Read from docs.apimatic.io (sitemap, 2 Oct 2026):

| APIMatic surface | What it takes | Runtime request validation? |
| --- | --- | --- |
| API Transformer / Validation | an **API definition** (OpenAPI, RAML, Postman...) and an account Auth Key in the `Authorization` header | No. It validates the *spec document* and converts formats. |
| Code generation (SDKs, portals) | a definition and an Auth Key, or the CLI | No. Build time. |
| Code Sample API | a published portal's generated artefacts, run locally on port 8080; needs the feature enabled in the subscription | No. It writes SDK snippets for a payload; it does not judge the payload. |
| Context Plugins | generated skills in a repo (`apimatic plugin generate`/`publish`) | No. Files read by a coding agent. |

`https://api.apimatic.io/api-entities` answers 405 to a GET and the root 404s: the API exists and wants an Auth Key I do not have, which the hackathon offer does not include (it says the plugin needs no credentials). So there is **no APIMatic service that checks whether a request body fits a contract**. Callcheck therefore uses APIMatic in two honest ways:

1. **Build time**: the Context Plugin, driven through Claude Code, while writing the SDK-related code. Evidence below.
2. **Run time, without calling APIMatic**: the APIMatic-*generated* SDK is a dependency of the Lambda. Its generated model schemas (`@apimatic/schema`) are loaded and used as a **second contract** beside PayPal's live OpenAPI schema. Callcheck asks "would the SDK accept this body, and what would it put on the wire?" That is APIMatic code running, not an APIMatic API being called.

## Plugin evidence

Run 1 (`evidence/plugin/run1.stream.jsonl`, `claude -p` in this directory with the plugin installed). Prompt: *"I am building a Node 22 service that creates PayPal orders. Using the PayPal plugin skills available to you, tell me: (1) which npm package and version to install, (2) how to construct the Client with client credentials for the sandbox, (3) how to pass PayPal-Request-Id on createOrder, (4) what exception type is thrown on a non-2xx response..."*

- Skill tool call: `paypal:typescript-getting-started`, then the agent read `typescript-client-initialization`, `typescript-authentication`, `typescript-calling-endpoints`, `typescript-error-handling` from the plugin directory.
- Answer it produced: pin `@paypal/paypal-server-sdk` exactly at `2.5.0`; the credentials property is `clientCredentialsAuthCredentials` (named after the auth *type*, not the scheme), with no `oAuthScopes` on client credentials; **`PayPal-Request-Id` is an operation argument (`paypalRequestId`), not a `requestOptions` field**; non-2xx throws `ApiError<T>` or a generated subclass.
- What it saved: the Request-Id placement and the credentials property name are the two details a model usually gets wrong from memory. Both are encoded in `src/sdkcontract.js` (header arguments come from the generated SDK map) and in the `sdk-method` finding.

More runs are appended below as they happen.

## 2026-10-02 sandbox probes (real calls, `evidence/probes/*.json`, `scripts/probe.mjs`)

Re-verified the corpus before encoding any of it. Results that **differ from what I was told or what the repo notes say**:

- **Invoice duplicate**: 422 `UNPROCESSABLE_ENTITY`, issue `DUPLICATE_INVOICE_NUMBER` (the brief said 422; the issue name is now recorded).
- **Payout `recipient_type`**: FINDINGS says the schema *enum* is EMAIL/PHONE/PAYPAL_ID. The live Payouts 1.9 schema has **no enum**: a free string (max 13 chars) whose prose lists EMAIL, PHONE, PAYPAL_ID, USER_HANDLE. VENMO_HANDLE comes from PayPal's AI-Toolkit skill file. All of USER_HANDLE, VENMO_HANDLE and BOGUS with an email receiver return 400 "Receiver is invalid or does not match with type".
- **Request-Id lifetime**: the live specs say Payouts **30 days**, Catalog and Subscriptions **72 hours**, Vault **3 hours**; Orders, Payments and Invoicing state nothing (the "6 hours" in the Orders schema is the payer-approval window, not the key lifetime). The generated SDK's doc comment says Orders keys last 6 hours. That is five different numbers across sources, computed live on the Sources page.
- **`PayPal-Request-Id` did not dedupe a payout**: same id, new `sender_batch_id` created a second batch (`M2XNMDWHZPBWE` then `3E8F6AR8PBSCJ`). The `sender_batch_id` is the real guard (400 `USER_BUSINESS_ERROR` "Batch with given sender_batch_id already exists", even with a fresh Request-Id).
- **Without a `sender_batch_id` an identical retry creates a second batch** (`BB8JWEGT784NE`, `YPWDMRFRC3D2U`).
- **GBP payout settled**: batch SUCCESS, item SUCCESS, fee GBP 0.02. The repo memory note says GBP fails with "balance not held in this currency"; that did not reproduce. BRL gives 400 `NON_HOLDING_CURRENCY`.
- **No per-item cap enforced**: 20,000.01 accepted, item UNCLAIMED, fee 14.00 (cancelled afterwards, 200).
- **PHONE** recipient accepted despite the docs; ends UNCLAIMED.
- **Orders**: same `PayPal-Request-Id` with a *different body* returns the first order (HTTP 200, same id). A numeric `amount.value` is accepted (201) although the schema says string. With `payment_source.paypal` the response is 200 `PAYER_ACTION_REQUIRED` and the link rel is `payer-action`; without it 201 `CREATED` and rel `approve`. A card-shaped payment source without `PayPal-Request-Id` fails with 400 `PAYPAL_REQUEST_ID_REQUIRED`; a wallet source does not need it.
- **`PayPal-Mock-Response` on Invoicing returns 403** with an empty body.
- **`/v1/reporting/transactions` returned 200** (zero items) for a five-day window, not 403 as the brief says. A 32-day range is 400 "Date range is greater than 31 days". Recorded as "access is account-dependent", not as a settled fact either way.
- Vault wallet setup token without `return_url`/`cancel_url`: 201 with status `CREATED` and **no approval link**; with both, `PAYER_ACTION_REQUIRED`.
- MCP: `/http` 404, `/mcp` 401, `/sse` 401 on both hosts. Invoicing on GitHub 2.6 with 16 paths, live 2.12.0 with 27.
- Webhook slots: 5 of 10 used at first look, 6 of 10 by the end of probing. Sibling projects are registering concurrently, so Callcheck re-checks before it registers.

**Disclosure**: one probe (`order.card-source`, in `evidence/probes/extra.json`) sent an order whose `payment_source.card` held the standard test PAN 4111111111111111. PayPal rejected it at header validation (`PAYPAL_REQUEST_ID_REQUIRED`) before processing. Nothing was stored or charged, but it was a card-shaped payload and the brief said never a card. The line is removed from `scripts/probe.mjs`, Callcheck refuses to run any request containing card data, and the card-related verdicts are shown as "recorded from a sibling run", not as re-run.

## 2026-10-02 engine

- `src/spec.js` loads `developer.paypal.com/api/<product>/<version>/schema.json` for ten products, with a labelled snapshot fallback (2.1 MB). Live fetch takes 0.5 to 2.4 s per product.
- `src/validate.js` is a JSON Schema validator for the OpenAPI subset PayPal uses, with allOf flattening so unknown-field detection does not misfire.
- `src/traps.js`: the catalogue. `src/sdkcontract.js`: the SDK as a second contract. `src/mcp.js`: MCP config checks. `src/check.js`: orchestration, verdict, corrected call.
- `node --test test/check.test.js`: 21 passing, including "every trap fires on its own example".

## 2026-10-02 plugin runs 2 and 3 (the plugin driving real work)

Both ran with `claude -p` in this directory, `paypal@context-plugins-local` loaded. Transcripts: `evidence/plugin/run2.stream.jsonl`, `run3.stream.jsonl`; the prompts are the `.prompt.txt` files beside them. Skill tool calls are read from the transcripts.

- **Run 2** (28 turns). Asked for `backend/scripts/sdk-vs-rest.mjs`, naming six skills. It called `paypal:typescript-getting-started`, `-client-initialization`, `-authentication`, `-calling-endpoints`, `-error-handling`, `-models`, then read the installed SDK source as the skills tell it to, and wrote the script. Output of the run it did: `[1] create USD 10.00 id=9KD27089R9503370M status=CREATED http=201`, `[2] replay id, USD 11.00 id=9KD27089R9503370M http=200 sameAsFirst=true`, `[3] breakdown 8.00 vs 10.00 CustomError http=422 name=UNPROCESSABLE_ENTITY issue=AMOUNT_MISMATCH`. It confirmed through the SDK two things my raw-HTTP probes had shown (a reused Request-Id returns the first order, AMOUNT_MISMATCH is a 422) and found a third: errors surface as the generated `CustomError` class with `.result` populated, which is a case the plugin's own error-handling skill gets slightly wrong ("`result` is always undefined on the default path" is true only where the default is `ApiError`). That detail went into the `sdk-method` guidance.
- **Run 3** (14 turns). Asked for `backend/test/sdk.test.js` naming `typescript-testing`, `-models`, `-calling-endpoints`. It called all three, probed the real values instead of guessing, and wrote 6 tests that passed first time. They now run in `npm test`. Cost of all three plugin runs: about $3.80 of Claude Code usage.
- What the plugin saved: reading 91 KB of skills instead of ~20 SDK source files to learn the Request-Id placement (an operation argument), the credentials property name (`clientCredentialsAuthCredentials`), the destructured-options call form, and the camelCase model convention. Those four facts are exactly what `src/sdkcontract.js` and the SDK-mode parser depend on.
- What it could not do: nothing in the plugin covers Payouts, Invoicing, Disputes, Webhooks or Catalog, and those are where the traps are. Callcheck says so on every such call (`sdk-not-covered`).

## 2026-10-02 trap sweep: predicted against observed

`backend/scripts/trap-sweep.mjs` checks every trap example, runs it in the sandbox, compares. First sweep: **29 held, 10 missed**. Every miss was a defect in Callcheck, not in the prediction:
- Second-send predictions were attached to calls whose first send had failed. Fix: a second send is only predicted (and only made) when the first was accepted.
- A DENIED batch (self-pay, bogus PAYPAL_ID) does **not** hold its `sender_batch_id`: the retry was accepted again with 201. New behaviour encoded as the second-send prediction.
- The curl "form encoding" example got 201 because the runner always sent JSON. Fix: the runner sends what curl would have sent.
- The plan example used a made-up product id (404). Fix: `{{new_product}}` and `{{new_plan}}` fixtures that create real objects.
- Webhook and PATCH examples were refused by the gate. Fix: webhook creation is allowed only for an example.com URL and deleted at once if accepted, and only while the app holds fewer than 9 of 10 webhooks; unsupported verbs are sent only against a fixture.
Second sweep: **39 held, 0 missed**, 1 example not run by policy (card). Output: `evidence/trap-sweep.out.txt`.

## 2026-10-02 deploy and webhook

- Lambda `callcheck-api` (Node 22, 1024 MB, 300 s, Function URL in RESPONSE_STREAM mode), DynamoDB `callcheck` (on-demand, TTL), S3 + CloudFront, role `callcheck-lambda`. `deploy.sh` re-runs cleanly; it stages production dependencies in `.deploy-state/stage`, so the SDK's `dist/cjs` and `src` stay out of the 2.9 MB zip.
- First `deploy.sh` run destroyed the local dev dependencies (`npm install --omit=dev` in place). Moved packaging to a staging directory.
- Webhook `7WJ53361D1798092F` registered on the Function URL after reading `GET /v1/notifications/webhooks`: 8 of 10 slots were used by sibling projects, so mine is the 9th. It was reused on every later deploy. Nothing of anyone else's was deleted.
- First real delivery verified locally (RSA-SHA256 over `id|time|webhookId|crc32`), linked to its run, shown on the Sources page. `scripts/tamper-test.mjs` replays a stored real delivery with one character changed: 401. See TEST-RESULTS.md.
- Bedrock: a real tool-using explanation took 18 s on the deployed function (tools used: `check_request`, `run_sandbox`).

## 2026-10-02 UI iteration (screenshots in `shots/r1` ... `shots/r6`, `shots/deployed`)

- **r1, 6.5/10.** Layout and hierarchy worked, but: the theme toggle rendered as a 5 px dot (`.icon-btn` lost to `.btn` padding by source order), the empty state was a paragraph and nothing else, mobile nav floated to the right of the brand over three rows, and the Traps and Examples pages scrolled sideways at 360 px by 21 and 17 px (long identifiers in cards).
- **r2, 7.5/10.** Fixed the icon button, wrapped long identifiers, added a real recorded predicted-against-observed run to the empty state, and corrected the ledger's "First send" label on a single-step result.
- **r4, 8/10.** Mobile nav on its own row; `min-width: 0` on grid children so the agent's code block stopped widening the panel; run, ledger and agent states screenshotted at 360 and 1280 in both themes.
- **r6, 9/10 for the Check flow (phone and desktop), 8.5/10 for the library pages.** Added the signature element: the predicted HTTP code set large in mono on the verdict, coloured by level and also written out. The library pages are tidy lists but not as distinctive as the Check page, which is why they stay at 8.5.
- **Accessibility script (`scripts/a11y-check.mjs`) failed ten checks on its first run**, all real: a 24 px summary and an 18 px checkbox under the 28 px floor, the header overflowing by 306 px at 200% text, a search field and a fieldset sized to their content, and a 13 px overflow at 320 px wide. Fixed one by one to 0 failing, then re-run against the deployed site: 0 failing.
- Colour: 166 text and UI pairs measured from the real hex values by `scripts/contrast.mjs`, 0 failing; the syntax-highlighting colours are measured on the code background, on added and removed diff lines, and on the code bar.

## Honest limits

- Sandbox runs go over raw REST. The SDK is used as a second contract (validation and the dropped-field check), not as the transport. A run through `OrdersController` would add little the contract check does not already show.
- Webhook-registration examples cannot run while the app holds 9 or more of its 10 webhooks, which it does now; they ran at 8 (see the first full sweep).
- The agent falls back to a rules explanation when Bedrock throttles, and says so on screen.
- `projects/channel3` was empty, so the worked examples cover eight integrations, not nine.
- `/v1/reporting/transactions` was 200 today where the brief says 403. Both are recorded; neither is hidden.
- Round r8: Traps page restructured to one line per trap (page height 7275 px to 2445 px at 1280, 16256 to 5020 at 360); Build page paragraph split into a statement, a coverage table and a not-covered line. Accessibility script re-run locally and on the deployed site: 0 failing; contrast 166 pairs, 0 failing.
