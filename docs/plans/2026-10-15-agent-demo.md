# Support agent demo implementation

## Authority and scope

The operator requested implementation of issue 13 through `pr-loop`.
Use the main workspace on `codex/issue-13-agent-demo`.
The root owns all edits, staging, commits, and final verification.
No worktree is necessary.

## Steps

1. Add CLI regression tests and observe missing scenario output before implementing the runner.
2. Add four synthetic tickets, payment fixtures, and a demo policy under `apps/agent-demo/`.
3. Connect existing context, policy, velocity, approval, and refund modules behind one SDK MCP server.
4. Add recorded playback through an MCP client and an opt-in Claude query with restricted capabilities.
5. Add disposable database lifecycle and CLI output, including a separate human approval path.
6. Exercise denial, approval separation, replay, and persisted velocity behavior through MCP.
7. Run the project gates, review the candidate adversarially, and repair verified findings.
8. Create scoped semantic commits and a PR, then complete hosted review and CI before requesting operator merge.

## Owned paths

- `apps/agent-demo/**`: implementation, fixtures, manifest, TypeScript configuration, and demo documentation.
- `tests/agent-demo.test.mjs`: behavioral regressions and CLI checks.
- `package.json`, `pnpm-lock.yaml`: command and required SDK dependency graph.
- `README.md`: demo entry point only.
- This plan and the matching spec.

## Verification

1. CLI and MCP behavior → `node --test tests/agent-demo.test.mjs`.
2. Dependency consistency → `pnpm install --frozen-lockfile`.
3. Formatting, types, general tests, and PostgreSQL tests → `pnpm check`.
4. Repository quality → `trunk check --all --no-fix`.
5. Compose structure → `docker compose --env-file .env.example config --quiet`.

Tests inspect decisions and actual synthetic payment writes, not model prose alone.
The demo requires local Docker with `postgres:17-alpine`.
Live Claude invocation is not part of unattended verification and must not silently spend API credits.
