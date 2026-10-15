# Human approval API implementation plan

Use [the issue contract](../specs/2026-10-15-approval-api.md) on `codex/issue-14-approval-api` in the existing main workspace.
The root owns all writes, staging, commits and final checks.
No task worktree is needed.

## Ordered steps

1. Extend the existing approval service with owner-scoped details/list, a transactional creation hook and a hash-guarded decision path with bounded trusted refresh outside transactions.
   Verify: real PostgreSQL regressions first reproduce missing hash/owner/detail guarantees and zero-side-effect mismatch; existing #12 tests remain unchanged in meaning.
2. Add private owner migration `004` and device authority in `apps/firewall/src/approver/identity.ts`.
   Verify: one-time enrollment, encrypted delivery tokens, JWT constraints, replay/concurrency and generation/config revocation through real PostgreSQL.
3. Add `apps/firewall/src/approver/delivery.ts` for transactional enqueue and a bounded lease-based FCM HTTP v1 worker with Google ADC.
   Verify: mock provider boundaries only; actual SQL queue/failure/restart/generation/expiry assertions and HTTP body/header inspection.
4. Add the separate Nest HTTP server in `apps/firewall/src/approver/server.ts` and explicit composition/export boundary.
   Verify: real HTTP curl registration/list/detail/decision, strict auth/body/owner/hash denial, safe response allowlist and no execution on conflicts.
5. Add a repeatable synthetic fixture/smoke entry point, wire its real DB tests into `scripts/test-audit-postgres.mjs`, and document caller composition and demo limitations in `docs/approval-api.md` with a scoped README link.
   Verify: curl flow needs no live payment/FCM credentials; no default W0 proxy or PR39 files change.
6. Pin direct JOSE and Google auth dependencies and regenerate `pnpm-lock.yaml`; verify frozen install and full project gates.
   Verify: `pnpm install --frozen-lockfile`, `pnpm check`, `trunk check --all --no-fix`, `docker compose --env-file .env.example config --quiet`.
7. Freeze candidate files and run independent authentication/HTTP and state/delivery reviews plus root adversarial verification.
   Verify repairs with observed failures, then scoped conventional commits, push, PR and bounded current-head hosted review/CI.

## Owned paths

- `apps/firewall/src/approvals/index.ts` and narrowly required approval types/helpers.
- New `apps/firewall/src/approver/` modules.
- New `migrations/004-approval-api.sql`.
- `apps/firewall/package.json`, root `package.json` for the focused test command, and `pnpm-lock.yaml`.
- New focused `tests/approval-api*.test.mjs`, existing approval tests only for necessary regressions, and `scripts/test-audit-postgres.mjs` plus the scoped curl fixture.
- `docs/approval-api.md`, this plan and its specification, and a scoped README entry explaining the new demo/auth limits.

Do not edit the open PR39 authentication server files, old migrations, unrelated scaffold prose, production data, private credentials or device state.
No notification or payment is sent to a real provider during this task.
