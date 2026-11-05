# Hosted demo

The hosted demo serves the read-only audit dashboard over synthetic data for [issue 20](https://github.com/AndrewDongminYoo/spendwall/issues/20).
It is not a payment service: no hosted component holds PayPal or model credentials, and the PayPal sandbox token path is not hosted.
The repository checks create no Render resources, public URL or paid plan.
The existing token manager and separate W0 payment path are unchanged.

## Current artifact

`Dockerfile` installs the pinned Node/pnpm dependency graph and builds the existing dashboard.
The runtime uses a non-root user and starts `scripts/hosted-dashboard.mjs` directly, without a package-manager wrapper.
The build context uses an allowlist; private local configuration, execution ledgers, Git history and host caches are not inputs.
The initial image retains build dependencies for a reproducible baseline; reducing image size is not part of this change.

The hosted entrypoint serves `GET /`, the built `GET /assets/*` files, `GET /audit`, `GET /stats` and `GET /healthz`.
The served directory is fixed in code to `apps/dashboard/dist`; no configuration field selects it.
Policy proposals/replay/export, model queries, reconciliation, MCP, enrollment and approval decisions are unavailable; the page hides the policy workshop and labels the reconciliation panel as not enabled and the audit assistant as not configured.
An injected configuration field cannot enable those routes.
The normal local dashboard entrypoint remains available for local evaluation.

AG Studio's [licence guide](https://www.ag-grid.com/studio/react/enterprise-licence/) requires a deployment licence.
The Docker build reads `VITE_AG_STUDIO_LICENSE_KEY` as a build argument and passes it to the dashboard build ([license key setup](dashboard.md#installing-the-license-key)); Render passes service environment variables to Docker builds as build arguments.
The key is readable in the served bundle by design; without it the image serves the unlicensed evaluation bundle.

## Runtime configuration

Set these values privately, outside Git and image layers:

| Variable                           | Meaning                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SPENDWALL_PUBLIC_ORIGIN`          | Exact HTTPS origin, such as `https://your-service.onrender.com`, with no trailing slash, path, credentials, query or fragment |
| `PORT`                             | Explicit listening port from 1 through 65535; the template uses 10000                                                         |
| `SPENDWALL_DASHBOARD_CONFIG`       | Absolute path to the private JSON configuration; the Render template expects `/etc/secrets/dashboard.json`                    |
| `SPENDWALL_DASHBOARD_DATABASE_URL` | Direct private-network PostgreSQL connection URL for the restricted reader, without query parameters or fragments             |
| `VITE_AG_STUDIO_LICENSE_KEY`       | Build-time AG Studio license key; public once bundled                                                                         |

Private JSON shape:

```json
{
  "identityKey": "<audit identity key: 64 hex characters>",
  "token": "<independent read-only access token: 64 hex characters>",
  "merchantId": "merchantA",
  "agents": [
    { "id": "support", "name": "Support bot", "budgetCents": 20000 },
    { "id": "returns", "name": "Returns bot", "budgetCents": 10000 }
  ],
  "databaseTls": "require"
}
```

Unknown JSON fields are rejected.
Do not supply PayPal credentials, model keys, enrollment tokens, policy reviewer credentials or replay encryption keys to any hosted service.
The dashboard and the synthetic writer read the same file, so the audit identity key always matches; changing it cannot safely reinterpret existing history.
Because the hosted data is synthetic, the read-only `token` may be published for judges; it grants no access beyond this synthetic database.

`databaseTls` selects the database TLS policy:

- `verify-full`, the default, verifies the certificate and host name.
- `require` encrypts without verifying the certificate. It is accepted only for a single-label host name such as Render's private-network host, because Render's internal connections use self-signed certificates and do not support `verify-ca` or `verify-full` ([Render Postgres connections](https://render.com/docs/postgresql-creating-connecting), read on 2026-11-01). It is rejected for dotted names, IP addresses and loopback.
- `disable` is accepted only for a literal loopback database host, for local container verification.

Do not add `sslmode` URL parameters that override the explicit TLS policy.

The server binds `0.0.0.0` only in explicit hosted mode.
The direct Host header must match the configured origin; an Origin header, when present, must match the complete origin.
Render's HTTP health check sends the service's own Render subdomain as the host when no custom domain is verified, so set `SPENDWALL_PUBLIC_ORIGIN` to that origin.
Forwarded headers never establish authority.
`/audit` and `/stats` still require the bearer credential and bounded read-only transactions.
The minimal unauthenticated `/healthz` checks restricted DB authority and access to the required tables, returning only `{"ready":true}` or `{"ready":false}`.
It is not an audit-integrity check or proof of payment-provider availability.
Health and data requests share the concurrency limit.
Only one health probe can run at a time, so unauthenticated probes cannot occupy all four request slots.
An overlapping health probe returns `503` without acquiring another database connection.

## Database provisioning

No migration or seed runs on image startup.
`scripts/hosted-setup.mjs` prepares an empty database once, as its owner, from a repository checkout; it is not in the image.
It applies `001-audit.sql`, `002-velocity.sql`, `003-approvals.sql` and `011-approval-guards.sql`, then `scripts/hosting-reader.sql`, sets the reader password and creates the `spendwall_demo_writer` login as a member of the audit application group.

```sh
SPENDWALL_SETUP_DATABASE_URL='<owner external URL>' \
SPENDWALL_READER_PASSWORD='<new reader password>' \
SPENDWALL_WRITER_PASSWORD='<different writer password>' \
node scripts/hosted-setup.mjs
```

`SPENDWALL_SETUP_DATABASE_TLS` takes the same values as `databaseTls` and defaults to `verify-full`.
Passwords must be at least 24 printable characters and must differ.
The script refuses with exit status 2, changing nothing, when the `audit` or `approvals` schema already exists.
A failure part-way can leave partial state; inspect it rather than dropping roles in a shared database.

The reader receives only schema usage and the specific audit/approval columns used by the projection.
It does not receive sealed approval snapshots, write privileges, sequence authority, role memberships or executable security-definer functions in Spendwall schemas.
Startup and health probes reject elevated roles, owners, role memberships, application write capabilities and read grants outside the required projection columns and relations; they also reject the writer login.
This is a scoped privilege check of Spendwall schemas, not an audit of every function in an arbitrary PostgreSQL installation.
The process also requests read-only transactions by default.

Actual Render role/grant compatibility is verified only by running the setup against the provisioned database; local PostgreSQL results cannot establish managed-provider permissions.
Do not solve a refusal by assigning owner credentials to the runtime.

## Synthetic writer

The dashboard's decision, rule, agent and money-out views cover the last 24 hours, and audit timestamps come from the database clock, so a one-time seed would leave them empty within a day.
`scripts/hosted-writer.mjs` therefore writes one small synthetic batch per run: two allowed refunds, one denied refund and one refund approved and executed by a synthetic executor that never contacts PayPal.
One batch adds seven audit rows.
It connects as `spendwall_demo_writer` through `SPENDWALL_WRITER_DATABASE_URL` and reads the same private JSON file.
It stops writing once the audit table holds 9,000 rows, below the dashboard's 10,000-row limit; at one batch every two hours that is about 107 days.

## Render template and release gate

`render.yaml` defines the dashboard web service, the synthetic writer cron job (every two hours) and PostgreSQL 17, all in Singapore.
The free Render Postgres plan expires 30 days after creation ([Render free plans](https://render.com/docs/free), read on 2026-11-01), which would end before the December 1–15 judging window, so the template uses paid plans.
The compute plans and 1 GB database storage are planning defaults, not a guaranteed bill; confirm the current total in the Render dashboard before applying the Blueprint.
Storage autoscaling and commit-triggered deployments are disabled; PostgreSQL external ingress is closed.
The database URLs intentionally are not automatic owner-credential references.

Release steps, all by the user in the Render dashboard:

1. Apply the Blueprint from the personal Render account after confirming the total estimate. Disabling automatic deploys does not prevent initial resource creation or billing.
2. Add the private JSON as the secret file `dashboard.json` on both the web service and the cron job.
3. Set `VITE_AG_STUDIO_LICENSE_KEY` and `SPENDWALL_PUBLIC_ORIGIN` on the web service.
4. Add your current IP address to the database's external access list, run `scripts/hosted-setup.mjs` from the checkout with the external owner URL as shown above, then remove the address so external ingress is closed again. The services cannot start before this step, so it cannot run from their shells.
5. Set `SPENDWALL_DASHBOARD_DATABASE_URL` to the reader's internal URL and `SPENDWALL_WRITER_DATABASE_URL` to the writer's internal URL, then deploy both services.
6. Trigger the cron job once, open the public URL with the read-only token and confirm the AG Studio watermark is absent.

The hosted demo does not establish webhook, mobile or sandbox-payment readiness.

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
It verifies the served page and bundle, empty/populated reads, authentication, forbidden routes, DB privilege rejection, recovery after idle connection termination, restart and graceful termination.
Its cleanup removes only its own containers and their anonymous volumes.
It neither creates Render services nor calls payment/model providers.
`tests/hosted-writer-postgres.test.mjs` runs the setup and two writer batches against the Postgres test database and reads the result through the restricted reader.
