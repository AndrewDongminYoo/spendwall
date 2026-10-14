# Audit-backed refund velocity

Implement [issue #8](https://github.com/AndrewDongminYoo/spendwall/issues/8) after PR #37, merged at `4ed4479a578bb92d042f5a6f6313c4dad980644e`.
This is a server-side reservation API, not a payment executor or approval workflow.
Callers provide a trusted context, such as the successful result of #9, and a server-assigned UUID that remains stable across network retries.
Agent arguments cannot provide trusted identities, the identity key, or aggregates.
The existing `evaluatePolicy` API and original audit migration remain unchanged.

## Identity and history contract

Require one stable 32-byte secret HMAC key, supplied as 64 hexadecimal characters through server configuration.
Domain-separated HMAC-SHA256 values identify the merchant, merchant-scoped customer, request binding, and key continuity tag.
Raw merchant/customer IDs, emails, and the key are never persisted.
Key rotation is unsupported: a different key continuity tag in reservation history fails closed instead of treating old usage as zero.
Persist an explicit `velocity` metadata object inside the already-hashed `resolved_ctx` column: `v`, `key_id`, `merchant_ref`, `customer_ref`, `request_id`, `binding_hash`, and integer `usd_cents`.
Bind the canonical trusted context, source arguments, resolved payment facts, and policy version; ignore caller-supplied `agg` in that binding and replace it before policy evaluation.
Metadata uses version 1, fixed keys, lowercase 64-character hexadecimal references, a lowercase UUID, and USD cents within #7's normalization bound.
The optional typed audit metadata input is separate from arbitrary argument/context JSON.
Both TypeScript and an owner-applied `002` migration validate this allowlist.
Preserve the original payment redactor and fixed v1 event payload so existing hashes remain valid.
No migration or backfill may rewrite existing events.

Only `create_refund` is in this reservation API's scope.
Read refund audit events in numeric ID order, with a bounded 10,000-row history budget.
History overflow, malformed identities, unsupported versions, inconsistent bindings, missing initial reservations, invalid lifecycle transitions, future timestamps, and unsafe numeric values deny the request.
This conservative baseline requires an operational follow-up before a deployment exceeds that history budget; it never truncates history into an empty or partial aggregate.
Legacy allowed/pending refund events without metadata cannot be reliably attributed and therefore block enforcement.
Legacy denied events without metadata contribute nothing.

## Lifecycle and time windows

Fold events by merchant reference and logical request UUID, rather than summing lifecycle rows.
Each binding contributes at most once.
The initial `tool_call` contains the evaluated decision, policy version, matched rules, and receipt.
An initial `allow` contributes an accepted reservation at its audit timestamp.
An initial `require_approval` creates a pending reservation with a generated approval UUID.
`approval_created` may confirm that pending reservation once.
`approval_decided: allow` leaves it pending until execution.
`approval_decided: deny` releases a pending reservation.
A matching `approval_executed: allow` with a 2xx upstream status and result UUID converts the pending reservation into one accepted contribution at execution time.
Failed or uncertain execution keeps the pending reservation charged.
Duplicate terminal transitions, contradictory metadata, and approval IDs that do not match the initial binding fail closed.
These are read contracts for future approval writers; this change does not implement those writers.

Accepted windows are `(now - duration, now]`.
Pending reservations do not expire automatically and remain charged in every window until an explicit matching release or confirmed execution.
Use integer USD cents from #7 normalization for sums, converting to the existing CEL dollar field only after the checked sum.
Calculate `agg.refund_usd_24h` and `agg.refund_count_1h` for the trusted merchant and agent.
Calculate `agg.customer_refund_count_7d` for the trusted merchant and customer across agents.
Aggregates exclude the candidate request; policy expressions can combine them with `amount.usd`.
A fake clock exercises exact boundaries and pending lifetimes.
Production time comes from PostgreSQL after lock acquisition.

## Transaction, retries, and failure

Own one pool-client transaction at READ COMMITTED isolation.
Acquire one merchant-scoped transaction advisory lock before reading history.
This deliberately coarse lock prevents same-agent, cross-agent customer, and replay races without introducing a lock-order protocol.
Read committed history, fold aggregates, evaluate the existing policy, and append the decision/reservation before committing.
Return a successful result only after commit.
Return the original committed decision and receipt with `replayed: true` for an identical request binding and policy version.
The replay does not append another event or reserve again.
Changed content under the same merchant/request UUID returns denial.
The result is not permission to execute another payment on retry; future execution must use the request binding and its own idempotency protocol.
Missing configuration, invalid trusted context, database/lock/commit failures, or unavailable history fail closed with a constant safe result.
Use a transaction-local timeout and release/rollback the client on all failure paths.

## Acceptance checks

1. Metadata and history → verify: unit and real PostgreSQL tests reject missing/malformed references, changed replay bindings, legacy unscoped accepted history, key changes, future rows, and history overflow.
2. Windows and lifecycle → verify: fake-clock tests cover exact lower/upper boundaries, all three aggregates, cross-agent customer scope, pending carryover, denial release, confirmed execution counted once, and uncertain outcomes retained.
3. Concurrency and retries → verify: independent PostgreSQL clients cannot collectively exceed same-agent or customer limits; identical concurrent retries reserve once and return one receipt.
4. Immutable audit → verify: a pre-002 chain remains valid, new metadata is hashed and redacted consistently, and app-role restrictions remain intact.
5. Delivery → verify: frozen install, `pnpm check`, `trunk check --all --no-fix`, Compose configuration, local adversarial review, and current-head hosted review/CI.

Oracle retrieval for velocity aggregation and audit concurrency returned `[no precedent found]`.
Advisor confirmed that conservative lifetime/retry choices fit the approved plan and required one contribution per lifecycle binding plus stable HMAC key continuity.
