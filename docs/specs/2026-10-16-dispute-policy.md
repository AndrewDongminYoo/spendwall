# Dispute policy baseline

## Goal and boundary

Implement the local policy slice of issue #28: trusted dispute facts, mandatory human approval for accepting a claim, and response-deadline classification.
The module never accepts a provider claim, creates an approval record, sends a notification or grants dispatch permission.
The W0 proxy, refund approval service and Flutter app remain separate integrations.
This PR does not establish the issue's live sandbox or notification acceptance.

## Evidence and supported responses

The captured MCP catalog defines `accept_dispute_claim` with `dispute_id` and `note`, and `get_dispute` with `dispute_id`.
The pinned [PayPal Disputes schema](https://github.com/paypal/paypal-rest-api-specifications/blob/90e8041ffe02d80c452d2b476bedd59a8d219bdc/openapi/customer_disputes_v1.json) defines `GET /v1/customer/disputes/{id}`, `dispute_amount`, `disputed_transactions[].seller.merchant_id`, `seller_transaction_id`, `seller_response_due_date` and applicable `accept-claim` response options/links.
The buyer object does not provide a dependable payer ID; a trusted server customer record must therefore carry its verified `seller_transaction_id` mapping.
The baseline supports exactly one fiat transaction, one matching merchant and one matching trusted customer transaction reference.
The transaction must be `COMPLETED` or `HELD`.
It rejects missing or inconsistent facts rather than guessing ownership or refund exposure.
Some valid provider responses may be outside this conservative subset.

## Contract

- Validate the catalog arguments and snapshot caller data before asynchronous work.
- Use only a fixed-origin sandbox GET path; retain the existing bounded response, deadline, cache and invalidation protections.
- Match dispute ID, seller merchant ID and trusted customer's seller transaction ID.
  If a seller email is present, it must also match the configured merchant email.
- Parse a positive dispute amount and transaction gross amount using the existing integer-money helpers; require matching currency and dispute amount no larger than gross.
  Reject cryptocurrency or mixed-asset responses.
- `get_dispute` can resolve known terminal states for inspection.
  Acceptance requires a known active state, full-refund response option and exact sandbox `accept-claim` POST link.
  Never follow provider-supplied links.
- `DisputePolicy.evaluate` accepts only `accept_dispute_claim` and applies the loaded policy to resolved context with caller aggregate hints discarded.
  Preserve deny; elevate allow to require_approval.
  Every result has `dispatchAllowed: false`.
- A successful review contains immutable source arguments, trusted identity context, resolved facts and a versioned SHA-256 binding fingerprint.
  Include policy version and all policy-visible trusted attributes in that fingerprint.
  It is a comparison fingerprint, not a signed token, durable approval or idempotency key.
- Classify a seller deadline as `not_provided`, `overdue`, `due_soon` (within 24 hours, inclusive), or `scheduled`.
  The exact due instant is overdue.
  Reject malformed timestamps and invalid clocks; do not convert an unknown deadline into a safe one.
  This baseline accepts canonical UTC seconds or exactly three fractional digits; other valid RFC3339 forms remain unsupported.
  Deadline urgency is advisory and never lowers an approval requirement.
- Expose explicit dispute invalidation; cache only verified provider facts, never caller identity decisions or deadline classifications.
- Keep the generic CEL evaluator unchanged.
  Integrators must use the dispute boundary; calling the generic evaluator directly does not enforce its mandatory floor.

## Acceptance checks

1. Actual resolver tests observe the current unsupported-tool denial before adding dispute support, then resolve a matching fixture with the exact amount and transaction binding.
2. Missing or mismatched ownership, IDs, transaction mapping, amount, currency, assets, status or response capability denies without provider writes or raw error leakage.
3. Loaded allow, approval and deny policies demonstrate the mandatory floor and deny precedence; unlisted agents and unsupported tools cannot obtain a review.
4. Changed arguments, trusted identity attributes, provider facts or policy version alter the fingerprint; input mutation during GET cannot alter the captured request.
5. Fake-clock boundary tests cover absent, expired, exact-now, exact-24-hour and malformed deadlines, plus cache freshness/invalidation and cross-caller identity checks.
6. A synthetic console example exercises the actual resolver/policy composition and asserts GET-only traffic.
7. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `trunk check --all --no-fix` and Compose configuration validation, followed by local adversarial review and current-head hosted checks.

## Deferred integration

An execution integration must independently authenticate the caller, create durable approval/audit records, seal the exact reviewed binding, reserve exposure, refresh provider facts, and implement provider-specific execution and recovery semantics.
Existing refund execution IDs and approval rows cannot be reused for dispute acceptance.
Notifications need their own authorized delivery integration; this baseline emits deadline data only.
No live provider request, payment operation, external notification or device write is part of verification.
