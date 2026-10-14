# Velocity aggregation prerequisite

## Current evidence

The operator requested implementation, verification, and a PR for [issue #8](https://github.com/AndrewDongminYoo/spendwall/issues/8).
Issue #8 names [issue #11](https://github.com/AndrewDongminYoo/spendwall/issues/11) as a prerequisite and requires audit-backed sums and counts, inclusion of pending approvals, and same-agent concurrency control.
Issue #11 is open, and the current repository has a PostgreSQL Compose service but no audit table, database client, migrations, or audit storage implementation.
The merged [issue #7 contract](../specs/2026-10-14-policy-evaluator.md) accepts caller-resolved `agg` data but does not obtain or authenticate it.

## Approved sequence

Complete #11 in a separate PR before implementing #8.
Use the existing local PostgreSQL service for the database boundary, with an append API, read support, application-role restrictions against update/delete, and hash-chain verification.
Implement the event fields and verification command required by #11 without adding an approval workflow, dashboard, or unrelated payment changes.
Check how approval lifecycle events identify a single logical request before defining velocity counting, so multiple events cannot count one refund repeatedly.
A database client dependency is necessary only if the existing runtime cannot access PostgreSQL; select and pin it during approved #11 implementation.

After #11 is merged, implement #8 using its actual storage contract.
Read audit facts, calculate aggregates, call the existing `evaluatePolicy`, and append the accepted or pending decision under the same agent-scoped database lock and transaction.
Scope agent and customer queries to the trusted merchant context.
Calculate USD sums using integer cents and reuse #7 normalization for candidate amounts.
Define exact time-window boundaries, future timestamps, pending reservation lifetime, and replay behavior in the #8 specification before its implementation.
Inject a fake clock for deterministic window tests.
PR #37 supports caller-owned `PoolClient` transactions and app-role reads, but currently discards merchant/customer identity and has no logical request correlation field apart from approval IDs.
Before #8 aggregates real rows, define safe stable merchant/customer references and a logical request identity through an explicit schema/redaction contract; do not treat missing identity as an empty history.
Keep real payment execution and the future #9 context resolver outside these PRs.

## Acceptance checks

1. #11 prerequisite → verify: real PostgreSQL tests cover all three decision values, append/read behavior, denied update/delete for the application role, and a deliberately altered row detected by `pnpm audit:verify` at the correct position.
2. #7 integration → verify: existing evaluator regressions remain green, and audit-derived aggregate fields are passed to `evaluatePolicy` without changing its public decision API.
3. #8 window behavior → verify: fake-clock cases cover window boundaries, accepted and pending requests, customer scope, and integer money sums.
4. #8 concurrency → verify: two independent database clients submit same-agent calls that would collectively exceed a limit; only the permitted request is accepted, and its reservation is visible to the second decision.
5. Each PR → verify: frozen install, formatting, strict types, behavioral tests, Trunk, Compose, local review, and current-head hosted CI/review.

## Authority and status

Implementation of #8 is authorized.
The operator approved implementing #11 through verification and PR first, then resuming #8 after its merge on 2026-10-14.
This plan does not authorize issue changes, payment calls, release publication, or merge.
Oracle retrieval returned `[no precedent found]` for velocity aggregation and audit concurrency.
An Advisor checkpoint recommended resolving the missing prerequisite rather than treating an in-memory fixture as completed audit-backed enforcement.
An existing #11 implementation in PR #37 is being reused and verified before starting #8.
