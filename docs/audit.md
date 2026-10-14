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
This one-time migration requires the database-specific group not to exist and creates it with NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, and NOBYPASSRLS.
An existing group always aborts migration, including a memberless group with residual grants or object ownership.
The database owner must review an existing role separately before retrying; the migration does not delete roles or adopt their privileges.
Application membership is granted only after successful migration.
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

## Velocity reservations

The server-side [velocity contract](specs/2026-10-14-velocity-aggregation.md) requires the owner to apply `migrations/002-velocity.sql` after `001-audit.sql`.
The extension preserves the original payment redactor and existing v1 event hashes.
It adds a strict `velocity` object inside `resolved_ctx`; it does not add unhashed columns or rewrite historical rows.
The optional `AuditEvent.velocity` input carries validated server metadata separately from arbitrary arguments and context.
Raw context cannot inject this object through the TypeScript API.

```ts
import { VelocityPolicy } from './velocity/index.ts';

const velocity = new VelocityPolicy(pool, { identityKey: serverIdentityKey });
const result = await velocity.evaluateAndReserve(policy, {
  requestId: serverRequestId,
  context: resolution.context,
  resolvedCtx: resolution.resolvedCtx,
});
```

The request UUID must remain stable across network retries.
Supply the trusted identities and payment facts from the server, and configure a stable unpredictable 32-byte HMAC key as 64 hexadecimal characters.
Never accept these values from agent arguments.
Configure the supplied pool with a bounded connection timeout appropriate for the server.
Missing or malformed key configuration rejects construction with a constant error.
The service replaces caller-supplied `agg` with audit-backed values, serializes reservations by merchant, and commits the decision and reservation together.
An identical binding and policy version returns the original decision and receipt with `replayed: true`; changed bindings deny without another reservation.
This API does not execute payments, and a replay must not authorize another payment execution.

Pending reservations remain charged until a matching denial or confirmed successful execution.
The stored `agent_id` is a domain-separated HMAC label, and `matched_rules` contains canonical `rules.v1` labels packing base-36 rule positions within the immutable policy version.
This supports the context resolver's agent identifiers and arbitrary policy rule names without weakening the audit label contract.
Results and exact retries return the original rule names; invalid, out-of-range, or excessive stored rule references deny.
Lifecycle writers must copy the stored request metadata, audit agent label, and rule references, together with the original arguments, policy version, and approval UUID.
Confirmed execution becomes one accepted contribution at execution time, rather than being added on top of the pending contribution.
Accepted reservations use `(now - window, now]` for the 24-hour USD sum, one-hour agent count, and seven-day customer count.
The customer count spans agents within the same trusted merchant.
Raw merchant/customer IDs and emails are replaced with domain-separated HMAC references.
Key rotation is unsupported; a continuity-tag mismatch fails closed rather than hiding prior usage.
Unscoped legacy allowed/pending refund rows, invalid lifecycle history, missing migration, and a history larger than the 10,000-row safety budget also deny.
The bounded prototype requires a separate operational follow-up before that database history budget is reached.
No approval writer, live payment execution, or proxy wiring is included in #8.

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
CI test step also exercises PostgreSQL. The runner executes audit and velocity files serially against its disposable database.
Direct `node --test` skips the database
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
