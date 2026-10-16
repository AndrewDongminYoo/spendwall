# Verified refund webhook reconciliation

## Problem and scope

Issue #19 needs evidence when a PayPal refund has no corresponding firewall execution.
Existing audit rows retain a local execution UUID, but intentionally redact provider refund IDs.
Add an opt-in local sandbox receiver, append-only execution receipts linked to existing audit rows, and a read-only dashboard projection.
Keep the audit hash chain and existing payment policy decisions unchanged.

The receiver accepts `PAYMENT.CAPTURE.REFUNDED` with a completed Payments v2 refund in USD.
Other signed event types receive an explicit ignored response without entering refund reconciliation.
Dispute and invoice workflows, live subscription registration, public ingress, payment writes, provider-wide polling and production operation are outside this baseline.
Issue #19 remains open until real delivery and a direct PayPal-dashboard refund have been observed.

## Trust and storage contract

- Bind the listener to loopback and one configured sandbox app, webhook ID, merchant and identity key.
- Verify the complete event and required transmission headers through the fixed PayPal sandbox signature endpoint.
  Accept only HTTP 200 with `verification_status: SUCCESS`.
  Reject missing, duplicate or malformed headers, malformed or oversized bodies, verification failure, timeouts and provider errors before storage.
- Parse the signed refund resource and its fixed-origin capture link.
  Read that capture through the configured sandbox API and require its ID, currency and payee merchant to match the expected scope.
  Never follow an event-supplied URL, fetch a certificate URL, or accept an event-supplied webhook ID.
- Persist only keyed event/refund/capture references, a keyed payload digest, scope references, USD cents and database receipt time.
  Do not persist raw payloads, notes, payer information, headers or credentials.
- A database uniqueness constraint serializes concurrent copies of the same scoped event.
  A duplicate with the same canonical payload is acknowledged; a changed payload under the same event ID is rejected without overwriting evidence.
  Acknowledge only after persistence succeeds.
- Store completed execution receipts through the trusted firewall composition, bound to the audit row, execution UUID, merchant, app, capture, refund and amount.
  Approval receipts commit atomically with `approval_executed` and the approval result.
  The synthetic direct-allow path records a receipt after its completed adapter result against its allowance audit row.
  A post-execution receipt failure retains the completed result and execution UUID with an unresolved reconciliation status; runner-only session recovery retries the receipt write without repeating payment execution.
  Pending, failed and unknown adapter outcomes are never completion evidence.
- The receiver database role cannot write audit, approval or execution-receipt state.
  Runtime roles cannot update or delete reconciliation evidence.
  The hosted dashboard reader receives no new privileges or routes.

## Read model

Recompute the projection on each authenticated dashboard refresh from persisted webhook observations and execution receipts joined to their audit evidence.
An exact match is `matched`.
An observation without a receipt is `pending` for five minutes after database receipt, then `unmediated`.
This label means no matching firewall completion evidence, not proven malicious activity or complete coverage of PayPal activity.
A known refund with conflicting capture, amount or audit binding is `mismatch` and remains visible for investigation.
A later valid receipt can change `pending` or `unmediated` to `matched` without rewriting the original event.
Key discontinuity, invalid evidence and overflow fail visibly instead of presenting a clean report.
Disabled reconciliation is distinct from an enabled empty report.

## Acceptance checks

1. Invalid signatures, malformed envelopes, duplicate headers, foreign certificate hosts, unexpected redirects and provider failures cause no event persistence.
2. A capture for a different merchant, a mismatched capture ID or invalid refund shape is rejected.
3. Concurrent delivery and restart produce one persisted row per scoped event ID; conflicting replays do not replace that row.
4. Real PostgreSQL permissions deny receiver writes to audit, approvals and execution receipts, and deny runtime evidence updates/deletes.
5. Exact completed receipt evidence matches; wrong refund ID, capture, amount, app, merchant or audit binding cannot match.
6. A webhook arriving before its receipt starts pending, becomes unmediated after the grace interval, and matches after a late receipt.
7. The dashboard renders disabled, empty, pending, matched, unmediated and mismatch states with no raw provider IDs or payloads.
8. Existing project checks pass; local screenshots support operator visual review.

## Sources and precedent

Primary sources inspected on 2026-10-16 are the [PayPal signature API](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post), [webhook integration guide](https://developer.paypal.com/api/rest/webhooks/rest/) and [Payments v2 schema](https://developer.paypal.com/api/payments/v2/schema.json), including `components.callbacks.capture_refunded`.
The integration guide distinguishes real notifications from mock simulator events: postback verification is unavailable for mock events.
Synthetic tests therefore inject provider responses and do not claim live signature acceptance.

Oracle returned `[no precedent found]` for Spendwall-specific webhook/reconciliation queries.
The account-neutral precedent at `wiki/sources/claude--skills--responding-to-ai-pr-review--references--workflow.md` supports stable event identities and distinguishing notifications from complete external state.
The coverage precedent at `wiki/sources/claude--skills--rlm-sweep--skill.md` confirms that observed evidence cannot establish exhaustive activity coverage.
These precedents justify durable event identity and explicit coverage limits, not an additional polling subsystem.
