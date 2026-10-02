// The 47 tools PayPal's Agent Toolkit registers (typescript/src/shared/tools.ts at paypal/agent-toolkit@main),
// as recorded in research/capability/FINDINGS.md section 1.4. `local` is whether `npx @paypal/mcp --tools=all` v1.8.1
// exposes it. PayPal publishes no catalogue of its own: its quickstart has a "MCP server tools" heading with nothing under it.
const T = (name, http, path, local = true) => ({ name, http, path, local });
export const MCP_TOOLS = [
  // invoicing (21)
  T('create_invoice', 'POST', '/v2/invoicing/invoices'), T('list_invoices', 'GET', '/v2/invoicing/invoices'), T('get_invoice', 'GET', '/v2/invoicing/invoices/{invoice_id}'),
  T('update_invoicing', 'PUT', '/v2/invoicing/invoices/{id}', false), T('delete_invoice', 'DELETE', '/v2/invoicing/invoices/{invoice_id}', false),
  T('send_invoice', 'POST', '/v2/invoicing/invoices/{id}/send'), T('send_invoice_reminder', 'POST', '/v2/invoicing/invoices/{id}/remind'), T('cancel_sent_invoice', 'POST', '/v2/invoicing/invoices/{id}/cancel'),
  T('generate_invoice_qr_code', 'POST', '/v2/invoicing/invoices/{id}/generate-qr-code'), T('generate_invoice_number', 'POST', '/v2/invoicing/generate-next-invoice-number', false),
  T('record_payment_for_invoice', 'POST', '/v2/invoicing/invoices/{id}/payments', false), T('record_refund_for_invoice', 'POST', '/v2/invoicing/invoices/{id}/refunds', false),
  T('search_invoicing', 'POST', '/v2/invoicing/search-invoices', false), T('setup_invoice_auto_reminders', 'POST', '/v2/invoicing/setup-reminders', false),
  T('update_invoice_auto_reminder', 'PUT', '/v2/invoicing/reminders/{reminder_configuration_id}', false), T('cancel_invoice_auto_reminder', 'POST', '/v2/invoicing/invoices/{id}/cancel-reminders', false),
  T('create_conditional_rules_for_invoice', 'POST', '/v2/invoicing/invoices/{id}/conditional-rules', false), T('create_recurring_series', 'POST', '/v2/invoicing/recurring-invoices', false),
  T('activate_recurring_series', 'POST', '/v2/invoicing/recurring-invoices/{id}/activate', false), T('get_recurring_series', 'GET', '/v2/invoicing/recurring-invoices/{id}', false),
  T('cancel_recurring_series', 'POST', '/v2/invoicing/recurring-invoices/{id}/cancel', false), T('delete_recurring_series', 'DELETE', '/v2/invoicing/recurring-invoices/{id}', false),
  // orders and payments (5)
  T('create_order', 'POST', '/v2/checkout/orders'), T('get_order', 'GET', '/v2/checkout/orders/{id}'), T('pay_order', 'POST', '/v2/checkout/orders/{id}/capture'),
  T('create_refund', 'POST', '/v2/payments/captures/{capture_id}/refund'), T('get_refund', 'GET', '/v2/payments/refunds/{refund_id}'),
  // catalog, plans, subscriptions (12)
  T('create_product', 'POST', '/v1/catalogs/products'), T('list_products', 'GET', '/v1/catalogs/products'), T('show_product_details', 'GET', '/v1/catalogs/products/{product_id}'), T('update_product', 'PATCH', '/v1/catalogs/products/{product_id}'),
  T('create_subscription_plan', 'POST', '/v1/billing/plans'), T('list_subscription_plans', 'GET', '/v1/billing/plans'), T('show_subscription_plan_details', 'GET', '/v1/billing/plans/{plan_id}'), T('update_plan', 'PATCH', '/v1/billing/plans/{plan_id}', false),
  T('create_subscription', 'POST', '/v1/billing/subscriptions'), T('show_subscription_details', 'GET', '/v1/billing/subscriptions/{id}'), T('update_subscription', 'PATCH', '/v1/billing/subscriptions/{id}', false), T('cancel_subscription', 'POST', '/v1/billing/subscriptions/{id}/cancel'),
  // disputes (3)
  T('list_disputes', 'GET', '/v1/customer/disputes'), T('get_dispute', 'GET', '/v1/customer/disputes/{dispute_id}'), T('accept_dispute_claim', 'POST', '/v1/customer/disputes/{dispute_id}/accept-claim'),
  // shipment tracking (3)
  T('create_shipment_tracking', 'POST', '/v1/shipping/trackers-batch'), T('get_shipment_tracking', 'GET', '/v1/shipping/trackers'), T('update_shipment_tracking', 'PUT', '/v1/shipping/trackers/{id}', false),
  // reporting (2)
  T('list_transactions', 'GET', '/v1/reporting/transactions'), T('get_merchant_insights', 'GET', '/v1/merchant/insights', false),
];

/** Three more exist only on the hosted server and need the request header x-feature-flags: commerce:true. Gift cards only, for now. */
export const MCP_COMMERCE_TOOLS = ['search_product', 'create_cart', 'checkout_cart'];

/** Names on PayPal's /ai-tools/agent-tools reference that do not resolve: documentation typos. */
export const MCP_DOC_TYPOS = { list_product: 'list_products', list_transaction: 'list_transactions' };

/** What an MCP client cannot do at all, by what people ask for. */
export const MCP_ABSENT = [
  { re: /payout|mass[_ -]?pay|send[_ -]?money|disburse/i, what: 'send a payout', rest: 'POST /v1/payments/payouts' },
  { re: /vault|payment[_ -]?token|setup[_ -]?token|save[_ -]?card/i, what: 'save or charge a payment method', rest: 'POST /v3/vault/setup-tokens' },
  { re: /webhook/i, what: 'manage or verify webhooks', rest: 'POST /v1/notifications/webhooks' },
  { re: /authori[sz]e|void|reauthori[sz]e/i, what: 'authorize or void a payment', rest: 'POST /v2/checkout/orders/{id}/authorize' },
  { re: /evidence|appeal|escalate|make[_ -]?offer/i, what: 'defend a dispute', rest: 'POST /v1/customer/disputes/{id}/provide-evidence' },
  { re: /pause|suspend|resume|revise|activate_subscription/i, what: 'pause, resume or revise a subscription', rest: 'POST /v1/billing/subscriptions/{id}/suspend' },
  { re: /fx|exchange[_ -]?rate|currency[_ -]?convert/i, what: 'quote an exchange rate', rest: 'POST /v2/pricing/quote-exchange-rates' },
];
