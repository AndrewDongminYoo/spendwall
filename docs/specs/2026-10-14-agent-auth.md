# Agent authentication and tool access (#10)

Implement #10 on main `fa96323`, independently of audit/velocity and PR #37.
Node >=24.21.0 <25, pnpm 11.24.0, frozen install, strict types and no new dependencies.
Only code and synthetic loopback tests; no external key provisioning, payment
requests, production migration, deployment or merge.

Agent API keys are high-entropy random values returned once by an issuance API.
The storage boundary receives SHA-256 hashes only. `AgentKeyStore` provides
hash lookup and key insertion; a parameterized PostgreSQL adapter and standalone
schema describe persistence without applying a migration or configuring a DB.
Agents own allowlists and enabled state; individual keys can be revoked.
Every downstream request authenticates independently and snapshots the principal.
Unknown/revoked/disabled keys and lookup failures receive a constant 401.

When an agent store is configured, the old local proxy key cannot authenticate.
For #5 compatibility only, the existing explicit local key remains a single
named agent backed by an in-memory hash, with the reviewed catalog as its
allowlist. This compatibility mode is not a multi-agent deployment.

`tools/list` returns only allowed tools. Direct `tools/call` attempts are checked
before schema validation or dispatch and receive the same error as unknown tools.
The built-in `check_approval` is separately allowlisted, never forwarded to PayPal,
and accepts a UUID. A trusted lookup receives agentId and approvalId; its result
must match both and contain only a known status. Missing lookup, unknown record,
malformed output or foreign ownership fails closed. This does not implement #12
or authorize execution.

Token lifetime, start-time expiry calculation, refresh coalescing and the refund
adapter remain intact. Sensitive results (known credentials/tokens or Authorization
headers) are denied as a whole with constant errors. Logger remains disabled.
Tests exercise real SDK/NestJS against loopback fixtures, log capture, short
token expiry/coalescing and identical refund ID/body across the sole 401 retry.

Local integration may use the immutable `AgentPrincipal` in the request handler
as its trusted agent identity; client metadata is never an identity source.
Policy/context/audit/reservation and approval execution wiring remain separate.
