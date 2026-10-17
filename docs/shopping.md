# Buyer-side shopping flow

## Local baseline

Issue [#26](https://github.com/AndrewDongminYoo/spendwall/issues/26) adds a buyer-side money-in path: an agent searches a catalog, the firewall creates a PayPal order through Orders v2, a human approves on PayPal's buyer page, and the firewall captures only after that approval is verified.
`OrderService` composes the existing `ContextResolver`, CEL policy evaluation, the audit log and a PostgreSQL ledger in `migrations/009-orders.sql` and `migrations/010-orders-insert-guard.sql`.
Product search is a local catalog fixture, not Channel3.
The W0 proxy and the refund demo remain separate compositions and do not gain this protection automatically.

Run the recorded scenario with Docker available:

```sh
pnpm demo shopping
```

The scenario searches the catalog, denies an agent-supplied price, creates one order and returns its approve link, denies capture before approval, applies a scripted buyer approval on the synthetic PayPal page, and captures once.
The demo's `create_order` tool accepts catalog `sku` and `quantity` only; unit prices come from the server-owned catalog, an unknown `sku` denies with `catalog_unknown`, and any other line field denies with `catalog_price_only`.
`OrderService` recomputes totals from the arguments it receives but cannot know whether a unit price is genuine, so the tool boundary that composes it must supply prices from trusted data.
Payment responses are synthetic; nothing contacts PayPal.

## Policy context

The [example policy](../apps/agent-demo/shopping-policy.yaml) allows `create_order` and `pay_order` for `demo-shopper` up to USD 50 and denies the rest.
Replace these synthetic values in trusted policy configuration before integrating another environment.

| Field    | Source and meaning                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `amount` | For `create_order`, the total recomputed from unit cost, quantity, exact per-unit tax, shipping and discount; never a caller total |
| `amount` | For `pay_order`, the provider's current order amount, which must also equal the ledger amount                                      |

The resolved provider order status is not a policy variable: a CEL condition that references `order.status` fails to evaluate and denies.
`OrderService.capture` checks that status in code after policy evaluation and denies a non-`APPROVED` order with `order_not_approved`; the status is recorded under `resolved_ctx.order` in the audit event for inspection only.

Resolution rules for `create_order` follow [tool-risk.md](tool-risk.md): USD only, `itemTotal` reconciled against `itemCost × quantity`, per-unit tax exact in cents, discount at most the item total, and no caller-supplied `shippingAddress`, `notes`, `returnUrl` or `cancelUrl`.
`require_approval` is denied because the human step is PayPal's own buyer approval, not the firewall approval service.

## Ledger and capture binding

Apply `migrations/009-orders.sql` as the trusted database owner after `001-audit.sql` and `002-velocity.sql`; it layers the Orders v2 fields onto the audit redaction allowlist as a wrapper over the current `audit.redact`, so upgraded databases get the same allowlist without rewriting earlier rows or hashes.
Then apply `migrations/010-orders-insert-guard.sql` as the same owner.
The application login inserts rows and may update only status, attempts, order id, approve link, capture id and the audit receipt columns; deletes and other rewrites are refused.
Insert triggers from `010` admit, for every role, only a reservation row: status `unknown`, no order id, approve link or capture id, and one counted attempt; the server clock replaces any supplied `created_at`.
The row's audit receipt must name an `allow` event for the matching tool (`create_order` for an order, `pay_order` for a capture), with the same row hash, appended in the inserting transaction itself and not in a savepoint, so a receipt copied from an earlier event cannot reserve an order or a capture slot.
Row triggers keep those updates forward-only for every role, as the approvals schema does: the binding and amount never change, attempts never decrease, an unknown row settles once into a terminal status under a new audit receipt, and a settled row is never rewritten.
Settle triggers from `010` bind that new receipt, for every role, to the outcome event `OrderService` appends: an `allow` event for the matching tool, with the same row hash, appended in the settling transaction itself and not in a savepoint, naming the row's request or execution UUID as its upstream result, with a provider status of the settled class (2xx for `created` or `completed`, a 4xx other than 408 or 429 for `failed`) and the row's own agent and policy version.
A `created` order must also match the event's order id and approve link, and a settled capture must match its parent order's id.
The redaction keeps no capture id, so the `capture_id` that a capture settles with is not bound to its outcome event.
Updates that keep a row `unknown` stay attempt-only and need no new event.
The remaining limit: a role that can append audit events can still forge a reservation or a settlement, but only by appending fresh `allow` events with the matching identifiers in the same transaction, which leaves them in the tamper-evident chain.
Hosted-dashboard and webhook-receiver readiness checks reject access to the `orders` schema.

Construct `OrderService(pool, { identityKey, resolver, tokens })` in trusted server code.
`create(policy, { requestId, args }, { agent, customer })` returns `{ decision, matchedRules, receipt, replayed, result }` where `result` holds the order id, amount and `approveUrl`.
The provider request carries `PayPal-Request-Id` equal to the request UUID and `custom_id` equal to the same UUID; the same UUID with the same arguments replays the stored result, and a changed binding or policy is denied with `request_conflict`.
The binding also covers the server-owned `returnUrl` and `cancelUrl`, so a retry after a configuration change is refused rather than resending a different body under the same identifier.
The audit log records the policy decision and a second `tool_call` event whose `upstream_result_ref` is the request UUID and whose `resolved_ctx.order` holds the order id, the approve link and status `CREATED`; the ledger row keyed by the same UUID holds the same order id and approve link, and its audit receipt moves from the reservation event to that outcome event so a replay returns the receipt the first call returned.
The audit redaction allowlist admits `order_id` only as a 17 to 32 character provider id and `approve_url` only on the sandbox origin, so the append-only chain names the created order without accepting arbitrary links.

`capture(policy, { executionId, args: { id } }, { agent, customer })` first answers an execution UUID that the ledger already binds from its capture and order rows, whose amount was checked equal to the provider's when the capture was reserved, so a settled capture replays during a provider outage or after the resolver cache expires; a first attempt reads the provider order, evaluates policy on its amount, requires a ledger row whose order id, amount and merchant match, and requires provider status `APPROVED`.
One live capture attempt per order is enforced by a database advisory lock and a partial unique index: a second execution UUID is denied with `order_capture_reserved`, and the same UUID replays the receipt.

## Retry semantics

Transport failures, timeouts, 5xx, 408, 429 and unparseable bodies throw `OrderOutcomeUnknownError`; the ledger row stays `unknown`, and a retry with the same identifier resends the idempotent request within five hours.
That window keeps a margin under PayPal's documented six-hour Orders v2 idempotency retention (see the [sandbox seed specification](specs/2026-10-13-sandbox-seed.md)); after it, the row needs reconciliation and no request is resent, because a replayed identifier the provider has forgotten would create a second order or capture.
A definitive 4xx on the first attempt marks the row `failed` and returns `provider_rejected`; a new execution UUID may capture the order again, while the failed UUID stays rejected.
A retry of a settled identifier, whether its row is `created`, `completed` or `failed`, never reaches the provider: it returns the stored receipt and the first attempt's decision and matched rules with `replayed: true`, and a changed binding, including the same execution UUID under another order, is denied with `request_conflict`.
A 4xx on a retried identifier is not evidence about the first attempt, because PayPal rejects a reused `PayPal-Request-Id` for reasons such as an already captured order: the row stays `unknown`, the capture slot stays reserved, and `OrderOutcomeUnknownError` asks for reconciliation.
The ledger counts provider attempts per identifier, so the same rule applies when two overlapping calls post the same identifier and the first one receives the duplicate rejection: it never settles `failed` over an attempt that may have completed.
Two overlapping calls with one identifier both reach the provider with the same `PayPal-Request-Id`; the call that settles second finds the settled ledger row, checks that the provider's replayed response names the same order or capture, and returns the stored receipt instead of an error.
The firewall never resubmits on its own.

## Verification

```sh
node --test tests/orders.test.mjs
node scripts/test-audit-postgres.mjs --orders
pnpm demo shopping
```

The database tests exercise forged totals, policy denials, pre-approval capture denial, unbound orders, two concurrent captures behind a held advisory lock, same-identifier replay with identical receipts, settled captures replayed from the ledger while provider reads fail, unknown-outcome recovery, definitive rejection, a rejected retry that keeps the row unknown, overlapping calls with one identifier, a duplicate-request rejection that reaches the overlapping first attempt, database-side redaction of order fields, application privilege limits and restricted-reader checks.
Live sandbox order creation, approve-link rendering and provider idempotency windows remain unverified.

## Follow-up

Delivering the approve link to a human is PayPal's buyer approval page in this baseline; the agent reports the link and the recorded demo applies a scripted approval.
FCM push of the approve link to the Flutter approval app and the matching Flutter screen are deferred to a follow-up issue filed with this PR; the existing approval-app issues cover refund approvals, not Orders v2 approve links.
