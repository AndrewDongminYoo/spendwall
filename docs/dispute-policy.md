# Dispute policy

## Local review boundary

Issue [#28](https://github.com/AndrewDongminYoo/spendwall/issues/28) adds trusted dispute context and a mandatory approval floor for `accept_dispute_claim`.
`DisputePolicy` preserves a policy denial and converts every other valid acceptance decision to `require_approval`.
Every result has `dispatchAllowed: false`.
It does not create a pending approval, persist an audit event, reserve funds, accept a provider claim or send a deadline notification.
The separate [deadline alert outbox](#deadline-alert-outbox) can record and push a review result's deadline stage without changing that result.
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
No email is sent; the deadline alert outbox below only records stages that a review has already classified, and the [dispute tracker](#dispute-tracking) is the only component that re-evaluates disputes and passes reviews to it.

## Deadline alert outbox

`DisputeDeadlineAlerts` (`apps/firewall/src/disputes/alerts.ts`) is a durable push outbox in `approvals.dispute_alerts`.
Apply `migrations/012-dispute-deadline-alerts.sql` as the trusted owner after `004-approval-api.sql`; it reuses the approver device registry.
Construct it with the application pool, the approval API's `DeviceAuthority` and an `FcmSender`.

`record(result, agentId, client?)` takes a `DisputePolicy` result and the trusted agent identity that the review used.
With a `client`, the insert runs on that client inside the caller's transaction and the client is not released; without one, `record` takes a pool connection.
It records nothing for a `deny` result, a result without `review`, or a `scheduled` or `not_provided` deadline.
An agent identity that differs from the review context's agent is refused, and so is a review whose context merchant differs from the merchant of the `DeviceAuthority` that the outbox uses.
For `due_soon` and `overdue` it inserts one `ready` row for each active device of that agent's owner and returns the number of new rows.
A row is unique per merchant, dispute, stage, device and device generation, so repeating a stage is a no-op and a later `overdue` review adds a second, separate alert after `due_soon`.
Rows keep the classified `due_at` and the review `bindingHash` as a record of what was classified; neither is sent.
Recording never changes the policy decision, lowers the approval requirement, creates an approval record, accepts a claim or calls PayPal, and no LLM participates.

`drain()` uses the same claim design as approval delivery: one running drain per instance, at most ten rows per drain, `FOR UPDATE SKIP LOCKED`, a 30-second persisted claim lease and outcome writes bound to the claim UUID.
It claims only rows of its own merchant.

| State     | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| `ready`   | Waiting for its next attempt time                                    |
| `sending` | Claimed under a lease; an expired lease is claimed again             |
| `sent`    | FCM accepted the message; final                                      |
| `skipped` | Unregistered, revoked or re-enrolled device, expired or out of tries |

A retryable FCM failure returns the row to `ready` with exponential backoff capped at 60 seconds, extended to the provider's `Retry-After` and at least one minute for HTTP 429.
An explicit FCM `UNREGISTERED` error, an inactive device, a changed device generation or owner, 100 attempts, or expiry ends the row as `skipped`; a `sending` row reaches that bound only after its lease has elapsed, so a concurrent drain never overwrites an outcome that is still being sent.
A row expires 72 hours after it is recorded, whatever its `due_at`; a deadline that has already passed is not a reason to skip, so an `overdue` alert is still delivered.
`close()` stops new drains and waits for the running one.

The FCM message carries only the target registration token, `data: { dispute_id, stage }` and the fixed title `Dispute response due` and body `Open Spendwall to review the dispute deadline.`.
No amount, customer identity, provider link, binding hash, JWT or credential is sent.
`FcmSender.sendDisputeDeadline` refuses an invalid token, dispute ID or stage as non-retryable before it requests an access token, and reuses the approval path's timeout, response size, response-name, `Retry-After` and `UNREGISTERED` handling.
The approval `send` payload is unchanged.

The database guard starts every row `ready` with no attempts, server-set creation, expiry and first-attempt times and a device of the recorded owner.
Identity columns cannot be rewritten, attempts never decrease and `sent` or `skipped` rows are final.
The application role has `SELECT` and `INSERT`, plus `UPDATE` on `state`, `attempts`, `next_attempt_at`, `claim_id` and `leased_until` only; it cannot delete or truncate rows, and `PUBLIC` has no access.

The Flutter approver shows an opened dispute push as a read-only, dismissible notice built only from the `dispute_id`/`stage` data; it makes no server call, offers no dispute action and stores nothing (see the [approver README](../apps/approver/README.md#dispute-deadline-notice)).

Out of scope: a server dispute list or detail API for the app, wiring into the W0 proxy, alert delivery in the agent demo, email, physical-device delivery and live sandbox disputes.

## Dispute tracking

`DisputeTracker` (`apps/firewall/src/disputes/tracking.ts`) re-evaluates disputes that verified webhook events discovered and passes each `due_soon` or `overdue` review to `record`.
The contract is the [dispute tracking spec](specs/2026-10-18-dispute-tracking.md).
Apply `migrations/013-dispute-tracking.sql` as the trusted owner after `007-reconciliation.sql` and `012-dispute-deadline-alerts.sql`.
It adds `disputes.events`, which the [webhook receiver](webhooks.md#dispute-events) inserts into, and `disputes.tracked`, which only an event trigger creates or advances.

Construct the tracker with the application pool, the merchant's `DeviceAuthority`, a `ContextResolver` for the same merchant, the loaded dispute policy, one review agent ID and a required `saleCustomer(sellerTransactionId)` lookup.
The lookup must return `{ id, email }` from the deployment's own authenticated customer records, or `undefined`.
No production code in this repository implements it; the agent demo's [opt-in dispute scenario](../apps/agent-demo/README.md#opt-in-dispute-deadline-scenario) uses a fixed synthetic mapping as a stand-in for a merchant's customer system.
A deployment that supplies no lookup stores verified events but re-evaluates no dispute; construction without a lookup, or with a resolver and `DeviceAuthority` for different merchants, is refused.
The review agent must be one that the policy allows for `accept_dispute_claim` and that has approver device grants; any other agent produces `policy_denied` and no alert.
`start()` runs one `tick()` every 60 seconds, `tick()` claims at most ten due rows of the tracker's merchant, each under a 30-second lease and at most once per tick, and `close()` stops new ticks and waits for the running one.
As in the alert outbox, the due check and the lease use the database clock, which also sets the trigger's check times; each claim returns that instant, and the evaluation schedules from it, so an application clock that differs from the database neither delays a check nor shortens another instance's lease.
The optional `now` clock replaces it in tests.

Each check looks up the customer, invalidates the cached dispute, resolves `get_dispute` and, when the dispute can be accepted, evaluates `accept_dispute_claim` with the fixed note `Spendwall_deadline_review`, which is never sent to PayPal.
Both resolutions share one cache entry, so a check normally makes one provider GET.
The tracker never accepts a claim, follows a provider link or calls a mutating PayPal API.

| Outcome                             | Next check                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `scheduled`                         | The earlier of `dueAt - 24h` and now + 24 hours                                    |
| `due_soon` (alert recorded)         | `dueAt`                                                                            |
| `overdue` (alert recorded)          | None; tracking ends                                                                |
| `not_provided` or `policy_denied`   | Now + 24 hours                                                                     |
| `not_acceptable`                    | As `scheduled` before `dueAt - 24h`, hourly until `dueAt`, then now + 24 hours     |
| `unmapped` or `dispute_unavailable` | Backoff from one minute, doubling, capped at one hour; these are the only failures |

An evaluation or settlement that throws, for example because `record` refuses the review, rolls back any alert and is recorded as `dispute_unavailable` for that row only; the tick continues with the next due row.

Tracking ends as `resolved` on a verified `CUSTOMER.DISPUTE.RESOLVED` event or a provider `RESOLVED` status, `overdue` after `record` accepts an overdue review, `exhausted` on a failed check at least seven days after the failure streak started, and `expired` 180 days after the first event, which is checked before any provider read.
Settlement locks the row only if its claim and event version are unchanged, records any alert on the same client and writes the outcome in the same transaction.
An event stored after the claim makes the read stale: the tracker records no alert, clears only its claim and leaves the trigger's schedule, so the next tick reads the dispute again.

The application group can read `disputes.tracked` and update only its schedule, failure, outcome, ending and claim columns; it cannot insert or delete tracked rows or read events.
A database guard keeps identity columns immutable, lets only the event trigger change `event_version`, keeps an ended row final and resets the failure streak only with a successful outcome.
The hosted dashboard reader's readiness check also refuses any `disputes` privilege, as it does for the `orders` schema.

## Verification and integration limits

```sh
node --test tests/dispute-policy.test.mjs tests/context-resolver.test.mjs tests/dispute-alerts.test.mjs tests/dispute-tracking.test.mjs
node scripts/test-audit-postgres.mjs --dispute-alerts
node scripts/test-audit-postgres.mjs --dispute-tracking
node scripts/dispute-demo.mjs
pnpm demo dispute
```

Tests exercise real policy loading and resolver code with controlled provider responses, changed ownership and money, unknown/terminal states, mutable inputs, cache invalidation, deadline boundaries and fingerprint changes.
They do not establish live PayPal response completeness, approval delivery or accepted disputes.

Calling `evaluatePolicy` directly bypasses this mandatory floor; an integration must compose `DisputePolicy` after caller authentication and tool authorization.
Before any future execution, it must create durable audited approval state bound to the exact request, verify current provider facts/capabilities, reserve exposure and implement provider-specific idempotency and recovery.
Do not reuse the refund executor or refund approval rows for dispute acceptance.
The alert tests use synthetic FCM responses and a disposable PostgreSQL database; they do not establish physical-device delivery or display.
The tracking tests use synthetic events, provider responses and customer lookups; they do not establish real webhook delivery, the dispute event resource shape, the equality of a dispute's `seller_transaction_id` and the Orders capture ID, or which statuses PayPal makes acceptable.
Outside those tests, the agent demo's [opt-in dispute scenario](../apps/agent-demo/README.md#opt-in-dispute-deadline-scenario) runs the path from a stored event to a recorded alert row with synthetic data; it does not run the alert drain and has the same limits as the tracking tests.
The original issue remains open for that integration, a trusted `saleCustomer` implementation, real webhook delivery, physical-device deadline delivery and display, and live sandbox disputes.

The supported response fields are grounded in the [pinned official PayPal schema](https://github.com/paypal/paypal-rest-api-specifications/blob/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/customer_disputes_v1.json) and the repository's captured MCP catalog.
