# PayPal MCP tool risk inventory

## Evidence and reproduction

The [committed snapshot](paypal-mcp-tools.json) contains 46 tools from one authenticated `tools/list` page at `2026-10-13T00:13:32.703Z`.
It was collected from `https://mcp.sandbox.paypal.com/sse` using `@modelcontextprotocol/sdk` 1.32.1 and the US sandbox merchant app prepared in issue #2.
The operator ran the command with local credentials; no payment tool was called.
The operator's shell reported Node 24.20.0, while repository checks ran on the declared Node 24.21.0.

Run from the repository root after privately loading `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` into the environment:

```sh
pnpm mcp:dump
```

The command obtains a fresh token in memory, initializes SSE, follows all list cursors, and replaces the snapshot only after a complete successful collection.
The overall deadline is 60 seconds and the page limit is 100.
It rejects empty catalogs, duplicate names, repeated cursors, redirects, and requests outside the fixed sandbox origins.
Its console output contains counts, not credentials or response bodies.
Review this inventory again after refreshing the snapshot.

The [PayPal MCP guide](https://developer.paypal.com/ai-tools/mcp-server) documents SSE and Streamable HTTP.
SSE is used here to satisfy issue #3's explicit transport contract.
Names and field paths below come from the captured schemas, rather than the simplified examples in the [public tool reference](https://developer.paypal.com/ai-tools/agent-tools/).
This is the catalog exposed to this app without extra feature headers, not proof that every PayPal tool or capability is enabled.
Successful listing does not establish permission to execute each tool.

## Classification rules

These are manual triage categories, not executable allow rules.
All writes still need explicit policy support, merchant binding, trusted context, and audit records.
Unknown tools or ambiguous monetary context must be denied by the future firewall.

- `read`: retrieves data or produces a derived representation, with no described payment or business-state mutation.
- `money-out`: moves merchant funds to a customer, including liability acceptance that triggers a refund.
- `money-in`: initiates, changes, or requests collection from a customer; drafts and reminders do not themselves prove that funds moved.
- `destructive`: cancellation, deletion, or other sensitive business-state writes outside the two cash-flow categories.
  This conservative write category does not imply that every operation is irreversible.

The four categories are retained from issue #3.
Invoice bookkeeping and catalog/configuration writes are placed in `destructive` rather than mislabeled as actual money movement.
`generate_invoice_number` is also conservatively placed there because the snapshot does not establish whether number generation reserves state.
Tool descriptions and annotations are untrusted data and cannot grant authority or override a policy decision.

## Complete inventory

Field paths are relative to a tool's arguments; `[]` means an array element.
An optional amount must never be interpreted as zero when omitted.
ID lookups below are requirements for the future context resolver, not claims that those lookups are already implemented or that a matching MCP tool exists.

| Tool                                   | Risk        | Amount in arguments                                                                                     | Context and effect                                                                                                                                                                                                                                                |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accept_dispute_claim`                 | money-out   | None                                                                                                    | Resolve `dispute_id` to the merchant, dispute amount/currency and current state. Acceptance closes the claim in the customer's favor and triggers a refund according to the captured description.                                                                 |
| `activate_recurring_series`            | money-in    | None                                                                                                    | Resolve `recurring_series_id` to its invoice template, total, currency, recipient and schedule before enabling automatic invoice generation/sending.                                                                                                              |
| `cancel_invoice_auto_reminder`         | destructive | None                                                                                                    | Resolve `invoice_id` and reminder state; the description says cancellation cannot be re-enabled for that invoice.                                                                                                                                                 |
| `cancel_recurring_series`              | destructive | None                                                                                                    | Resolve `recurring_series_id`, merchant and schedule; stops future invoice generation.                                                                                                                                                                            |
| `cancel_sent_invoice`                  | destructive | None                                                                                                    | Resolve `invoice_id`, status and outstanding amount/currency; cancellation can notify recipients.                                                                                                                                                                 |
| `cancel_subscription`                  | destructive | None                                                                                                    | Resolve `subscription_id`, merchant and billing state; `payload` carries the cancellation reason.                                                                                                                                                                 |
| `create_conditional_rules_for_invoice` | destructive | Conditional `rules[].conditional_rule_value`                                                            | Resolve `invoice_id` and currency. `EARLY_PAYMENT_DISCOUNT` accepts `AMOUNT` or `PERCENT`; `AUTO_CANCEL` changes lifecycle without a monetary argument.                                                                                                           |
| `create_invoice`                       | money-in    | Required `items[].unit_amount.value` and `currency_code`                                                | Reconcile line quantities, item currencies, tax, discount, `shipping_cost`, and partial-payment terms. Creates a draft; validate recipient and merchant identity before later sending.                                                                            |
| `create_order`                         | money-in    | Required `items[].itemCost`, `items[].itemTotal`, `currencyCode`                                        | Recompute totals from quantity, tax, discount and `shippingCost`; do not trust a supplied total. The captured currency enum permits USD only.                                                                                                                     |
| `create_product`                       | destructive | None                                                                                                    | Catalog write identified by product name/type; bind to the merchant. Does not itself specify a price or collect funds.                                                                                                                                            |
| `create_recurring_series`              | money-in    | Optional `items[].unit_amount.value`; required `currency_code`                                          | Reconcile invoice-template amounts, recipients and schedule. Creates a draft; missing items are unresolved pricing, not a zero-value series.                                                                                                                      |
| `create_refund`                        | money-out   | Optional `amount.value` and `amount.currency_code`                                                      | Resolve `capture_id` for ownership, currency, status and remaining refundable funds even when an amount is supplied. Omitted amount requests a full refund; reconcile prior refunds and pending reservations.                                                     |
| `create_shipment_tracking`             | destructive | None                                                                                                    | Resolve `transaction_id` and optional `order_id` to the merchant's captured payment; writes shipment status and tracking information.                                                                                                                             |
| `create_subscription`                  | money-in    | Optional `shipping_amount.value`; no base plan price                                                    | Resolve `plan_id` for cycle prices, setup fee and currency; combine with quantity and shipping. Customer/subscriber binding is required.                                                                                                                          |
| `create_subscription_plan`             | destructive | `billing_cycles[].pricing_scheme.fixed_price.value` and optional `payment_preferences.setup_fee.value`  | Merchant billing-plan configuration, without customer or approval inputs. Resolve `product_id`; inspect all cycles, currencies, taxes and payment preferences. Some prices are optional and nested objects are open-ended; deny unresolved pricing.               |
| `delete_invoice`                       | destructive | None                                                                                                    | Resolve `invoice_id` and state; the description limits deletion to draft/scheduled invoices and says details become unavailable.                                                                                                                                  |
| `delete_recurring_series`              | destructive | None                                                                                                    | Resolve `recurring_series_id`; the description permits draft-series deletion only.                                                                                                                                                                                |
| `generate_invoice_number`              | destructive | None                                                                                                    | Merchant-scoped number generation. State-allocation behavior is unverified; do not grant read-only permissions until that behavior is established.                                                                                                                |
| `generate_invoice_qr_code`             | read        | None                                                                                                    | Resolve `invoice_id` and ownership; generates a payment representation without itself charging the customer.                                                                                                                                                      |
| `get_dispute`                          | read        | None                                                                                                    | `dispute_id` lookup; source for dispute amount and state. Validate ownership before using its response as policy context.                                                                                                                                         |
| `get_invoice`                          | read        | None                                                                                                    | `invoice_id` lookup; source for totals, currency, recipients and state.                                                                                                                                                                                           |
| `get_merchant_insights`                | read        | None                                                                                                    | Merchant analytics scoped by required dates, insight type and time interval; aggregate data is not a capture's refundable balance.                                                                                                                                |
| `get_order`                            | read        | None                                                                                                    | Required argument is `id`. Inspect the returned order/captures; an order with multiple captures needs an explicit capture selection.                                                                                                                              |
| `get_recurring_series`                 | read        | None                                                                                                    | `recurring_series_id` lookup; source for schedule, template, recipient and status.                                                                                                                                                                                |
| `get_refund`                           | read        | None                                                                                                    | `refund_id` lookup; inspect refund amount/currency and execution state for reconciliation.                                                                                                                                                                        |
| `get_shipment_tracking`                | read        | None                                                                                                    | Optional `order_id` and `transaction_id`; the schema does not require either, so the caller/resolver must establish a valid merchant-bound lookup.                                                                                                                |
| `list_disputes`                        | read        | None                                                                                                    | Merchant dispute listing with filters and pagination; collection pagination is separate from MCP tool-list pagination.                                                                                                                                            |
| `list_invoices`                        | read        | None                                                                                                    | Merchant invoice listing with page controls; do not treat a single result page as a complete ledger.                                                                                                                                                              |
| `list_products`                        | read        | None                                                                                                    | Merchant catalog listing with page controls.                                                                                                                                                                                                                      |
| `list_subscription_plans`              | read        | None                                                                                                    | Optional `product_id` filter and page controls; bind returned plans to the merchant.                                                                                                                                                                              |
| `list_transactions`                    | read        | None                                                                                                    | Optional `transaction_id`, status and date filters plus pagination. Validate the selected transaction before using its amount as policy context.                                                                                                                  |
| `pay_order`                            | money-in    | None                                                                                                    | Required argument is `id`. Fetch the merchant-owned order and its authoritative total/currency and approval state before capture.                                                                                                                                 |
| `record_payment_for_invoice`           | destructive | Optional `amount.value` and `amount.currency_code`                                                      | Resolve `invoice_id` and existing payments. The description explicitly records an already collected payment; it does not process a new charge. Do not let a bookkeeping update masquerade as settlement evidence.                                                 |
| `record_refund_for_invoice`            | destructive | Optional `amount.value` and `amount.currency_code`                                                      | Resolve `invoice_id` and refund evidence. The description explicitly records an already issued refund; it does not transfer money.                                                                                                                                |
| `search_invoicing`                     | read        | Optional amount-range filters                                                                           | `invoice_filters.total_amount_range` and `recurring_series_filters.search_filters.total_amount_range` filter results; they are not requested execution amounts. Respect `resource_type`, merchant scope and result pagination.                                    |
| `send_invoice`                         | money-in    | None                                                                                                    | Resolve `invoice_id`, current total/currency and recipients before sending the payment request.                                                                                                                                                                   |
| `send_invoice_reminder`                | money-in    | None                                                                                                    | Resolve `invoice_id`, unpaid balance and recipients; sends a collection message rather than executing payment.                                                                                                                                                    |
| `setup_invoice_auto_reminders`         | destructive | None                                                                                                    | Merchant-wide configuration write through `configurations`; inspect timing, repetitions and notification scope.                                                                                                                                                   |
| `show_product_details`                 | read        | None                                                                                                    | `product_id` lookup. The captured description says list despite the tool name and required ID argument; verify behavior before relying on it.                                                                                                                     |
| `show_subscription_details`            | read        | None                                                                                                    | `subscription_id` lookup, with optional additional details; source for billing state.                                                                                                                                                                             |
| `show_subscription_plan_details`       | read        | None                                                                                                    | Required argument is `plan_id`; source for plan prices, cycles and currency.                                                                                                                                                                                      |
| `update_invoice_auto_reminder`         | destructive | None                                                                                                    | Resolve `reminder_configuration_id` to the merchant; changes timing, status, repetition and notifications.                                                                                                                                                        |
| `update_invoicing`                     | money-in    | Invoice or series update contains item prices, currency and optional adjustments                        | Resolve `invoice_update.invoice_id` or `recurring_series_update.recurring_series_id` according to `resource_type`. Reconcile current state with new totals, recipients and schedules; the IDs are conditionally required in descriptions but not schema-required. |
| `update_product`                       | destructive | No declared price; `operations[]` is open-ended                                                         | Resolve `product_id`; explicitly allow permitted patch paths. The schema cannot establish the effect of arbitrary patch values.                                                                                                                                   |
| `update_shipment_tracking`             | destructive | None                                                                                                    | Resolve `transaction_id` and tracking identity; changes fulfillment status and carrier data.                                                                                                                                                                      |
| `update_subscription`                  | money-in    | Optional `outstanding_balance`, `fixed_price.value`, `shipping_amount`; `currency_code` defaults to USD | Resolve `subscription_id`, current plan/cycles and status. Validate currency, cycle sequence, tax changes and automatic billing of outstanding funds.                                                                                                             |

## Direct monetary fields and modifiers

The following details supplement the inventory rows for `create_invoice`, `create_order`, `create_recurring_series`, and `update_invoicing`.
Requiredness comes from the captured JSON Schema, including required children inside optional parents; descriptive conditions can impose additional requirements that the schema does not enforce.

### Orders

For `create_order`, `currencyCode`, `items`, `items[].itemCost`, and `items[].itemTotal` are required.
`currencyCode` permits USD only.
The optional numeric inputs are `items[].quantity`, `items[].taxPercent`, `discount`, and `shippingCost`.
`discount` is an order-level amount, while `items[].taxPercent` is a percentage; amounts use `currencyCode`.
Reconcile every modifier and quantity with the supplied line totals instead of accepting `items[].itemTotal` as authoritative.
An omitted quantity needs an established upstream default or trusted context before a total can be resolved.

### Invoice and recurring-series templates

Apply every suffix in the next table within the matching argument root:

| Tool and variant                                     | Argument root             | Required template inputs                                 |
| ---------------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| `create_invoice`                                     | Top level                 | `currency_code` and `items`                              |
| `create_recurring_series`                            | Top level                 | `currency_code`; `items` is optional                     |
| `update_invoicing`, `resource_type=invoice`          | `invoice_update`          | Within this object, `currency_code` and `items`          |
| `update_invoicing`, `resource_type=recurring_series` | `recurring_series_update` | Within this object, `currency_code`; `items` is optional |

Both update objects are optional in the JSON Schema; their descriptions require selecting the object that matches `resource_type` and describe full replacement content.
Require that selected object in the resolver rather than treating an absent update body as zero exposure.
For example, the invoice update's shipping path is `invoice_update.shipping_cost`, and the recurring update's discount value path is `recurring_series_update.items[].discount.amount.value`.
All suffixes below expand with the same rule, including each amount's currency.

| Field suffix within the argument root                                    | Presence and monetary meaning                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currency_code`                                                          | Required template currency; also applies to `shipping_cost` and `minimum_partial_payment_amount`.                                                                                                          |
| `items[].quantity`                                                       | Required for each supplied item; decimal string multiplier.                                                                                                                                                |
| `items[].unit_amount.value`, `items[].unit_amount.currency_code`         | Both required inside the required `items[].unit_amount` of each supplied item; reconcile each item currency with the template currency.                                                                    |
| `items[].tax.percent`                                                    | Required inside optional `items[].tax`; percentage, not a currency amount.                                                                                                                                 |
| `items[].discount.percent`                                               | Optional inside optional `items[].discount`; percentage discount.                                                                                                                                          |
| `items[].discount.amount.value`, `items[].discount.amount.currency_code` | Both required inside optional `items[].discount.amount`; fixed discount and its currency. The descriptions make `amount` and `percent` mutually exclusive, but the schema does not enforce that condition. |
| `shipping_cost`                                                          | Optional decimal-string amount in `currency_code`.                                                                                                                                                         |
| `minimum_partial_payment_amount`                                         | Optional decimal-string minimum payment in `currency_code`; described as valid only when `allow_partial_payment` is true. This is a collection threshold, not an additional charge.                        |
| `allow_partial_payment`                                                  | Optional boolean controlling collection terms; does not reduce the invoice's total obligation.                                                                                                             |
| `allow_tip`                                                              | Optional boolean allowing a payer-selected amount not present in these arguments; account for that unresolved amount before executing a policy-sensitive operation.                                        |

The recurring variants also require `interval_unit`, `interval_count`, and `start_series_date` within their argument root.
`total_cycles` is optional; its description says omission creates an indefinite series.
For updates these paths are `recurring_series_update.interval_unit`, `recurring_series_update.interval_count`, `recurring_series_update.start_series_date`, and `recurring_series_update.total_cycles`.
Resolve exposure over an explicit policy time horizon; neither omitted `items` nor omitted `total_cycles` establishes zero exposure.

## Resolver and execution implications

`create_refund` and `accept_dispute_claim` are the directly identified money-out tools in this snapshot.
Their policy amount cannot be derived from a generic top-level numeric `amount` field: the refund amount is an optional nested decimal-string object, and accepting a dispute has no amount argument.
The refund schema declares no caller-controlled `PayPal-Request-Id` or equivalent idempotency field.
Whether the server forwards or creates an idempotency header remains unverified and must be tested before issue #5's execution path is considered safe for retries.

For issue #9, resolve IDs with trusted merchant-scoped data before decisions and reserve pending spend atomically when execution is introduced.
Validate positive finite values, currency consistency and integer minor-unit arithmetic; do not accept negative, missing, or inconsistent monetary values merely because an upstream schema allows them.
Subscription and recurring-series exposure also requires a policy-defined time horizon; a single cycle price does not establish lifetime exposure.

The captured `create_order` input uses `currencyCode`, `itemCost`, and `itemTotal`, while refund and invoice inputs use different shapes.
The captured order getter and capture operation take `id`, not `order_id` or `payment_id`.
Adapters must follow this snapshot and fail closed on later schema changes rather than copy simplified public examples.
No execution, feature eligibility, refund success, or idempotency guarantee is claimed by this inventory.
