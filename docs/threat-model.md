# Threat model

## Scope and assets

This model describes the current modules and the local synthetic support-agent composition, not a deployed production gateway.
Assets include merchant funds, payment credentials, trustworthy customer/capture context, approval authority, request identity and audit integrity.
The support ticket and model outputs are attacker-controlled data.
The host process, policy files, identity provisioning, database owner and trusted context source are inside the trusted computing boundary.

A malicious ticket may ask an agent to ignore instructions, select another customer's capture, split a refund into many requests, approve its own request or change arguments after approval.
A buggy agent can trigger the same failures without a malicious author.
A model following its system prompt is not a security control.

## Controls and evidence

| Threat                                                         | Implemented boundary                                                                                                                                | Evidence and limit                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt injection requests unrelated refunds                    | Demo MCP tool checks trusted ticket capture scope and resolves merchant/customer facts before policy evaluation                                     | [Demo composition](../apps/agent-demo/src/firewall.ts), [adversarial tests](../tests/agent-demo.test.mjs); specific inputs, not universal injection immunity                                                                                                                   |
| Missing context or invalid policy input                        | Resolver and deterministic evaluator fail closed; unknown agents/tools are denied                                                                   | [Resolver](../apps/firewall/src/context/index.ts), [evaluator](../packages/policy/src/evaluator.ts), [resolver tests](../tests/context-resolver.test.mjs), [policy tests](../tests/policy-evaluator.test.mjs); conservative live-response restrictions can deny valid requests |
| Burst refunds and concurrent limit bypass                      | Audit-backed reservation evaluation serializes a merchant's decision transaction; pending/unknown reservations remain charged                       | [Velocity boundary](../apps/firewall/src/velocity/index.ts), [history fold](../apps/firewall/src/velocity/aggregate.ts), [PostgreSQL concurrency tests](../tests/velocity-postgres.test.mjs); requires all relevant calls to use this boundary                                 |
| Approval substitution, expiry or double execution              | Approval binds normalized arguments, identity, amount and policy; refreshed facts and hash must match; persisted execution identity handles repeats | [Binding](../apps/firewall/src/approvals/binding.ts), [approval service](../apps/firewall/src/approvals/index.ts), [PostgreSQL tests](../tests/approvals-postgres.test.mjs); server-side authority is essential                                                                |
| Timeout treated as a failed payment and retried under a new ID | Refund ledger retains uncertain outcomes and bound request IDs; recovery preserves reservation state                                                | [Executor](../apps/firewall/src/refunds.ts), [executor tests](../tests/refund-execution.test.mjs); provider idempotency is time-bounded and local ledger loss is not repaired automatically                                                                                    |
| Agent sees payment credentials or grants itself approval       | Optional agent subprocess receives an explicit minimal environment and scoped tools; human decision capability is outside its catalog               | [Agent boundary](../apps/agent-demo/src/agent.ts), [demo tests](../tests/agent-demo.test.mjs); a compromised host can still read process secrets                                                                                                                               |
| Upstream result echoes a PayPal credential                     | Proxy withholds results whose serialized text or any JSON/percent-decoded stage contains a configured or issued PayPal credential                   | [Token manager](../apps/firewall/src/token.ts), [decoder tests](../tests/refund-execution.test.mjs), [proxy tests](../tests/refund-proxy.test.mjs); base64, hex and unknown credentials are not detected                                                                       |
| Another device claims an approval                              | Separate approval API checks provisioned device/JWT ownership and generation, and requires the displayed argument hash                              | [API contract](approval-api.md), [API tests](../tests/approval-api-postgres.test.mjs); no production identity system or device attestation                                                                                                                                     |
| Application modifies audit history                             | Restricted application role and chained hashes provide append-only storage and tamper detection                                                     | [Audit contract](audit.md), [database tests](../tests/audit-postgres.test.mjs); database owners and host compromise are outside this control                                                                                                                                   |
| Dashboard/model changes payments or invents SQL                | Dashboard is authenticated and read-only; Claude selects a fixed intent, while code computes rows and widget schemas                                | [Dashboard server](../apps/firewall/src/dashboard/server.ts), [query contract](../apps/firewall/src/dashboard/query-contract.ts), [query API tests](../tests/dashboard-query-api.test.mjs); its bearer token grants access to the configured merchant's audit data             |
| AI summary is mistaken for approval                            | Fixed advisory label, bounded fields, no authorization or payment tools; approval path works without a summary                                      | [Summary contract](approval-api.md#optional-advisory-summaries), [summary tests](../tests/approval-summary.test.mjs); output may still contain misleading text                                                                                                                 |

These references describe the control that each test reads.
Synthetic transport and database checks do not prove current PayPal connectivity, real-device behavior or resistance to every possible model output.
The audit trail does not imply every direct provider action or early demo scope rejection is recorded there.

## Exclusions and residual risks

- **Compromised firewall host or database owner:** an attacker can change policies, credentials, ledgers and code, or rewrite audit data and hashes.
- **Compromised approver device or stolen credentials:** a valid session can act within its scope; expiry/generation checks do not prove the human understood the request.
  Flutter biometrics and native push verification remain planned.
- **Upstream bugs or incomplete payment facts:** validation rejects unsupported or inconsistent responses, but cannot independently prove every upstream statement is true.
  The system is not a substitute for provider reconciliation.
- **Direct PayPal access:** calls that bypass the composed firewall are not prevented by it.
  Webhook reconciliation and unmediated-payment detection remain planned in #19.
- **Unprotected entry points:** the W0 `pnpm proxy` does not integrate policy, velocity and human approvals.
  A localhost bearer token is not production per-agent authorization.
- **Deployment attacks:** production TLS, identity lifecycle, rate limiting, distributed operations, backups and recovery require a deployment design.
  Loopback Host/Origin checks do not make public hosting safe.
- **Data disclosure:** audit/query users can read the configured merchant's data.
  Optional Claude queries send the question; summaries send allowlisted facts and redacted text.
  Input bounds do not redact secrets, so callers must prevent credentials or unnecessary customer data from reaching those fields.
- **Availability and measurement limits:** bounded histories and unavailable dependencies fail closed; that can deny legitimate operations.
  Monitoring budgets are not policy limits, and the demo's fictional FX rates are not live exchange rates.

## Operational rules

Keep PayPal credentials server-side and outside agent/browser configuration and Git.
Use a dedicated read-only database role for dashboard deployment and separate credentials for approval authority.
Preserve uncertain payment state and reconcile it before retries; never delete a ledger to force another payment.
Treat model text as data and retain the authoritative payment facts and fixed advisory labels in any future approval UI.
See [proxy recovery](proxy.md#recovery-and-local-state), [approval binding](approvals.md) and [dashboard limits](dashboard.md) before connecting these modules to real services.
