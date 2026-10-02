# TEST-RESULTS

All output below is pasted from the runs, 2 October 2026. Nothing is summarised from memory. Raw files are under `evidence/`.

## 1. Unit and in-process tests (`npm test`, no network)
```
✔ the agent calls real tools, then submits; its corrected call is re-checked by the engine (11.121606ms)
✔ a model that claims a fix the engine still rejects is told so (1.744378ms)
✔ throttling falls back to a rules explanation that says so (1.8622ms)
✔ a model that never submits also falls back, with the reason (0.470594ms)
✔ the run tool refuses requests the gate refuses, and the budget caps runs at two (1.096703ms)
✔ rulesExplanation lists blockers and warnings, not notes (0.435516ms)
✔ every trap with an example fires its own detector on that example (87.410129ms)
✔ payout to an unregistered address is accepted, then held UNCLAIMED (1.241918ms)
✔ duplicate sender_batch_id is predicted as a 400 on the second send only (0.368207ms)
✔ self pay is predicted as DENIED/FAILED after a 201 (0.367703ms)
✔ invoice number over 25 characters is a schema blocker with the observed issue name (0.407114ms)
✔ PATCH on an invoice is not an operation, and the checker says which verbs exist (0.369847ms)
✔ order breakdown mismatch is fixed by the corrected call (1.114756ms)
✔ numeric money value is a warning, not a blocker, because the API accepted it (0.498578ms)
✔ orders without a payment source expect 201 and the approve link (0.459404ms)
✔ JPY with decimals and USD with three decimals are separate 422s (0.938692ms)
✔ curl -d without a JSON header is a 415 (0.616556ms)
✔ credentials are removed from the request and never echoed (0.291702ms)
✔ live host is flagged and the call is not runnable (0.315069ms)
✔ webhook event names are checked against the event-type list and a nearest name is proposed (0.394002ms)
✔ transaction search over 31 days is a 400 (0.26754ms)
✔ a card payment source is refused as unrunnable and never executed (0.467576ms)
✔ a path nobody owns gets nearest operations (0.18202ms)
✔ SDK mode converts camelCase to the REST call and finds dropped snake_case keys (1.745215ms)
✔ SDK mode: a field the SDK model lacks is dropped silently (1.333311ms)
✔ payouts have no SDK method, and the checker says so (0.337184ms)
✔ MCP mode: /http path, --tools=all, typo names, absent tools (250.802684ms)
✔ health, meta, traps and examples answer (2.099548ms)
✔ check answers 200 with a verdict, 400 for an empty paste, and never echoes a pasted token (6.667875ms)
✔ run refuses what the gate refuses, with a reason (18.372351ms)
✔ check rate limit answers 429 in words (22.007184ms)
✔ webhook: 200 at once for a verified delivery, work happens after, duplicates are 200, tampering is 401 (3.793378ms)
✔ admin routes need the token and unknown routes are 404 (0.290248ms)
✔ 47 tools, 28 reachable from the local CLI, 19 hidden (1.137345ms)
✔ /http is a blocker with a patch to /mcp (0.800208ms)
✔ --tools=all warns, and blocks when a hidden tool is named (0.35833ms)
✔ documentation typos, absent tools and gated commerce tools (1.780856ms)
✔ empty input is an error that says what to paste (0.315979ms)
✔ the live Orders create path maps to OrdersController.createOrder (1.953571ms)
✔ a valid REST-shaped order body passes the SDK model untouched (59.087825ms)
✔ a numeric amount.value is a type error the SDK would throw on (0.443997ms)
✔ a field the model never heard of is reported as dropped, not rejected (0.435403ms)
✔ a createOrder snippet becomes a POST with the request-id header and a snake_case body (1.172087ms)
✔ Payouts is outside the SDK 2.5.0 surface, so coverage lists it as missing (0.18311ms)
✔ live fetch is used when reachable and labelled live (2.199849ms)
✔ an unreachable host falls back to the bundled snapshot and says so (1.562117ms)
✔ unknown product names list the valid ones (0.344281ms)
✔ Request-Id lifetime statements are read from the live schemas (3.68677ms)
✔ GitHub comparison reports missing live paths (5.406538ms)
✔ closest suggests near names only (1.953845ms)
✔ a valid order body has no errors and no unknown fields (10.001382ms)
✔ enum, type and required errors carry JSON pointers (0.5619ms)
✔ unknown fields are reported without being errors (0.234566ms)
✔ maxLength on invoice_number is 25 (3.088781ms)
✔ operation matching prefers literal segments and fills path params (0.355043ms)
✔ payouts schema: recipient_type has no enum in the live schema (0.875078ms)
✔ curl parsing: quotes, continuations, -u, and the implicit form encoding (2.519449ms)
✔ raw HTTP parsing and bad JSON (0.948199ms)
✔ JS literal reader never evaluates and marks variables (0.667525ms)
✔ crc32 matches the known check value (1.476909ms)
✔ a correctly signed delivery verifies (4.476213ms)
✔ TAMPERED payload is rejected: one changed character (0.956489ms)
✔ wrong webhook id, wrong key, stale time, foreign cert host and missing headers are all rejected (25.092623ms)
✔ cert URL check accepts only https on paypal.com (0.210276ms)
✔ resource ids are pulled from payout and invoice events (0.166194ms)
ℹ tests 65
ℹ suites 0
ℹ pass 65
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 452.46441
```

## 2. Live sandbox suite (`npm run test:sandbox`)
Every trap that has an example is checked, run against the PayPal sandbox and its prediction compared. The two webhook examples are skipped by the gate because the shared app holds 9 of 10 webhooks; they passed in the sweep below when it held 8.
```
✔ payout-201-is-acceptance: Payout to a stranger (32129.070577ms)
✔ payout-no-batch-id: Payout without a batch id (56428.827969ms)
✔ payout-dup-batch-id: Payout with a fixed batch id (28535.492191ms)
✔ payout-recipient-type: Payout with VENMO_HANDLE (477.887682ms)
✔ payout-paypal-id: Payout to a PAYPAL_ID that does not exist (20142.137042ms)
✔ payout-mixed-currency: Mixed-currency batch (406.221785ms)
✔ payout-currency-not-held: Payout in BRL (560.172831ms)
✔ payout-self-pay: Payout to the sender (55516.670668ms)
✔ payout-unregistered: Payout to an unregistered address (25040.485289ms)
✔ payout-per-item-cap: Payout above 20,000 (29361.87323ms)
✔ payout-magic-note: Simulated failure ERRPYO005 (393.489825ms)
✔ invoice-number-dup: Invoice with a fixed number (2285.306448ms)
✔ invoice-number-length: Invoice number of 26 characters (440.09497ms)
✔ invoice-update-is-put: PATCH an invoice (1272.426723ms)
✔ mock-header-scope: Mock header on an invoice (400.078075ms)
✔ orders-amount-mismatch: Order whose breakdown does not add up (1122.601531ms)
✔ orders-currency-decimals: JPY order with a decimal (413.619081ms)
✔ orders-value-type: Order with a numeric amount (471.401181ms)
✔ orders-request-id-reuse: Order with a fixed Request-Id (1128.139555ms)
✔ orders-create-response: Wallet order with a payment source (1280.865693ms)
✔ orders-capture-unapproved: Capture a fresh order (1308.944116ms)
﹣ orders-card-source: Vault a card (889.72461ms) # Vaulting a card is refused on this kind of account
✔ vault-wallet-urls: Wallet setup token without URLs (373.154815ms)
✔ plans-cycles: Plan with an infinite trial (1339.091004ms)
✔ plans-patch-cycles: Patch a plan cycle (1311.021989ms)
✔ disputes-invented-id: Fetch an invented dispute (1290.151271ms)
﹣ webhook-event-name: Subscribe to PAYOUTS-ITEM.SUCCESS (1424.819267ms) # The app already holds 9 of its 10 webhooks. Callcheck leaves the last slots to the projects that own them.
﹣ webhook-url: Register an http webhook (1048.498492ms) # The app already holds 9 of its 10 webhooks. Callcheck leaves the last slots to the projects that own them.
✔ txn-window: Search 55 days (785.843978ms)
✔ generic-content-type: curl without a JSON header (539.812434ms)
ℹ tests 30
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 268217.536697
```

## 3. Predicted against observed (`backend/scripts/trap-sweep.mjs`, second sweep)
```

payout-dup-batch-id  (Payout with a fixed batch id)
  checker:   This call goes through, then bites.  Expect HTTP 201, then item SUCCESS in batch SUCCESS
  send 1:    predicted HTTP 201, then item SUCCESS in batch SUCCESS
             observed  HTTP 201, status PENDING, then item SUCCESS in batch SUCCESS
             PREDICTION HELD
  send 2:    predicted HTTP 400 USER_BUSINESS_ERROR (already exists)
             observed  HTTP 400 USER_BUSINESS_ERROR (Batch with given sender_batch_id already exists)
             PREDICTION HELD

payout-201-is-acceptance  (Payout to a stranger)
  checker:   This call goes through, then bites.  Expect HTTP 201, then item UNCLAIMED (RECEIVER_UNREGISTERED) in batch SUCCESS
  send 1:    predicted HTTP 201, then item UNCLAIMED (RECEIVER_UNREGISTERED) in batch SUCCESS
             observed  HTTP 201, status PENDING, then item UNCLAIMED (RECEIVER_UNREGISTERED) in batch SUCCESS
             PREDICTION HELD
  send 2:    predicted HTTP 400 USER_BUSINESS_ERROR (already exists)
             observed  HTTP 400 USER_BUSINESS_ERROR (Batch with given sender_batch_id already exists)
             PREDICTION HELD

payout-no-batch-id  (Payout without a batch id)
  checker:   This call goes through, then bites.  Expect HTTP 201, then item SUCCESS in batch SUCCESS
  send 1:    predicted HTTP 201, then item SUCCESS in batch SUCCESS
             observed  HTTP 201, status PENDING, then item SUCCESS in batch SUCCESS
             PREDICTION HELD
  send 2:    predicted HTTP 201, a second resource
             observed  HTTP 201, status PENDING, then item SUCCESS in batch SUCCESS
             PREDICTION HELD

payout-mixed-currency  (Mixed-currency batch)
  checker:   This call will fail.  Expect HTTP 400 VALIDATION_ERROR (Multiple currencies)
  send 1:    predicted HTTP 400 VALIDATION_ERROR (Multiple currencies)
             observed  HTTP 400 VALIDATION_ERROR (Multiple currencies within a batch is not allowed)
             PREDICTION HELD

payout-recipient-type  (Payout with VENMO_HANDLE)
  checker:   This call will fail.  Expect HTTP 400 VALIDATION_ERROR (does not match with type)
  send 1:    predicted HTTP 400 VALIDATION_ERROR (does not match with type)
             observed  HTTP 400 VALIDATION_ERROR (Receiver is invalid or does not match with type)
             PREDICTION HELD

payout-paypal-id  (Payout to a PAYPAL_ID that does not exist)
  checker:   This call is accepted, then fails.  Expect HTTP 201, then item FAILED (RECEIVER_ACCOUNT_INVALID) in batch DENIED
  send 1:    predicted HTTP 201, then item FAILED (RECEIVER_ACCOUNT_INVALID) in batch DENIED
             observed  HTTP 201, status PENDING, then item FAILED (RECEIVER_ACCOUNT_INVALID) in batch DENIED
             PREDICTION HELD
  send 2:    predicted HTTP 201 again: a DENIED batch does not hold its sender_batch_id
             observed  HTTP 201, status PENDING, then item FAILED (RECEIVER_ACCOUNT_INVALID) in batch DENIED
             PREDICTION HELD

payout-currency-not-held  (Payout in BRL)
  checker:   This call will fail.  Expect HTTP 400 NON_HOLDING_CURRENCY
  send 1:    predicted HTTP 400 NON_HOLDING_CURRENCY
             observed  HTTP 400 NON_HOLDING_CURRENCY
             PREDICTION HELD

payout-unregistered  (Payout to an unregistered address)
  checker:   This call goes through, then bites.  Expect HTTP 201, then item UNCLAIMED (RECEIVER_UNREGISTERED) in batch SUCCESS
  send 1:    predicted HTTP 201, then item UNCLAIMED (RECEIVER_UNREGISTERED) in batch SUCCESS
             observed  HTTP 201, status PENDING, then item UNCLAIMED (RECEIVER_UNREGISTERED) in batch SUCCESS
             PREDICTION HELD
  send 2:    predicted HTTP 400 USER_BUSINESS_ERROR (already exists)
             observed  HTTP 400 USER_BUSINESS_ERROR (Batch with given sender_batch_id already exists)
             PREDICTION HELD

payout-self-pay  (Payout to the sender)
  checker:   This call is accepted, then fails.  Expect HTTP 201, then item FAILED (SELF_PAY_NOT_ALLOWED) in batch DENIED
  send 1:    predicted HTTP 201, then item FAILED (SELF_PAY_NOT_ALLOWED) in batch DENIED
             observed  HTTP 201, status PENDING, then item FAILED (SELF_PAY_NOT_ALLOWED) in batch DENIED
             PREDICTION HELD
  send 2:    predicted HTTP 201 again: a DENIED batch does not hold its sender_batch_id
             observed  HTTP 201, status PENDING, then item FAILED (SELF_PAY_NOT_ALLOWED) in batch DENIED
             PREDICTION HELD

payout-magic-note  (Simulated failure ERRPYO005)
  checker:   This call goes through, then bites.  Expect HTTP 422 INSUFFICIENT_FUNDS
  send 1:    predicted HTTP 422 INSUFFICIENT_FUNDS
             observed  HTTP 422 INSUFFICIENT_FUNDS
             PREDICTION HELD

invoice-number-dup  (Invoice with a fixed number)
  checker:   This call goes through, then bites.  Expect HTTP 201
  send 1:    predicted HTTP 201
             observed  HTTP 201
             PREDICTION HELD
  send 2:    predicted HTTP 422 UNPROCESSABLE_ENTITY (DUPLICATE_INVOICE_NUMBER)
             observed  HTTP 422 UNPROCESSABLE_ENTITY (DUPLICATE_INVOICE_NUMBER)
             PREDICTION HELD

payout-per-item-cap  (Payout above 20,000)
  checker:   This call goes through, then bites.  Expect HTTP 201, then item UNCLAIMED (RECEIVER_UNREGISTERED) in batch SUCCESS
  send 1:    predicted HTTP 201, then item UNCLAIMED (RECEIVER_UNREGISTERED) in batch SUCCESS
             observed  HTTP 201, status PENDING, then item UNCLAIMED (RECEIVER_UNREGISTERED) in batch SUCCESS
             PREDICTION HELD
  send 2:    predicted HTTP 400 USER_BUSINESS_ERROR (already exists)
             observed  HTTP 400 USER_BUSINESS_ERROR (Batch with given sender_batch_id already exists)
             PREDICTION HELD

invoice-number-length  (Invoice number of 26 characters)
  checker:   This call will fail.  Expect HTTP 400 INVALID_REQUEST (INVALID_STRING_MAX_LENGTH)
  send 1:    predicted HTTP 400 INVALID_REQUEST (INVALID_STRING_MAX_LENGTH)
             observed  HTTP 400 INVALID_REQUEST (INVALID_STRING_MAX_LENGTH)
             PREDICTION HELD

mock-header-scope  (Mock header on an invoice)
  checker:   This call will fail.  Expect HTTP 403
  send 1:    predicted HTTP 403
             observed  HTTP 403
             PREDICTION HELD

invoice-update-is-put  (PATCH an invoice)
  checker:   This call will fail.  Expect HTTP 404
  send 1:    predicted HTTP 404
             observed  HTTP 404
             PREDICTION HELD

orders-amount-mismatch  (Order whose breakdown does not add up)
  checker:   This call will fail.  Expect HTTP 422 UNPROCESSABLE_ENTITY (AMOUNT_MISMATCH)
  send 1:    predicted HTTP 422 UNPROCESSABLE_ENTITY (AMOUNT_MISMATCH)
             observed  HTTP 422 UNPROCESSABLE_ENTITY (AMOUNT_MISMATCH)
             PREDICTION HELD

orders-currency-decimals  (JPY order with a decimal)
  checker:   This call will fail.  Expect HTTP 422 UNPROCESSABLE_ENTITY (DECIMALS_NOT_SUPPORTED)
  send 1:    predicted HTTP 422 UNPROCESSABLE_ENTITY (DECIMALS_NOT_SUPPORTED)
             observed  HTTP 422 UNPROCESSABLE_ENTITY (DECIMALS_NOT_SUPPORTED)
             PREDICTION HELD

orders-value-type  (Order with a numeric amount)
  checker:   This call goes through, then bites.  Expect HTTP 201, status CREATED
  send 1:    predicted HTTP 201, status CREATED
             observed  HTTP 201, status CREATED
             PREDICTION HELD

orders-request-id-reuse  (Order with a fixed Request-Id)
  checker:   This call goes through, then bites.  Expect HTTP 201, status CREATED
  send 1:    predicted HTTP 201, status CREATED
             observed  HTTP 201, status CREATED
             PREDICTION HELD
  send 2:    predicted HTTP 200, the same resource as the first send
             observed  HTTP 200, status CREATED
             PREDICTION HELD

orders-create-response  (Wallet order with a payment source)
  checker:   This call goes through, then bites.  Expect HTTP 200, status PAYER_ACTION_REQUIRED
  send 1:    predicted HTTP 200, status PAYER_ACTION_REQUIRED
             observed  HTTP 200, status PAYER_ACTION_REQUIRED
             PREDICTION HELD
  send 2:    predicted HTTP 200, the same resource as the first send
             observed  HTTP 200, status PAYER_ACTION_REQUIRED
             PREDICTION HELD

orders-capture-unapproved  (Capture a fresh order)
  checker:   This call will fail.  Expect HTTP 422 UNPROCESSABLE_ENTITY (ORDER_NOT_APPROVED)
  send 1:    predicted HTTP 422 UNPROCESSABLE_ENTITY (ORDER_NOT_APPROVED)
             observed  HTTP 422 UNPROCESSABLE_ENTITY (ORDER_NOT_APPROVED)
             PREDICTION HELD

vault-wallet-urls  (Wallet setup token without URLs)
  checker:   This call goes through, then bites.  Expect HTTP 201, status CREATED
  send 1:    predicted HTTP 201, status CREATED
             observed  HTTP 201, status CREATED
             PREDICTION HELD

orders-card-source  (Vault a card)
  checker:   This call will fail.  Expect (none)
  not run:   Vaulting a card is refused on this kind of account

plans-cycles  (Plan with an infinite trial)
  checker:   This call will fail.  Expect HTTP 422 UNPROCESSABLE_ENTITY (INVALID_TRIAL_BILLING_TOTAL_CYCLES)
  send 1:    predicted HTTP 422 UNPROCESSABLE_ENTITY (INVALID_TRIAL_BILLING_TOTAL_CYCLES)
             observed  HTTP 422 UNPROCESSABLE_ENTITY (INVALID_TRIAL_BILLING_TOTAL_CYCLES)
             PREDICTION HELD

disputes-invented-id  (Fetch an invented dispute)
  checker:   This call goes through, then bites.  Expect HTTP 403 or 404
  send 1:    predicted HTTP 403 or 404
             observed  HTTP 403 NOT_AUTHORIZED (ACTION_NOT_ALLOWED)
             PREDICTION HELD

plans-patch-cycles  (Patch a plan cycle)
  checker:   This call will fail.  Expect HTTP 400 INVALID_REQUEST (INVALID_PATCH_PATH)
  send 1:    predicted HTTP 400 INVALID_REQUEST (INVALID_PATCH_PATH)
             observed  HTTP 400 INVALID_REQUEST (INVALID_PATCH_PATH)
             PREDICTION HELD

webhook-event-name  (Subscribe to PAYOUTS-ITEM.SUCCESS)
  checker:   This call will fail.  Expect HTTP 400 VALIDATION_ERROR (valid event name)
  send 1:    predicted HTTP 400 VALIDATION_ERROR (valid event name)
             observed  HTTP 400 VALIDATION_ERROR (Not a valid event name)
             PREDICTION HELD

generic-content-type  (curl without a JSON header)
  checker:   This call will fail.  Expect HTTP 415
  send 1:    predicted HTTP 415
             observed  HTTP 415 UNSUPPORTED_MEDIA_TYPE
             PREDICTION HELD

txn-window  (Search 55 days)
  checker:   This call will fail.  Expect HTTP 400 INVALID_REQUEST
  send 1:    predicted HTTP 400 INVALID_REQUEST
             observed  HTTP 400 INVALID_REQUEST (Date range is greater than 31 days)
             PREDICTION HELD

webhook-url  (Register an http webhook)
  checker:   This call will fail.  Expect HTTP 400 VALIDATION_ERROR (valid webhook URL)
  send 1:    predicted HTTP 400 VALIDATION_ERROR (valid webhook URL)
             observed  HTTP 400 VALIDATION_ERROR (Not a valid webhook URL)
             PREDICTION HELD

39 predictions held, 0 missed, 1 examples not run by policy or for lack of a prediction.
```

## 4. Webhook: real delivery, altered copies rejected (`scripts/tamper-test.mjs`, against the deployed listener)
```
stored delivery WH-1AK62900VJ947382B-9SN50950Y7971811W  PAYMENT.PAYOUTSBATCH.SUCCESS
1. original, untouched             HTTP 200 in 273 ms  {"ok":true,"duplicate":true}
2. one character changed           HTTP 401 in 278 ms  {"ok":false,"error":"signature not verified"}
3. status text edited              HTTP 401 in 293 ms  {"ok":false,"error":"signature not verified"}
4. signature header removed        HTTP 401 in 268 ms  {"ok":false,"error":"signature not verified"}
PASS: every altered delivery was rejected with 401
(the untouched replay answered 200: 200 while inside the one-hour replay window, 401 after it)
```
The signature-level tests (wrong webhook id, wrong key, stale time, foreign certificate host, missing headers) are in section 1, `webhook.test.js`.

## 5. Deployed browser journey (check, run in the sandbox, agent), CloudFront
```
run 360 light {"panelRight":344,"over":0,"bad":["CODE.","SPAN.tk-url","SPAN.tk-str","SPAN.tk-pun"]}
agent 360 light {"panelRight":344,"over":0,"bad":["CODE.","SPAN.tk-url","SPAN.tk-str","SPAN.tk-pun"]}
run 1280 light {"panelRight":1264,"over":0,"bad":["CODE."]}
agent 1280 light {"panelRight":1264,"over":0,"bad":["CODE."]}
done /home/rogerkorantenng/dev/Hackathons/paypal/projects/apimatic/shots/deployed
```
Screenshots: `shots/deployed/`.

## 6. Accessibility script, local then deployed
```
0 failing
local: 45 checks
44
deployed: 0 failing, 44 checks passed
```
First run failed ten checks (see BUILD-LOG.md). Last lines of the deployed run:
```
PASS  200% text at 360: traps has no horizontal page scroll (overflow 0px)
PASS  200% text at 360: examples has no horizontal page scroll (overflow 0px)
PASS  200% text at 360: method has no horizontal page scroll (overflow 0px)
PASS  reflow at 320: check has no horizontal page scroll (overflow 0px)
PASS  reflow at 320: traps has no horizontal page scroll (overflow 0px)
PASS  reflow at 320: examples has no horizontal page scroll (overflow 0px)
PASS  reflow at 320: method has no horizontal page scroll (overflow 0px)
0 failing
```

## 7. Contrast (`npm run contrast`)
```
PASS   5.20:1  (need 3)  [dark] Input border against code block (UI, 3:1)  #7c8596 on #0c0e12
PASS  10.95:1  (need 3)  [dark] Focus ring against page (UI, 3:1)  #c3b8ff on #090a0d
PASS  10.37:1  (need 3)  [dark] Focus ring against surface (UI, 3:1)  #c3b8ff on #101216
166 pairs, 0 failing
```
Full table of 166 pairs: `evidence/contrast.md`.

## 8. Known gaps
- Two webhook examples cannot run while the app holds 9 of 10 webhooks.
- Card and vault-token verdicts are recorded from sibling runs, not re-run.
- The agent has been run live on Bedrock (18 s, tools `check_request` and `run_sandbox`) and in the deployed journey above; its fallback is tested with a simulated throttle in `agent.test.js`.
