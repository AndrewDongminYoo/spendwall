# Webhook reconciliation implementation plan

## Approved direction

Continue issue #19 through the requested PR loop on `codex/issue-19-webhook-reconciliation` in the main Spendwall workspace.
The [specification](../specs/2026-10-16-webhook-reconciliation.md) defines the bounded local sandbox baseline.
No new dependency or mobile platform change is needed.

## Steps and ownership

The root agent owns all edits, staging, commits and verification.
Independent reviewers remain read-only.

1. Add failing provider and HTTP contract tests in `tests/webhooks.test.mjs` and a minimal implementation surface under `apps/firewall/src/webhooks/`.
   Verify signature failures, provider errors, merchant binding, body/header limits and fixed network destinations with injected fetch responses and real loopback requests.
2. Add `migrations/007-reconciliation.sql`, reconciliation modules and `tests/reconciliation-postgres.test.mjs`.
   Verify persistence, concurrent duplicate delivery, changed replay rejection, role isolation and late receipt matching against disposable PostgreSQL.
   Register the suite in `scripts/test-audit-postgres.mjs`.
3. Wire opt-in completed receipt recording in `apps/firewall/src/approvals/index.ts` and `apps/firewall/src/approver/server.ts`.
   Enable it in the synthetic demo with its migration and direct-allow completion receipt.
   Verify both execution paths and the existing approval/demo regressions.
4. Add a private-config loopback receiver runner and opt-in reconciliation reads to the local dashboard runner/server.
   Keep hosted API permissions and surface unchanged; extend its privilege check to reject access to the new schema.
5. Add the dashboard reconciliation panel, fixture and preview states.
   Inspect desktop and narrow layouts with the installed isolated browser and preserve screenshots for operator approval.
6. Update affected README, AGENTS and operational documentation in this PR.
   Explain opt-in configuration, roles, migration order, coverage and external acceptance gaps.
7. Run the declared gates, then parallel bounded security/data-integrity review plus an adversarial cross-check appropriate to this core-area change.
   Repair confirmed findings within the two-round local budget.
8. Create concern-based commits, push, open the PR and complete current-head hosted review and CI within the recorded budget.
   Request visual approval and operator merge with visible evidence.

## Verification

```sh
node --test tests/webhooks.test.mjs
pnpm test:audit:postgres
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @spendwall/dashboard build
trunk check --all --no-fix
docker compose --env-file .env.example config --quiet
```

The provider tests inspect outgoing requests and persisted effects, not real PayPal behavior.
PostgreSQL tests inspect actual uniqueness, transactional and privilege behavior.
Browser checks inspect rendered states from fixtures that contain the triggering observations and receipts.
Live PayPal delivery, public deployment and real direct-dashboard refunds remain unverified.
