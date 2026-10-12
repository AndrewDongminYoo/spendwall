# Spendwall contributor instructions

## Scope

Spendwall is a payment policy firewall for merchant-support AI agents.
Keep policy decisions deterministic and default to denial when trustworthy payment context is unavailable.
Never put PayPal credentials in the agent or commit real credentials.
The current repository contains a scaffold, not a working payment service.

## Structure

- `packages/policy`: framework-independent TypeScript policy code.
- `apps/firewall`: future NestJS integration boundary.
- `apps/agent-demo`: future Claude Agent SDK demo.
- `apps/dashboard`: future React dashboard.
- `apps/approver`: separate Flutter project outside the pnpm workspace.
- `docs/specs`, `docs/plans`, and `docs/notes`: durable project documentation.

## Checks

Use the Node and pnpm versions pinned in `.node-version` and `package.json`.
After dependency changes, regenerate `pnpm-lock.yaml` with pnpm and verify a frozen install.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
trunk check --all --no-fix
docker compose --env-file .env.example config --quiet
```

Trunk manages pre-commit secret scanning and the pre-push quality check.
Install hooks with `pnpm hooks:install`.
Do not bypass hooks or add a second hook manager.
Run formatters only against explicit changed paths and review the resulting diff.
Prefer Node's built-in test runner until the implementation needs more.

## Change discipline

Keep changes within the selected issue and preserve unrelated work.
Keep TypeScript strict and avoid speculative abstractions or dependencies.
Do not initialize mobile platforms or contact payment APIs for a scaffold-only task.
Money-moving code needs tests for denial, retries, concurrency, and approval binding when those features are introduced.
