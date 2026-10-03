// The trap catalogue. Each entry is a known way a PayPal integration goes wrong, with a detector, a prediction that can be
// tested against the sandbox, and the evidence behind it. Evidence is either a recorded sandbox probe, a quote from PayPal's
// own schema, or a log from one of the sibling integrations built in this repository.
import { probe, sibling, doc, specNote, policy } from './evidence.js';
import { closest } from './spec.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const lc = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
export const hdr = (c, name) => c.headers[name.toLowerCase()];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const minor = (v) => Math.round(Number(v) * 100);
const ZERO_DECIMAL = ['HUF', 'JPY', 'TWD'];
const NON_HOLDING = ['BRL', 'MYR', 'RUB', 'THB'];
const PAYOUT_TYPES = ['EMAIL', 'PHONE', 'PAYPAL_ID', 'USER_HANDLE'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAGIC = { ERRPYO001: [403, 'SENDER_RESTRICTED'], ERRPYO002: [403, 'SENDER_EMAIL_UNCONFIRMED'], ERRPYO003: [403, 'AUTHORIZATION_ERROR'], ERRPYO005: [422, 'INSUFFICIENT_FUNDS'], ERRPYO006: [500, 'INTERNAL_ERROR'], ERRPYO010: [400, 'VALIDATION_ERROR'] };

/** rank: the order PayPal evaluates things in. Lower happens first. */
const RANK = { transport: 1, host: 2, schema: 3, business: 4, terminal: 8, success: 9 };

const items = (c) => (Array.isArray(c.body?.items) ? c.body.items : []);
const recipientType = (c, it) => it?.recipient_type ?? c.body?.sender_batch_header?.recipient_type;
const isRealId = (s) => typeof s === 'string' && !/\{\{|<|\$\{/.test(s);

export const TRAPS = [];
const add = (t) => TRAPS.push({ severity: 'warning', products: ['*'], evidence: [], ...t });

/* ------------------------------------------------------------------ Payouts */

add({
  id: 'payout-201-is-acceptance', products: ['payouts'], ops: ['POST /v1/payments/payouts'], severity: 'note', group: 'Payouts',
  title: 'A 201 on a payout proves nothing',
  summary: 'The 201 only means PayPal accepted the batch. The batch status can read SUCCESS while every item is UNCLAIMED, and DENIED while the item FAILED. Money moved only when the item status says so.',
  evidence: [probe('payout.unregistered.poll'), probe('payout.self-pay.poll'), sibling('escrow', 'Batch status reached SUCCESS while every item was UNCLAIMED. Batch SUCCESS does not mean money delivered.')],
  example: { name: 'Payout to a stranger', text: payoutExample('callcheck-nobody-{{uniq}}@example.com', 'EMAIL', '1.00', 'USD') },
  detect(c) {
    return [{ severity: 'note', title: 'The 201 will not tell you whether the money moved', what: 'PayPal answers 201 as soon as it accepts the batch. The outcome sits on each item and settles about 20 seconds later.', fix: 'Poll GET /v1/payments/payouts/{payout_batch_id} until every item reaches a terminal status (SUCCESS, FAILED, UNCLAIMED, RETURNED, BLOCKED, REFUNDED, REVERSED). Read the item status, not the batch status.', evidence: this.evidence.slice(0, 2), predicts: { rank: RANK.success, status: 201 }, confidence: 'observed' }];
  },
});

add({
  id: 'payout-no-batch-id', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'No sender_batch_id means a retry pays twice',
  summary: 'sender_batch_id is optional. Without it PayPal has nothing to refuse a retry on, so a timed-out POST that you resend creates a second batch and a second payment.',
  evidence: [probe('payout.no-batch-id.second'), specNote('The live schema says: "PayPal does not process duplicate payouts. If you specify a sender_batch_id that was used in the last 30 days, the API rejects the request."')],
  example: { name: 'Payout without a batch id', text: payoutExample('sb-patient@personal.example.com', 'EMAIL', '1.00', 'USD', { noBatchId: true }) },
  detect(c) {
    if (c.body?.sender_batch_header?.sender_batch_id) return [];
    return [{ severity: 'warning', where: '/sender_batch_header/sender_batch_id', title: 'A retry of this call would pay again', what: 'There is no sender_batch_id. Two identical POSTs sent in the sandbox created two separate batches, each with its own payout.', fix: 'Set sender_batch_id to a value you derive from the thing being paid (an invoice number, a claim id), so the same payment always carries the same id.', evidence: this.evidence, confidence: 'observed', predicts: { rank: RANK.success, attempt: 2, status: 201, sameResourceAsAttempt1: false },
      patch: (r) => { r.body.sender_batch_header ??= {}; r.body.sender_batch_header.sender_batch_id = 'pay-' + hash(JSON.stringify(r.body.items ?? [])); } }];
  },
});

add({
  id: 'payout-dup-batch-id', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'A duplicate sender_batch_id is a 400 that means the batch exists',
  summary: 'Re-sending a sender_batch_id returns 400 USER_BUSINESS_ERROR with a link to the original batch. That is the idempotency guard working, so treat it as success and read the original batch instead of retrying.',
  evidence: [probe('payout.dup-batch-id.new-request-id'), probe('payout.dup-batch-id.same-request-id'), sibling('cancelled-op', 'Duplicate sender_batch_id -> 400 USER_BUSINESS_ERROR, details[0].link[0].href is the ORIGINAL batch, so a lost write can be recovered by adopting that batch id.')],
  example: { name: 'Payout with a fixed batch id', text: payoutExample('sb-patient@personal.example.com', 'EMAIL', '1.00', 'USD') },
  detect(c) {
    const id = c.body?.sender_batch_header?.sender_batch_id;
    if (!id) return [];
    return [{ severity: 'warning', where: '/sender_batch_header/sender_batch_id', title: 'The second send of this batch id will be a 400', what: `sender_batch_id "${id}" can be used once in 30 days. A retry returns 400 USER_BUSINESS_ERROR "Batch with given sender_batch_id already exists", and the response links to the original batch.`, fix: 'Catch that 400. When details[0].issue says the batch already exists, take the id from details[0].link[0].href and carry on with that batch. Do not treat it as a failure and do not generate a new id.', evidence: this.evidence.slice(0, 2), confidence: 'observed',
      predicts: { rank: RANK.business, attempt: 2, status: 400, name: 'USER_BUSINESS_ERROR', issue: /already exists/i } }];
  },
});

add({
  id: 'payout-request-id-not-enough', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'PayPal-Request-Id did not stop a duplicate payout',
  summary: 'The Payouts schema says request ids are stored for 30 days. In the sandbox a second batch with a new sender_batch_id but the same PayPal-Request-Id was created anyway. The sender_batch_id is the real guard.',
  evidence: [probe('payout.request-id-only.second'), sibling('cancelled-op', 'PayPal-Request-Id replay does NOT dedupe payouts in this sandbox: same Request-Id + new sender_batch_id created a 2nd batch.'), sibling('tailrace', 'Repeating a sender_batch_id returns 400 USER_BUSINESS_ERROR with a link to the existing batch, even with the same PayPal-Request-Id.')],
  detect(c) {
    if (!hdr(c, 'paypal-request-id')) return [];
    return [{ severity: 'warning', where: 'header:PayPal-Request-Id', title: 'The Request-Id header is not your payout guard', what: 'Sending the same PayPal-Request-Id with a different sender_batch_id created a second batch in the sandbox, although the schema promises 30 days of storage.', fix: 'Keep the header if you like, but make sender_batch_id deterministic per payment. That is the field PayPal refuses duplicates on.', evidence: this.evidence.slice(0, 2), confidence: 'observed' }];
  },
});

add({
  id: 'payout-recipient-type', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'recipient_type is a free string, and PayPal\'s pages disagree on its values',
  summary: 'The live schema declares recipient_type as a plain string (maximum 13 characters) with no enum. Its prose lists EMAIL, PHONE, PAYPAL_ID and USER_HANDLE; PayPal\'s own AI-Toolkit skill file says VENMO_HANDLE instead. A value that does not fit the receiver is rejected with a 400.',
  evidence: [probe('payout.type.venmo-handle'), probe('payout.type.user-handle'), probe('payout.item-over-batch-type'), specNote('Live Payouts 1.9 describes recipient_type in prose only: EMAIL, PHONE, PAYPAL_ID, USER_HANDLE. There is no enum.'), doc('PayPal\'s AI-Toolkit skill file lists EMAIL, PHONE, PAYPAL_ID, VENMO_HANDLE.')],
  example: { name: 'Payout with VENMO_HANDLE', text: payoutExample('sb-patient@personal.example.com', 'VENMO_HANDLE', '1.00', 'USD') },
  detect(c) {
    const out = [];
    items(c).forEach((it, i) => {
      const t = recipientType(c, it); const r = it?.receiver;
      if (typeof t !== 'string' || typeof r !== 'string') return;
      const where = `/items/${i}/recipient_type`;
      const mismatch = (t === 'EMAIL' && !EMAIL_RE.test(r)) || (t === 'PAYPAL_ID' && EMAIL_RE.test(r)) || ((t === 'USER_HANDLE' || t === 'VENMO_HANDLE') && EMAIL_RE.test(r)) || (t === 'PHONE' && EMAIL_RE.test(r));
      if (!PAYOUT_TYPES.includes(t)) {
        const near = closest(t, PAYOUT_TYPES, 1)[0] ?? 'EMAIL';
        out.push({ severity: 'blocker', where, title: `"${t}" is not a recipient type PayPal documents`, what: `Item ${i + 1} uses recipient_type ${t}. The live Payouts schema lists EMAIL, PHONE, PAYPAL_ID and USER_HANDLE. The sandbox answers any other value with 400 VALIDATION_ERROR "Receiver is invalid or does not match with type".`, fix: t === 'VENMO_HANDLE' ? 'Use USER_HANDLE for a Venmo username (US and USD only), or EMAIL for an email address.' : `Use ${near}, or whichever of ${PAYOUT_TYPES.join(', ')} matches the receiver.`, evidence: this.evidence.slice(0, 1).concat(this.evidence.slice(3)), confidence: 'observed',
          predicts: { rank: RANK.business, status: 400, name: 'VALIDATION_ERROR', issue: /does not match with type/i }, patch: (r2) => { const it2 = r2.body.items[i]; it2.recipient_type = EMAIL_RE.test(it2.receiver) ? 'EMAIL' : near; } });
      } else if (t === 'USER_HANDLE' && !EMAIL_RE.test(r)) {
        out.push({ severity: 'warning', where, title: 'USER_HANDLE is documented, and the sandbox refused every handle tried', what: `Item ${i + 1} pays "${r}" as a USER_HANDLE (a Venmo username). The schema lists the type, Venmo is US and USD only, and the sandbox answered 400 VALIDATION_ERROR "Receiver is invalid or does not match with type" for a handle-shaped receiver.`, fix: 'Do not build a demo on Venmo handles. Pay EMAIL or PAYPAL_ID, which settle.', evidence: [probe('payout.user-handle.handle'), this.evidence[3]], confidence: 'observed', predicts: { rank: RANK.business, status: 400, name: 'VALIDATION_ERROR', issue: /does not match with type/i } });
      } else if (mismatch) {
        out.push({ severity: 'blocker', where, title: `The receiver does not look like a ${t}`, what: `Item ${i + 1} sets recipient_type ${t} for "${r}". PayPal checks the receiver against the type and answers 400 VALIDATION_ERROR "Receiver is invalid or does not match with type".`, fix: EMAIL_RE.test(r) ? 'Use recipient_type EMAIL for an email address.' : `Give a receiver in the shape ${t} expects.`, evidence: [this.evidence[2], this.evidence[1]], confidence: 'observed',
          predicts: { rank: RANK.business, status: 400, name: 'VALIDATION_ERROR', issue: /does not match with type/i }, patch: (r2) => { if (EMAIL_RE.test(r2.body.items[i].receiver)) r2.body.items[i].recipient_type = 'EMAIL'; } });
      }
    });
    return out;
  },
});


add({
  id: 'payout-paypal-id', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'A PAYPAL_ID that is not an account: batch DENIED, item FAILED',
  summary: 'A PAYPAL_ID of the wrong shape is a 400 at creation. One of the right shape (13 capitals and digits) that belongs to no account is accepted with 201, then the batch goes DENIED and the item FAILED with RECEIVER_ACCOUNT_INVALID. Two sibling logs disagree on whether the batch reads SUCCESS here; the recorded run says DENIED.',
  evidence: [probe('payout.paypal-id.bogus13.poll'), probe('payout.paypal-id.short'), sibling('cancelled-op', 'Item-level FAILED: recipient_type PAYPAL_ID with a bogus id -> batch DENIED, item FAILED RECEIVER_ACCOUNT_INVALID.'), sibling('aggrid', 'PAYPAL_ID bogus id ends FAILED / RECEIVER_ACCOUNT_INVALID while the BATCH reads SUCCESS.')],
  example: { name: 'Payout to a PAYPAL_ID that does not exist', text: payoutExample('ABCDEFGHJKLMN', 'PAYPAL_ID', '1.00', 'USD') },
  detect(c) {
    const its = items(c); const out = [];
    its.forEach((it, i) => {
      if (recipientType(c, it) !== 'PAYPAL_ID' || typeof it.receiver !== 'string' || EMAIL_RE.test(it.receiver) || !isRealId(it.receiver)) return;
      if (!/^[A-Z0-9]{13}$/.test(it.receiver)) { out.push({ severity: 'blocker', where: `/items/${i}/receiver`, title: 'A PAYPAL_ID is 13 capitals and digits', what: `"${it.receiver}" is not that shape. PayPal answers 400 VALIDATION_ERROR "Receiver is invalid or does not match with type".`, fix: 'Use the payer_id PayPal returned for the account, or pay EMAIL.', evidence: [this.evidence[1]], confidence: 'observed', predicts: { rank: RANK.business, status: 400, name: 'VALIDATION_ERROR', issue: /does not match with type/i } }); return; }
      if (its.length === 1) out.push({ severity: 'blocker', where: `/items/${i}/receiver`, title: 'This PAYPAL_ID is not a known account', what: 'If no sandbox account has this id, PayPal accepts the batch (201), then denies it: batch DENIED, item FAILED, RECEIVER_ACCOUNT_INVALID. A real id succeeds.', fix: 'Take the id from a sandbox account\'s payer_id, not from an example. Check the item status after the 201.', evidence: this.evidence.slice(0, 1).concat(this.evidence.slice(2)), confidence: 'observed', predicts: { rank: RANK.terminal, status: 201, terminal: { batch: 'DENIED', item: 'FAILED', error: 'RECEIVER_ACCOUNT_INVALID' } } });
    });
    return out;
  },
});

add({
  id: 'payout-phone-sandbox', products: ['payouts'], ops: ['POST /v1/payments/payouts'], severity: 'note', group: 'Payouts',
  title: 'PHONE payouts: the docs say the sandbox rejects them, and it accepts them',
  summary: 'The schema says the sandbox does not support the PHONE recipient type. The sandbox accepted a PHONE payout and left the item UNCLAIMED with RECEIVER_UNREGISTERED.',
  evidence: [probe('payout.phone.poll'), specNote('Live Payouts 1.9: "The PayPal sandbox does not support the PHONE recipient type."'), sibling('escrow', 'PHONE with +14085551234 was ACCEPTED in sandbox (docs say sandbox does not support PHONE).')],
  detect(c) {
    return items(c).some((it) => recipientType(c, it) === 'PHONE') ? [{ severity: 'note', title: 'PHONE is accepted here, but it will not settle', what: 'The docs say the sandbox does not support PHONE. It accepted one, then held the item as UNCLAIMED because no sandbox account owns that number.', fix: 'Do not demo or test PHONE payouts in the sandbox. Use EMAIL with a sandbox personal account.', evidence: this.evidence.slice(0, 2), confidence: 'observed' }] : [];
  },
});

add({
  id: 'payout-mixed-currency', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'One batch, one currency',
  summary: 'A batch that mixes currencies is rejected whole with 400 VALIDATION_ERROR, so one GBP item can sink a USD batch.',
  evidence: [probe('payout.mixed-currency'), sibling('escrow', 'Multi-currency batch -> VALIDATION_ERROR (so currency cannot be used to force a partial failure).')],
  example: { name: 'Mixed-currency batch', text: payoutExample('sb-patient@personal.example.com', 'EMAIL', '1.00', 'USD', { second: ['sb-patient@personal.example.com', '1.00', 'GBP'] }) },
  detect(c) {
    const cur = [...new Set(items(c).map((it) => it?.amount?.currency).filter(Boolean))];
    if (cur.length < 2) return [];
    return [{ severity: 'blocker', where: '/items', title: 'The batch mixes currencies', what: `Items are in ${cur.join(' and ')}. PayPal refuses the whole batch with 400 VALIDATION_ERROR "Multiple currencies within a batch is not allowed". Nothing is paid.`, fix: `Send one batch per currency. This call keeps ${cur[0]} items only; send the ${cur.slice(1).join(', ')} items in their own batch.`, evidence: this.evidence, confidence: 'observed',
      predicts: { rank: RANK.business, status: 400, name: 'VALIDATION_ERROR', issue: /Multiple currencies/i }, patch: (r) => { r.body.items = r.body.items.filter((it) => it?.amount?.currency === cur[0]); } }];
  },
});

add({
  id: 'payout-currency-not-held', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'Some currencies need a balance you do not hold',
  summary: 'PayPal converts 21 currencies automatically. BRL, MYR, RUB and THB are payable currencies but not auto-convertible, so a payout fails with 400 NON_HOLDING_CURRENCY unless that balance exists.',
  evidence: [probe('payout.brl'), doc('research/capability/FINDINGS.md section 7.3: BRL, MYR, RUB, THB need a held balance.')],
  example: { name: 'Payout in BRL', text: payoutExample('sb-patient@personal.example.com', 'EMAIL', '1.00', 'BRL') },
  detect(c) {
    const bad = [...new Set(items(c).map((it) => it?.amount?.currency).filter((x) => NON_HOLDING.includes(x)))];
    if (!bad.length) return [];
    return [{ severity: 'blocker', where: '/items/0/amount/currency', title: `${bad.join(', ')} needs a balance in that currency`, what: `PayPal auto-converts 21 currencies and ${bad.join(', ')} is not one of them. The sandbox returned 400 NON_HOLDING_CURRENCY for BRL.`, fix: 'Pay in a currency PayPal converts (USD, GBP, EUR and 18 more), or fund a balance in this currency first.', evidence: this.evidence, confidence: 'observed',
      predicts: { rank: RANK.business, status: 400, name: 'NON_HOLDING_CURRENCY' }, patch: (r) => { r.body.items.forEach((it) => { if (it?.amount && NON_HOLDING.includes(it.amount.currency)) it.amount.currency = 'USD'; }); } }];
  },
});

add({
  id: 'payout-gbp-settles', products: ['payouts'], ops: ['POST /v1/payments/payouts'], severity: 'note', group: 'Payouts',
  title: 'GBP payouts settle here, despite a note saying they do not',
  summary: 'An earlier note in this repository said GBP payouts return 201 and then fail because the balance is USD only. That did not reproduce: a GBP 1.00 payout reached batch SUCCESS and item SUCCESS with a GBP 0.02 fee.',
  evidence: [probe('payout.gbp.poll'), sibling('cancelled-op', 'GBP 262.00 batch TB7XZTHHQJTC4 -> batch SUCCESS + item SUCCESS, fee GBP 5.24.')],
  detect(c) {
    return items(c).some((it) => it?.amount?.currency === 'GBP') ? [{ severity: 'note', title: 'GBP is fine on this account', what: 'GBP payouts reached SUCCESS in the sandbox. Do not special-case sterling because of an old note.', fix: 'Pay in GBP directly. Still poll the item, as with any payout.', evidence: this.evidence, confidence: 'observed' }] : [];
  },
});

add({
  id: 'payout-self-pay', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'Paying your own account is denied after the 201',
  summary: 'A payout whose receiver is the sending account is accepted with 201, then the batch goes DENIED and the item FAILED with SELF_PAY_NOT_ALLOWED.',
  evidence: [probe('payout.self-pay.poll'), sibling('tailrace', 'The sending business account itself -> batch DENIED, item FAILED / SELF_PAY_NOT_ALLOWED.')],
  example: { name: 'Payout to the sender', text: payoutExample('sb-mixsn53098231@business.example.com', 'EMAIL', '1.00', 'USD') },
  detect(c) {
    const me = (c.env.senderEmail || '').toLowerCase();
    const hit = items(c).findIndex((it) => me && String(it?.receiver).toLowerCase() === me);
    if (hit < 0) return [];
    const single = items(c).length === 1;
    return [{ severity: 'blocker', where: `/items/${hit}/receiver`, title: 'The receiver is the account that sends the payout', what: 'PayPal accepts this with 201, then denies the batch and fails the item with SELF_PAY_NOT_ALLOWED. The batch status is DENIED, which a script that only checks for 2xx will miss.', fix: 'Pay a different account. Test with a sandbox personal account, not the business account that funds the payout.', evidence: this.evidence, confidence: 'observed',
      predicts: single ? { rank: RANK.terminal, status: 201, terminal: { batch: 'DENIED', item: 'FAILED', error: 'SELF_PAY_NOT_ALLOWED' } } : { rank: RANK.terminal, status: 201 } }];
  },
});

add({
  id: 'payout-unregistered', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'An email with no PayPal account is held as UNCLAIMED',
  summary: 'Pay an address that has no account and the item ends UNCLAIMED with RECEIVER_UNREGISTERED while the batch reads SUCCESS. The money is held for 30 days; the item can be cancelled only while UNCLAIMED.',
  evidence: [probe('payout.unregistered.poll'), sibling('cancelled-op', 'Any unregistered address -> item UNCLAIMED (RECEIVER_UNREGISTERED).'), probe('payout.cap.20000.01.poll')],
  example: { name: 'Payout to an unregistered address', text: payoutExample('callcheck-nobody-{{uniq}}@example.com', 'EMAIL', '1.00', 'USD') },
  detect(c) {
    const its = items(c);
    if (its.length !== 1) return [];
    const it = its[0]; const t = recipientType(c, it); const r = String(it?.receiver ?? '');
    if (t !== 'EMAIL' || !EMAIL_RE.test(r)) return [];
    const reg = (c.env.registered || []).map((x) => x.toLowerCase());
    if (r.toLowerCase() === (c.env.senderEmail || '').toLowerCase()) return [];
    if (reg.includes(r.toLowerCase())) return [{ severity: 'note', title: 'This receiver is a registered sandbox account', what: 'The item should reach SUCCESS about 20 seconds after the 201.', fix: 'Poll the item until it says SUCCESS.', evidence: [probe('payout.create.ok.poll')], confidence: 'observed', predicts: { rank: RANK.terminal, status: 201, terminal: { batch: 'SUCCESS', item: 'SUCCESS' } } }];
    if (/@personal\.example\.com$/i.test(r)) return [{ severity: 'note', title: 'Unknown whether this sandbox account exists', what: 'If the address belongs to a sandbox personal account the item reaches SUCCESS. If it does not, it stays UNCLAIMED.', fix: 'Check Sandbox > Accounts in the developer dashboard, then poll the item.', evidence: [this.evidence[0]], confidence: 'spec' }];
    return [{ severity: 'warning', where: `/items/0/receiver`, title: 'This payout will be held as UNCLAIMED', what: `Nothing in the sandbox owns ${r}. The batch will read SUCCESS while the item sits UNCLAIMED with RECEIVER_UNREGISTERED, and the funds are held for 30 days.`, fix: 'Pay a registered account, or tell the recipient to sign up with that email. Cancel an unclaimed item with POST /v1/payments/payouts-item/{id}/cancel; it works only while the status is UNCLAIMED.', evidence: this.evidence.slice(0, 2), confidence: 'observed',
      predicts: { rank: RANK.terminal, status: 201, terminal: { batch: 'SUCCESS', item: 'UNCLAIMED', error: 'RECEIVER_UNREGISTERED' } } }];
  },
});

add({
  id: 'payout-per-item-cap', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'The per-item cap has three values, and the sandbox enforces none',
  summary: 'PayPal\'s FAQ says $20,000 per item. The fees page says USD 60,000 for a registered recipient and 20,000 for an unregistered one (GBP 50,000 and 15,000). The AI-Toolkit skill file says $20,000. The live schema states no cap. The sandbox accepted 20,000.01.',
  evidence: [probe('payout.cap.20000.01'), probe('payout.cap.20000.01.poll'), sibling('escrow', 'Sandbox accepted per-item 19,999.99 / 20,000.00 / 20,000.01 / 25,000 / 50,000 to unregistered receivers: no per-item cap enforced in sandbox.')],
  example: { name: 'Payout above 20,000', text: payoutExample('callcheck-cap-{{uniq}}@example.com', 'EMAIL', '20000.01', 'USD') },
  detect(c) {
    const over = items(c).findIndex((it) => Number(it?.amount?.value) > 20000);
    if (over < 0) return [];
    return [{ severity: 'warning', where: `/items/${over}/amount/value`, title: 'Above the lowest documented per-item cap', what: `Item ${over + 1} is ${c.body.items[over].amount.value} ${c.body.items[over].amount.currency}. PayPal documents caps of 20,000, 60,000 and 20,000 depending on the page. The sandbox accepted 20,000.01 (fee 14.00) and held it as UNCLAIMED. Production may refuse it.`, fix: 'Split anything above 20,000 into several items, and confirm your account limit with PayPal before relying on a higher figure.', evidence: this.evidence.slice(0, 2), confidence: 'observed', predicts: { rank: RANK.success, status: 201 } }];
  },
});

add({
  id: 'payout-magic-note', products: ['payouts'], ops: ['POST /v1/payments/payouts'], severity: 'note', group: 'Payouts',
  title: 'A note that starts a failure on purpose',
  summary: 'PayPal\'s sandbox reads simulation codes out of the item note. ERRPYO005 returns 422 INSUFFICIENT_FUNDS at creation time. Other codes (001, 002, 003, 006, 010) force other errors, and some codes are ignored.',
  evidence: [probe('payout.magic.ERRPYO005'), sibling('cancelled-op', 'ERRPYO001 403 SENDER_RESTRICTED, 002 403 SENDER_EMAIL_UNCONFIRMED, 003 403 AUTHORIZATION_ERROR, 005 422 INSUFFICIENT_FUNDS, 006 500 INTERNAL_ERROR, 010 400 VALIDATION_ERROR; 004/007/008/009 -> plain SUCCESS.')],
  example: { name: 'Simulated failure ERRPYO005', text: payoutExample('sb-patient@personal.example.com', 'EMAIL', '1.00', 'USD', { note: 'ERRPYO005' }) },
  detect(c) {
    const code = items(c).map((it) => /ERRPYO0\d\d/.exec(String(it?.note ?? ''))?.[0]).find(Boolean);
    if (!code) return [];
    const m = MAGIC[code];
    return [{ severity: 'note', where: '/items/0/note', title: `${code} is a simulation trigger`, what: m ? `The sandbox turns this note into a ${m[0]} ${m[1]}. It is a test switch, not a real failure.` : `${code} is in the simulation range but did nothing in earlier runs; the call goes through as a plain success.`, fix: 'Remove the code from the note before the same payload goes anywhere near production.', evidence: this.evidence, confidence: m && code === 'ERRPYO005' ? 'observed' : 'recorded',
      predicts: m && code === 'ERRPYO005' ? { rank: RANK.business, status: m[0], name: m[1] } : undefined }];
  },
});

add({
  id: 'payout-batch-size', products: ['payouts'], ops: ['POST /v1/payments/payouts'], group: 'Payouts',
  title: 'Batches stop at 15,000 items',
  summary: 'The Payouts API takes 1 to 15,000 items per call and 400 POSTs a minute. The web file upload takes 5,000.',
  evidence: [specNote('Live Payouts 1.9: "You can send up to 15,000 payments per call."'), doc('research/capability/FINDINGS.md section 7.3: rate limit 400 POST requests per minute.')],
  detect(c) {
    return items(c).length > 15000 ? [{ severity: 'blocker', where: '/items', title: `${items(c).length} items is over the 15,000 limit`, what: 'PayPal documents 15,000 items per call as the ceiling.', fix: 'Split into batches of 15,000 or fewer, each with its own sender_batch_id.', evidence: this.evidence, confidence: 'spec' }] : [];
  },
});

/* ---------------------------------------------------------------- Invoicing */

add({
  id: 'invoice-number-dup', products: ['invoicing'], ops: ['POST /v2/invoicing/invoices'], group: 'Invoicing',
  title: 'A duplicate invoice_number is a 422 that means the invoice exists',
  summary: 'Creating a second invoice with the same invoice_number returns 422 UNPROCESSABLE_ENTITY with issue DUPLICATE_INVOICE_NUMBER. The first one stands, so a retry after a timeout should adopt it rather than fail.',
  evidence: [probe('invoice.dup-number'), probe('invoice.search-by-number')],
  example: { name: 'Invoice with a fixed number', text: invoiceExample('CC-FIXED-{{uniq}}') },
  detect(c) {
    const n = c.body?.detail?.invoice_number;
    if (!n) return [];
    return [{ severity: 'warning', where: '/detail/invoice_number', title: 'The second send of this invoice number is a 422', what: `Invoice number "${n}" is unique per account. A retry returns 422 DUPLICATE_INVOICE_NUMBER with the message "Invoice number is duplicate."`, fix: 'Catch the 422 and read the issue. On DUPLICATE_INVOICE_NUMBER, look the invoice up with POST /v2/invoicing/search-invoices {"invoice_number": "..."} and carry on with it. Do not retry with a new number, or the customer gets two invoices.', evidence: this.evidence, confidence: 'observed',
      predicts: [{ rank: RANK.success, attempt: 1, status: 201 }, { rank: RANK.business, attempt: 2, status: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'DUPLICATE_INVOICE_NUMBER' }] }];
  },
});


add({
  id: 'invoice-request-id-ignored', products: ['invoicing'], ops: ['POST /v2/invoicing/invoices'], group: 'Invoicing',
  title: 'PayPal-Request-Id does nothing on invoice create',
  summary: 'Two POSTs with the same PayPal-Request-Id and different invoice numbers created two invoices. The invoice_number is the idempotency key for invoices, not the header.',
  evidence: [probe('invoice.request-id.second'), sibling('bryntum', 'Invoicing v2 ignores PayPal-Request-Id on create (checked: three calls, three invoices), so the idempotency key is a deterministic invoice number.')],
  detect(c) {
    if (!hdr(c, 'paypal-request-id')) return [];
    return [{ severity: 'warning', where: 'header:PayPal-Request-Id', title: 'The Request-Id will not stop a duplicate invoice', what: 'The same header on two creates produced two invoices in the sandbox.', fix: 'Derive invoice_number from the thing you are billing and let DUPLICATE_INVOICE_NUMBER be the guard.', evidence: this.evidence, confidence: 'observed' }];
  },
});

add({
  id: 'invoice-number-length', products: ['invoicing'], ops: ['POST /v2/invoicing/invoices', 'PUT /v2/invoicing/invoices/{invoice_id}'], group: 'Invoicing',
  title: 'invoice_number stops at 25 characters',
  summary: 'The schema caps invoice_number at 25 characters. A longer one is a 400 INVALID_STRING_MAX_LENGTH. Prefix and suffix schemes grow past 25 quickly, and a number from generate-next-invoice-number can be too long for create to accept.',
  evidence: [probe('invoice.number-26'), sibling('pre-price', 'PayPal generate-next-invoice-number gives >25 char value its own create rejects.')],
  example: { name: 'Invoice number of 26 characters', text: invoiceExample('INV-2026-OCTOBER-0000000042') },
  detect(c) {
    const n = c.body?.detail?.invoice_number;
    if (typeof n !== 'string' || n.length <= 25 || !isRealId(n)) return [];
    return [{ severity: 'blocker', where: '/detail/invoice_number', title: `invoice_number is ${n.length} characters`, what: 'The limit is 25. PayPal answers 400 INVALID_REQUEST with issue INVALID_STRING_MAX_LENGTH and creates nothing.', fix: 'Shorten the number to 25 characters or fewer, or leave invoice_number out and PayPal assigns one.', evidence: this.evidence, confidence: 'observed',
      predicts: { rank: RANK.schema, status: 400, name: 'INVALID_REQUEST', issue: 'INVALID_STRING_MAX_LENGTH' }, patch: (r) => { r.body.detail.invoice_number = r.body.detail.invoice_number.slice(0, 25); } }];
  },
});

add({
  id: 'invoice-update-is-put', products: ['invoicing'], ops: [], group: 'Invoicing',
  title: 'Invoices update with PUT, not PATCH',
  summary: 'The live Invoicing schema has GET, PUT and DELETE on an invoice and no PATCH. A PATCH answers 404 with an empty body, which looks like a wrong id rather than a wrong verb. PUT replaces the whole invoice.',
  evidence: [probe('invoice.patch'), doc('research/capability/FINDINGS.md section 9: Update is PUT only, full replace, no PATCH.')],
  example: { name: 'PATCH an invoice', text: 'PATCH /v2/invoicing/invoices/{{new_invoice}}\nContent-Type: application/json\n\n[{"op":"replace","path":"/detail/note","value":"Thanks"}]' },
  detect() { return []; }, // raised by the generic unknown-method check, which knows which verbs exist
});

add({
  id: 'mock-header-scope', products: ['*'], ops: [], group: 'Everything',
  title: 'PayPal-Mock-Response works on two APIs and fails on the rest',
  summary: 'Negative testing with PayPal-Mock-Response is for Orders and Payments. Sent to Invoicing it returned 403 with an empty body, which reads like a permissions problem.',
  evidence: [probe('invoice.mock-header'), probe('order.mock-header'), doc('PayPal marks negative testing as beta and says it works on Orders v2, Payments v2 and Payments v1.')],
  example: { name: 'Mock header on an invoice', text: invoiceExample('CC-MOCK-{{uniq}}', { mock: true }) },
  detect(c) {
    const v = hdr(c, 'paypal-mock-response');
    if (v === undefined) return [];
    if (c.product === 'orders' || c.product === 'payments') return [{ severity: 'note', where: 'header:PayPal-Mock-Response', title: 'This header triggers a simulated error', what: 'The sandbox returns the error named in mock_application_codes instead of doing the work. It must not ship to production.', fix: 'Strip the header outside tests.', evidence: [this.evidence[1]], confidence: 'observed' }];
    return [{ severity: 'blocker', where: 'header:PayPal-Mock-Response', title: `${c.product ? c.product[0].toUpperCase() + c.product.slice(1) : 'This API'} does not support the mock header`, what: 'Sent here, the sandbox answered 403 with an empty body. That looks like a permissions failure and is not one.', fix: 'Remove PayPal-Mock-Response. Use it only on Orders and Payments.', evidence: this.evidence.slice(0, 1), confidence: c.product === 'invoicing' ? 'observed' : 'doc',
      predicts: c.product === 'invoicing' ? { rank: RANK.business, status: 403 } : undefined, patch: (r) => { for (const k of Object.keys(r.headers)) if (k.toLowerCase() === 'paypal-mock-response') delete r.headers[k]; } }];
  },
});

add({
  id: 'invoice-qr', products: ['invoicing'], ops: ['POST /v2/invoicing/invoices/{invoice_id}/generate-qr-code'], severity: 'note', group: 'Invoicing',
  title: 'The QR code endpoint returns multipart, not JSON, and does not check the invoice state',
  summary: 'The docs say the invoice must be sent first. The sandbox generated a QR image for a DRAFT invoice. The response is multipart/form-data holding a PNG, so a JSON parser fails on it.',
  evidence: [probe('invoice.qr-before-send'), doc('PayPal docs: send the invoice before generating the QR code.')],
  detect() {
    return [{ severity: 'note', title: 'Do not parse this response as JSON', what: 'A 200 here carries a multipart body with the image, and the sandbox did not enforce "send first" on a draft invoice.', fix: 'Read the response as a stream of bytes and split the multipart parts. Send the invoice before generating the code, as documented, because production may enforce it.', evidence: this.evidence, confidence: 'observed' }];
  },
});

/* ------------------------------------------------------------------- Orders */

add({
  id: 'orders-amount-mismatch', products: ['orders'], ops: ['POST /v2/checkout/orders'], group: 'Orders',
  title: 'The breakdown has to add up to the amount',
  summary: 'amount.value must equal item_total + tax_total + shipping + handling + insurance - shipping_discount - discount. The schema cannot express that sum, so a mismatch passes validation and PayPal answers 422 AMOUNT_MISMATCH.',
  evidence: [probe('order.amount-mismatch')],
  example: { name: 'Order whose breakdown does not add up', text: orderExample({ value: '10.00', breakdown: { item_total: { currency_code: 'USD', value: '8.00' } } }) },
  detect(c) {
    const out = [];
    (c.body?.purchase_units ?? []).forEach((pu, i) => {
      const a = pu?.amount; const b = a?.breakdown;
      if (!isObj(a) || !isObj(b) || a.value == null) return;
      const v = (k) => Number(b[k]?.value ?? 0);
      const sum = v('item_total') + v('tax_total') + v('shipping') + v('handling') + v('insurance') - v('shipping_discount') - v('discount');
      if (Number.isNaN(sum) || Number.isNaN(Number(a.value))) return;
      if (Math.abs(minor(sum) - minor(a.value)) >= 1) out.push({ severity: 'blocker', where: `/purchase_units/${i}/amount/value`, title: 'amount.value does not equal the breakdown', what: `The breakdown adds up to ${sum.toFixed(2)} and amount.value is ${a.value}. PayPal answers 422 UNPROCESSABLE_ENTITY with AMOUNT_MISMATCH and creates no order.`, fix: `Set amount.value to ${sum.toFixed(2)}, or correct the breakdown lines.`, evidence: this.evidence, confidence: 'observed',
        predicts: { rank: RANK.business, status: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'AMOUNT_MISMATCH' }, patch: (r) => { r.body.purchase_units[i].amount.value = sum.toFixed(2); } });
    });
    return out;
  },
});

add({
  id: 'orders-currency-decimals', products: ['orders', 'payments'], ops: ['POST /v2/checkout/orders'], group: 'Orders',
  title: 'Decimal places depend on the currency',
  summary: 'HUF, JPY and TWD take whole numbers only; a decimal is 422 DECIMALS_NOT_SUPPORTED. Every other currency takes at most two places; a third is 422 DECIMAL_PRECISION.',
  evidence: [probe('order.jpy-decimals'), probe('order.usd-3dp'), doc('research/capability/FINDINGS.md section 12.7: 24 currencies, only HUF, JPY and TWD are zero-decimal.')],
  example: { name: 'JPY order with a decimal', text: orderExample({ value: '10.50', currency: 'JPY' }) },
  detect(c) {
    const out = [];
    (c.body?.purchase_units ?? []).forEach((pu, i) => {
      const a = pu?.amount; if (!isObj(a) || a.value == null || !isRealId(String(a.value))) return;
      const s = String(a.value); const dec = (s.split('.')[1] ?? '').length;
      if (ZERO_DECIMAL.includes(a.currency_code) && dec > 0) out.push({ severity: 'blocker', where: `/purchase_units/${i}/amount/value`, title: `${a.currency_code} takes whole numbers only`, what: `"${s}" has ${dec} decimal place${dec > 1 ? 's' : ''}. PayPal answers 422 DECIMALS_NOT_SUPPORTED.`, fix: `Send ${Math.round(Number(s))} for this amount. Round before you build the request.`, evidence: [this.evidence[0]], confidence: 'observed', predicts: { rank: RANK.business, status: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'DECIMALS_NOT_SUPPORTED' }, patch: (r) => { r.body.purchase_units[i].amount.value = String(Math.round(Number(s))); } });
      else if (!ZERO_DECIMAL.includes(a.currency_code) && dec > 2) out.push({ severity: 'blocker', where: `/purchase_units/${i}/amount/value`, title: `${a.currency_code || 'This currency'} allows two decimal places`, what: `"${s}" has ${dec}. PayPal answers 422 DECIMAL_PRECISION.`, fix: `Send ${Number(s).toFixed(2)}.`, evidence: [this.evidence[1]], confidence: 'observed', predicts: { rank: RANK.business, status: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'DECIMAL_PRECISION' }, patch: (r) => { r.body.purchase_units[i].amount.value = Number(s).toFixed(2); } });
    });
    return out;
  },
});

add({
  id: 'orders-value-type', products: ['orders', 'payments'], ops: ['POST /v2/checkout/orders'], group: 'Orders',
  title: 'Money values are strings, and the API forgives numbers that the SDK refuses',
  summary: 'The schema types amount.value as a string. The live API accepted the number 10 and created the order (201). The APIMatic-generated SDK validates before sending and throws. Code that works over raw HTTP then fails the day it moves to the SDK.',
  evidence: [probe('order.value-number'), specNote('Live Orders 2.36: money.value is type string.')],
  example: { name: 'Order with a numeric amount', text: orderExample({ value: 10 }) },
  detect(c) {
    const out = [];
    (c.body?.purchase_units ?? []).forEach((pu, i) => {
      const a = pu?.amount;
      if (isObj(a) && typeof a.value === 'number') out.push({ severity: 'warning', where: `/purchase_units/${i}/amount/value`, title: 'amount.value is a number; the schema says string', what: `PayPal accepted the number 10 and created an order (201). The SDK would refuse it before the request leaves your process. Floating-point values also round badly (0.1 + 0.2).`, fix: `Send "${Number(a.value).toFixed(2)}" as a string, formatted to the currency's decimal places.`, evidence: this.evidence, confidence: 'observed', predicts: { rank: RANK.success, status: 201 }, patch: (r) => { r.body.purchase_units[i].amount.value = Number(a.value).toFixed(2); } });
    });
    return out;
  },
});

add({
  id: 'orders-request-id-required', products: ['orders'], ops: ['POST /v2/checkout/orders'], group: 'Orders',
  title: 'Charging at create time needs PayPal-Request-Id',
  summary: 'When the order carries a card payment source, PayPal refuses it unless PayPal-Request-Id is present: 400 PAYPAL_REQUEST_ID_REQUIRED. A PayPal-wallet payment source did not need it. The generated SDK documents the header as mandatory for every single-step create.',
  evidence: [probe('order.card-source'), probe('order.wallet-source.no-request-id'), doc('APIMatic SDK 2.5.0, createOrder: "It is mandatory for all single-step create order calls (E.g. Create Order Request with payment source information like Card, PayPal.vault_id, PayPal.billing_agreement_id)."')],
  detect(c) {
    const ps = c.body?.payment_source;
    if (!isObj(ps) || hdr(c, 'paypal-request-id')) return [];
    const needs = isObj(ps.card) || (isObj(ps.paypal) && (ps.paypal.vault_id || ps.paypal.billing_agreement_id)) || ps.token;
    if (!needs) return [];
    return [{ severity: 'blocker', where: 'header:PayPal-Request-Id', title: 'PayPal-Request-Id is missing on a charge', what: 'This order tries to take payment as it is created. PayPal answers 400 INVALID_REQUEST with issue PAYPAL_REQUEST_ID_REQUIRED.', fix: 'Add PayPal-Request-Id with a value you can regenerate for the same purchase (an order number), so a retry cannot charge twice.', evidence: this.evidence.slice(0, 2), confidence: isObj(ps.card) ? 'observed' : 'doc', predicts: isObj(ps.card) ? { rank: RANK.schema, status: 400, name: 'INVALID_REQUEST', issue: 'PAYPAL_REQUEST_ID_REQUIRED' } : undefined,
      patch: (r) => { r.headers['PayPal-Request-Id'] = 'order-' + hash(JSON.stringify(r.body.purchase_units ?? [])); } }];
  },
});

add({
  id: 'orders-request-id-reuse', products: ['orders'], ops: ['POST /v2/checkout/orders'], group: 'Orders',
  title: 'Reusing a Request-Id with a different body returns the first order',
  summary: 'PayPal replays the stored response for a PayPal-Request-Id it has already seen, even when the body has changed. A second POST with a different amount returned the original order, with HTTP 200 instead of 201 and the old amount.',
  evidence: [probe('order.create.same-rid.diff-body'), probe('order.create.same-rid')],
  example: { name: 'Order with a fixed Request-Id', text: orderExample({ value: '10.00' }, { requestId: 'cc-order-{{uniq}}' }) },
  detect(c) {
    const rid = hdr(c, 'paypal-request-id');
    if (!rid) return [];
    return [{ severity: 'warning', where: 'header:PayPal-Request-Id', title: 'A reused Request-Id hides changes to the order', what: 'On the second POST with this id PayPal returns the first response unchanged, with HTTP 200 and the same order id, whatever the new body says. Change the amount and keep the id and you will capture the old amount.', fix: 'Derive the id from the purchase, so a retry of the same purchase repeats it and a changed purchase gets a new one. Treat 200 with an existing order id as "already created".', evidence: this.evidence, confidence: 'observed',
      predicts: { rank: RANK.success, attempt: 2, status: 200, sameResourceAsAttempt1: true } }];
  },
});

add({
  id: 'orders-create-response', products: ['orders'], ops: ['POST /v2/checkout/orders'], severity: 'note', group: 'Orders',
  title: 'The approval link has two names, and the status code changes with the payment source',
  summary: 'An order created without a payment source returns 201 CREATED and a link with rel "approve". With payment_source.paypal it returns 200 PAYER_ACTION_REQUIRED and the same link under rel "payer-action". Code that looks for one name misses the other.',
  evidence: [probe('order.create'), probe('order.wallet-source')],
  example: { name: 'Wallet order with a payment source', text: orderExample({ value: '10.00' }, { walletSource: true, requestId: 'cc-wallet-{{uniq}}' }) },
  detect(c) {
    const wallet = isObj(c.body?.payment_source?.paypal);
    return [{ severity: 'note', title: wallet ? 'Expect 200 and a payer-action link' : 'Expect 201 and an approve link', what: wallet ? 'With payment_source.paypal the response is HTTP 200, status PAYER_ACTION_REQUIRED, and the buyer URL is under rel "payer-action".' : 'Without a payment source the response is HTTP 201, status CREATED, and the buyer URL is under rel "approve". No buyer can be charged until they approve it in a browser.', fix: 'Find the link whose rel is "payer-action" or "approve". Accept both 200 and 201 as success on create.', evidence: wallet ? [this.evidence[1]] : [this.evidence[0]], confidence: 'observed',
      predicts: wallet ? { rank: RANK.success, status: 200, body: { status: 'PAYER_ACTION_REQUIRED' } } : { rank: RANK.success, status: 201, body: { status: 'CREATED' } } }];
  },
});

add({
  id: 'orders-capture-unapproved', products: ['orders'], ops: ['POST /v2/checkout/orders/{id}/capture', 'POST /v2/checkout/orders/{id}/authorize'], group: 'Orders',
  title: 'Capture before the buyer approves is a 422',
  summary: 'A new order is CREATED. Capture and authorize both answer 422 ORDER_NOT_APPROVED until the buyer approves it in a browser (or a vaulted token approved it for them). No API approves an order on the buyer\'s behalf.',
  evidence: [probe('order.capture-unapproved'), probe('order.authorize-unapproved')],
  example: { name: 'Capture a fresh order', text: 'POST /v2/checkout/orders/{{new_order}}/capture\nContent-Type: application/json\nPayPal-Request-Id: cc-cap-{{uniq}}\n\n{}' },
  detect(c) {
    const id = c.o?.pathParams?.id;
    const fresh = id === '{{new_order}}' || id === 'a1b2c3d4-order';
    return [{ severity: fresh ? 'blocker' : 'warning', title: 'The order must be APPROVED first', what: fresh ? 'This order was created seconds ago and nobody has approved it. PayPal answers 422 ORDER_NOT_APPROVED.' : 'If the buyer has not approved this order, PayPal answers 422 ORDER_NOT_APPROVED. The same happens on authorize.', fix: 'Send the buyer to the payer-action (or approve) link, wait for CHECKOUT.ORDER.APPROVED or GET the order until status is APPROVED, then capture. For hands-free charges, create the order with a vaulted PayPal token instead.', evidence: this.evidence, confidence: 'observed',
      predicts: fresh ? { rank: RANK.business, status: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'ORDER_NOT_APPROVED' } : undefined }];
  },
});

add({
  id: 'orders-card-source', products: ['orders', 'vault'], ops: ['POST /v2/checkout/orders', 'POST /v3/vault/setup-tokens', 'POST /v3/vault/payment-tokens'], group: 'Orders',
  title: 'Card payment sources need Expanded Checkout, and vaulting a card is a 403 outside it',
  summary: 'Expanded Checkout covers 37 countries. Outside them, or without PayPal\'s approval, a raw card order fails with PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING and vaulting a card fails with 403 NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE. PayPal-wallet vaulting works. Callcheck does not send cards, so this verdict is recorded, not re-run.',
  evidence: [sibling('guarantee', 'Raw card vaulting: NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE. Raw card orders: PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING. Sandbox app has no card processing.'), doc('research/capability/FINDINGS.md section 12.5: Expanded Checkout is limited to 37 countries; this developer account is registered in the UAE.'), policy('Callcheck never runs a request that contains card data.')],
  example: { name: 'Vault a card', text: 'POST /v3/vault/setup-tokens\nContent-Type: application/json\nPayPal-Request-Id: cc-card-{{uniq}}\n\n{"payment_source":{"card":{"name":"Test Buyer","number":"4111111111111111","expiry":"2030-12","security_code":"123"}}}' },
  detect(c) {
    const ps = c.body?.payment_source;
    if (!isObj(ps) || !isObj(ps.card)) return [];
    const vault = c.product === 'vault';
    return [{ severity: 'blocker', where: '/payment_source/card', title: vault ? 'Vaulting a card is refused on this kind of account' : 'Card processing is not enabled here', what: vault ? 'The sandbox app answered 403 NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE for a card. The account is outside the 37 Expanded Checkout countries.' : 'The sandbox app answered PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING for a card order.', fix: 'Use a PayPal-wallet payment source: a setup token with payment_source.paypal, approved once by the buyer, then a payment token. Callcheck will not send card data, so it will not run this call.', evidence: this.evidence, confidence: 'recorded', runnable: false }];
  },
});

add({
  id: 'orders-vault-id-stored-credential', products: ['orders'], ops: ['POST /v2/checkout/orders'], group: 'Orders',
  title: 'Charging a vaulted token needs stored_credential, and AUTHORIZE completes at once',
  summary: 'A vault_id charge needs stored_credential (payment_initiator MERCHANT, usage SUBSEQUENT). With a vaulted wallet token and intent AUTHORIZE, the create call itself returns COMPLETED with an authorization, so a later /authorize returns ORDER_ALREADY_AUTHORIZED. Treat that as success.',
  evidence: [sibling('guarantee', 'Order with payment_source.paypal.vault_id + stored_credential MERCHANT/SUBSEQUENT and intent AUTHORIZE returns COMPLETED with an authorization in ONE call; a follow-up /authorize returns ORDER_ALREADY_AUTHORIZED.')],
  detect(c) {
    const p = c.body?.payment_source?.paypal;
    if (!isObj(p) || !p.vault_id) return [];
    const out = [];
    if (!p.stored_credential) out.push({ severity: 'warning', where: '/payment_source/paypal/stored_credential', title: 'A vaulted charge without stored_credential', what: 'Merchant-initiated charges against a vault_id are expected to say so with stored_credential: payment_initiator MERCHANT, usage SUBSEQUENT, and payment_type RECURRING or UNSCHEDULED. Without it the charge can be treated as buyer-present.', fix: 'Add "stored_credential": {"payment_initiator":"MERCHANT","payment_type":"UNSCHEDULED","usage":"SUBSEQUENT"}.', evidence: this.evidence, confidence: 'recorded', patch: (r) => { r.body.payment_source.paypal.stored_credential = { payment_initiator: 'MERCHANT', payment_type: 'UNSCHEDULED', usage: 'SUBSEQUENT' }; } });
    if (c.body?.intent === 'AUTHORIZE') out.push({ severity: 'note', where: '/intent', title: 'With a vault token, AUTHORIZE completes at create', what: 'The create response already holds the authorization. Calling /authorize afterwards returns ORDER_ALREADY_AUTHORIZED.', fix: 'Read the authorization id from the create response. Treat ORDER_ALREADY_AUTHORIZED as success.', evidence: this.evidence, confidence: 'recorded' });
    return out;
  },
});

/* -------------------------------------------------------------------- Vault */

add({
  id: 'vault-wallet-urls', products: ['vault'], ops: ['POST /v3/vault/setup-tokens'], group: 'Vault',
  title: 'A wallet setup token with no return and cancel URLs has no approval link',
  summary: 'Without experience_context.return_url and cancel_url the setup token is still created (201), but its status is CREATED and its only link is "self". There is nothing to send the buyer to. With both URLs the status is PAYER_ACTION_REQUIRED and an approval link appears.',
  evidence: [probe('vault.setup-token.missing-urls'), probe('vault.setup-token.wallet')],
  example: { name: 'Wallet setup token without URLs', text: 'POST /v3/vault/setup-tokens\nContent-Type: application/json\nPayPal-Request-Id: cc-vault-{{uniq}}\n\n{"payment_source":{"paypal":{"usage_type":"MERCHANT"}}}' },
  detect(c) {
    const p = c.body?.payment_source?.paypal;
    if (!isObj(p)) return [];
    const ec = p.experience_context;
    const ok = isObj(ec) && ec.return_url && ec.cancel_url;
    if (ok) return [{ severity: 'note', title: 'Expect PAYER_ACTION_REQUIRED and an approval link', what: 'The buyer approves once in a browser. After that you exchange the setup token for a payment token.', fix: 'Redirect the buyer to the approve link, then POST /v3/vault/payment-tokens with the setup token id.', evidence: [this.evidence[1]], confidence: 'observed', predicts: { rank: RANK.success, status: 201, body: { status: 'PAYER_ACTION_REQUIRED' } } }];
    return [{ severity: 'warning', where: '/payment_source/paypal/experience_context', title: 'The buyer will have nowhere to go', what: 'No return_url and cancel_url. PayPal still answers 201, with status CREATED and no approval link, so the failure shows up later as a stuck flow rather than an error.', fix: 'Add experience_context with return_url and cancel_url.', evidence: [this.evidence[0]], confidence: 'observed', predicts: { rank: RANK.success, status: 201, body: { status: 'CREATED' } },
      patch: (r) => { r.body.payment_source.paypal.experience_context = { ...(r.body.payment_source.paypal.experience_context ?? {}), return_url: 'https://example.com/vault/return', cancel_url: 'https://example.com/vault/cancel' }; } }];
  },
});

/* ------------------------------------------------------------ Subscriptions */

add({
  id: 'plans-cycles', products: ['subscriptions'], ops: ['POST /v1/billing/plans'], group: 'Subscriptions',
  title: 'Billing cycle rules the schema cannot express',
  summary: 'A plan needs exactly one REGULAR cycle, at most two TRIAL cycles and at most 12 cycles in all. total_cycles 0 (run forever) is legal only on the REGULAR cycle. Break any of these and the plan is a 422.',
  evidence: [probe('plan.infinite-trial'), probe('plan.no-regular'), doc('research/capability/FINDINGS.md section 10.')],
  example: { name: 'Plan with an infinite trial', text: 'POST /v1/billing/plans\nContent-Type: application/json\nPayPal-Request-Id: cc-plan-{{uniq}}\n\n{"product_id":"{{new_product}}","name":"Callcheck plan","billing_cycles":[{"frequency":{"interval_unit":"MONTH","interval_count":1},"tenure_type":"TRIAL","sequence":1,"total_cycles":0,"pricing_scheme":{"fixed_price":{"value":"5","currency_code":"USD"}}},{"frequency":{"interval_unit":"MONTH","interval_count":1},"tenure_type":"REGULAR","sequence":2,"total_cycles":0,"pricing_scheme":{"fixed_price":{"value":"5","currency_code":"USD"}}}],"payment_preferences":{"auto_bill_outstanding":true,"payment_failure_threshold":3}}' },
  detect(c) {
    const cy = c.body?.billing_cycles; if (!Array.isArray(cy)) return [];
    const out = []; const reg = cy.filter((x) => x?.tenure_type === 'REGULAR').length; const trial = cy.filter((x) => x?.tenure_type === 'TRIAL').length;
    cy.forEach((x, i) => { if (x?.tenure_type === 'TRIAL' && x.total_cycles === 0) out.push({ severity: 'blocker', where: `/billing_cycles/${i}/total_cycles`, title: 'A trial cannot run forever', what: 'total_cycles 0 means "indefinite" and is allowed only on the REGULAR cycle. PayPal answers 422 INVALID_TRIAL_BILLING_TOTAL_CYCLES.', fix: 'Give the trial a finite total_cycles, for example 1.', evidence: [this.evidence[0]], confidence: 'observed', predicts: { rank: RANK.business, status: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'INVALID_TRIAL_BILLING_TOTAL_CYCLES' }, patch: (r) => { r.body.billing_cycles[i].total_cycles = 1; } }); });
    if (reg !== 1) out.push({ severity: 'blocker', where: '/billing_cycles', title: reg === 0 ? 'A plan needs one REGULAR cycle' : 'A plan allows only one REGULAR cycle', what: `This plan has ${reg}. PayPal answers 422 MISSING_REGULAR_BILLING_CYCLE when there is none.`, fix: 'Keep exactly one cycle with tenure_type REGULAR, after any trials.', evidence: [this.evidence[1]], confidence: reg === 0 ? 'observed' : 'doc', predicts: reg === 0 && !out.length ? { rank: RANK.business, status: 422, name: 'UNPROCESSABLE_ENTITY', issue: 'MISSING_REGULAR_BILLING_CYCLE' } : undefined });
    if (trial > 2) out.push({ severity: 'blocker', where: '/billing_cycles', title: 'At most two trial cycles', what: `This plan has ${trial} TRIAL cycles.`, fix: 'Merge trials or drop extras.', evidence: [this.evidence[2]], confidence: 'doc' });
    if (cy.length > 12) out.push({ severity: 'blocker', where: '/billing_cycles', title: 'At most 12 billing cycles', what: `This plan has ${cy.length}.`, fix: 'Reduce to 12 or fewer.', evidence: [this.evidence[2]], confidence: 'doc' });
    return out;
  },
});

add({
  id: 'plans-patch-cycles', products: ['subscriptions'], ops: ['PATCH /v1/billing/plans/{plan_id}', 'PATCH /v1/billing/plans/{id}'], group: 'Subscriptions',
  title: 'You cannot PATCH a plan\'s billing cycles',
  summary: 'A plan\'s billing_cycles are immutable once created. PATCH on a cycle path answers 400 INVALID_PATCH_PATH. Change a price with update-pricing-schemes; for anything else, create a new plan.',
  evidence: [probe('plan.patch-cycles'), doc('research/capability/FINDINGS.md section 10: Plans are largely immutable.')],
  example: { name: 'Patch a plan cycle', text: 'PATCH /v1/billing/plans/{{new_plan}}\nContent-Type: application/json\n\n[{"op":"replace","path":"/billing_cycles/0/total_cycles","value":5}]' },
  detect(c) {
    const bad = Array.isArray(c.body) ? c.body.findIndex((p) => /^\/billing_cycles/.test(String(p?.path))) : -1;
    if (bad < 0) return [];
    return [{ severity: 'blocker', where: `/${bad}/path`, title: 'billing_cycles cannot be patched', what: 'PayPal answers 400 INVALID_REQUEST with issue INVALID_PATCH_PATH.', fix: 'To change the price use POST /v1/billing/plans/{id}/update-pricing-schemes. To change anything else, create a new plan and move new subscribers to it.', evidence: this.evidence, confidence: 'observed', predicts: { rank: RANK.schema, status: 400, name: 'INVALID_REQUEST', issue: 'INVALID_PATCH_PATH' } }];
  },
});

add({
  id: 'subscription-approval', products: ['subscriptions'], ops: ['POST /v1/billing/subscriptions'], severity: 'note', group: 'Subscriptions',
  title: 'A new subscription waits for a human',
  summary: 'POST /v1/billing/subscriptions returns 201 with status APPROVAL_PENDING. Activating it before the buyer approves is a 422 SESSION_STATE_NOT_VALID. Nothing in the sandbox moves its clock, so renewals and retries cannot be demonstrated.',
  evidence: [probe('subscription.create'), probe('subscription.activate-pending'), doc('research/capability/FINDINGS.md section 10: PayPal documents no sandbox fast-forward.')],
  detect() {
    return [{ severity: 'note', title: 'Expect APPROVAL_PENDING, not ACTIVE', what: 'The buyer must approve in a browser. Until then the subscription is APPROVAL_PENDING and /activate answers 422 SESSION_STATE_NOT_VALID.', fix: 'Redirect to the approve link and listen for BILLING.SUBSCRIPTION.ACTIVATED. Do not call /activate yourself.', evidence: this.evidence.slice(0, 2), confidence: 'observed' }];
  },
});

/* ----------------------------------------------------------------- Disputes */

add({
  id: 'disputes-accept-claim', products: ['disputes'], ops: ['POST /v1/customer/disputes/{id}/accept-claim', 'POST /v1/customer/disputes/{dispute_id}/accept-claim'], group: 'Disputes',
  title: 'accept-claim closes the dispute in the buyer\'s favour and refunds',
  summary: 'It is the only dispute write PayPal\'s MCP server offers, and it concedes. Callcheck never runs it.',
  evidence: [doc('PayPal MCP tool description: "the dispute closes in the customer\'s favor and PayPal automatically refunds money to the customer from the merchant\'s account."'), sibling('dispute-defence', 'accept-claim refunds buyers, so it is never called live.'), policy('Callcheck refuses to run accept-claim.')],
  detect() {
    return [{ severity: 'blocker', title: 'This call concedes the dispute', what: 'PayPal closes the dispute for the buyer and refunds them from your balance. It cannot be undone.', fix: 'To contest, use provide-evidence, make-offer or escalate instead. Callcheck will check this call but will not run it.', evidence: this.evidence, confidence: 'doc', runnable: false }];
  },
});

add({
  id: 'disputes-invented-id', products: ['disputes'], ops: ['GET /v1/customer/disputes/{id}', 'GET /v1/customer/disputes/{dispute_id}'], group: 'Disputes',
  title: 'An invented dispute id can belong to someone else',
  summary: 'A made-up id that fits the PP-D-nnnnn pattern may be a real dispute on another merchant\'s account: 403 NOT_AUTHORIZED. An id nobody owns is 404 RESOURCE_NOT_FOUND. The sandbox lists zero disputes for this account.',
  evidence: [probe('disputes.invented-id'), probe('disputes.unknown-id'), probe('disputes.list'), sibling('dispute-defence', 'The id PP-D-48201 I had invented happens to be a real sandbox dispute of someone else (403).')],
  example: { name: 'Fetch an invented dispute', text: 'GET /v1/customer/disputes/PP-D-48201' },
  detect(c) {
    const id = c.o?.pathParams?.id ?? c.o?.pathParams?.dispute_id;
    if (!id || !/^PP-D-\d{4,}$/.test(id)) return [];
    return [{ severity: 'warning', where: 'path', title: 'This id may be someone else\'s dispute', what: 'Ids shaped like PP-D-nnnnn are shared across merchants. A made-up one can come back 403 ACTION_NOT_ALLOWED (it exists, and is not yours) or 404 (it does not exist).', fix: 'List with GET /v1/customer/disputes first and only use ids that come back. Name fixtures so they cannot collide, for example FX-D-48201.', evidence: this.evidence.slice(0, 2), confidence: 'observed', predicts: { rank: RANK.business, status: [403, 404] } }];
  },
});

add({
  id: 'disputes-evidence-multipart', products: ['disputes'], ops: ['POST /v1/customer/disputes/{id}/provide-evidence', 'POST /v1/customer/disputes/{dispute_id}/provide-evidence'], group: 'Disputes',
  title: 'provide-evidence is multipart, and the schema only describes the file part',
  summary: 'The spec declares multipart/form-data with an evidence-file part. The JSON part named input appears only in PayPal\'s integration guide samples. A plain JSON body is not what this endpoint expects.',
  evidence: [sibling('dispute-defence', 'Schema documents provide-evidence ONLY as multipart/form-data with an evidence-file part; the JSON part (input) is not in the machine-readable schema.'), doc('jpg, jpeg, gif, png, pdf only; under 10 MB per file, 50 MB total.')],
  detect(c) {
    return [{ severity: 'warning', title: 'Send multipart, with a JSON part named input', what: 'The schema cannot validate this body because it only describes the file part. Tools generated from the spec send the wrong shape.', fix: 'POST multipart/form-data: a part named input (type application/json) holding evidence_type and evidence_info, plus file parts. Callcheck will not run this call.', evidence: this.evidence, confidence: 'recorded', runnable: false }];
  },
});

/* ----------------------------------------------------------------- Webhooks */

add({
  id: 'webhook-event-name', products: ['webhooks'], ops: ['POST /v1/notifications/webhooks'], group: 'Webhooks',
  title: 'Webhook event names do not match the status names',
  summary: 'A subscribed event name that PayPal does not know is a 400 "Not a valid event name". Webhook names differ from the statuses they report: SUCCEEDED, not SUCCESS, for a payout item; HELD, not ONHOLD. The live list has 205 names.',
  evidence: [probe('webhook.bad-event-name'), probe('webhooks.event-types'), doc('research/capability/FINDINGS.md section 7.4.')],
  example: { name: 'Subscribe to PAYOUTS-ITEM.SUCCESS', text: 'POST /v1/notifications/webhooks\nContent-Type: application/json\n\n{"url":"https://example.com/hook","event_types":[{"name":"PAYMENT.PAYOUTS-ITEM.SUCCESS"}]}' },
  detect(c) {
    const list = c.deps.eventTypes; const ev = c.body?.event_types;
    if (!Array.isArray(list) || !Array.isArray(ev)) return [];
    const out = [];
    ev.forEach((e, i) => {
      const n = e?.name; if (typeof n !== 'string' || n === '*' || list.includes(n)) return;
      const near = closest(n, list, 2);
      out.push({ severity: 'blocker', where: `/event_types/${i}/name`, title: `${n} is not an event PayPal sends`, what: `It is not among the ${list.length} names from GET /v1/notifications/webhooks-event-types. PayPal answers 400 VALIDATION_ERROR "Not a valid event name" and registers nothing.`, fix: near.length ? `Did you mean ${near.join(' or ')}?` : 'List valid names with GET /v1/notifications/webhooks-event-types.', evidence: this.evidence.slice(0, 2), confidence: 'observed', predicts: { rank: RANK.business, status: 400, name: 'VALIDATION_ERROR', issue: /valid event name/i }, patch: near[0] ? (r) => { r.body.event_types[i].name = near[0]; } : undefined });
    });
    return out;
  },
});

add({
  id: 'webhook-url', products: ['webhooks'], ops: ['POST /v1/notifications/webhooks'], group: 'Webhooks',
  title: 'Webhook URLs must be https',
  summary: 'An http URL is a 400 "Not a valid webhook URL". Each app holds at most 10 webhooks, and PayPal retries a non-2xx answer up to 25 times over 3 days, so the listener must answer 200 at once and work afterwards.',
  evidence: [probe('webhook.http-url'), doc('research/capability/FINDINGS.md section 12.4: 10 webhook URLs per app; non-2xx retried up to 25 times over 3 days.')],
  example: { name: 'Register an http webhook', text: 'POST /v1/notifications/webhooks\nContent-Type: application/json\n\n{"url":"http://example.com/hook","event_types":[{"name":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED"}]}' },
  detect(c) {
    const out = []; const u = c.body?.url;
    if (typeof u === 'string' && /^http:\/\//i.test(u)) out.push({ severity: 'blocker', where: '/url', title: 'The webhook URL is not https', what: 'PayPal answers 400 VALIDATION_ERROR "Not a valid webhook URL".', fix: `Use ${u.replace(/^http:/i, 'https:')}.`, evidence: [this.evidence[0]], confidence: 'observed', predicts: { rank: RANK.business, status: 400, name: 'VALIDATION_ERROR', issue: /valid webhook URL/i }, patch: (r) => { r.body.url = r.body.url.replace(/^http:/i, 'https:'); } });
    if (typeof c.deps.webhookCount === 'number') out.push({ severity: c.deps.webhookCount >= 10 ? 'blocker' : 'note', title: `${c.deps.webhookCount} of 10 webhook slots are in use on this app`, what: c.deps.webhookCount >= 10 ? 'The app is at its cap, so this registration will be refused.' : 'The limit is 10 per app, and registrations accumulate.', fix: 'List with GET /v1/notifications/webhooks, reuse the one that already points at your listener, and delete only your own stale entries.', evidence: [this.evidence[1]], confidence: 'observed' });
    return out;
  },
});

add({
  id: 'webhook-verify-simulator', products: ['webhooks'], ops: ['POST /v1/notifications/verify-webhook-signature'], group: 'Webhooks',
  title: 'Simulator events cannot be verified',
  summary: 'Events from the webhook simulator carry the literal webhook id WEBHOOK_ID. verify-webhook-signature rejects it before it looks at the signature, because ids must be alphanumeric: 400 INVALID_REQUEST.',
  evidence: [probe('webhook.verify-simulator'), doc('research/capability/FINDINGS.md section 12.4.')],
  detect(c) {
    return c.body?.webhook_id === 'WEBHOOK_ID' ? [{ severity: 'blocker', where: '/webhook_id', title: 'WEBHOOK_ID is the simulator placeholder', what: 'PayPal answers 400 INVALID_REQUEST: webhook_id must match ^[a-zA-Z0-9]+$.', fix: 'Verify real deliveries, with your registered webhook id. Do not try to verify simulator events.', evidence: this.evidence, confidence: 'observed', predicts: { rank: RANK.schema, status: 400, name: 'INVALID_REQUEST' } }] : [];
  },
});

/* ------------------------------------------------------------ Transactions */

add({
  id: 'txn-window', products: ['transactions'], ops: ['GET /v1/reporting/transactions'], group: 'Transaction search',
  title: 'Transaction search takes 31 days at most, and both dates',
  summary: 'A range over 31 days is 400 INVALID_REQUEST "Date range is greater than 31 days". Omitting start_date or end_date is a 400 as well.',
  evidence: [probe('txn-search.window-32d'), probe('txn-search.no-dates')],
  example: { name: 'Search 55 days', text: 'GET /v1/reporting/transactions?start_date=2026-08-01T00:00:00-0000&end_date=2026-09-25T00:00:00-0000' },
  detect(c) {
    const s = c.req.query.start_date; const e = c.req.query.end_date;
    if (!s && !e) return [{ severity: 'blocker', where: 'query', title: 'start_date and end_date are required', what: 'PayPal answers 400 INVALID_REQUEST: start_date and end_date should be present in query.', fix: 'Add both, in ISO 8601 with an offset such as 2026-09-01T00:00:00-0000, and no more than 31 days apart.', evidence: [this.evidence[1]], confidence: 'observed', predicts: { rank: RANK.schema, status: 400, name: 'INVALID_REQUEST' } }];
    const d = (Date.parse(String(e).replace(/-0000$/, 'Z')) - Date.parse(String(s).replace(/-0000$/, 'Z'))) / 86400000;
    if (!Number.isFinite(d) || d <= 31) return [];
    return [{ severity: 'blocker', where: 'query/end_date', title: `The range is ${Math.ceil(d)} days`, what: 'The limit is 31. PayPal answers 400 INVALID_REQUEST "Date range is greater than 31 days".', fix: 'Walk the history in windows of 31 days or fewer.', evidence: [this.evidence[0]], confidence: 'observed', predicts: { rank: RANK.schema, status: 400, name: 'INVALID_REQUEST' } }];
  },
});

add({
  id: 'txn-access', products: ['transactions'], ops: ['GET /v1/reporting/transactions'], severity: 'note', group: 'Transaction search',
  title: 'Transaction search access is not stable across runs',
  summary: 'Earlier in this repository /v1/reporting/transactions returned 403. On 2 October 2026 it returned 200 with zero items for a five-day window, and the token now lists the reporting/search/read scope. Treat access as account-dependent.',
  evidence: [probe('txn-search.403'), probe('txn-search.scope-balances')],
  detect() {
    return [{ severity: 'note', title: 'A 403 here is an account setting, not a bug in your call', what: 'The same call returned 403 earlier and 200 later on the same app. Search access follows the account\'s reporting permission and can lag a change by hours.', fix: 'Handle 403 by showing "reporting is not enabled for this account", and keep a list of the ids you create so you do not depend on search to find them.', evidence: this.evidence, confidence: 'observed' }];
  },
});

/* ----------------------------------------------------------------- Generic */

add({
  id: 'generic-content-type', products: ['*'], ops: [], group: 'Everything',
  title: 'curl -d sends form encoding unless you say JSON',
  summary: 'A curl command with -d and no Content-Type header goes out as application/x-www-form-urlencoded. PayPal answers 415 UNSUPPORTED_MEDIA_TYPE.',
  evidence: [probe('generic.content-type-form')],
  example: { name: 'curl without a JSON header', text: 'curl -X POST https://api-m.sandbox.paypal.com/v2/checkout/orders -d \'{"intent":"CAPTURE","purchase_units":[{"amount":{"currency_code":"USD","value":"10.00"}}]}\'' },
  detect(c) {
    const ct = hdr(c, 'content-type');
    const sends = ['POST', 'PUT', 'PATCH'].includes(c.req.method) && c.body !== undefined;
    if (!sends) return [];
    if (c.req.implicitFormContentType || (ct && !/json/i.test(ct) && !/multipart/i.test(ct))) return [{ severity: 'blocker', where: 'header:Content-Type', title: 'The body will not be sent as JSON', what: `${c.req.implicitFormContentType ? 'curl adds application/x-www-form-urlencoded when you pass -d without a Content-Type.' : `Content-Type is ${ct}.`} PayPal answers 415.`, fix: 'Add -H "Content-Type: application/json".', evidence: this.evidence, confidence: 'observed', predicts: { rank: RANK.transport, status: 415 }, patch: (r) => { r.headers['Content-Type'] = 'application/json'; r.implicitFormContentType = false; } }];
    return [];
  },
});

add({
  id: 'generic-host', products: ['*'], ops: [], severity: 'warning', group: 'Everything',
  title: 'Host and environment',
  summary: 'api-m.sandbox.paypal.com is the sandbox host the specs declare. api.sandbox.paypal.com also answers, and PayPal\'s own toolkit uses both in different files. Callcheck only talks to the sandbox, so a live host is never called.',
  evidence: [doc('research/capability/FINDINGS.md section 1.6: shared/api.ts uses api-m.*, shared/client.ts uses api.* (no -m).')],
  detect(c) {
    const h = c.req.host; if (!h) return [];
    if (h === 'api-m.sandbox.paypal.com') return [];
    if (h === 'api.sandbox.paypal.com') return [{ severity: 'note', title: 'api.sandbox.paypal.com works, but the specs say api-m', what: 'Both hosts answer. PayPal\'s toolkit mixes them across files.', fix: 'Use api-m.sandbox.paypal.com, the host in the OpenAPI servers block.', evidence: this.evidence, confidence: 'doc', patch: (r) => { r.host = 'api-m.sandbox.paypal.com'; } }];
    if (/(^|\.)paypal\.com$/.test(h) && !/sandbox/.test(h)) return [{ severity: 'blocker', where: 'host', title: 'This is the live PayPal host', what: `${h} moves real money. Callcheck checks the call but runs it only against the sandbox.`, fix: 'Point the call at https://api-m.sandbox.paypal.com while testing.', evidence: this.evidence, confidence: 'policy', runnable: false, patch: (r) => { r.host = 'api-m.sandbox.paypal.com'; } }];
    return [{ severity: 'warning', where: 'host', title: `${h} is not a PayPal host`, what: 'The path is checked as if it were PayPal\'s; the host is replaced with the sandbox when the call runs.', fix: 'Use https://api-m.sandbox.paypal.com.', evidence: this.evidence, confidence: 'doc', patch: (r) => { r.host = 'api-m.sandbox.paypal.com'; } }];
  },
});

export function getTrap(id) { return TRAPS.find((t) => t.id === id); }

/** Library view: strips detectors. */
export function trapLibrary() {
  return TRAPS.map((t) => ({ id: t.id, group: t.group, title: t.title, severity: t.severity, summary: t.summary, products: t.products, ops: t.ops ?? [], evidence: t.evidence, example: t.example ?? null, runnable: !/policy/.test(JSON.stringify(t.evidence.map((e) => e.kind))) }));
}

/* -------------------------------------------------------------- example text */

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

function payoutExample(receiver, type, value, currency, o = {}) {
  const item = (rc, v, cu) => ({ recipient_type: type, amount: { value: v, currency: cu }, receiver: rc, note: o.note ?? 'Callcheck example', sender_item_id: 'item-{{uniq}}' + (rc === receiver ? '' : '-b') });
  const items2 = [item(receiver, value, currency)]; if (o.second) items2.push(item(...o.second));
  const header = { email_subject: 'Callcheck example' }; if (!o.noBatchId) header.sender_batch_id = 'cc-{{uniq}}';
  return `POST /v1/payments/payouts\nContent-Type: application/json\n\n${JSON.stringify({ sender_batch_header: header, items: items2 }, null, 2)}`;
}

function invoiceExample(number, o = {}) {
  const body = { detail: { invoice_number: number, currency_code: 'USD' }, invoicer: { business_name: 'Callcheck example' }, primary_recipients: [{ billing_info: { email_address: 'sb-patient@personal.example.com' } }], items: [{ name: 'Consulting', quantity: '1', unit_amount: { currency_code: 'USD', value: '5.00' } }] };
  return `POST /v2/invoicing/invoices\nContent-Type: application/json\n${o.mock ? 'PayPal-Mock-Response: {"mock_application_codes":"DUPLICATE_INVOICE_ID"}\n' : ''}\n${JSON.stringify(body, null, 2)}`;
}

function orderExample(amount, o = {}) {
  const a = { currency_code: amount.currency ?? 'USD', value: amount.value }; if (amount.breakdown) a.breakdown = amount.breakdown;
  const body = { intent: 'CAPTURE', purchase_units: [{ amount: a }] };
  if (o.walletSource) body.payment_source = { paypal: { experience_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel' } } };
  return `POST /v2/checkout/orders\nContent-Type: application/json\n${o.requestId ? `PayPal-Request-Id: ${o.requestId}\n` : ''}\n${JSON.stringify(body, null, 2)}`;
}

export const _internal = { clone, lc, RANK, hash };
