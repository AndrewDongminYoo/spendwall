# Policy preview implementation plan

## Contract and decision gate

Follow [the approved contract](../specs/2026-10-16-policy-preview.md).
Use the existing main workspace and branch `codex/issue-21-policy-preview` under the approved encrypted replay-retention decision.
Do not create a worktree or change existing token management.
The operator approved encrypted retention and exact reevaluation on 2026-10-16.
The root owns edits, staging, commits and final verification.

## Intended files and boundaries

- Reuse `packages/policy/src/index.ts` and `evaluator.ts` without changing their public contract.
- Add focused proposal and replay modules under `apps/firewall/src/policy-preview/`.
- Add `migrations/006-policy-replay.sql` and a recorder option at the evaluation point in `apps/firewall/src/velocity/index.ts`.
- Add preview routes to `apps/firewall/src/dashboard/server.ts` only as opt-in read/compute operations; preserve all existing authorization and read-only runtime-policy guarantees.
- Add the optional provider/configuration adapter through `scripts/dashboard.mjs` and a focused Claude adapter beside the preview module.
- Add a dashboard proposal component and scoped styles under `apps/dashboard/src/`; reuse existing UI tokens and narrow-screen conventions.
- Add focused `tests/policy-preview*.test.mjs` coverage and register the database suite in `scripts/test-audit-postgres.mjs`.
- Extend `docs/dashboard.md` with configuration, retention, coverage and manual activation boundaries.

No new dependency is planned: the existing YAML/CEL loader, Node crypto, PostgreSQL, React and Claude request pattern cover the intended baseline.
Reassess rather than silently adding a library if implementation disproves this assumption.

## Execution sequence

1. Resolve the replay-retention decision and record the exact authorized scope in Git-local state.
   Verify branch availability, open PRs, clean status and current main before starting the branch.
2. Write failing proposal tests for malformed output, forbidden default changes, invalid CEL, stale base and no policy mutation.
   Add the smallest candidate-validation and diff implementation, reusing the policy loader.
3. For approved replay storage, write real PostgreSQL failures for atomic capture, encrypted payloads, tenant binding, permissions and retention.
   Capture the exact post-aggregation evaluation context in the existing transaction without duplicating logical requests.
   Verify optional storage failure cannot commit an allowance while silently losing an enabled replay record.
4. Write dry-run failures for exact-input replay, changed/unchanged counts, legacy/unavailable coverage, tampering and time boundaries.
   Compare with independently evaluated fixture inputs, not assertions derived from the preview implementation.
   Add a negative control that removes or changes a snapshot and confirms the coverage/fidelity check fails.
5. Add the bounded Claude adapter and optional authenticated dashboard routes.
   Test real HTTP with synthetic provider responses, cancellation and zero payment/policy writes.
6. Add the diff, coverage counts and confirmed-draft export UI.
   Inspect the real rendered desktop and narrow states with an isolated browser session, then close that session.
   Keep live Claude invocation, license issuance and deployment disabled.
7. Run `pnpm check`, the focused PostgreSQL suite, dashboard build, `trunk check --all --no-fix` and Compose configuration.
   Run independent core-area reviews for storage/privacy and proposal/confirmation boundaries, followed by a root adversarial cross-check.
8. Make concern-based commits and open a scoped PR referencing issue 21 without closing unfulfilled acceptance criteria.
   Observe current-head CI and code/security review within the recorded public-repository budget.
   Present screenshots and request operator visual approval and merge only after the implementation and reviews are concrete.

## Completion boundary

No post-merge release, deployment, payment execution or scheduled maintenance is authorized by this plan.
Do not replace unavailable historical coverage with synthetic coverage in the final claim.
