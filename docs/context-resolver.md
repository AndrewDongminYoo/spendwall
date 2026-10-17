# Context resolver

The #9 boundary resolves monetary context before policy evaluation.
It supports `create_refund`, `create_invoice`, `send_invoice`, `get_invoice`, `accept_dispute_claim`, `get_dispute`, `create_order` and `pay_order` from the #3 catalog; the order rules are in the [shopping flow](shopping.md).
Other tools return an explicit deny until their own resolvers exist.
Successful resolution supplies facts; it does not grant execution permission.

```ts
import { ContextResolver } from '../apps/firewall/src/context/index.ts';
import { evaluatePolicy } from '../packages/policy/src/index.ts';

const resolver = new ContextResolver({
  merchant: authenticatedMerchant, // { id, email }, server configuration
  tokens: serverTokenManager, // existing trusted get()/isSensitive() boundary
});
const result = await resolver.resolve(
  { tool: 'create_refund', args: { capture_id: captureId } },
  { agent: authenticatedAgent, customer: verifiedCustomer, agg: trustedSpend },
);
if (!result.ok) {
  // result.decision is 'deny'; do not submit a payment operation.
} else {
  const decision = evaluatePolicy(policy, result.context);
  // Pass result.resolvedCtx through the audit sanitizer once #37 is integrated.
}
```

The instance's merchant/token source and the separate trusted identities must
come from server authentication/configuration. Tool arguments cannot supply
these identities or VIP/spend claims. The customer ID must match the capture's
order payer ID; the customer's verified email must match invoice billing email.
Internal-to-provider identity mapping and authentication remain #8 integration.
Caller JSON is snapshotted before asynchronous work and returned data is deeply
immutable. The fixed merchant instance scopes its cache; each caller's identities
and requested refund amount are checked independently even when reads are shared.

## Refunds

The resolver reads capture detail and then its related order. It checks IDs,
amounts, currency, status and merchant ownership across both responses. The order
must have one purchase unit, one matching capture and an explicit refunds array.
Each refund requires a unique ID and exact fixed-origin parent-capture link.
Completed refunds are summed in integer minor units; failed/cancelled records
contribute zero. Pending/unknown or inconsistent history is denied.

An omitted amount means the original principal minus completed refunds. A
positive partial amount must have the same currency and fit the remaining funds.
The audit facts expose original, refunded and remaining minor units and status.
No fractional floating-point arithmetic is used to sum or subtract money.

Capture GET alone does not expose a total-refunded aggregate. The additional
documented order payment history is required; missing history is never treated
as zero. The explicit-array, single-capture and identity requirements are
conservative supported-response restrictions. Some valid live PayPal responses
may omit required facts and will be denied. Live completeness/eligibility has
not been tested. See the [design's official schema evidence](specs/2026-10-14-context-resolver.md).

## Invoices

Draft creation recomputes item unit amounts times positive integer quantities,
plus optional nonnegative shipping. It requires one recipient matching the
verified customer and a consistent invoice currency; supplied invoicer email
must match server configuration. It performs no REST write or draft creation.

Invoice reads use GET and reconcile line totals, shipping, currency and the
reported amount, then bind invoicer and recipient. Sending context requires a
DRAFT invoice with no saved CC recipients and does not support added notification recipients or disabling
recipient delivery. It still performs only a GET; sending is a future execution
integration. Taxes, discounts, fractional quantities, tips, partial payments,
custom amounts and other unsupported pricing options fail closed. Zero reported
tax is accepted only when its currency matches. There is no speculative pricing
calculation for unsupported terms.

## Disputes

Dispute reads verify the merchant and the trusted customer's `seller_transaction_id` against one provider transaction.
Acceptance requires full-refund capability and a known active state; successful resolution still does not authorize acceptance.
Use the mandatory approval floor and deadline classifier in the [dispute policy boundary](dispute-policy.md), which documents the supported response subset and missing execution integration.

## Currency and policy contract

The existing policy `normalizeAmount` function supplies the explicitly fictional
USD/EUR/KRW conversion and upward USD-cent rounding. There is no second FX table,
live rate lookup or change to `packages/policy`. For example, a remaining
EUR 90.91 or KRW 140,001 yields USD 100.01.

`result.amount` includes the independently computed `usd` for inspection.
`result.context.amount` contains only `value` and `currency`, as required by the
policy evaluator, which recomputes USD itself. A caller-provided USD field is
rejected by the tool schema and cannot override the source amount. The assembled
policy envelope must also fit the shared inert-JSON size/depth budget.

## Cache and errors

Default TTL is 2 seconds with a hard maximum of 5 seconds, measured from lookup
start. Slow reads that outlive freshness are denied. Same-key concurrent callers
share only validated remote facts; decisions, requested amounts and caller
identities are never cached. Cache/in-flight maps are each limited to 128 keys.
Expired/reversed/invalid clocks and refresh failures never fall back to stale
facts. Failed reads are not negatively cached.

Call `invalidateCapture(id)`, `invalidateInvoice(id)` or `invalidateDispute(id)` when related state changes.
Every resolution rechecks a freshness/invalidation lease before returning, including cache hits.
An invalidated in-flight read cannot return as a current resolution or repopulate
the cache, and its cleanup cannot remove a newer in-flight lookup.

GET requests use only the fixed sandbox origin, reject redirects, have an overall
deadline including token lookup/body reading, and limit each response to 128 KiB.
There are no automatic retries. Transport/parse/validation failures return a
constant deny reason without response bodies, tokens, URLs or customer data.

Short-lived lookup facts do not reserve money. Before execution, a future caller
must invalidate/re-resolve and reserve/refund atomically; pending reservations
and approval binding belong to the execution/aggregation work. The current
refund executor's USD-only and completed-capture restrictions are unchanged.

## Verification and remaining integration

```sh
pnpm install --frozen-lockfile
node --test tests/context-resolver.test.mjs
pnpm lint
pnpm typecheck
pnpm test
trunk check --all --no-fix
docker compose --env-file .env.example config --quiet
```

Resolver tests use synthetic tokens and a loopback REST server; every outbound
adapter URL is asserted before redirecting it to that fixture. No PayPal API,
payment/refund operation, real credentials or database is used.

The firewall call sites, authentication mapping, audit persistence (#37), spend
reservation and approval/execution integration remain separate. This change
provides `context` and `resolvedCtx` interfaces and synthetic proof; it does not
claim that every real call is now resolved or audited. Audit PR #37 is unchanged.
