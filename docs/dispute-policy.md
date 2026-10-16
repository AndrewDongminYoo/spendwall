# Dispute policy

## Local review boundary

Issue [#28](https://github.com/AndrewDongminYoo/spendwall/issues/28) adds trusted dispute context and a mandatory approval floor for `accept_dispute_claim`.
`DisputePolicy` preserves a policy denial and converts every other valid acceptance decision to `require_approval`.
Every result has `dispatchAllowed: false`.
It does not create a pending approval, persist an audit event, reserve funds, accept a provider claim or send a deadline notification.
The W0 proxy, refund approval service and mobile app are not wired to this boundary.

Run the synthetic example:

```sh
node scripts/dispute-demo.mjs
```

It checks a valid review, foreign merchant, inconsistent amount and overdue response deadline using synthetic GET responses.
It reads no environment credentials and makes no network requests.

## Trusted context and supported subset

Construct `ContextResolver` with a trusted merchant and token source, then supply it to `new DisputePolicy({ resolver })`.
Call `evaluate(loadedPolicy, { tool: 'accept_dispute_claim', args: { dispute_id, note } }, { agent, customer, agg })` from trusted server composition.
The [sample policy](../apps/agent-demo/dispute-policy.yaml) requires approval and denies non-USD claims.
No LLM participates in the decision.

The trusted `customer` must contain `id`, `email` and `seller_transaction_id`.
The server must establish this customer-to-sale mapping from its own authenticated records; an agent's claim is not sufficient.
PayPal dispute detail does not provide a dependable buyer payer ID.
The resolver matches the mapped seller transaction ID and the configured merchant ID against the single provider transaction.
It checks the seller email too when that optional field is present, but does not infer buyer ownership from a display name or email.
Caller aggregates are replaced with an empty object because there is no dispute exposure ledger in this baseline.
Policies that need unavailable aggregates fail closed.

The resolver reads only `GET /v1/customer/disputes/{id}` at the fixed sandbox origin.
It supports one fiat transaction in `COMPLETED` or `HELD` state, positive dispute and gross amounts in the same supported currency, and a dispute amount no larger than gross.
Cryptocurrency, multiple transactions, missing ownership and inconsistent money fail closed.
Amounts use the existing USD/EUR/KRW normalization; the fictional FX rates are not live conversion or settlement evidence.
Dispute amount is the provider's originally disputed amount, not an estimate of all possible fees or the final settlement amount.

Acceptance context additionally requires a known active dispute state, the `REFUND` response option and an exact sandbox `accept-claim` link with method `POST`.
The link is checked as capability evidence and is never followed.
`RESOLVED` and `OTHER` deny acceptance.
`get_dispute` can still resolve those known states for inspection when the other supported facts are present.
Unsupported or incomplete provider responses deny even when they could be legitimate outside this narrow subset.

`invalidateDispute(id)` invalidates cached and in-flight facts.
The shared resolver retains its default two-second lease, GET-only transport, response/body limits and constant failure reasons.
Cache entries hold provider facts; trusted customer mapping and policy decisions are checked independently for each caller.
See the [resolver contract](context-resolver.md).

## Review result and deadlines

A successful review returns the immutable `context`, `resolvedCtx`, `bindingHash` and `deadline`.
The context includes the exact source arguments and complete policy-visible trusted identities.
Resolved facts include the dispute and sale IDs, dispute/gross amounts, transaction status, dispute status/stage, capability and optional seller deadline.
The versioned SHA-256 fingerprint binds that context, those facts and the loaded policy version.
It is neither a secret nor an authenticated authorization token.
Do not use it as an approval ID, provider idempotency key or reusable execution permission.

Seller deadlines accept canonical UTC timestamps with seconds or three fractional digits, such as `2026-10-17T12:00:00Z` or `2026-10-17T12:00:00.000Z`.
Other offsets/precision and impossible calendar values are outside this baseline and deny resolution.
An omitted deadline produces `not_provided`; a malformed present deadline does not silently become missing.

| Status         | Meaning                                    |
| -------------- | ------------------------------------------ |
| `not_provided` | No seller response deadline was returned   |
| `overdue`      | At or past the deadline                    |
| `due_soon`     | More than zero and at most 24 hours remain |
| `scheduled`    | More than 24 hours remain                  |

Deadline classification is recomputed at review time, even for cached provider facts.
It is advisory: an overdue claim still needs human review, never automatic acceptance.
No scheduler, push channel, email or durable alert queue is included.

## Verification and integration limits

```sh
node --test tests/dispute-policy.test.mjs tests/context-resolver.test.mjs
node scripts/dispute-demo.mjs
```

Tests exercise real policy loading and resolver code with controlled provider responses, changed ownership and money, unknown/terminal states, mutable inputs, cache invalidation, deadline boundaries and fingerprint changes.
They do not establish live PayPal response completeness, approval delivery or accepted disputes.

Calling `evaluatePolicy` directly bypasses this mandatory floor; an integration must compose `DisputePolicy` after caller authentication and tool authorization.
Before any future execution, it must create durable audited approval state bound to the exact request, verify current provider facts/capabilities, reserve exposure and implement provider-specific idempotency and recovery.
Do not reuse the refund executor or refund approval rows for dispute acceptance.
The original issue remains open for that integration and actual deadline delivery.

The supported response fields are grounded in the [pinned official PayPal schema](https://github.com/paypal/paypal-rest-api-specifications/blob/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/customer_disputes_v1.json) and the repository's captured MCP catalog.
