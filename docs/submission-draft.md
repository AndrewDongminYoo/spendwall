# Spendwall submission draft

Repository draft for [#24](https://github.com/AndrewDongminYoo/spendwall/issues/24), reviewed against the implementation at `bd5a9ac6c56f27fd52eb218cccac6934168b3413` on October 16, 2026.
This task prepares repository text only; the Devpost saved state has not been verified, and no final submission is made here.
The narrative below is proposed submission copy; the review notes at the end are for preparation.

## Project name and tagline

**Spendwall**

Deterministic payment policies for AI support agents.

## Inspiration

A support agent can read a refund request, but the customer's message should not define the agent's payment authority.
An injected instruction or a repeated tool call should not become permission to move money.
Spendwall explores a practical boundary: let AI handle the conversation while explicit code checks the payment request against trusted context and merchant policy.

## What it does

Spendwall checks an AI support agent's refund requests before execution.
Its local demo combines ticket scope, trusted payment context, deterministic policy evaluation, persisted spending reservations, bound human approval and an audit trail.
Missing trustworthy context results in denial.
The policy decision path does not use an LLM.

The default demo runs four recorded scenarios with synthetic payment responses: a small refund, a refund requiring approval, out-of-ticket refund attempts and a repeated-refund limit.
It executes real firewall modules and PostgreSQL operations, but it does not move PayPal funds.
Human approval is scripted in this mode; the agent can request a refund and check status, but cannot approve its own request.
An optional live Claude mode uses the same synthetic payment boundary.

A separate React dashboard uses AG Studio to display audit results from its own synthetic fixtures.
Three audit prompts show large refund attempts, denial groups and agent reservation history.
Its policy workshop provides a YAML draft, a diff and historical replay results; confirmation downloads the draft without changing the running policy.
The preview labels synthetic data and retains evaluation watermarks.

The separate sandbox proxy has recorded PayPal MCP/SSE connectivity and REST refund evidence.
It does not compose the demo's policy and approval pipeline, so this project does not claim an integrated production payment service.

## How we built it

The core is a TypeScript workspace with a framework-independent YAML/CEL policy package and PostgreSQL-backed audit, velocity and approval modules.
The demo exposes scoped MCP tools through the Claude Agent SDK and supplies a synthetic payment adapter.
Approval is bound to the request context, and the refund executor preserves execution identity across retries.

The sandbox proxy uses NestJS and the MCP SDK; its documented successful upstream observation used SSE, while refund execution used PayPal REST.
React and AG Studio provide the local dashboard.
A separate Flutter app implements an approval flow for iOS and Android, with physical-device push, biometrics and integrated sandbox acceptance still pending.

Codex assisted development, tests, documentation and code review.
It was the only AI development tool used.
Claude is an application runtime integration, described separately in the AI disclosure below.

## Challenges

The main challenge was keeping model intent separate from execution authority.
An approval must authorize the specific request, and repeated or concurrent attempts must not silently consume the budget or execute a second refund.
Tests exercise denial, approval binding, persisted reservations and retry behavior using synthetic providers.

Another challenge was describing the evidence accurately.
In a live Claude rehearsal, the injection fixture did not produce the out-of-ticket tool calls seen in recorded replay.
That live observation was a model choice, not proof that the firewall rejected those calls.
The recorded fixture separately verifies the denial path and zero synthetic writes.

The PayPal integration also required an explicit transport distinction: the dated sandbox observation succeeded over SSE, while upstream HTTP initialization returned 404.
The project preserves that boundary rather than claiming both transports worked.

## What's next

Connect and verify the policy-and-approval composition against the sandbox execution path, preserving the existing denial, recovery and retry contracts.
Complete physical-device push and biometric approval checks, real webhook delivery and integrated sandbox acceptance.
Resolve public dashboard licensing and hosting, then verify the intended operational window.
Prepare the demonstration video and complete the remaining submission checks.

## Built with

TypeScript, Node.js, PostgreSQL, YAML, CEL, Model Context Protocol, Claude Agent SDK, NestJS, React, AG Studio, Flutter/Dart and Docker.
PayPal MCP and Orders/Payments REST are used by the separate sandbox tools; the local demo uses synthetic responses.
The webhook receiver is implemented, but live delivery acceptance remains pending.
Codex is the development assistant; Claude is the optional runtime model integration.

## AI tool disclosure

**Development:** Codex assisted implementation, test development, documentation and review.
Codex was the only AI development tool used.

**Application runtime:** Claude can generate support-agent tool calls, advisory approval summaries, a bounded audit-query intent or a proposed policy draft when explicitly configured.
The default demo replays recorded calls, and the dashboard preview uses a labelled synthetic classifier.
Claude output does not grant payment authority: deterministic code evaluates policies, the server computes audit queries, and policy confirmation only exports a draft.
The live support-agent rehearsal used real Claude responses with synthetic payment responses.

## Judge access

Source code: [AndrewDongminYoo/spendwall](https://github.com/AndrewDongminYoo/spendwall).
Follow the [judge guide](judge-guide.md) for the credential-free local run and its prerequisites.
The separate sandbox setup requires private credentials and explicit payment-operation approval; it is not required for the synthetic Quickstart.
No public hosted demo URL or submission video URL is supplied in this draft.

## Preparation notes

### Claim sources

| Claim                                                            | Evidence                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo composition, trusted scope and denial                       | [Composition](../apps/agent-demo/src/firewall.ts), [behavior tests](../tests/agent-demo.test.mjs)                                                                            |
| Deterministic YAML/CEL policy and money handling                 | [Policy package](../packages/policy/package.json), [evaluator](../packages/policy/src/evaluator.ts), [money normalization](../packages/policy/src/money.ts)                  |
| Persisted reservations and bound approval                        | [Velocity tests](../tests/velocity-postgres.test.mjs), [approval tests](../tests/approvals-postgres.test.mjs), [approval binding](../apps/firewall/src/approvals/binding.ts) |
| Refund retry identity                                            | [Executor](../apps/firewall/src/refunds.ts), [proxy tests](../tests/refund-proxy.test.mjs)                                                                                   |
| Separate NestJS sandbox proxy and dated provider result          | [Server](../apps/firewall/src/server.ts), [proxy guide](proxy.md), [refund evidence](../fixtures/proxy-refund.json)                                                          |
| React/AG Studio dashboard, synthetic classifier and draft export | [Dashboard manifest](../apps/dashboard/package.json), [dashboard contract](dashboard.md), [preview server](../scripts/dashboard-preview.mjs)                                 |
| Flutter implementation and device acceptance limits              | [Approver guide](../apps/approver/README.md), [manifest](../apps/approver/pubspec.yaml)                                                                                      |
| Runtime AI surfaces and live-model distinction                   | [README AI table](../README.md#where-ai-is-used), [live rehearsal](notes/2026-10-16-live-rehearsal.md)                                                                       |
| Development tool disclosure                                      | Operator confirmation on October 16, 2026: Codex only; reflected in [README](../README.md#where-ai-is-used)                                                                  |
| Hosting and webhook limits                                       | [Hosting guide](hosting.md), [webhook guide](webhooks.md)                                                                                                                    |

### Save and submission checklist

The [official rules](https://paypalaihackathon.devpost.com/rules), accessed October 16, 2026, allow runnable repository instructions as an alternative to a hosted demo.
They require English submission materials, a public open-source repository and a public YouTube demonstration video; the video guidance specifies a length under three minutes.
These requirements do not establish this project's eligibility or completion.
The issue's November 6 draft target is an internal milestone; the official submission deadline is November 12, 2026 at noon Pacific time.

- [ ] Confirm the actual Devpost fields and character limits before copying this draft; those fields have not been inspected.
- [ ] Review the narrative and AI disclosure, then save through the verified operator account and confirm persistence without final submission.
- [ ] Add the real demonstration video URL after recording and publication; do not substitute the dashboard GIF for the required video.
- [ ] Recheck licensing, access and remaining acceptance evidence against the intended submission.
- [ ] Review the issue's prize interests: Grand Prizes, Best Use of Agentic Commerce and Best Use of AG Grid.
- [ ] Recheck prize eligibility with the organizer's rules; AG Studio dependency presence alone does not establish sponsor eligibility or deployment rights.
- [ ] Keep #24 open until the Devpost draft is saved; final submission remains [#25](https://github.com/AndrewDongminYoo/spendwall/issues/25).

The rules permit at most one Grand Prize plus one Sponsor Prize, or one Honorable Mention Prize plus one Sponsor Prize.
No award eligibility or selection is asserted by this draft.
