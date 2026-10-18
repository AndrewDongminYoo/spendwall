# Dispute tracking and deadline re-evaluation

## Problem and scope

Issue #28 has a durable deadline alert outbox (`DisputeDeadlineAlerts`, PR #71) and a read-only app notice (PR #74), but nothing calls `record(result, agentId)`.
`DisputePolicy` is not wired into any server, the webhook receiver ignores dispute events, and `docs/dispute-policy.md` lists the re-evaluating scheduler as out of scope.
This spec is the contract for one implementation PR that tracks disputes from verified webhook events, re-evaluates them on events and on a timer, and passes each review result to `record`.
It changes no policy decision, accepts no claim, calls no mutating PayPal API and adds no app or dashboard surface.
Issue #28 stays open: no code in this repository supplies the trusted customer lookup that the tracker requires (decision 3), and real webhook delivery, live sandbox disputes and physical-device display remain unverified after this PR.

## Evidence

- The [PayPal webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/) page, inspected on 2026-10-18, lists `CUSTOMER.DISPUTE.CREATED` ("A dispute is created."), `CUSTOMER.DISPUTE.UPDATED` ("A dispute is updated.") and `CUSTOMER.DISPUTE.RESOLVED` ("A dispute is resolved."), and marks `RISK.DISPUTE.CREATED` as superseded and deprecated by `CUSTOMER.DISPUTE.CREATED`.
- The [pinned Disputes schema](https://github.com/paypal/paypal-rest-api-specifications/blob/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/customer_disputes_v1.json) defines `GET /v1/customer/disputes` (`disputes.list`) with summary items (`dispute_info`) that have no `disputed_transactions`, `page_size` at most 50, `start_time`, `update_time_before` and `update_time_after` within the last 180 days, and `start_time` and `disputed_transaction_id` as mutually exclusive.
  It defines no webhook callbacks or event payloads.
  It describes `seller_transaction_id` only as "The ID, as seen by the merchant, for this transaction."
- **Unverified:** that a dispute event's `resource` carries `dispute_id` and `disputed_transactions[].seller_transaction_id` in the same shape as the dispute detail.
  No primary source inspected for this spec shows the event resource shape; the implementation must treat any other shape as a rejected event, and only a real sandbox delivery can confirm it.
- **Unverified:** that a dispute's `seller_transaction_id` equals the Orders v2 capture ID stored in `orders.captures.capture_id`.
- **Unverified:** which dispute statuses carry an `accept_claim` option with the `REFUND` claim type and an `accept-claim` link, which together make the resolver set `canAccept`.
  The resolver code is deterministic, but no primary source inspected for this spec says when PayPal adds or removes them.
- **Unverified:** the `transaction_status` of a resolved dispute's transaction.
  The resolver accepts only `COMPLETED` and `HELD`, so a dispute whose transaction leaves those statuses after resolution cannot be read as `RESOLVED`.
- In this repository, `orders.orders.agent_id` stores a keyed `agent:<reference>` value, velocity and invoice records store only keyed `customer_ref` values, the refund reconciliation tables `reconciliation.refund_events` and `reconciliation.refund_receipts` store only keyed 64-hex `merchant_ref`, `refund_ref` and `capture_ref` values, and audit rows redact provider identifiers.
  No existing table holds a raw agent ID or a customer `id`, `email` and `seller_transaction_id` together, so existing records cannot supply the trusted mapping.
- `ContextResolver` requires trusted `agent`, `customer` and `agg` before any provider GET, for `get_dispute` as well as `accept_dispute_claim`.
  The lookup key for the mapping therefore cannot come from the resolver itself.
  Both tools cache provider facts under the same `dispute:<id>` entry, which `invalidateDispute(id)` clears.
- The captured MCP catalog requires `accept_dispute_claim.note` to match `^[A-Za-z0-9_-]{1,255}$`, so an empty note is invalid.
- The sample dispute policy (`apps/agent-demo/dispute-policy.yaml`) allows `accept_dispute_claim` only for the `support` agent, and its default is `deny`.

## Decisions

### 1. Dispute source

Decision: verified webhook events discover disputes, and each tracked dispute is re-read with `GET /v1/customer/disputes/{id}` through the existing resolver on events and on its timer.
The receiver handles `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED` and `CUSTOMER.DISPUTE.RESOLVED` after the existing signature postback succeeds.
`RISK.DISPUTE.CREATED` stays ignored because the provider deprecated it, and every other unsupported type keeps the existing ignored response.
An event is a trigger and a lookup key, not a fact source: deadlines, money and ownership come only from the resolver's GET, and no event produces an alert.
A verified event can only bring a check forward or, for `CUSTOMER.DISPUTE.RESOLVED`, end tracking; ending tracking can only suppress alerts, and it also covers a resolved dispute that the resolver can no longer read (see Evidence).

Rejected: periodic `disputes.list` polling, alone or in addition.
Its summary items carry no `disputed_transactions`, so the mapping key and the resolver's ownership checks would still need a detail GET for every listed dispute; paging at 50 within a 180-day window cannot claim complete coverage; and the webhook reconciliation spec already rejected a provider-wide polling subsystem.

### 2. Tracked-dispute storage

Decision: a new `disputes` schema with two append-or-advance tables, applied by the trusted owner after `012-dispute-deadline-alerts.sql`.

- `disputes.events` stores one row per scoped event: adapter and merchant references, a keyed event reference, a keyed payload digest, the event type, `dispute_id` and the event's single `seller_transaction_id`.
  It stores no payload, buyer data, amount, note or header.
  A uniqueness constraint on (adapter, merchant, event reference) serializes copies; a repeat with the same digest is acknowledged and a changed digest under the same event ID is rejected, as in refund reconciliation, which is why the receiver can also `SELECT` this table.
- `disputes.tracked` stores one row per (merchant reference, `dispute_id`): `seller_transaction_id`, first and last event times, an `event_version` counter, `next_check_at`, consecutive failures, the last outcome, an `ended` reason, and `claim_id` and `leased_until` for the claim.
  An insert into `disputes.events` inserts or advances this row through an `AFTER INSERT` trigger whose function is `SECURITY DEFINER`, owned by the trusted owner, with `EXECUTE` revoked from `PUBLIC` and every runtime role, so the receiver needs no privilege on `disputes.tracked`.
  The trigger increments `event_version`, sets `next_check_at` to the database clock, ends a row on a `CUSTOMER.DISPUTE.RESOLVED` event, and never changes identity columns or an ended row.
  Settlement binds to `event_version` rather than the last event time, because the database clock is the transaction start time, so an event transaction that commits after a claim can carry an earlier time than the one the claim observed.

Out-of-order or repeated events need no ordering logic, because every evaluation reads current provider state; an event only brings the next check forward.
An event for an ended row is stored as evidence but does not reopen it.
A database guard keeps identity columns immutable, `event_version` changed only by the trigger and never decreasing, `ended` rows final and failure counts non-decreasing except on a successful evaluation; no runtime role can delete rows.
Only the `unmapped` and `dispute_unavailable` outcomes count as failures; every other outcome in decision 5 is a successful evaluation and resets the count to zero.

Tracking ends with one of these reasons:

| Reason      | When                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| `resolved`  | A verified `RESOLVED` event, or a `get_dispute` resolution of `RESOLVED` |
| `overdue`   | `record` has accepted an `overdue` review for the dispute                |
| `exhausted` | 7 days of consecutive failed evaluations                                 |
| `expired`   | 180 days after the first event                                           |

### 3. Trusted context

Decision: the tracker takes a required trusted lookup, `saleCustomer(sellerTransactionId)`, that returns `{ id, email }` from the deployment's own authenticated customer records or `undefined`.
The tracker builds `customer: { id, email, seller_transaction_id }` from that answer and the tracked row, and the resolver independently requires the provider's transaction ID and merchant to match.
A wrong or forged lookup key therefore cannot produce a review for another sale.

No code in this repository implements `saleCustomer`: no existing record holds the customer fields (see Evidence), and a customer store is out of scope.
This PR adds the lookup interface, its validation and test fixtures only.
The tracker refuses construction without a lookup, so a deployment that supplies none still stores verified events but re-evaluates no dispute and records no alert; this PR proves the alert path in tests, not in a shipped composition.

When the lookup returns `undefined` or invalid data, the tracker makes no resolver call, records no alert, sets the last outcome to `unmapped` and retries within the failure bound.

Rejected: deriving the mapping from `orders.captures` (no customer fields, keyed agent, and the capture-ID equality is unverified), from the refund reconciliation tables (keyed capture and refund references only, no customer fields), from audit or velocity records (keyed or redacted), or from the event's buyer fields (the dispute policy already states that PayPal dispute detail has no dependable buyer payer ID).

### 4. Agent and device routing

Decision: each tracker is configured with one review agent ID for its merchant.
That agent must be one that the loaded dispute policy allows for `accept_dispute_claim` (in the sample policy, `support`) and that has approver device grants in the merchant's `DeviceAuthority`.
The tracker passes it as `trusted.agent.id` to `DisputePolicy.evaluate` and as `agentId` to `record`, so the alert goes to the devices of the owner who would approve the acceptance.
A misconfigured agent that the policy does not admit produces `policy_denied` for every dispute and therefore no alert; the outcome records that reason.

Merchant scoping is enforced at three points: the tracker refuses construction unless its resolver and `DeviceAuthority` are configured for the same merchant; it claims only rows of its own merchant reference; and `record` already refuses a review whose context merchant differs from its `DeviceAuthority` (#71 round 2).
The receiver and tracker must derive the same keyed merchant reference from the same identity key, and a test asserts that they agree.

Rejected: the agent that created the sale (only a keyed reference is stored, and `record` needs the raw ID), and any agent named by an event or provider response (untrusted input).

### 5. Re-evaluation schedule

Each re-evaluation of a claimed row:

1. Looks up the trusted customer; on failure it records `unmapped`.
2. Calls `invalidateDispute(id)`, then resolves `get_dispute` with the trusted context; a failed resolution records `dispute_unavailable`.
   A `RESOLVED` status ends tracking; otherwise a `can_accept` value of `false` in the resolved context records `not_acceptable` and skips step 3.
3. Evaluates `accept_dispute_claim` with the fixed server-owned note `Spendwall_deadline_review` through `DisputePolicy` and passes the result to `record`.
   The note satisfies the catalog pattern and enters the review's `bindingHash`, but it is never sent to PayPal.

Steps 2 and 3 share the resolver's `dispute:<id>` cache entry, so one check normally makes one provider GET, and never more than one GET per tool resolution.
Because step 2 reads `can_accept` from the resolver's own facts, a readable dispute that cannot yet be accepted is a successful evaluation, not a failure, and it never reaches `exhausted`; a `dispute_unavailable` result from step 3 after step 2 saw `can_accept: true` is still a failure.

The next check follows the review's deadline classification, which uses the same 24-hour boundary as `DisputePolicy`:

| Outcome                             | Next check                                        |
| ----------------------------------- | ------------------------------------------------- |
| `scheduled`                         | the earlier of `dueAt - 24h` and now + 24 hours   |
| `due_soon` (alert recorded)         | `dueAt`, when the review becomes `overdue`        |
| `overdue` (alert recorded)          | none; tracking ends                               |
| `not_provided` or `policy_denied`   | now + 24 hours                                    |
| `not_acceptable`                    | see below                                         |
| `unmapped` or `dispute_unavailable` | backoff from 1 minute, doubling, capped at 1 hour |

For `not_acceptable`, the tracker uses the `seller_response_due_date` of the `get_dispute` context as `dueAt` for scheduling only: the earlier of `dueAt - 24h` and now + 24 hours before that boundary, now + 1 hour from `dueAt - 24h` until `dueAt`, and now + 24 hours after `dueAt` or when there is no deadline.
A dispute that becomes acceptable inside the 24-hour window therefore reaches `due_soon` within an hour, and a dispute that never becomes acceptable is read hourly only inside that window.

`due_soon` starts at `remainingMs <= 86_400_000`, so checking at exactly `dueAt - 24h` reaches it without earlier polling, and the exact due instant is `overdue`.
The 24-hour cap re-reads a dispute whose deadline changed without an event we received.
A provider GET happens only when a row is due; the timer itself is a database query.

The timer runs one tick per instance every 60 seconds, claims at most 10 due rows that are not ended per tick with `FOR UPDATE SKIP LOCKED`, and sets a 30-second persisted lease bound to a claim UUID, as the alert outbox does.
The claim returns each row's `event_version`, and the outcome write is a single conditional `UPDATE` that matches both the claim UUID and that version, so a process whose lease expired cannot overwrite a newer claim and an evaluation cannot replace the schedule of an event that arrived after its claim.
Under read committed, a settlement that waits behind an uncommitted event re-checks its condition after the event commits and then matches no row.
When the outcome write matches no row, the tracker clears only `claim_id` and `leased_until` of a row that still has its claim UUID and is not ended, and leaves `next_check_at`, the failure count, the last outcome and `ended` as the trigger left them; the next tick re-reads the dispute and derives any ending again.
An ended row keeps its stale claim, which is harmless because the claim query excludes ended rows.
An alert that `record` accepted during such an evaluation stays, because it came from a real provider read and `record` is idempotent.
If two processes do evaluate the same dispute after a lease expiry, `record` is idempotent per (merchant, dispute, stage, device, generation), so no duplicate alert results.
`close()` stops new ticks and waits for the running one.

### 6. Failure and safety

- Re-evaluation never accepts a claim, never follows a provider link, never changes or lowers a policy decision and never calls a mutating PayPal API; the only provider traffic is the resolver's fixed-origin GET and the existing signature postback.
- `DisputePolicy` collapses every resolution failure (provider error, ownership or money mismatch, unsupported or terminal state) to `dispute_unavailable`.
  The tracker records only the outcomes it can observe: `unmapped`, `dispute_unavailable`, `not_acceptable` (from the `get_dispute` context, decision 5), `policy_denied`, the deadline status, and the ending reason; it does not claim a finer cause.
- Failed evaluations record no alert and retry with the backoff above until the `exhausted` bound.
- The receiver database role gets `SELECT` and column-level `INSERT` on `disputes.events` only, and no privilege on `disputes.tracked`.
  `checkWebhookReceiver` is extended to allow exactly those privileges in the `disputes` schema, and continues to refuse any other privilege, including `EXECUTE` on a security-definer function such as the trigger function.
- The application group (`audit.app_role()`) gets `USAGE` on the `disputes` schema, `SELECT` on `disputes.tracked`, and column-level `UPDATE` on its `next_check_at`, consecutive-failure, last-outcome, `ended`, `claim_id` and `leased_until` columns only, as `012-dispute-deadline-alerts.sql` grants for the alert outbox.
  It gets no `INSERT` or `DELETE` on `disputes.tracked`, no privilege on `disputes.events` and no `EXECUTE` on the trigger function, so only verified events create tracked rows.
- `PayPalWebhookVerifier.verify` returns a tagged result for a refund or a dispute event; a dispute event without exactly one `dispute_id` and one `seller_transaction_id` in the accepted identifier shapes is rejected with 422 before storage.

## Verification plan

The implementation must include:

1. Deterministic-clock tests for `scheduled`, exactly `dueAt - 24h`, `due_soon`, exactly `dueAt`, `not_provided` and the 24-hour cap, asserting `next_check_at` and the number of provider GETs.
2. Webhook tests for forged signatures, replayed events with the same payload, changed payloads under one event ID, `RISK.DISPUTE.CREATED` and unsupported types, malformed dispute resources, a `RESOLVED` event that ends tracking without a provider GET, and an event after `RESOLVED`; `tests/webhooks.test.mjs` currently asserts that `CUSTOMER.DISPUTE.CREATED` is ignored, and that assertion is replaced.
3. Missing or invalid customer mapping, and a mapping whose transaction differs from the provider's, produce no alert and the recorded outcome; a tracker constructed without a lookup is refused.
4. A readable dispute with `can_accept: false` records `not_acceptable`, resets the failure count, follows the `not_acceptable` schedule and never ends as `exhausted`; when it becomes acceptable inside the 24-hour window, the next check records a `due_soon` alert.
5. Cross-merchant routing: a dispute of another merchant, a tracker configured with mismatched merchants, and another merchant's tracked rows produce no alert and no claim.
6. A review agent that the policy does not admit produces `policy_denied` and no alert.
7. Concurrent schedulers against one disposable PostgreSQL database claim each row once per lease and produce one alert per device and stage.
   A deterministic interleaving, in which the fake resolver inserts a `CUSTOMER.DISPUTE.UPDATED` event during its GET, leaves `next_check_at` at the trigger's value instead of the deadline-derived one and clears the claim; the next tick makes one more provider GET and, when the update moved `dueAt` inside 24 hours, records a `due_soon` alert.
8. Real PostgreSQL permission checks, through `scripts/test-audit-postgres.mjs`, for the receiver grants and the application-group grants in decision 6 (including refused `INSERT` and `DELETE` on `disputes.tracked`, refused access to `disputes.events` and refused updates of identity columns and `event_version`), the trigger and the row guards.
9. Existing project checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `trunk check --all --no-fix` and Compose configuration validation.

Unverifiable locally: real PayPal webhook delivery and signature acceptance (mock events cannot be postback-verified), the dispute event resource shape, the capture-to-`seller_transaction_id` equality, which statuses PayPal makes acceptable, a resolved dispute's transaction status, live sandbox disputes and physical-device display.
No test can show alerts for real customers until a deployment supplies `saleCustomer`.

## Out of scope

- A customer store, a server dispute list or detail API, dashboard or app changes, email, and wiring into the W0 proxy or agent demo.
- Any dispute action, including accepting a claim, and any change to `DisputePolicy`, the resolver or the alert outbox contract.
- Provider-wide dispute polling, backfill of disputes opened before the receiver ran, and public webhook ingress or subscription registration.

## Open questions

- Who supplies `saleCustomer` in a real deployment: a merchant's own customer system behind the composition, or a future customer store in this repository? Until one exists, no tracked dispute is re-evaluated outside tests.
- A dispute whose acceptance the policy denies (for example a non-USD dispute), or that the resolver never reads as acceptable, never produces a review, so it never gets a deadline alert; should deadline alerts be independent of the acceptance decision?
- The outbox key (merchant, dispute, stage, device, generation) allows one `overdue` alert per dispute, so a new seller deadline in a later lifecycle stage cannot alert again; tracking ends at `overdue` for that reason.
- The 7-day failure bound, the 180-day tracking bound and the hourly `not_acceptable` check inside the 24-hour window are conservative defaults chosen for this PR, not provider requirements.
