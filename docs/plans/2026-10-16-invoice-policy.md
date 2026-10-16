# Invoice policy implementation plan

## Ownership and sequence

The root agent owns all implementation, staging and Git operations in the existing main workspace.
No worktree or dependency change is required.

1. Add behavioral tests for the real resolver/policy/database composition and observe intended failures before implementation.
   Own `tests/invoice-policy.test.mjs`, `tests/invoice-policy-postgres.test.mjs` and their explicit fixture helper.
2. Add `apps/firewall/src/invoices/index.ts`, `migrations/008-invoice-policy.sql` and `apps/agent-demo/invoice-policy.yaml`.
   Verify atomic reservation, immutable replay, key continuity and audit binding with disposable PostgreSQL.
3. Extend existing hosted-reader and webhook-receiver permission checks to the new schema and add negative permission fixtures.
4. Add `scripts/invoice-demo.mjs`, include the database suite in `scripts/test-audit-postgres.mjs`, and document usage and boundaries in `docs/invoice-policy.md`, root `README.md` and applicable contributor claims.
5. Run `node scripts/test-audit-postgres.mjs --invoice-policy`, the synthetic demo, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `trunk check --all --no-fix` and `docker compose --env-file .env.example config --quiet`.
   Checks establish local policy behavior and storage correctness, not live provider delivery.
6. Complete two independent read-only reviews for policy/retry integrity and storage/permission security, then root adversarial assessment and scoped repairs.
7. Group semantic commits, push, open the PR and finish hosted review plus current-head CI under the parent PR loop.
   Request operator merge only after those gates pass.
