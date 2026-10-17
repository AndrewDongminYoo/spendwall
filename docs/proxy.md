# Run the sandbox refund proxy

For database-backed agent keys and exact tool isolation, use the separate [agent-authenticated entrypoint](agent-auth.md).
The shared-key W0 commands below retain their existing behavior; neither entrypoint composes policy or human approvals.

## Boundary

This W0 proxy runs only on `127.0.0.1` and uses fixed PayPal sandbox endpoints.
It has no policy engine or approval workflow yet.
Only `create_refund` has a persisted idempotent execution path; other tools are forwarded without automatic retries.
Do not expose this server publicly or treat the local bearer key as per-agent authorization.

The downstream endpoint is stateless Streamable HTTP at `/mcp`.
Ordinary calls forward tool names and arguments; W0 does not relay progress notifications, task state, or protocol metadata.
The refund execution ID described below is the one supported local metadata extension.
Upstream defaults to `https://mcp.sandbox.paypal.com/http`.
Set `PAYPAL_MCP_TRANSPORT=sse` explicitly to use the compatibility transport.
There is no automatic transport fallback.
The complete upstream tool names and input schemas must match [the reviewed snapshot](paypal-mcp-tools.json), which was captured over SSE.
The comparison permits changing timestamp defaults only for `list_transactions.start_date` and `list_transactions.end_date`; their constraints and all other defaults remain checked.
An HTTP connection must be verified separately.

## Observed sandbox result

On 2026-10-13 the documented upstream `/http` endpoint returned HTTP 404 during authenticated initialization.
Explicit SSE mode listed all 46 tools, passed the reviewed catalog check, and returned a seeded order through the local Streamable HTTP proxy.
Use `PAYPAL_MCP_TRANSPORT=sse` for the verified sandbox path; this does not change the HTTP default or enable automatic fallback.

The [connection evidence](../fixtures/proxy-connection.json) records the successful read.
The [refund evidence](../fixtures/proxy-refund.json) records a USD 1.00 refund for capture `88896157CU229004T`, identical refund ID `87H97021S1343912T` on the duplicate call, and a completed refund GET.
This establishes the SSE and REST execution path, not hosted upstream HTTP compatibility.

## Start

Load the sandbox credentials privately as described in [sandbox setup](sandbox.md).
Generate a local key in that shell and start the server:

```sh
export SPENDWALL_PROXY_KEY="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
PAYPAL_MCP_TRANSPORT=sse pnpm proxy
```

The default port is 3001; `SPENDWALL_PROXY_PORT` can change it.
Configure your MCP client with the printed URL and `Authorization: Bearer <local key>`.
Keep this key out of committed MCP configuration and logs.
Requests require the exact localhost Host header; browser Origins must match the server origin.
Stop the server with Ctrl+C before running a smoke command, because both use the same execution ledger.

## Read-only connection check

```sh
PAYPAL_MCP_TRANSPORT=sse pnpm proxy:check
```

This command starts a temporary local proxy, authenticates with an ephemeral local key, lists the upstream tools, and reads a seeded order through MCP.
It does not request a refund.
It writes safe evidence to `fixtures/proxy-connection.json` and then closes the proxy.
The reported transport is the one actually used.

## Explicit refund acceptance

Choose one unrefunded capture from [the seed fixture](../fixtures/captures.json).
Generate one UUID for that logical refund, record it, and reuse it for every attempt.
The command requires both values and only accepts captures from the current app's fixture.

```sh
PAYPAL_MCP_TRANSPORT=sse pnpm proxy:refund --capture CAPTURE_ID --execution-id UUID
```

This requests a full refund of that capture through the local MCP endpoint.
The MCP request retains the upstream `create_refund` arguments and adds `_meta["spendwall/execution-id"]` as request metadata.
The server sends the UUID as the REST `PayPal-Request-Id` after saving the request binding and explicit amount.
The smoke command invokes the same operation twice, checks that both return the same refund ID, and reads the refund through REST before writing `fixtures/proxy-refund.json`.
It does not use a new execution ID for the second call.

New W0 refunds require a `COMPLETED` USD capture.
Partially refunded captures are refused until the remaining-balance resolver in #9 exists.
Positive partial amounts can be supplied through MCP; omission resolves to the full captured amount.
The fixture's historical capture record remains unchanged after a refund and no longer proves remaining refundable funds.

## Recovery and local state

`.spendwall/refunds.json` is private runtime state and is ignored by Git.
It binds each execution ID to the sandbox app, capture, normalized arguments, request body and refund outcome.
The proxy serializes local refund writes and holds `.spendwall/refunds.json.lock` for its lifetime.
Do not delete, edit, or replace these files to force a retry.
After an abnormal process exit, inspect the PID in the lock and confirm the owner stopped before removing that exact stale lock.
Keep the ledger even after a successful demonstration.
If a durable write fails, the process refuses further refunds; reconcile the saved state before restarting it.

- A completed operation returns its saved refund without another POST, including after restart.
- A known pending refund is checked with GET.
- A timeout, 5xx, or malformed successful response leaves an unknown result; repeat only the same execution ID and arguments.
- Unknown operations cannot POST again after 24 hours and require reconciliation.
- An HTTP error alone does not prove a previous attempt failed; preserve unknown state and inspect sandbox activity.
  Only a validated refund resource with `FAILED` or `CANCELLED` establishes a failed execution.
- A 401 permits one token renewal with the same ID and body; no other automatic refund retry occurs.
- Token renewal uses actual `expires_in` with a safety margin capped at 30 seconds, rather than a fixed nine-hour lifetime.

The local lock and ledger do not coordinate multiple machines, supply policy approval, or protect against manual ledger loss.
See [the execution contract](specs/2026-10-13-refund-proxy.md) for follow-up boundaries.

## Credential output

The proxy withholds an upstream or refund result that contains a known credential: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, or an access token that the token manager issued.
The check serializes the result as JSON and reads that text as plain text, without regard to quote structure.
It searches the text and each decoded stage for those credentials.
Each stage decodes the JSON escapes `\uXXXX`, `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r` and `\t`, and the percent encoding `%XX`, in either hex case.
Decoding repeats until the text stops changing, so nested JSON strings and percent-encoded escapes are covered.
A malformed sequence stays as it is.
If the text still changes at the fixed stage bound (`MAX_DECODE_ROUNDS` in [the token manager](../apps/firewall/src/token.ts)), the result is withheld.

The check does not cover base64, hex or other encodings that JSON and URL unescaping do not reverse.
It does not detect unknown credentials or Bearer-shaped text.

## Verification

```sh
node --test tests/refund-execution.test.mjs tests/refund-proxy.test.mjs
pnpm check
```

These tests read actual local HTTP requests, persistent ledger state, and real MCP client responses.
They cannot establish hosted PayPal connectivity or actual refund success; those require the two smoke commands and their inspected evidence files.
