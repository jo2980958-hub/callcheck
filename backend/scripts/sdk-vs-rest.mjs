// Three things the raw REST calls don't tell you, asked of the SDK instead:
// does a replayed PayPal-Request-Id give back the first order, and what does a
// 400 actually look like once ApiError has it. Usage: node scripts/sdk-vs-rest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  Environment,
  OrdersController,
  CheckoutPaymentIntent,
  ApiError,
  CustomError,
} from '@paypal/paypal-server-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '../../../../.env'); // ../../../.env from backend/
for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) {
  if (l && !l.startsWith('#') && l.includes('=')) {
    const i = l.indexOf('=');
    process.env[l.slice(0, i)] ??= l.slice(i + 1);
  }
}
const { PAYPAL_CLIENT_ID, PAYPAL_SECRET } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
  console.error(`missing PAYPAL_CLIENT_ID / PAYPAL_SECRET in ${envFile}`);
  process.exit(1);
}

// One client for the process: it caches the client-credentials token, and a
// client per call would throw that away. Sandbox resolves to api-m.sandbox.paypal.com.
const client = new Client({
  environment: Environment.Sandbox,
  clientCredentialsAuthCredentials: {
    oAuthClientId: PAYPAL_CLIENT_ID,
    oAuthClientSecret: PAYPAL_SECRET,
  },
});
const orders = new OrdersController(client);

// Model fields are camelCase; the schema maps them to purchase_units/currency_code.
const order = (value, itemTotal) => ({
  intent: CheckoutPaymentIntent.Capture,
  purchaseUnits: [
    {
      amount: {
        currencyCode: 'USD',
        value,
        ...(itemTotal
          ? { breakdown: { itemTotal: { currencyCode: 'USD', value: itemTotal } } }
          : {}),
      },
    },
  ],
});

// createOrder is the destructured-options form, so the request id is a named key.
const create = (body, paypalRequestId) =>
  orders.createOrder({ body, paypalRequestId, prefer: 'return=minimal' });

const requestId = `sdk-vs-rest-${Date.now()}`;

// 1 — the baseline order.
const first = await create(order('10.00'), requestId);
console.log(`[1] create USD 10.00  id=${first.result.id} status=${first.result.status} http=${first.statusCode}`);

// 2 — same PayPal-Request-Id, different amount. Replay gives back the first
// order; a rejected replay comes back as an ApiError, so catch either.
try {
  const second = await create(order('11.00'), requestId);
  const same = second.result.id === first.result.id;
  console.log(`[2] replay id, USD 11.00  id=${second.result.id} http=${second.statusCode} sameAsFirst=${same}`);
} catch (err) {
  if (err instanceof ApiError) {
    console.log(`[2] replay id, USD 11.00  rejected ${err.constructor.name} http=${err.statusCode} name=${err.result?.name} issue=${err.result?.details?.[0]?.issue} sameAsFirst=n/a`);
  } else {
    throw err;
  }
}

// 3 — breakdown that doesn't add up: item_total 8.00 under a value of 10.00.
// createOrder maps 400 to CustomError, so the parsed payload lands on .result
// under the spec's own field names.
try {
  const bad = await create(order('10.00', '8.00'), `${requestId}-bad`);
  console.log(`[3] breakdown 8.00 vs 10.00  UNEXPECTED SUCCESS id=${bad.result.id} http=${bad.statusCode}`);
} catch (err) {
  if (err instanceof CustomError) {
    console.log(`[3] breakdown 8.00 vs 10.00  ${err.constructor.name} http=${err.statusCode} name=${err.result?.name} issue=${err.result?.details?.[0]?.issue}`);
  } else if (err instanceof ApiError) {
    // bare ApiError: nothing parsed .result, so the payload is only on .body
    console.log(`[3] breakdown 8.00 vs 10.00  ApiError http=${err.statusCode} body=${String(err.body).slice(0, 200)}`);
  } else {
    throw err; // network, abort, or the pre-flight auth throw — not an API error
  }
}
