# Trusted context resolver (#9)

Build an independent read-only resolver boundary on main `6fc3881`, in the
`codex/issue-9-context-resolver` worktree. Audit PR #37 and `packages/policy`
remain unchanged. Existing refund execution restrictions remain unchanged.

## Interface and trust

`ContextResolver.resolve({ tool, args }, trusted)` returns either a safe explicit
`{ ok: false, decision: 'deny', reason }` or a successful resolution containing
`context`, independently normalized `amount`, and `resolvedCtx` audit facts.
Success is not authorization. The policy envelope has exactly tool/args/amount/
agent/customer/merchant/agg; its amount has value/currency only, matching #7.
Reuse the existing policy `normalizeAmount` export for fictional USD/EUR/KRW FX.
Never implement another evaluator or FX table.

The instance's merchant ID/email and token provider are server configuration.
Agent/customer/aggregation are separately supplied trusted server context, not
tool arguments; customer identity must match REST payer/recipient information.
Authentication and internal/provider identity mapping remain #8 integration.
Snapshot inert JSON before awaiting requests; reject invalid structures and bound
depth, values and text. Validate supported tool arguments against the committed
#3 MCP schemas. Unknown tools fail closed.

## Registry and refund context

Support `create_refund` (money-out), `create_invoice`/`send_invoice` (money-in),
and `get_invoice` (read), using the names/shapes from `docs/tool-risk.md`.
Other tools require future explicit resolvers and are denied.

Get `/v2/payments/captures/{capture_id}`, then its server-supplied related order
at `/v2/checkout/orders/{order_id}`. Capture detail does not contain an aggregate
refunded amount. Validate matching IDs, original amounts/currencies/statuses,
merchant IDs, payer identity and a completed order. Conservatively require one
purchase unit and one matching capture, plus an explicit refund array. Omission
of refund history is unresolved, never assumed to mean zero. Every refund needs
a unique ID, matching currency and an exact fixed-origin capture parent link.
Reject unknown/pending refund states and inconsistent capture/history totals.

Sum completed prior refunds in integer minor units, calculate remaining funds,
use a positive supplied partial amount or remaining funds when omitted, and deny
zero/excess/currency mismatch. Expose original/refunded/remaining amounts as
auditable facts. Multi-capture history, missing merchant/customer facts, unknown
status and unavailable history fail closed. These restrictions are deliberate:
no real API eligibility or complete integration is claimed by synthetic tests.

## Invoice context

`create_invoice` recomputes positive line totals from unit amount and positive
integer quantity, validates common currency, and binds exactly one recipient
email to the trusted customer. The proposed price is caller input to be checked
by policy, not an existing payable transaction. Optional invoicer email must
match the configured merchant. Shipping can be added as an explicit nonnegative
same-currency amount. Unsupported taxes, discounts, fractional quantities,
partial-payment settings and other ambiguous monetary modifiers are denied.

`send_invoice` and `get_invoice` read `/v2/invoicing/invoices/{invoice_id}` and
validate identity, invoicer/recipient binding, detail currency, item sums and
reported total. Sending requires DRAFT. Reject missing or inconsistent totals
and unsupported pricing configuration/breakdowns. Cache only validated remote
facts, never caller-specific decisions or requested amounts.

## Transport, cache and integration

GET only, fixed sandbox origin, no redirects or automatic retries. Bound token
lookup/fetch/body reading by an overall timeout and response byte limit. Failure
returns a constant reason without tokens, URLs, response bodies or customer data.
All tests inject synthetic tokens and route requests to loopback REST fixtures.

Default TTL is 2 seconds, maximum 5 seconds; measure from lookup start so slow
requests cannot renew stale facts. Cache and in-flight maps are bounded and
instance-local to one merchant. Share same-key in-flight lookups, recompute each
call's amount and identity checks, reject expired/reversed clocks, never serve
stale data after failures. Explicit invalidation prevents older in-flight work
from populating the cache or returning an apparently current resolution.

This snapshot is not a reservation or execution guarantee. Future execution
must invalidate/re-resolve and reserve/refund atomically. `resolvedCtx` provides
the boundary for #37's audit sanitizer; no audit files or real call sites are
wired here. Do not weaken the existing USD/completed-capture-only executor.

## Evidence

Use only synthetic REST fixtures. Cover partial/full refunds, USD/EUR/KRW
rounding, nonexistent capture, ownership/identity mismatch, incomplete/tampered
responses, prior refund reconciliation, pending/duplicate/over-refund history,
invoice totals/recipient validation, cache expiry, concurrent callers, invalidation,
timeouts, redirects, bounds and unchanged inputs/execution restrictions.

Official schema evidence (read from GitHub, no PayPal API request):
[payments](https://github.com/paypal/paypal-rest-api-specifications/blob/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/payments_payment_v2.json),
[orders](https://github.com/paypal/paypal-rest-api-specifications/blob/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/checkout_orders_v2.json),
[invoicing](https://github.com/paypal/paypal-rest-api-specifications/blob/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/invoicing_v2.json).
The capture/history restrictions above are conservative inference from the
documented optional response fields and comprehensive purchase-unit payment
history; live response completeness has not been established.
