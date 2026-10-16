# Agent authentication and tool isolation

Issue: https://github.com/AndrewDongminYoo/spendwall/issues/10.
The operator approved the remaining agent authentication and tool isolation work, keeping the existing token manager and deferring trial issuance.

## Contract

Add an explicit agent-authenticated mode to the existing loopback W0 proxy.
Store only SHA-256 digests of generated 256-bit random keys in PostgreSQL, scoped to one merchant and agent, with bounded exact-name tool grants and revocation.
A restricted runtime role can read credentials but cannot issue, revoke or widen grants.
Trusted local administration issues credentials once to a new private file and revokes by key ID; there is no public administration endpoint.

Authenticate every MCP request and re-read the grant before listing or invoking tools.
Unknown, revoked, foreign-merchant or unavailable credentials fail closed, without fallback to the legacy shared proxy key.
List only granted tools; direct calls to hidden tools must fail before validation or upstream/payment work.
Names from caller metadata never establish agent identity.
Namespace refund execution IDs by authenticated merchant and agent so equal caller UUIDs cannot reuse another agent's ledger result; preserve retries and key rotation within the same identity.

## Boundaries

The existing local shared-key mode remains compatible and explicitly lacks per-agent isolation.
Use a separate configured entrypoint for DB-backed agent mode; this does not compose policy, context, velocity or approval into the W0 proxy.
Do not expose this as a production payment gateway.
No token-manager changes, dependency additions, live provider calls, deployment, trial, or mobile work.
The firewall-only check_approval tool belongs to the existing composed approval boundary; do not add an unbound status oracle to the W0 proxy.
Reference #10 instead of claiming all broader issue acceptance is complete.

## Acceptance

1. Real MCP clients with different keys see different exact tool lists; forbidden direct calls produce zero upstream calls and zero refund writes.
2. Real PostgreSQL proves hash-only storage, restricted runtime grants, revocation, wrong-merchant denial, empty grants and database-failure denial.
3. Credential revocation or grant changes after MCP initialization affect the next call; a request delayed while reading its body must not retain stale authority.
4. Same-agent retry/rotation keeps one refund operation while another agent using the same caller UUID cannot read or reuse its result.
5. Existing token and refund retry tests remain unchanged and pass; malformed authentication and DB errors produce sanitized responses.
6. Key administration and explicit authenticated startup are runnable with local configuration; errors do not print credentials.

## Evidence

Oracle found no relevant personal Spendwall precedent for agent authentication or tool allowlists (source c1681868ac634e4b2414874716bb75a7864113c4; freshness unverified).
Current implementation and behavioral tests determine this contract.
