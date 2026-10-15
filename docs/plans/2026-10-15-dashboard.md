# Dashboard implementation plan

## Direction and ownership

The operator authorized selecting the next issue and immediately starting pr-loop.
Advisor selected issue 17; the root owns edits, staging, commits, and final checks in the main workspace.
Oracle found no project-specific dashboard precedent; `wiki/concepts/plan-audit-verify-against-code.md` confirmed checking implementation instead of roadmap markers.
The dashboard package is empty and the firewall has no dashboard read API.

## Sequence

1. Write failing projection and HTTP regressions for the documented read contract.
2. Implement bounded merchant-scoped audit projection and authenticated read-only server under `apps/firewall/src/dashboard/`.
3. Add actual PostgreSQL tests and a disposable live-data preview using existing migrations and services.
4. Implement React/AG Studio report, custom utilization widget, theme, and connection states under `apps/dashboard/`.
5. Add only required frontend dependencies; regenerate `pnpm-lock.yaml` and verify a frozen install.
6. Verify lint, strict types, all tests, frontend production build, Trunk, Compose, and actual browser states.
7. Review authentication/data boundaries and UI integration independently, repair verified findings, then commit and open a PR.
8. Complete hosted reviews and CI; request visual approval and operator merge with screenshots and limits.

## Owned paths

Root owns `apps/firewall/src/dashboard/**`, `apps/dashboard/**`, dashboard test/preview scripts, the database test runner, the workspace manifest/lockfile, dashboard documentation, and this spec/plan.
No existing payment execution or policy semantics change.

## Success checks

1. Data meaning and tenant privacy → projection regressions plus real PostgreSQL/HTTP tests, including a failing negative control.
2. Working UI and custom widget → production build served against a disposable database and named browser-session evidence.
3. Repository compatibility → `pnpm check`, `pnpm --filter @spendwall/dashboard build`, `trunk check --all --no-fix`, and Compose validation.
4. Publication readiness → current-head CI/reviews, zero unresolved threads, and operator visual approval.
