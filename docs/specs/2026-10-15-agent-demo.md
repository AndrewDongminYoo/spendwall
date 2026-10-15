# Support agent demo

## Contract

Implement [issue 13](https://github.com/AndrewDongminYoo/spendwall/issues/13) as a repeatable local demonstration.
The default `pnpm demo [scenario]` replays synthetic agent calls and synthetic PayPal responses through a real MCP connection and the existing policy, context resolver, velocity, approval, and refund modules.
An explicit `--live` option uses the Claude Agent SDK with one in-process firewall MCP server and no built-in tools or inherited settings.
Live model output is nondeterministic and requires a separately supplied Anthropic API key.
Payment traffic always remains synthetic.

## Boundaries

Trusted ticket metadata fixes the customer and permitted captures outside agent arguments.
Ticket text is untrusted data, including instructions to refund other orders.
The firewall denies out-of-ticket captures, invalid arguments, and unavailable context.
Only `create_refund` and read-only `check_approval` are agent tools.
An operator-side approval callback is separate from the MCP server.
Recorded mode labels its scripted human decision explicitly.
Live mode requires terminal confirmation before approving a synthetic refund.

Each run uses disposable PostgreSQL and a temporary ledger.
Existing databases, environment files, credentials, and payment endpoints are not used.
The default W0 proxy and the separate agent-auth PR are outside scope.
This demo does not certify model resistance to all prompt injection, production identity, or live payment integration.

## Acceptance

- Small refund: policy allows and exactly one synthetic refund completes.
- Large refund: request remains pending with zero payment writes, then a separate human decision permits exactly one completion.
- Injection: attempted refunds outside the trusted ticket scope are denied with zero payment writes.
- Velocity: two small refunds complete, the third is denied by the actual persisted aggregate.
- Scenario regression tests use the real MCP and database boundaries with synthetic external responses.
- Unknown scenarios exit nonzero; output includes decisions and reasons with ANSI colors on a terminal and plain output when redirected.
- SDK configuration restricts tools, MCP configuration, settings, environment, turns, and cost.
- Frozen installation, repository checks, Trunk, and Compose validation pass.

## Evidence limits

Recorded calls are authored adversarial fixtures, not captured Claude sessions.
They prove firewall behavior for those calls, not how a live model will respond to each ticket.
No relevant personal project precedent was found for `agent demo` or `prompt injection`.
