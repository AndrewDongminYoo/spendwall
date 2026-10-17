# Buyer-side shopping agent baseline

## Problem and scope

Issue #26 asks for a shopping agent that searches products, lets the firewall create a PayPal order through Orders v2, pushes the buyer approve link to a human and captures the order after approval.
This baseline adds `create_order` and `pay_order` to the policy path with a server-owned PostgreSQL ledger and a synthetic `shopping` demo scenario.
Product search is a local catalog fixture; no Channel3 integration, FCM push or Flutter screen is included.

## Contract

- The resolver recomputes every `create_order` total from `items[].itemCost`, `items[].quantity` (schema default 1), `items[].taxPercent`, `discount` and `shippingCost`.
  A supplied `items[].itemTotal` is reconciled against `itemCost × quantity` and any mismatch denies; the caller never supplies the policy amount.
  Only USD is accepted; per-unit tax must be exact in cents; `shippingAddress`, `notes`, `returnUrl` and `cancelUrl` are server-owned and deny when supplied.
- Recomputation proves arithmetic, not provenance: `OrderService` cannot tell a genuine unit price from a claimed one, so the tool boundary that composes it must take prices from trusted data.
  The demo tool accepts catalog `sku` and `quantity` only, prices every line from the server-owned catalog, denies an unknown `sku` with `catalog_unknown` and denies any other line field with `catalog_price_only` before any firewall call.
- `OrderService.create` resolves under a database advisory lock, evaluates the CEL policy on `amount.usd` with the agent allowlist and default deny, audits the decision and, when allowed, records a ledger row before the Orders v2 request.
  The request carries `PayPal-Request-Id` equal to the request UUID; the response must report `CREATED`, the recomputed amount and exactly one `approve` link on the sandbox origin.
  The request binding covers the trusted context, the resolved facts, the policy version and the server-owned `returnUrl` and `cancelUrl`, so a retry under a changed configuration is refused as `request_conflict` instead of resending a different body under the same identifier.
  The ledger row and the post-creation audit event both record the order id and approve link, and the row's audit receipt points at that outcome event so a replay returns the first call's receipt; the agent receives the approve link and never a provider token.
- `OrderService.capture` resolves the provider order under the same lock, evaluates policy on the provider amount, requires a ledger row whose order id, amount and merchant match the provider facts, and requires provider status `APPROVED` before any capture request.
  Captures are keyed by execution UUID; one live capture attempt per order is enforced by the lock and a partial unique index.
  A retry with the same execution UUID replays the receipt; a different UUID is denied while a live attempt exists.
- Unknown provider outcomes (transport failure, timeout, 5xx, 408, 429 or an unparseable body) throw `OrderOutcomeUnknownError` with the identifier to reuse; the ledger row stays `unknown` and a retry resends the idempotent request.
  The replay window is five hours from the row's creation, a margin under PayPal's documented six-hour Orders v2 idempotency retention recorded in the sandbox seed specification; an older `unknown` row throws without a provider request and requires reconciliation, because a forgotten identifier would create a second order or capture.
  A definitive 4xx on the first attempt marks the row `failed`, returns `provider_rejected`, and frees the capture slot for a new execution UUID.
  The ledger counts every provider attempt sent under an identifier; a 4xx settles `failed` only while that count is one.
  Once a retry or an overlapping call has also posted, a rejection may be the provider's duplicate-request response, so the row stays `unknown` and the call throws `OrderOutcomeUnknownError`, whichever call receives it.
  Overlapping calls with one identifier settle once; the later call reuses the settled row's receipt when the provider's replayed response names the same order or capture.
- `require_approval` is denied: the human approval step is PayPal's buyer approval page, not the firewall approval service.
- `migrations/009-orders.sql` extends the audit redaction allowlist as a wrapper over the current `audit.redact`, the same layering `002-velocity.sql` used, so `001-audit.sql` stays unchanged and upgraded databases receive the order fields.
- Application credentials can insert rows and update only status, order id, approve link, capture id and the audit receipt columns; they cannot delete or rewrite history.
  Hosted readers and webhook receivers must reject access to the `orders` schema.

## Non-goals and limits

The W0 proxy still forwards `create_order` and `pay_order` without this policy path.
No Channel3 API, FCM push, Flutter approval screen, dashboard view or live sandbox order is included.
Live mode of the demo observes creation and the pre-approval denial; buyer approval and capture are exercised by the recorded replay.
Provider idempotency windows and sandbox approve-link rendering remain unverified here.

## Acceptance

1. Forged line totals, non-USD currency, inexact tax, oversized discounts and caller-supplied URLs deny without a provider request.
2. An allowed order stores its order id and approve link, audits two linked events and replays the same result for the same request UUID.
3. Capture before approval, capture of an unbound order and capture by an agent outside the allowlist deny without a provider write.
4. Two concurrent captures of one approved order complete exactly once; retries replay and later UUIDs are refused.
5. Unknown outcomes are preserved and recovered under the same identifier; first-attempt definitive rejections free the slot, and rejected retries keep it reserved.
6. The recorded `shopping` scenario passes and existing repository gates pass.

## Precedent

The brief records the operator's approval of this plan on 2026-10-17.
No oracle lookup ran in this build session (the subagent had no oracle access), so no retrieved precedent was used as design authority.
