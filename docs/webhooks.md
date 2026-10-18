# Local sandbox refund reconciliation

This baseline compares verified, observed PayPal refund notifications with completed firewall execution receipts.
It is separate from the W0 proxy and the hosted read-only dashboard entrypoint.
It does not register a webhook, expose public ingress, move money, poll all PayPal activity or prove that all bypasses are detected.
Real delivery and a direct PayPal-dashboard refund remain acceptance work in [issue #19](https://github.com/AndrewDongminYoo/spendwall/issues/19).

## Prepare storage and identities

Apply `migrations/007-reconciliation.sql` as the trusted database owner after migrations `001` through `003`.
This adds append-only refund observations and execution receipts without changing historical audit rows or their hash format.
The existing application group can read both tables and call the constrained receipt function; it cannot insert observations or update/delete evidence.
The new database-specific receiver group can read and insert observations only.
It cannot read or change audit, approval or execution-receipt state.

Create a separate login as the trusted owner and grant only the group returned by `reconciliation.receiver_role()`.
For example, after setting a unique password privately:

```sql
CREATE ROLE spendwall_webhook_login LOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO spendwall_webhook_login', reconciliation.receiver_role());
END $$;
```

The runner checks actual role capabilities at startup and before each persisted event.
An owner login, application login or receiver with extra protected-schema privileges is rejected.
Additional direct or indirect role memberships are rejected, including roles reachable through `SET ROLE` without inherited privileges.
Privileged attributes on either the login or its receiver group are also rejected, even when those attributes are not inherited.
Ownership and protected-schema object privileges are checked for each role as well, including permissions available only after `SET ROLE`.
Keep the existing identity key stable across the execution composition, receiver and dashboard.
The app reference is SHA-256 of the exact sandbox `PAYPAL_CLIENT_ID`, matching `RefundExecutor.identity`.
Different apps and merchants do not share matches; changing the identity key makes existing reconciliation evidence unavailable.

## Run the receiver

Use the pinned Node version.
Supply `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` through private process environment provisioning.
The runner does not load `.env` files or accept a provider URL.
Create a private JSON file outside Git with `databaseUrl` for the receiver login, `identityKey`, `merchantId`, `webhookId` and optional `port` (default `4402`).
Restrict the file's filesystem permissions.
The webhook ID must be the ID of the intended sandbox app's subscription, not an event or transmission ID.

```sh
node scripts/webhooks.mjs --config /absolute/private-webhooks.json
```

The only route is `POST /webhooks/paypal` on `127.0.0.1`.
The listener requires JSON, limits the body to 64 KiB, limits in-flight work to four requests, and uses a five-second body deadline.
Verification and capture requests have 15-second fetch deadlines; an expired access token can cause one refresh/retry.
Missing/duplicate transmission headers, foreign certificate hosts, verification failures and provider errors are rejected before persistence.
The process sends the configured webhook ID, transmission headers and full event to PayPal's fixed sandbox verification endpoint.
It retains the validated UTF-8 event text exactly for postback, including whitespace, escaping and numeric spelling, while parsing a separate copy for semantic checks.
It never downloads a header-provided certificate URL or follows a payload-provided URL.
Only the exact successful verification result is accepted.

Completed USD Payments v2 `PAYMENT.CAPTURE.REFUNDED` events proceed to a fixed-origin capture lookup that confirms the capture and merchant.
Verified [dispute events](#dispute-events) are stored for dispute tracking.
Other verified event types are acknowledged as ignored and are not reconciliation evidence.
Unsupported or invalid refund shapes are rejected.
Only keyed references, a keyed canonical payload digest, scope, amount and database receipt time are stored.
Raw webhook bodies, notes, payer information and transmission headers are not retained.
Exact duplicates are acknowledged after verifying existing evidence; conflicting payloads under the same event identity fail without replacing it.
There is no acknowledgement before the database write completes.

PayPal delivery requires separately configured public HTTPS ingress.
Do not expose the W0 proxy or hosted dashboard as a shortcut.
Subscription creation, ingress deployment and a direct-dashboard test refund require their own authorized integration work.
PayPal's mock simulator events do not support this postback verification path.
See the [integration guide](https://developer.paypal.com/api/rest/webhooks/rest/) and [signature endpoint](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post), inspected on 2026-10-16.

## Dispute events

After a successful signature postback, `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED` and `CUSTOMER.DISPUTE.RESOLVED` events are stored as triggers for the [dispute tracker](dispute-policy.md#dispute-tracking).
`RISK.DISPUTE.CREATED` is deprecated by PayPal and stays ignored.
An event is a lookup key, not a fact source: the receiver makes no dispute GET, and deadlines, money and ownership come only from the tracker's provider read.
A dispute event whose `resource` does not carry exactly one `dispute_id` and one `disputed_transactions[].seller_transaction_id` in the accepted identifier shapes is rejected with 422; the event resource shape is unverified against a real delivery.

Apply `migrations/013-dispute-tracking.sql` as the trusted owner to store them.
While the `disputes` schema does not exist, verified dispute events with an accepted resource shape are acknowledged as ignored; the receiver checks for the schema on every event, and a malformed dispute resource is still rejected with 422.
`disputes.events` keeps the app and merchant references, a keyed event reference, a keyed payload digest, the event type, the dispute ID and the sale ID; no payload, buyer data, amount, note or header.
The merchant reference is the one that the approver `DeviceAuthority` derives from the same identity key.
Exact duplicates are acknowledged and a changed payload under the same event ID is rejected, as for refunds.
A database trigger creates or advances the tracked dispute, and a `RESOLVED` event ends its tracking; an event for a dispute whose tracking has ended is kept as evidence only.
The receiver group gets `USAGE` on the `disputes` schema, `SELECT` on `disputes.events` and `INSERT` on its stored columns only.
Once the schema exists, the startup check also requires exactly those privileges and refuses any other `disputes` privilege, including access to tracked rows and `EXECUTE` on the trigger function.

## Record execution evidence

Set `reconciliation: true` in trusted `ApprovalService` or `startApproverServer` options after applying the migration.
The service records a completed adapter result in the same transaction as its completion audit event and approval result.
Pending, failed and unknown adapter results create no completion receipt.
If receipt persistence fails after the provider action, the completion transaction rolls back and the execution remains unresolved; preserve its execution UUID and use the existing recovery procedure rather than issuing another refund.
Enabling this option does not backfill earlier executions.

For a trusted direct-allow composition, use `Reconciliation.record(database, allowance.receipt, completedResult)` after the executor returns `COMPLETED`.
Pass the same identity key, merchant and executor identity used by the policy/approval composition.
The SQL function requires a matching allowed audit row and execution UUID.
It is a server-side integration point, never an agent or HTTP input.
The synthetic support demo includes this path and approval receipt recording.
If its direct receipt write fails after execution, it returns the known completed refund and execution UUID with `reconciliation: unresolved`, never a false denial.
Its runner-only `recoverReconciliation(executionId)` retries the receipt write without invoking the payment adapter.
That queue is in memory for the disposable demo session; durable restart recovery requires a separate production composition.
The separate W0 proxy does not have a policy audit receipt and remains outside this integration.

## Read the dashboard

Add `reconciliation: { "adapterRef": "<SHA-256 of the sandbox client ID>" }` to the private local dashboard configuration.
Its database reader needs SELECT on both reconciliation tables and EXECUTE on `reconciliation.valid_receipt(reconciliation.refund_receipts,audit.audit_events)`, in addition to the existing local audit/approval reads.
Do not grant receipt-writing functions to a dedicated reader.
The hosted dashboard configuration rejects this option and its privilege check rejects access to the new evidence.

Each refresh recomputes these states:

| State        | Meaning                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `pending`    | No completion receipt yet; the observation arrived less than five minutes ago.                         |
| `matched`    | App, merchant, key, refund, capture and amount match a receipt with valid linked audit evidence.       |
| `unmediated` | No matching firewall completion evidence after five minutes; investigate PayPal and execution records. |
| `mismatch`   | A receipt for this refund exists, but capture, amount or linked audit evidence differs.                |

`unmediated` is an evidence gap, not proof of malicious activity.
Legacy executions, disabled receipt recording and failed local persistence can cause it.
A later receipt can resolve it without replacing the original observation.
Multiple event IDs can describe the same refund; displayed amounts belong to observations and must not be summed as total spending.
More than 1,000 scoped observations, key discontinuity or missing storage returns unavailable, not a partial clean report.
Disabled and enabled-but-empty reports are distinct.

`pnpm dashboard:preview` renders synthetic examples of all four states with real SQL/HTTP reads.
`pnpm dashboard:preview --empty` renders an enabled empty report.
These fixtures do not establish actual PayPal signature or delivery behavior.

## Verification

```sh
node --test tests/webhooks.test.mjs tests/webhook-http.test.mjs
node scripts/test-audit-postgres.mjs --reconciliation
node scripts/test-audit-postgres.mjs --dispute-tracking
pnpm check
```

The focused tests inspect outgoing provider requests, HTTP rejection/persistence ordering, concurrent PostgreSQL uniqueness, role privileges, receipt binding and late reconciliation.
They include forged/provider-failure responses and a stalled request that actually aborts.
No test contacts PayPal or creates a real refund.
