# Approval summary implementation

## Authority and ownership

The operator requested selection and immediate implementation through pr-loop.
Issue 16 is the selected bounded task; the root owns all edits and Git mutations in the main workspace.
No worktree or dependency is required.

## Steps and checks

1. Add an authenticated HTTP regression that expects an advisory summary and observe the current 404 failure.
2. Add bounded summary generation and a Claude Messages adapter under `apps/firewall/src/approver/`; use synthetic provider responses to test strict output, timeout, isolation, and cost limits.
3. Add the optional summary route without changing policy, sealed approval data, or decision schemas.
4. Test a held model request concurrently with a successful human decision, and reject cross-owner requests before generating.
5. Document server composition and verification limits in `docs/approval-api.md`.
6. Run `pnpm check`, `trunk check --all --no-fix`, and Compose validation; review the candidate adversarially before commits and PR.
7. Complete current-head hosted code/security review and CI, then request operator merge.

## Owned paths

- `apps/firewall/src/approver/summary.ts`, `claude-summary.ts`, and `server.ts`.
- `tests/approval-summary.test.mjs` and `tests/approval-api-postgres.test.mjs`.
- `docs/approval-api.md`, this plan, and the matching spec.

## Success criteria

1. Summary isolation and failure handling → focused unit tests exercise actual prompt/body parsing and cancellation.
2. Approval authority and nonblocking behavior → `pnpm test:approval-api` exercises HTTP, PostgreSQL, and the synthetic refund executor.
3. Repository compatibility → `pnpm check` plus Trunk and Compose validation.

No live model call is authorized or needed for unattended checks.
Synthetic output tests do not establish universal injection resistance or live model quality.
