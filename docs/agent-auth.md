# Agent keys and tool isolation

## Scope

The agent-authenticated entrypoint adds database-backed identity and exact tool grants to the loopback W0 sandbox proxy.
It does not wire in policy evaluation, trusted payment context, velocity or human approval.
Granting a payment tool permits that sandbox operation; a tool allowlist is not a payment policy.
Do not publish this entrypoint as a production payment firewall.
The existing `pnpm proxy` remains the legacy shared-key W0 path and does not provide agent isolation.
There is no fallback from database authentication to that shared key.

The token manager and upstream credential handling are unchanged.
No AG Studio trial, live payment, deployment or mobile setup is required for the synthetic tests.
The composed demo already has a bound approval-status tool; this W0 entrypoint does not expose `check_approval` or an unscoped approval lookup.

## Database and trusted administration

Apply `migrations/005-agent-auth.sql` once to the intended database as its trusted owner.
This migration is independent of the audit and approval schemas.
It creates the `agent_auth` schema and a database-specific NOLOGIN reader role, whose name the owner can obtain with `SELECT agent_auth.reader_role()`.
Grant that role to a separate restricted login for the proxy.
Do not run the proxy using the schema owner or a login with additional write privileges.
The reader can query credential digests but cannot insert, update or delete credentials.

Credential records contain a key ID, merchant ID, agent ID, SHA-256 key digest, exact tool names and creation/revocation times.
Keys contain 32 cryptographically random bytes; they are not user-selected passwords, so a password KDF is not used.
Raw keys are returned only at issuance and never sent to the database.
Merchant and agent identifiers use 1–128 ASCII letters, digits, underscores or hyphens.
Treat the configured merchant identity as an operator-provisioned boundary, not proof of PayPal account ownership.
Use a separate credential database/reader login when stronger isolation between operators is required.

Create a private JSON configuration outside the repository containing the owner connection, merchant, agent and exact tools from the reviewed catalog:

```json
{
  "databaseUrl": "postgresql://trusted-owner@localhost/spendwall",
  "merchantId": "merchantA",
  "agentId": "support-bot",
  "tools": ["get_order"]
}
```

Use an existing secure credential mechanism for database authentication; the example omits its password.
Keep configuration files private.
Run from the repository root:

```sh
node scripts/agent-keys.mjs issue --config /absolute/private-issuer.json --output /absolute/new-agent-key.json
```

The output file is created exclusively with mode `0600` and contains `id` and `key`.
It will not overwrite an existing file and does not print the key.
Provide the key to its agent through a private channel outside this workflow; send it as the MCP `Authorization: Bearer` value.
No public issuance endpoint or secret delivery service is included.
If issuance is interrupted, inspect the exact output file and recent database rows before retrying.
A crash after database insertion can leave an active credential whose delivery is uncertain; revoke that key ID rather than assuming retry is safe.

To revoke, use an owner configuration with `databaseUrl`, `merchantId` and `keyId`:

```sh
node scripts/agent-keys.mjs revoke --config /absolute/private-revocation.json
```

A missing or foreign-merchant key ID fails; repeated revocation of the same owned key succeeds.
Rotation means issuing a new key for the same merchant/agent and then revoking the previous key by ID.
For a grant change, the trusted owner can update the exact row's `tools`, or issue a replacement and revoke the previous key.
No authentication cache is used.
An empty grant is valid and exposes no tools; unknown names grant no additional tools.
Keys do not expire automatically in this baseline; the owner must revoke them when no longer needed.

## Start the authenticated proxy

Create a separate private runtime configuration using the restricted database login:

```json
{
  "databaseUrl": "postgresql://agent-reader@localhost/spendwall",
  "merchantId": "merchantA",
  "ledgerPath": "/absolute/private/agent-refunds.json",
  "transport": "sse",
  "port": 3001
}
```

Configure PayPal sandbox credentials in the server process as described in [proxy setup](proxy.md).
The example selects SSE explicitly based on the historical W0 evidence; verify current connectivity separately.

```sh
node scripts/agent-proxy.mjs --config /absolute/private-agent-proxy.json
```

The launcher verifies database read access before starting the upstream connection, and applies bounded database connection, statement and query timeouts.
It binds only to loopback and closes its own server and pool on Ctrl+C.
Using `startProxy` directly requires supplying `agentAuth`; custom database pools must also configure timeouts.
A failed database lookup denies the request without disclosing the database error or using the shared key.
Each request authenticates before reading its body and the tool handler rechecks current grants before dispatch.
Revocation affects subsequent authorization checks; it cannot cancel an already dispatched upstream operation.

`tools/list` returns only catalog entries named in the authenticated grant.
`tools/call` checks the same grant before argument validation or upstream/refund work.
Caller metadata cannot choose the authenticated merchant or agent.
A raw SQL-capable database owner and a compromised server remain trusted-boundary exclusions.

## Refund identity and migration caution

Authenticated mode derives a stable UUID from the merchant, agent and caller's original execution UUID.
This derived UUID is used only in the private ledger and as `PayPal-Request-Id`.
The response retains the original caller execution UUID, so retrying that receipt keeps the same operation.
Rotation for the same merchant/agent preserves that mapping; another agent gets a separate namespace.

Legacy W0 execution IDs are not namespaced.
Do not replay an existing legacy payment in authenticated mode, switch the same outstanding operation between modes, or change merchant/agent identity during recovery: that would create a different provider idempotency key.
Keep separate ledger paths and preserve both until all uncertain outcomes are reconciled.
Tool isolation does not prevent two authorized agents from intentionally refunding the same capture under different operations.

## Verification

`tests/refund-proxy.test.mjs` uses real local MCP/HTTP clients and synthetic PayPal responses to inspect visible tools, direct-call rejection, body-time revocation and refund request counts/IDs.
`tests/agent-auth-postgres.test.mjs` reads real database rows and role permissions, exercises key CLI issuance/revocation, and verifies unavailable or malformed credentials cannot yield a principal.

```sh
node --test tests/refund-proxy.test.mjs
node scripts/test-audit-postgres.mjs
pnpm check
```

The database suite requires local Docker and uses only its own disposable database.
Synthetic results do not prove live PayPal availability or public-deployment readiness.
