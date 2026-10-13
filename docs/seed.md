# Seed refundable sandbox captures

## Prerequisites

Use the US sandbox merchant app configured in [sandbox setup](sandbox.md), with Advanced Credit and Debit Card Payments enabled.
Load `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` privately into the shell environment.
Use the Node and pnpm versions pinned by the repository.
Never paste credential values into commands, logs, PRs, or fixtures.

The script is fixed to the sandbox Orders v2 endpoint and a [published sandbox test card](https://developer.paypal.com/sandbox-testing/card-testing).
It does not accept real card details or a production endpoint.
Card expiry is selected when a batch starts and retained for its retries.

## Run and inspect

```sh
pnpm seed
```

A new batch creates and captures 20 USD orders through the [single-request card flow](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/advanced/).
Five amounts are $5, $10, $20, $30, and $40; five are $80, $120, $200, $350, and $500.
Ten small amounts range from $1.00 through $1.09 and share one fictional customer ID for velocity scenarios.
Other customer IDs are fictional and unique within the batch.
This customer grouping is fixture metadata, not proof of a PayPal buyer's identity.

`fixtures/captures.json` contains a `captures` array.
Each record provides `id` (the capture ID), `orderId`, `amount` (a decimal string), `currency`, `customerId`, `batchId`, `requestId`, and the local observation time `createdAt`.
Only a matching completed capture enters this array; no response body, card data, or credentials are retained.
Top-level metadata identifies the sandbox, schema version, REST client ID hash, and any `pending` batch.
The hash prevents accidental reuse with another app; it is not an authentication mechanism.

On success the command prints safe progress counts and a JSON summary containing `added` and `total`.
After a complete first run, run the same command again: it appends 20 new captures and preserves all previous records.
An interrupted batch is resumed first, so that invocation can add fewer than 20 remaining captures.
Inspect `pending: null`, unique capture IDs, and both amount bands before recording live acceptance.
Previously captured entries can later be refunded by other tasks; their presence does not prove they remain refundable.

A fixture is bound to one sandbox REST app.
For a different app, preserve the existing fixture and select a separate output:

```sh
pnpm seed --output fixtures/my-sandbox/captures.json
```

## Failure and recovery

Each request ID and body hash is saved before submission.
Network failures, HTTP 429, and HTTP 5xx receive at most three attempts using the same payload and `PayPal-Request-Id`.
Other HTTP failures stop the batch; raw upstream error text is never printed.
Each request has a 15-second deadline, and requests run sequentially.
The [PayPal idempotency contract](https://developer.paypal.com/api/rest/reference/idempotency/) protects retries only while the server retains the ID.
The [Orders SDK reference](https://developer.paypal.com/sdk/orders/v2/orders-create/) states six-hour retention; the script permits only five hours from the first attempt and then requires reconciliation.

- Missing credentials: load the same sandbox app credentials privately and rerun.
- HTTP 401: check the sandbox app credentials; no new request ID is allocated for the pending payment.
- HTTP 403 or 422: inspect app card eligibility and sandbox activity before retrying.
- An incomplete, declined, or mismatched capture: preserve the pending entry and reconcile it in the sandbox; the script does not treat it as a successful fixture.
- Network failure or retryable HTTP failure: rerun within the replay window to resume the saved request.
- Expired replay window or changed request body: inspect sandbox activity using the saved request and customer correlation IDs; do not delete pending state to force another charge.
- Lock error: another seed process may be running; do not remove its lock.
  If a process was killed, inspect the PID in the adjacent `.json.lock` file and confirm that the seed process has stopped before removing that exact lock.

Do not edit, replace, or delete the ledger during a run.
Atomic replacement and a local exclusive lock protect normal concurrent runs on the same output path; they are not a distributed payment coordinator or a guarantee against disk loss or manual file changes.
The buyer-approval fallback from issue #4 is only needed if this app cannot complete the card path and requires separate implementation and live evidence.

## Verification

```sh
node --test tests/paypal-seed.test.mjs
```

The tests send actual HTTP requests to a local synthetic OAuth/Orders server and inspect the persisted file.
They verify request shape, completed-capture validation, amount distribution, retries, interrupted-run recovery, client binding, expired replay refusal, lock behavior, and safe failures.
They do not prove sandbox card eligibility or real capture success.
Issue #4 also requires two actual sandbox runs and inspection that the second preserves the first batch.
