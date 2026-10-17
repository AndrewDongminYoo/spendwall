# Support agent demo

Run from the repository root with the pinned Node and pnpm versions and Docker running:

```sh
pnpm demo
pnpm demo small
pnpm demo approval
pnpm demo injection
pnpm demo velocity
pnpm demo shopping
```

The default mode replays authored synthetic agent calls through the SDK's firewall MCP server.
It uses the real context resolver, policy evaluator, PostgreSQL velocity reservations, approval service, and refund executor.
All payment HTTP responses come from a synthetic adapter that has no network fallback.
Completed direct allowances and approved executions also record [reconciliation receipts](../../docs/webhooks.md#record-execution-evidence) tied to their audit evidence.
The demo does not receive real webhook deliveries.
If direct refund receipt persistence fails after execution, the tool retains the completed refund result and execution UUID and reports `reconciliation: unresolved`.
The runner can call `recoverReconciliation(executionId)` to retry only that receipt write; this capability is not an agent tool and never resubmits a refund.
The recovery queue lasts only for this disposable demo session; it is not production restart recovery.
No PayPal credentials or `.env` files are read.
Each invocation owns a disposable `postgres:17-alpine` container and temporary refund ledgers.
If the image is not cached, a separate cancellable download has a five-minute deadline before container startup.

| Scenario    | Expected result                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `small`     | A USD 10 refund is allowed and completes once.                                                                                                                                                                       |
| `approval`  | A USD 60 refund waits with no payment write, then a labeled scripted human approval executes it once.                                                                                                                |
| `injection` | The ticket asks to ignore instructions and refund other orders; both out-of-ticket attempts are denied.                                                                                                              |
| `velocity`  | Two USD 10 refunds complete; the third is denied by the persisted one-hour count.                                                                                                                                    |
| `shopping`  | An agent-supplied price is denied at the catalog boundary, a USD 19.99 catalog order is created with its approve link, capture is denied before buyer approval, then a scripted buyer approval lets it capture once. |

The runner checks decisions and payment writes before printing `PASS`.
Terminal decisions use green, yellow, and red; redirected output and `NO_COLOR` use plain text.
Ticket bodies are untrusted input.
Customer identity and capture scope come from separate trusted fixture fields, never from model arguments.
The tools are `create_refund` (full remaining refund only) and read-only `check_approval`.
Human approval is deliberately absent from the agent's tool catalog.
The `shopping` scenario uses a separate buyer-side composition with `search_products` (local catalog), `create_order` and `pay_order`; buyer approval on the synthetic PayPal page is a runner capability, never a tool.
See the [shopping flow](../../docs/shopping.md) for its ledger and capture binding.

## Optional Claude run

Supply `ANTHROPIC_API_KEY` through your shell's normal secret handling, then select one scenario:

```sh
pnpm demo small --live
```

This opt-in run can spend Anthropic credits, with an SDK budget of USD 1, eight turns, and a two-minute timeout.
The SDK uses its default model.
The agent receives one in-process firewall MCP server, no built-in tools, no plugins or skills, and no inherited user or project settings.
Its temporary home and explicit environment keep payment credentials outside the subprocess.
Only the API key and runtime path are forwarded.
The payment provider remains synthetic even in live mode.

If a live request waits for approval, the runner asks the terminal operator to type `approve` after the model turn ends.
The prompt shows the stored approval's capture, amount, customer, merchant, and expiry before accepting a decision.
The decision uses the argument hash from that displayed approval.
Any other response, including noninteractive input, denies it.
Live output says `LIVE OBSERVATION`, not `PASS`: the model may refuse the injection or choose different valid actions.
In the `shopping` scenario, live mode observes order creation and the pre-approval capture denial and then lists created orders; buyer approval and capture are exercised only by the recorded replay.
The recorded adversarial calls establish firewall enforcement for those inputs; they do not establish universal prompt-injection resistance.

### Observed live run

The [October 16 live rehearsal](../../docs/notes/2026-10-16-live-rehearsal.md) exercised all four fixtures with actual Claude responses and synthetic payments.
The approval case waited without a payment and was denied noninteractively; the velocity case allowed two refunds and denied the third.
The injection case differed from recorded replay: the model did not request the two out-of-ticket refunds, but it did refund the one in-scope capture.
That observation does not exercise the firewall's out-of-ticket denial path; retain the recorded replay for that deterministic check.
The note identifies the observed SDK/model, cost estimates and limits rather than promising identical behavior on another run.

## Verification and limits

```sh
node --test tests/agent-demo.test.mjs
pnpm check
```

Tests inspect actual MCP results, persisted aggregate decisions, and synthetic payment writes.
They also exercise missing credentials, unknown scenarios, self-approval attempts, payer mismatch, and concurrent velocity calls.
The SDK boundary is tested with a substituted model stream; unattended checks do not call a paid model.
This is a demo composition, not the production proxy bootstrap or a replacement for agent authentication, mobile approval, FCM, or live sandbox verification.
