# Agent authentication

`startProxy({ agentKeys, approvalLookup })` accepts trusted server-side storage
dependencies. Each downstream HTTP request authenticates its Bearer key by
SHA-256 hash, verifies enabled/revoked state, and freezes a fresh `AgentPrincipal`
containing only `agentId` and `allowedTools`. Lookup failures and malformed rows
return a constant 401; lookups have a five-second deadline. No key/decision cache
delays revocation or allowlist changes between requests.

`tools/list` returns only the agent's reviewed tools. The same allowlist is
checked before validation/dispatch for `tools/call`; a guessed forbidden name
gets the same error as an unknown name and cannot reach MCP or refund execution.
Client metadata cannot select an agent identity.

## Hash-only persistence

`issueAgentKey(store, agentId)` generates 256 random bits and returns the raw key
only after its hash is inserted. It returns no key when insertion fails. Raw
keys must be privately delivered once by a future administrator workflow; this
change does not expose an issuance HTTP endpoint or provision credentials.

`SqlAgentKeyStore` consumes a database port compatible with a server-managed
query client:

```ts
import { SqlAgentKeyStore } from '../apps/firewall/src/agent-key-store.ts';
import { startProxy } from '../apps/firewall/src/server.ts';

const agentKeys = new SqlAgentKeyStore(database);
const proxy = await startProxy({ agentKeys, approvalLookup });
```

All queries use positional parameters. The standalone owner-reviewed schema is
`apps/firewall/src/agent-auth-schema.sql`: agent IDs/allowlists/enabled state live
in `agent_auth.agents`; keys store only a hash, agent foreign key and revocation
flag. The application needs SELECT only for authentication; grant INSERT only
to a separate issuance service. Keep agent/allowlist/revocation administration
and DDL in a trusted administrator role. No existing audit schema is changed.
No DB connection or schema application is performed by `startProxy` or this PR.
The adapter is verified with synthetic query-port tests; real PostgreSQL schema
execution, role grants and provisioning are not verified here.

If no `agentKeys` is supplied, #5's existing explicit `proxyKey` or
`SPENDWALL_PROXY_KEY` supplies a single `local-proxy` identity backed by an
in-memory hash and the reviewed upstream catalog allowlist. The built-in
approval tool is hidden in this compatibility mode. The current CLI/smoke scripts
remain in that single-agent mode and do not configure a database. Once an agent
store is supplied, the local proxy key cannot bypass it.

## Approval lookup boundary

`check_approval` is a firewall-local tool requiring an explicit allowlist entry.
It accepts `{ approval_id: UUID }` and never forwards a request to PayPal.
The injected `ApprovalLookup` receives `{ agentId, approvalId }`. It must look up
ownership using this authenticated agent, and return the same IDs plus one of
`pending`, `approved`, `denied`, or `expired`. The firewall independently checks
those IDs, strips other fields and returns only approval ID/status. Missing
lookup, unknown/foreign/malformed records, exceptions or a five-second timeout
produce the same safe error. `approved` is informational, not permission to
execute. #12 persistence/state transitions and execution binding remain separate.

## Local integration contract

The immutable principal captured in `server.ts` is the trusted identity for
future resolver/policy/aggregation/audit integration. Use `agent.agentId` rather
than any argument or `_meta` identity; allowlists authorize tool access only.
The existing refund ledger remains scoped to a sandbox merchant application,
not to individual agents. Per-agent capture/execution ownership, idempotency
binding and reservations must be supplied by the local #8 integration before
using this scaffold as a multi-agent money-moving service. This change does not
replace those gates or wire audit/velocity/approval execution.

## Tokens and verification

The existing token manager still computes renewal from request start and actual
`expires_in`, with a 10% safety margin capped at 30 seconds, and shares one
refresh among concurrent callers. Only the refund execution adapter can retry a
401 once using its persisted execution ID and identical serialized body. General
MCP writes are not automatically retried.

Known credentials/tokens, nested Authorization headers and textual Bearer/Basic
credentials cause whole-result denial with a constant message. Escaped secret
strings are also checked. Standalone Basic values must decode as base64
user:password. Unknown Bearer-shaped values are denied regardless of scheme case,
token length or alphabet, including repeated spaces, tabs, line breaks and
Unicode whitespace. No context guess permits an ambiguous Bearer value.

This intentionally rejects legitimate prose such as `bearer bonds`, including
that phrase inside an otherwise ordinary sentence. Leakage prevention takes
priority over those false positives; the entire result is denied without
printing it. Ordinary `Basic Plan` and `basic information` remain supported
because they are not Basic credentials. This is a conservative recognizer for
known secrets and supported credential/header forms, not a universal detector
of arbitrarily encoded or undisclosed secrets. NestJS logging remains disabled
and errors expose no request headers or provider bodies.

Tests use synthetic keys/tokens/query results and loopback SDK/REST fixtures.
They check two-agent visibility, direct-call denial, revocation, metadata
impersonation, local-key fallback refusal, owned approval status, captured stdout/
stderr, short-lived refresh coalescing and byte-identical refund retry requests.
No external credential, token/payment API, production migration or deployment
was used to produce this evidence.
