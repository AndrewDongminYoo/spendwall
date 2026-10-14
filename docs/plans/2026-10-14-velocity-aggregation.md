# Velocity implementation plan

The operator approved #8 implementation and its PR after #11's merge.
Use [the velocity specification](../specs/2026-10-14-velocity-aggregation.md) as the current contract; the prerequisite proposal contains an older discovery snapshot.
Work in the main checkout on `codex/issue-8-velocity-aggregation`.
Do not call PayPal, apply production migrations, change issues, or merge.

## Steps and checks

1. Define the typed audit metadata and deterministic lifecycle fold.
   Own `apps/firewall/src/audit/velocity.ts`, `apps/firewall/src/audit/event.ts`, `apps/firewall/src/velocity/aggregate.ts`, and `tests/velocity.test.mjs`.
   Verify: focused tests first fail on real missing pending/window behavior, then pass after the implementation.
2. Add the owner-only incremental redaction migration and transactional reservation API.
   Own `migrations/002-velocity.sql` and `apps/firewall/src/velocity/index.ts`.
   Verify: real PostgreSQL tests prove unchanged historical hashes, metadata persistence, app permissions, exact retries, and denial on unavailable history.
3. Add concurrency evidence and integrate the disposable test runner.
   Own `tests/velocity-postgres.test.mjs` and the explicit test-file list in `scripts/test-audit-postgres.mjs`.
   Verify: two clients race at an agent limit, two agents race at a customer limit, and identical concurrent retries produce one reservation.
4. Update the audit caller documentation for the extension and current limits.
   Own `docs/audit.md` plus this plan and its specification.
   Verify: explicit-path formatting, frozen install, `pnpm check`, full Trunk and Compose checks.
5. Review the complete change and repair blocking findings with regression evidence.
   Verify: independent reviews calibrated to the final core-area scope, followed by final checks on the candidate.
6. Make scoped conventional commits and publish the approved PR.
   Verify: exact-head CI, actual hosted verdict, fully paginated review threads, clean checkout, and operator merge request.

No new dependency is planned.
Preserve `migrations/001-audit.sql`, the v1 event payload, and unrelated proxy/resolver code.
