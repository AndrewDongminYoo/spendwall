# Sandbox MCP proxy and refund execution

## Problem and decision

Issues #2 through #4 established sandbox authentication, actual MCP schemas, and 40 captured sandbox payments.
The captured `create_refund` schema has no caller-controlled idempotency key and rejects additional properties.
Whether the hosted MCP service forwards arbitrary HTTP headers remains unverified.
Consequently, passing every call through MCP cannot establish issue #12's `PayPal-Request-Id` contract.

Keep the downstream MCP interface and use a dedicated REST execution path for `create_refund`.
Use Streamable HTTP upstream by default and allow an explicit SSE compatibility mode.
Never change transports or replay a mutation automatically after an ambiguous result.
The operator approved this direction, related issue updates, and the implementation-to-PR workflow on 2026-10-13.

## W0 scope

- Run the NestJS app on `127.0.0.1` with a required local bearer key, Host/Origin checks, and a bounded JSON request body.
- Serve stateless Streamable HTTP at `/mcp` using the installed MCP SDK.
- Retrieve the actual upstream tool catalog with pagination and compare its names and input schemas with the committed snapshot before exposing it.
  Refuse drift instead of silently accepting a changed payment contract.
  Ignore only valid timestamp values in `list_transactions.start_date.default` and `list_transactions.end_date.default`, which change between discovery calls.
  Preserve their presence, field constraints, and every other default in the comparison; expose the actual upstream schema unchanged.
- Forward validated ordinary tool calls through the selected upstream transport without automatic mutation retries.
  W0 forwards tool names and arguments; it does not relay progress notifications, task state, or ordinary-call protocol metadata.
- Route `create_refund` to the fixed sandbox Payments v2 REST endpoint.
  Require a UUID in MCP request metadata `_meta["spendwall/execution-id"]`; keep the PayPal tool's arguments unchanged.
  This ID identifies one logical operation and must be reused after any lost response.
- Bind the execution ID to the sandbox app, capture, and canonical tool arguments.
  Persist the binding and resolved request body before submitting a refund.
  Reject an ID reused with different arguments.
- Use a single-process, atomically replaced local ledger and an exclusive process lock.
  Serialize refund execution; a repeated completed operation returns the stored refund without another POST.
  A failed durable write disables further execution in that process until state is reconciled and the proxy is restarted.
  This is a localhost sandbox baseline, not a distributed execution coordinator.
- For a new W0 refund, retrieve the capture with the same app credentials and require `COMPLETED`, USD, and a positive amount.
  Reject partially refunded captures until issue #9 provides trustworthy remaining-balance resolution.
  Resolve an omitted refund amount to the captured amount and persist that explicit amount.
- Send the persisted execution UUID as `PayPal-Request-Id`.
  A 401 permits one token refresh and retry with the identical ID and body.
  Transport errors, timeouts, 5xx responses, and malformed successful responses remain `unknown`.
  Repeating an unknown operation may replay only the same saved request within 24 hours of its first submission; older unknown operations require reconciliation.
  A known refund ID is reconciled with GET, not a new POST.
- Keep token credentials and raw upstream failures out of downstream errors, logs, ledgers, and committed evidence.
  Schedule renewal using actual `expires_in`, a bounded safety margin, and one shared refresh promise.

## Acceptance

1. A real SDK client lists the actual catalog through the NestJS Streamable HTTP endpoint and receives an ordinary upstream tool result.
2. A local HTTP fixture observes the exact refund URL, bearer token, request ID, and body, with the durable ledger written before POST.
3. Duplicate and concurrent execution requests, plus a process restart, preserve one logical refund; changed arguments cannot reuse its ID.
4. Ambiguous responses retain the original ID and body, and expired unknown operations stop before another refund POST.
5. Short-lived tokens renew based on a controlled clock; concurrent requests share renewal and a 401 retry keeps the payment identity unchanged.
6. Unauthenticated, wrong-origin, invalid-schema, and drifted-catalog requests fail before upstream execution.
7. An upstream disconnect or stall produces a safe bounded error instead of hanging; no transport fallback repeats a mutation.
8. An authenticated sandbox `/http` connection is observed before claiming live HTTP compatibility.
9. The operator runs the explicit refund smoke command against one selected fixture capture.
   Two calls with the same execution ID return the same refund ID, and a refund GET confirms the final state.
   Save safe acceptance evidence separately from the private runtime ledger.

## Deferred work

Policy evaluation, tenant isolation, per-agent authorization, distributed storage, velocity reservations, human approval APIs, and the complete approval state machine remain in their existing issues.
Issue #10 adopts the expiry contract; issue #12 will bind approval and policy context to this execution path.
Other upstream mutations do not gain an idempotency guarantee from this proxy.
There is no public deployment or production-payment support in W0.

## Evidence and precedent

- [Actual tool snapshot](../paypal-mcp-tools.json) and [risk inventory](../tool-risk.md).
- [PayPal MCP transports](https://developer.paypal.com/ai-tools/mcp-server), [OAuth lifetime](https://developer.paypal.com/api/rest/authentication/), and [refund request header](https://developer.paypal.com/api/payments/v2/captures-refund).
- [Refund replay documentation](https://developer.paypal.com/api/rest/requests/) describes a retention period up to 45 days; the local 24-hour replay limit is deliberately shorter and does not replace reconciliation.
- PayPal's [sandbox HATEOAS examples](https://developer.paypal.com/api/rest/webhooks/rest/) also use `api.sandbox.paypal.com`.
  Accept that exact sandbox alias and `api-m.sandbox.paypal.com` when checking the refund's capture link; never follow a response-provided URL.
- Oracle global precedent `wiki/entities/mcp-builder.md` and `raw/sources/.claude/skills/mcp-builder/reference/mcp_best_practices.md` confirm Streamable HTTP for remote MCP and that annotations do not guarantee behavior.
  Source commit: `c1681868ac634e4b2414874716bb75a7864113c4`; freshness: `UNVERIFIED`.
  Project refund-idempotency precedent: `[no precedent found]`.
