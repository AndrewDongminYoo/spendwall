# Hosting preparation

This is a partial delivery of [issue 20](https://github.com/AndrewDongminYoo/spendwall/issues/20), not a deployed service.
No Render resources, public URL, paid plan, trial licence or 48-hour observation are created by the repository checks.
The existing token manager and separate W0 payment path are unchanged.

## Current artifact

`Dockerfile` installs the pinned Node/pnpm dependency graph and builds the existing dashboard.
The runtime uses a non-root user and starts `scripts/hosted-dashboard.mjs` directly, without a package-manager wrapper.
The build context uses an allowlist; private local configuration, execution ledgers, Git history and host caches are not inputs.
The initial image retains build dependencies for a reproducible baseline; reducing image size is not part of this change.

The hosted entrypoint is deliberately API-only: `GET /audit`, `GET /stats` and `GET /healthz`.
It does not serve the bundled AG Studio files, even when a client requests their known filenames.
Policy proposals/replay/export, model queries, MCP, enrollment and approval decisions are unavailable.
An injected configuration field cannot enable those routes.
The normal local dashboard entrypoint remains available for local evaluation.

AG Studio's [licence guide](https://www.ag-grid.com/studio/react/enterprise-licence/) requires a deployment licence.
Trial issuance remains deferred.
Serving the frontend later requires confirmed licence coverage, licence integration and a separately approved public release; this entrypoint has no flag that silently enables it.

## Runtime configuration

Set these values privately, outside Git and image layers:

| Variable                           | Meaning                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SPENDWALL_PUBLIC_ORIGIN`          | Exact HTTPS origin, such as `https://your-service.onrender.com`, with no trailing slash, path, credentials, query or fragment |
| `PORT`                             | Explicit listening port from 1 through 65535; the template uses 10000                                                         |
| `SPENDWALL_DASHBOARD_CONFIG`       | Absolute path to the private JSON configuration; the Render template expects `/etc/secrets/dashboard.json`                    |
| `SPENDWALL_DASHBOARD_DATABASE_URL` | Direct private-network PostgreSQL connection URL for the restricted reader, without query parameters or fragments             |

Private JSON shape:

```json
{
  "identityKey": "<existing audit identity key: 64 hex characters>",
  "token": "<independent read-only access token: 64 hex characters>",
  "merchantId": "merchantA",
  "agents": [{ "id": "support", "name": "Support bot" }],
  "databaseTls": "verify-full"
}
```

Unknown JSON fields are rejected.
Do not supply PayPal credentials, model keys, enrollment tokens, policy reviewer credentials or replay encryption keys to this service.
The audit identity key must match the writer's identity key; changing it cannot safely reinterpret existing history.
TLS verifies the database certificate by default.
`databaseTls: "disable"` is accepted only for a literal loopback database host, for local container verification; it is rejected for provider/private-network hostnames.
Do not add `sslmode` URL parameters that override the explicit TLS policy.

The server binds `0.0.0.0` only in explicit hosted mode.
The direct Host header must match the configured origin; an Origin header, when present, must match the complete origin.
Forwarded headers never establish authority.
`/audit` and `/stats` still require the existing bearer credential and bounded read-only transactions.
The minimal unauthenticated `/healthz` checks restricted DB authority and access to the required tables, returning only `{"ready":true}` or `{"ready":false}`.
It is not an audit-integrity check or proof of payment-provider availability.
Health and data requests share the concurrency limit.

## Database provisioning

No migration or seed runs on image startup.
As a trusted migration owner, apply the existing migrations in their documented order to an explicitly selected database.
The dashboard requires `001-audit.sql`, `002-velocity.sql` and `003-approvals.sql`; other services retain their own additional requirements.
Then apply `scripts/hosting-reader.sql` once and set that login's unique password through the provider's private administration path.
The script fails if its fixed reader role already exists; inspect ownership before reuse rather than dropping a role or resetting a shared database.

The reader receives only schema usage and the specific audit/approval columns used by the projection.
It does not receive sealed approval snapshots, write privileges, sequence authority, role memberships or executable security-definer functions in Spendwall schemas.
Startup and health probes reject elevated roles, owners, role memberships and application write capabilities.
This is a scoped privilege check of Spendwall schemas, not an audit of every function in an arbitrary PostgreSQL installation.
The process also requests read-only transactions by default.

Actual Render role/grant compatibility is not yet verified.
Before any live deployment, verify the existing migration and privilege boundary with the real provider owner; do not solve a refusal by assigning owner credentials to the runtime.
Local PostgreSQL results cannot establish managed-provider permissions or TLS compatibility.

## Render template and release gate

`render.yaml` proposes one Docker web service and PostgreSQL 17 in Singapore.
The compute plans and 1 GB database storage are planning defaults, not purchased capacity or a guaranteed bill.
Storage autoscaling and commit-triggered deployments are disabled; PostgreSQL external ingress is closed.
The database URL intentionally is not an automatic owner-credential reference.
Add the restricted reader URL and private JSON secret file manually after approved provisioning.
Secret-file provisioning is not represented as a fake Blueprint field.

Do not sync this template yet.
Disabling automatic deploys does not prevent initial resource creation or billing when a Blueprint is applied.
Before release, approve the personal Render account, region, exact services, current total estimate and rollback plan.
Read the current [Blueprint reference](https://render.com/docs/blueprint-spec), [plans](https://render.com/docs/compute-plans) and [pricing](https://render.com/pricing); these were inspected on 2026-10-16.

The full issue still requires licensed public frontend access, an integrated sandbox firewall/approval composition with durable refund state, and observed 48-hour unattended upstream/token operation.
The API-only artifact does not establish webhook, mobile or sandbox-payment readiness.

## Local verification

```sh
pnpm check
docker build -t spendwall-hosting:local .
node scripts/hosting-smoke.mjs spendwall-hosting:local
trunk check --all --no-fix
docker compose --env-file .env.example config --quiet
```

The smoke runner requires a local Docker daemon and an already-built image.
It uses owned disposable PostgreSQL and application containers, synthetic data and loopback ports.
It verifies empty/populated reads, authentication, forbidden routes, DB privilege rejection, recovery after idle connection termination, restart and graceful termination.
Its cleanup removes only its own containers and their anonymous volumes.
It neither creates Render services nor calls payment/model providers.
