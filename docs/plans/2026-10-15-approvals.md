# Approval implementation plan

Use [the approved issue contract and specification](../specs/2026-10-15-approvals.md).
Work in the existing checkout on `codex/issue-12-approvals`.
The root owns all implementation, staging, commits and final verification.

## Steps

1. Define normalized binding and encrypted persistence helpers in `apps/firewall/src/approvals/binding.ts`.
   Verify: `tests/approvals.test.mjs` first fails on changed binding and malformed encrypted payloads.
2. Add owner-applied `migrations/003-approvals.sql` and `apps/firewall/src/approvals/index.ts`.
   Verify: `tests/approvals-postgres.test.mjs` exercises actual state storage, audit transactions, TTL, concurrency and restart boundaries.
3. Add a read-only recovery method and stable account identity to `apps/firewall/src/refunds.ts`.
   Verify: real executor tests with mocked HTTP prove stable request identity/body and zero POST on read-only recovery.
4. Add `apps/firewall/src/approvals/tool.ts` with owner-scoped status lookup and the PR #39 lookup contract.
   Verify: protocol-facing handler returns safe status/result, rejects other owners, and never executes.
5. Add the new DB test to the explicit serial list in `scripts/test-audit-postgres.mjs` and document caller use.
   Verify: `pnpm check`, `trunk check --all --no-fix`, and `docker compose --env-file .env.example config --quiet`.
6. Complete independent transaction/execution and audit/privacy reviews against frozen full files.
   Verify repairs with observed failing regressions, then make scoped conventional commits, push, open PR and observe exact-head review/CI.

No dependency or existing migration rewrite is planned.
Use only disposable local database containers and synthetic credentials/ledger files in tests.
Do not contact PayPal, alter PR #39, expose approval REST endpoints, or merge.
