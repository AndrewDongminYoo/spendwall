# Audit log

The #11 audit boundary is independent of the policy package and current payment
proxy. It records tool calls and approval lifecycle events when its caller invokes
`AuditLog.append`. Synthetic tests cover all decisions and event kinds; policy
and approval execution call sites still need to adopt this interface. No real
payment requests or production migrations are part of this change.

## Local setup

Use the repository's pinned Node and pnpm versions. Install with
`pnpm install --frozen-lockfile`. The owner-only, one-time migration is
`migrations/001-audit.sql`; apply it only to a disposable local database for now:

```sh
docker compose --env-file .env.example up -d --wait postgres
docker compose --env-file .env.example exec -T postgres \
  psql -U spendwall -d spendwall -v ON_ERROR_STOP=1 < migrations/001-audit.sql
```

The migration creates an unprivileged NOLOGIN group named `spendwall_audit_app_` followed by the first 40 hexadecimal characters of the current database name's SHA-256 hash.
[PostgreSQL roles are shared across databases in a cluster](https://www.postgresql.org/docs/17/database-roles.html), so a fixed group name would reuse memberships across deployments.
As the schema owner, run `SELECT audit.app_role()` in the target database to obtain its exact group name, then grant that group only to the corresponding unprivileged application login.
Use distinct application logins for separate deployments and a different trusted schema owner; never run the app with the Compose owner login.
The database name is part of this role assignment; renaming or restoring into a different database requires reviewing and replacing its audit-role grants.
Do not grant the application ownership, superuser, role administration, or membership in privileged roles.
The migration rejects an existing app group with elevated attributes or any inherited role membership.
No login, password or external credential is created by the migration.

The group has SELECT and append-function EXECUTE only. UPDATE, DELETE, INSERT,
TRUNCATE, sequence access and schema creation are revoked. The fixed-search-path
security-definer function serializes writers by locking the independent chain
head before allocating an ID. Append and head update are one transaction.
Failed/rolled-back appends may leave sequence gaps, which are valid.

## Caller interface

```ts
import { Pool } from 'pg';
import { AuditLog } from './audit/index.ts';

const pool = new Pool({ connectionString: process.env.AUDIT_DATABASE_URL });
const audit = new AuditLog(pool);
await audit.append({
  agentId: 'support-agent',
  tool: 'create_refund',
  args: { amount: { value: '5.00', currency_code: 'USD' } },
  resolvedCtx: { amount_minor: 500, status: 'COMPLETED' },
  decision: 'require_approval',
  matchedRules: ['refund-approval'],
  policyVersion: 'a'.repeat(64), // SHA-256 of the evaluated policy
  eventKind: 'tool_call',
  latencyMs: 12,
});
```

Decisions use the policy contract: `allow`, `deny`, `require_approval`.
Kinds are `tool_call`, `approval_created`, `approval_decided`,
`approval_executed`; approval kinds require `approvalId` (UUID). Use a new row
for every lifecycle transition. Approved/denied human outcomes map to allow/deny.
An upstream HTTP status and opaque local result UUID may be supplied; raw
response bodies and URLs must never be supplied. Metadata labels (agent, tool,
rule IDs) must be internal bounded identifiers, never customer text or secrets.

A Pool append commits before returning its receipt. A PoolClient can bind an
append to the caller's transaction; the caller must await its commit before
acting on the result. Audit failures reject with a safe error. Future execution
call sites must handle failures before authorizing a side effect and append a
separate outcome event, including uncertain upstream outcomes. Do not silently
drop a failed audit append or claim the current proxy is integrated.

## Sensitive data and hashes

The module accepts inert JSON, rejects unsupported values/accessors/cycles,
limits depth to 32 and each argument/context document to 64 KiB. `args_hash` is
SHA-256 of the recursively key-sorted original JSON arguments. Original arguments
are never sent to SQL or stored by this module. This is an unkeyed commitment,
not encryption: low-entropy arguments may be guessed from the hash.

Both module and append function retain only an allowlist: validated `amount`
objects with a decimal `value` and a supported `currency`/`currency_code`
(USD/EUR/KRW, matching the demo; KRW has no fractional part), nonnegative safe
integer `amount_minor`, `refunded_minor`, `remaining_minor`, `age_hours`,
`quantity`, and a fixed set of payment statuses. These fields are retained
recursively inside fixed `capture`, `payment`, `refund`, `order`, `invoice`
object containers and object entries of `items` arrays. Arbitrary wrapper names,
scalar array entries, other keys, credentials,
PII, payment identifiers and free text are discarded. A generic `value` field or
an amount without a supported, consistent currency is discarded, so digit-only
OTPs/account IDs cannot be mistaken for amounts. Changing this list is a
schema/contract decision: add matching module and real DB tests together.

`row_hash` is SHA-256 of version 1's UTF-8 JSONB payload from actual row columns,
including UTC timestamp, ID, all metadata and `prev_hash`. Version 1 enumerates
its fixed column list, so adding a column does not invalidate historical hashes.
Genesis is 64 zeros.
The payload function is part of the trusted owner-managed schema. Do not change
existing payload semantics; a future hash format needs an explicit versioned
migration and verifier support.

## Verification

Set `AUDIT_DATABASE_URL` privately to the application/read-only login URL and run:

```sh
pnpm audit:verify
```

The verifier only reads. It uses one repeatable-read snapshot and batches 1,000
rows in numeric ID order, so concurrent appends cannot produce a false mismatch.
It independently recomputes each SHA-256 in Node, checks predecessor links, then
compares the independent stored head. Success prints count and head hash. Failure
prints the first failing ID, one-based position and reason, and exits 1 without
printing rows or credentials. Deletion is diagnosed at the first surviving
broken link, or the head's missing tail ID. A changed last row is detectable.

The unprivileged app cannot modify history. A privileged owner can modify a row
for a synthetic tamper test; full history/head/schema rewriting by that owner
is outside this threat model. Retain the reported head hash independently if
external anchoring is required. This command cannot recover deleted data.

## Disposable PostgreSQL tests

```sh
pnpm test:audit:postgres
```

This command creates a uniquely named `--rm` Postgres 17 container, loopback-only
random port, a test-only database and synthetic data; it removes that container
when finished. It does not reuse the Compose volume or a configured app URL.
Docker must be available; missing Docker fails rather than pretending to pass.
`pnpm test` runs the general suite and this disposable runner, so the existing
CI test step also exercises PostgreSQL. Direct `node --test` skips the database
suite unless a dedicated local `AUDIT_TEST_DATABASE_URL` is provided; the runner
is the normal way to execute it. Do not supply an existing/production database:
the tests drop their audit schema.

The database tests cover decisions and approval kinds, direct-function redaction,
app privilege denial using a separate unprivileged test login, unsafe existing
group rejection, 40 concurrent writers, rollback, pagination under writes,
every hashed column, nested redaction, nullable-column schema evolution,
exact first/middle/tail mutation reports, empty chains,
missing tails and damaged heads. CLI verification is exercised for success and
each mutation location. All events and credentials in these tests are synthetic.
