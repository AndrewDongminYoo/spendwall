# Spendwall

A deterministic payment policy firewall between AI agents and PayPal.
The planned merchant-support workflow controls refunds through tool permissions, trusted payment context, spending limits, human approval, and an audit trail.

This repository currently contains the development scaffold for [issue #1](https://github.com/AndrewDongminYoo/spendwall/issues/1).
Payment execution and application interfaces are not implemented yet.
See the [roadmap](https://github.com/AndrewDongminYoo/spendwall/issues/29).

## Prerequisites

- Node.js 24.21.0, as pinned in `.node-version`.
- pnpm 11.24.0, as pinned in `package.json`.
- [Trunk CLI](https://docs.trunk.io/code-quality/get-started/install).
- Docker with Compose v2 for local Postgres.

## Setup

```sh
pnpm install --frozen-lockfile
trunk install
pnpm hooks:install
pnpm check
trunk check --all --no-fix
```

Trunk manages Git hooks and installs the pinned Gitleaks version.
The pre-commit action scans staged changes with redacted output and blocks commits when the scan fails.
The pre-push action runs Trunk checks.
Automatic formatting on commit is disabled.
Hooks are local controls; CI repeats the repository checks independently.

`pnpm lint` checks formatting, `pnpm typecheck` checks each TypeScript package, and `pnpm test` exercises real Git commits in temporary repositories with Trunk hooks installed.
The app entry points are intentionally empty, so type checking does not yet establish application behavior.

## Local database

The Compose file starts only Postgres, bound to `127.0.0.1`.
For a disposable local development database, the committed example provides non-production settings:

```sh
docker compose --env-file .env.example config --quiet
docker compose --env-file .env.example up -d --wait postgres
docker compose --env-file .env.example down
```

The named database volume survives `down`.
Provide a private environment file with your own database password when needed.
Never reuse the example password outside local development.
PayPal credentials are unnecessary for this scaffold and must stay out of Git when integration work begins.

## Repository layout

The [human approval API](docs/approval-api.md) provides device enrollment, short-lived JWTs, owned approval list/detail/decision endpoints and queued FCM data delivery.
Run `pnpm test:approval-api` for the disposable PostgreSQL and actual-curl fixture with synthetic payment and push providers.
Enrollment credentials are provisioned once by the server operator; expired sessions require a new enrollment credential in this demo.
This API is a separate loopback server component and does not add human authorization to the W0 MCP binary.
It has no device attestation, production login or live mobile-delivery verification.

| Path              | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `packages/policy` | Pure TypeScript policy engine, planned for W1          |
| `apps/firewall`   | NestJS firewall, planned                               |
| `apps/agent-demo` | Merchant-support agent, planned                        |
| `apps/dashboard`  | React and AG Studio dashboard, planned                 |
| `apps/approver`   | Future independent Flutter project, excluded from pnpm |
| `scripts`         | Repository tooling                                     |
| `tests`           | Security-hook integration tests                        |
| `docs`            | Specifications, plans, and project notes               |

## License

[MIT](LICENSE).
