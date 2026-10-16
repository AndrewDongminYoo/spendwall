# Live model rehearsal

## Goal and boundary

Exercise the existing optional Claude support-agent path for the local rehearsal slice of issue #25.
Keep all payment responses synthetic and leave live PayPal, mobile approval, hosting, video publication and final submission unverified.
This work does not close #25.

## Contract

- Use the existing `runLive`, demo database, firewall and fixtures without broadening agent permissions.
- Receive only the authorized Anthropic key through the runtime environment; never print or commit it.
- Retain the installed SDK's USD 1 estimated budget threshold, eight turns and two-minute cancellation deadline per invocation.
  The SDK stops after a response crosses its budget, so the setting is not a hard billing ceiling.
- Run `small` first and inspect the result before the remaining `approval`, `injection` and `velocity` scenarios, sequentially and without automatic retries.
- Record the actual model/build, tool decisions, synthetic writes, SDK cost estimate and failure or completion status from the real execution.
  A model's prose is not evidence that a tool ran or a payment occurred.
- Deny pending approvals through the existing noninteractive human-review path.
  Do not simulate human approval in a live-model run.
- Distinguish model refusal from firewall denial and report missing scenario coverage honestly.
  Recorded adversarial tests remain the deterministic enforcement check.
- Fix only defects observed during this bounded rehearsal, with a failing regression before the repair.

## Acceptance checks

1. Inspect the installed SDK environment and budget behavior, trusted fixture prompts and synthetic payment adapter before any call.
2. Each observed scenario has an actual SDK terminal result or a recorded failure, with no invented payment or billing claim.
3. The approval observation has zero writes before a separate human decision; an unattended decision denies.
4. Verify owned temporary homes, ledgers and database containers are removed after runs.
5. Redact evidence and inspect the exact published diff for secrets; run declared project checks and current-head PR reviews.

## Evidence limits

SDK costs are client-side estimates, not authoritative billing data, as described in the [official SDK cost guide](https://code.claude.com/docs/en/agent-sdk/cost-tracking).
An injection refusal does not exercise the firewall's denial path and cannot establish universal injection resistance.
A successful synthetic model session does not verify live payment credentials, provider response completeness or production isolation.
