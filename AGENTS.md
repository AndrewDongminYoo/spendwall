# Spendwall contributor instructions

## Scope

Spendwall is a payment policy firewall for merchant-support AI agents.
Keep policy decisions deterministic and default to denial when trustworthy payment context is unavailable.
Never put PayPal credentials in the agent or commit real credentials.
The repository contains tested payment-control modules, a synthetic support-agent demo and a local read-only dashboard.
The human-approval recording uses synthetic payments by default; its `--paypal-sandbox` flag opts into one real PayPal sandbox refund per approval and has no live PayPal path.
The W0 sandbox proxy is a separate integration without the demo's policy/approval composition; do not describe it as a production payment service.
The hosted dashboard preparation entrypoint is API-only; public UI licensing, deployment and 48-hour operation remain unverified.
The optional loopback sandbox webhook receiver verifies observed refunds and compares them with opt-in execution receipts; one live delivery of a direct-dashboard sandbox refund was observed through a temporary ingress on 2026-10-27, and hosted ingress remains unverified.
The invoice policy module reserves allowed send attempts atomically; its synthetic console example does not create or send provider invoices.
The dispute policy module returns review-only approval requirements and deadline data; it does not create approval records, accept claims or send notifications.
The dispute tracker re-reads disputes from verified webhook events and records deadline alerts only through a required trusted customer lookup that no code in this repository implements; it never accepts a claim.
The order module recomputes `create_order` totals, records approve links in a PostgreSQL ledger and captures only after the provider reports buyer approval; the shopping demo's catalog and payments are synthetic.

## Structure

- `packages/policy`: framework-independent TypeScript policy loading and evaluation.
- `apps/firewall`: proxy, context, audit, velocity, approval, webhook reconciliation, invoice/dispute policy and dashboard server modules.
- `apps/agent-demo`: synthetic support-agent composition with optional Claude execution.
- `apps/dashboard`: React and AG Studio read-only dashboard.
- `apps/approver`: independent iOS/Android Flutter approval app outside the pnpm workspace; use its pinned SDK and app-local checks.
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

For `apps/approver`, also run its documented Flutter analyze, format and test checks.
Native builds and synthetic UI checks do not replace physical-device push, biometric and sandbox acceptance.

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
