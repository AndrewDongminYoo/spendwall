# Payment oversight dashboard

## Local evaluation

The dashboard is a separate, read-only loopback server.
It serves the production React/AG Studio build and authenticated `/audit` and `/stats` routes from one origin.
No approval decisions, policy updates, AI requests, or PayPal requests are available through it.

Use the pinned Node and pnpm versions, then build and start an isolated preview:

```sh
pnpm install --frozen-lockfile
pnpm --filter @spendwall/dashboard build
pnpm dashboard:preview
```

The preview prints its local URL and a disposable test token.
Enter that token in the connection form.
It creates a uniquely named PostgreSQL container and populates it through the existing velocity and approval services with a synthetic executor.
The UI reads real SQL/HTTP results, but the payment outcomes are test data.
Ctrl+C closes the server and removes only that preview container.
`pnpm dashboard:preview --empty` exercises the empty state.
If the process is forcibly killed, inspect and remove its exact printed container separately.

## Existing firewall database

Apply the existing audit, velocity, and approval migrations through the established owner workflow first.
Use the matching identity key and merchant ID; a different identity key is not a new empty merchant.
Create a private JSON configuration outside the repository or in its ignored `.spendwall/` directory.
The configuration accepts `databaseUrl`, `identityKey`, `merchantId`, `token`, optional `port`, and optional `agents` entries with `id`, `name`, and `budgetCents`.
Use a dedicated random 32-byte hex dashboard token, different from the identity key and all agent credentials.
Do not put either key in browser build variables or commit the configuration.
Restrict the configuration's filesystem permissions.
The server reads only the explicitly named configuration, not a default `.env` file.

```sh
pnpm dashboard --config /absolute/private-dashboard.json
```

The connection pool is bounded to four clients with a connection timeout.
Reads use a repeatable read-only transaction and a five-second SQL timeout.
The caller's database role needs SELECT on the existing audit and approval tables; the server performs no application writes.
Use a dedicated SELECT-only role for deployment rather than expanding the existing application role's rights.
The local bearer token gives read access to the entire configured merchant, not just one agent.
There is no browser token persistence, anonymous data mode, or cross-origin access.
This prototype is not a public hosting configuration.

## Reading the report

- Confirmed refunds count only succeeded approval executions with matching audit lifecycle evidence.
  A tool call marked allow is a reservation, not proof of settlement.
- Decisions and denial rates count original tracked refund requests in the last 24 hours, not their repeated lifecycle events.
- Reservation utilization follows the existing velocity calculation and includes older pending reservations.
  The optional agent budget is a monitoring reference set in configuration, not an inferred or enforced CEL limit.
- Pending approvals exclude expired and processed requests without mutating their state.
- Rule references retain their policy version and positional encoding.
  Compact references are split into individual positions before counting matches on denied requests.
  Counts can overlap when one request matches multiple rules.
  A matched rule is not necessarily the sole cause of denial; entries without references use the neutral `unreferenced-denial` label.
  Historical names cannot be recovered safely from a different policy.
- Coverage includes refund events with the existing merchant-bound velocity metadata.
  Unscoped legacy events and unsupported tools are not presented as complete payment history.

An overflowing 10,000-row merchant history, more than 100 agents, malformed lifecycle data, missing schema, or database error returns unavailable rather than a partial success.
Each API request reads its own consistent snapshot; the two endpoints are not an atomic pair.
Refresh clears the previous displayed data before loading and clears it on failure.
The page shows the stats snapshot time.

## AG Studio and licenses

The integration follows the provider/data/report/theme boundaries of the [PayPal boilerplate at 5de114e](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate/tree/5de114eb4306e844396022f9ca0558a4937761e2) and the official [custom widget API](https://www.ag-grid.com/studio/react/custom-widgets/).
The reservation visualization is registered as an actual Studio custom widget and uses native HTML progress elements.
Shell and Studio theme share CSS tokens.
No standalone enterprise grid or chart is embedded in the custom widget.

AG Studio permits [local evaluation without a license](https://www.ag-grid.com/studio/react/installation/); console/license warnings and watermarks are expected in this mode.
Every deployment requires a license under the [enterprise license guidance](https://www.ag-grid.com/studio/react/enterprise-licence/).
No trial has been requested or key installed for this change.
The operator raised the timing concern: a 45-day trial issued on October 15 would end before the issue's December 1–15 judging window.
Defer issuance until November 1 or later, then verify the actual issued expiration covers the full judging window before deployment.
This timing is a planning calculation, not a provider guarantee.
License acquisition and public deployment are not part of the local evaluation evidence.

## Verification

```sh
pnpm check
pnpm --filter @spendwall/dashboard build
trunk check --all --no-fix
docker compose --env-file .env.example config --quiet
```

`tests/dashboard.test.mjs` covers projection meaning, failure limits, and pre-database authentication.
`tests/dashboard-postgres.test.mjs` covers actual SQL, lifecycle writes from existing services, merchant separation, HTTP, and unchanged audit data.
Browser verification must include populated/empty snapshots, invalid credentials, refresh failure, narrow layout, and the actual custom widget fill.
Operator approval of the rendered candidate remains required before merge.
