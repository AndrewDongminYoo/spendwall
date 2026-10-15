# Spendwall contributor instructions

## Scope

Spendwall is a payment policy firewall for merchant-support AI agents.
Keep policy decisions deterministic and default to denial when trustworthy payment context is unavailable.
Never put PayPal credentials in the agent or commit real credentials.
The repository contains tested payment-control modules, a synthetic support-agent demo and a local read-only dashboard.
The W0 sandbox proxy is a separate integration without the demo's policy/approval composition; do not describe it as a production payment service.

## Structure

- `packages/policy`: framework-independent TypeScript policy loading and evaluation.
- `apps/firewall`: proxy, context, audit, velocity, approval and dashboard server modules.
- `apps/agent-demo`: synthetic support-agent composition with optional Claude execution.
- `apps/dashboard`: React and AG Studio read-only dashboard.
- `apps/approver`: reserved Flutter app directory outside the pnpm workspace; no platforms generated.
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
