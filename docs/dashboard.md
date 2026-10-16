# Payment oversight dashboard

## Local evaluation

The dashboard is a separate, read-only loopback server.
It serves the production React/AG Studio build and authenticated `/audit` and `/stats` routes from one origin.
No approval decisions, policy updates, or PayPal requests are available through it.
The optional audit agent uses Claude only to select a supported read-only query.
The separate [hosted preparation entrypoint](hosting.md) exposes only authenticated audit/statistics reads and minimal health, with no frontend assets, model queries or policy workshop.

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

## Audit assistant

The AG Studio Agent Framework runs a custom agent that sends one complete question to the authenticated `POST /query` route.
The server selects one of three deterministic projections from validated merchant history; the model cannot supply SQL, widgets, or payment actions.
Each successful question replaces the single result widget.
Refresh, disconnect, cancellation, and failed queries clear the previous result.

- The weekly refund view includes original tracked attempts strictly above USD 100 from Monday 00:00 UTC through the query snapshot.
- The denial view groups original denials in the last 24 hours by canonical rule position and policy version.
- The support trend samples reservation balances hourly for 24 hours, including older pending amounts, releases, and the 24-hour window after acceptance or successful execution.
  Its reference line is the current configured monitoring budget, not a historical or enforced policy limit.
  Agent ID `support-bot` takes priority; otherwise exactly one configured display name must normalize to `supportbot` after lowercasing and removing spaces and hyphens.
  Missing or ambiguous identity and absent budget return unavailable.

Enable Claude by adding `claude` with `apiKey` and an explicit structured-output-capable `model` to the private server configuration.
Reuse the same credential provisioning approach as the approval summary adapter.
There is no automatic credential lookup or default paid model.
Only the current question and fixed intent descriptions leave the server; audit records and prior conversations are excluded.
Do not enter credentials or customer details in questions.
Each question can make one provider request, without retries, with a ten-second provider deadline and a 16 KiB response limit.
Only one query runs at a time; a query holds no database connection while waiting for the provider.
Bodies are limited to 8 KiB and questions to 2,000 characters, with a five-second body deadline.

The local preview labels its agent as synthetic and recognizes only the three supplied prompt buttons.
It exercises the actual Studio runner, HTTP endpoint, SQL, and widgets without making model calls.
Free-form Claude interpretation and repeatability with a configured live model require separate authorized verification; synthetic results do not establish model accuracy.
Unsupported questions receive no result rather than a guessed answer.
The browser keeps only its current conversation in memory.

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

## Policy workshop (optional)

The workshop generates a policy draft, compares it with the configured base and reevaluates available historical inputs.
It does not apply policies or execute payments.
The final action downloads a validated YAML draft only after explicit human confirmation; activation remains a separate operator action.
A changed base version invalidates the draft and requires reloading and review.
Schema and CEL validation cannot establish that a generated policy matches the operator's intent.

Add `policyPreview` to the private dashboard configuration:

```json
{
  "policyPreview": {
    "databaseUrl": "postgresql://replay-reader@localhost/spendwall",
    "encryptionKey": "<independent 64-hex key from private configuration>",
    "accessToken": "<separate 64-hex policy reviewer credential>",
    "policyPath": "/absolute/current-policy.yaml",
    "claude": {
      "apiKey": "<private provider key>",
      "model": "<explicit model supporting structured output>"
    }
  }
}
```

This is an optional section alongside the existing dashboard fields.
Every policy route requires the existing dashboard bearer plus the independent `policyPreview.accessToken` in `x-spendwall-policy-token`, before any policy, model or history work.
Give the reviewer credential only to operators authorized to infer sensitive retained input: arbitrary CEL predicates and exact counts can reveal attributes, even though plaintext is not returned.
The ordinary dashboard token cannot access proposals, replay or export by itself.
The UI keeps the reviewer token only in component memory and clears it on lock, dashboard refresh or disconnect.
It does not replace the audit-query Claude configuration.
The generator follows the [Claude structured-output contract](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
Enabling it sends the operator instruction and current policy to Anthropic and can incur charges.
Decrypted replay inputs are never model inputs.
The model has no tools, redirects or automatic retries; only validated output can become a draft.
One provider operation may run at a time, including an abandoned operation that has not settled.
Generation is bounded to ten seconds and 4,096 output tokens.
Proposals must fit 64 KiB and 2,000 lines; the comparison preserves the common prefix/suffix and marks the replacement region.

The replay reader must connect to the same live PostgreSQL database as the dashboard.
Before listening, startup verifies separate pools through a transaction-scoped advisory-lock challenge; a separate database, clone, inaccessible connection or failed check prevents startup.
All history queries use explicit schema names.

### Encrypted replay and retention

As the trusted owner, apply `migrations/006-policy-replay.sql` after `001` and `002`.
Grant `policy_replay.reader_role()` to a separate runtime login for `policyPreview.databaseUrl`.
This role can read replay ciphertext and audit rows and call the narrowly scoped expired-payload purge function.
It cannot insert or update replay payloads, delete unexpired payloads, modify audit history or execute payments.
The existing audit application role receives only the additional replay insert columns and expired-payload purge capability.

Trusted evaluation composition must explicitly supply a recorder:

```ts
import { PolicyReplay } from './apps/firewall/src/policy-preview/replay.ts';

const replay = new PolicyReplay(independentReplayKey);
const velocity = new VelocityPolicy(pool, { identityKey, replay });
// ApprovalService also accepts the same optional replay instance.
```

The default W0 proxy and existing service constructors remain unchanged unless this option is supplied.
Use the same replay key in the recorder and preview reader, independently of the identity key, dashboard token and provider credentials.
The store encrypts the complete policy-visible input and original policy using AES-256-GCM with a random nonce and audit-row/merchant binding.
This is additional sensitive retention beyond the redacted audit log, explicitly approved for this feature.
Only initial evaluations are captured, in the same transaction as the audit event; request retries do not add snapshots.
When enabled recording fails, the evaluation fails closed and rolls back the audit transaction.
No historical backfill is attempted.

Replay access expires after seven days.
The dashboard launcher purges expired payloads at startup and every minute while running; recording also purges expired payloads in its transaction.
Each call deletes at most 1,000 expired rows through an expiry index and skips rows locked by another cleanup.
The worker commits each batch separately.
The worker is owned by that launcher and stops with it; no machine scheduler is installed.
Physical deletion can lag by the worker interval, an expired-record backlog or process downtime, and resumes when the launcher or recorder next runs.
Audit events remain append-only and are not deleted by this retention worker.
Database backups, key rotation and deployment-wide lifecycle management remain operator responsibilities.
Changing or losing the replay key makes old ciphertext unavailable; never replace missing historical inputs with guesses.

### Reading coverage

The seven-day preview uses original tool calls and their exact recorded inputs and aggregates.
It is not a simulation of changed historical payment sequences or a prediction of future spending.
Original policy version and decision are checked before the candidate is evaluated.
Counts distinguish changed, unchanged and unavailable calls, with partial coverage whenever a scoped call lacks a valid snapshot.
Old rows without snapshots, expired data and failed authentication of ciphertext are unavailable, not unchanged.
Unscoped identity history, malformed scoped history, a continuity-key mismatch, database failure or more than 10,000 recent merchant calls or 8 MiB of merchant ciphertext makes the preview unavailable.
Valid foreign-merchant records do not consume the merchant replay budget.
Only safe counts, versions and the snapshot time are returned to the browser; no decrypted payment context is returned.

`pnpm dashboard:preview` supplies synthetic policy output and an owned disposable database, including one legacy call without a replay snapshot.
No model, payment or license request is made by that preview.
Use an instruction containing `invalid` to exercise rejected synthetic output.
The desktop and narrow layouts show the same confirmation and coverage boundaries.
