# Sandbox capture seed

## Problem and scope

[Issue #4](https://github.com/AndrewDongminYoo/spendwall/issues/4) needs real refundable sandbox captures for demos and tests.
Implement the preferred Orders v2 card flow using the existing US sandbox app and a published sandbox test card.
Each new batch contains 20 USD captures: five amounts from $5 to $40, five from $80 to $500, and ten small payments sharing a fictional customer for velocity scenarios.
No production endpoint, configurable card, refund, browser approval flow, or payment-policy implementation is included unless actual sandbox evidence requires the issue's buyer-approval fallback.

## Behavior

`pnpm seed` writes `fixtures/captures.json` and preserves all earlier captures.
The document includes sandbox metadata, a hash binding it to the REST client ID, capture IDs, order IDs, decimal-string amounts, currencies, fictional customer IDs, batch/request IDs, and an unfinished batch when applicable.
No credential, token, raw payment response, buyer account, or card data is written to the fixture.
An optional output path permits a different sandbox app to use a separate fixture.

Persist each request ID and its first-attempt time before the money-moving request.
Use the same request ID and identical payload for bounded transient retries and interrupted-batch recovery.
Refuse replay after a conservative five-hour window; require manual reconciliation instead of silently generating a new request ID.
An exclusive local lock prevents two processes from editing the same fixture.
Atomically replace the fixture after every validated capture and retain unfinished work on failure.
Record only a completed capture whose currency, amount, and purchase-unit correlation match the request.
Reject malformed fixtures, duplicate IDs, a different client ID, redirects, incomplete captures, and unexpected upstream data.

## Acceptance

- One fresh live `pnpm seed` run creates at least 20 completed captures.
- A second complete run adds another distinct batch while preserving earlier records and IDs.
- Tests exercise ambiguous transient failures, stable replay, an interrupted batch, expired replay refusal, concurrent invocation, invalid responses, and secret-safe errors.
- Missing credentials and invalid local state make no payment request.
- Project formatting, type checks, tests, Trunk, and Compose checks pass.
- Real sandbox evidence is required before closing the issue; synthetic tests alone do not satisfy it.

## Evidence and limits

The [Orders card use cases](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/advanced/) document single-request create-and-capture.
The [idempotency reference](https://developer.paypal.com/api/rest/reference/idempotency/) limits replay protection to server retention; the [Orders SDK reference](https://developer.paypal.com/sdk/orders/v2/orders-create/) documents six-hour retention.
The [sandbox card guide](https://developer.paypal.com/sandbox-testing/card-testing) supplies the fixed test card.
The five-hour client limit leaves a margin and does not claim permanent exactly-once execution.
Deleting or editing the fixture defeats its recovery guarantees; a stale lock after a killed process requires operator inspection.
CLI and machine-readable data changes require no visual approval.
