# Agent authentication implementation

## Scope and sequence

The root owns changes in the current main workspace on codex/issue-10-agent-auth.
No worktree or dependency is needed.

1. Add failing real MCP tests to tests/refund-proxy.test.mjs for list filtering, direct-call denial, revocation and caller UUID isolation.
2. Implement the minimal typed authentication hook in apps/firewall/src/server.ts and database authority in apps/firewall/src/agent-auth.ts.
3. Add migrations/005-agent-auth.sql and tests/agent-auth-postgres.test.mjs; wire the database test into scripts/test-audit-postgres.mjs.
   Verify hash storage, read-only role, administration and failure paths against disposable PostgreSQL.
4. Add scripts/agent-keys.mjs and scripts/agent-proxy.mjs for explicit private configuration, then document operation in docs/agent-auth.md and link it from docs/proxy.md.
5. Run pnpm check, trunk check --all --no-fix and Compose validation with pinned Node/pnpm.
   Preserve token.ts and existing payment retry semantics; inspect the full diff and run independent core-area reviews.
6. Create scoped semantic commits and PR, observe current-head CI and hosted reviews, then request operator merge.

## Safety and completion

Use only synthetic upstreams and owned disposable PostgreSQL fixtures.
Do not inspect private credential files, change shared configuration, issue trials or deploy.
No post-merge version or release work is scheduled.
