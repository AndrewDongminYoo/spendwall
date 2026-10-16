# Invoice policy

## Local baseline

Issue [#27](https://github.com/AndrewDongminYoo/spendwall/issues/27) adds policy evaluation and durable reservations for `create_invoice` and `send_invoice`.
`InvoicePolicy` composes the existing `ContextResolver`, CEL policy evaluation and audit log.
It does not call a provider write API.
The W0 proxy and the refund demo remain separate compositions.

Run the synthetic example with Docker available:

```sh
node scripts/invoice-demo.mjs
```

The example creates its own disposable PostgreSQL database, uses synthetic invoice GET responses and checks an allowed draft, an amount denial, a recipient-domain denial, concurrent send reservations and a retry.
It never creates or sends an invoice at PayPal.
The database is removed when the example exits.
No credentials or database URL from the environment are accepted.

## Policy context

The [example policy](../apps/agent-demo/invoice-policy.yaml) limits each invoice to USD 100, allows exactly `example.invalid` and reserves at most one send per customer per UTC calendar day.
Replace these synthetic values in trusted policy configuration before integrating another environment.
Other currencies are denied by this example; the existing policy engine still supports its documented normalized currencies.
No new policy syntax is introduced.

| Field                        | Source and meaning                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `amount`                     | Verified invoice total from `ContextResolver`, including supported shipping                           |
| `customer.email_domain`      | Domain derived from the verified recipient email, lowercased; caller values are replaced              |
| `agg.invoice_send_count_day` | Committed allowed send reservations for this merchant and stable customer ID on the database UTC date |

A subdomain does not match the example's exact domain allowlist.
The resolver requires one matching recipient and rejects unsupported invoice details or notification recipients as described in the [resolver contract](context-resolver.md).
Trusted server customer IDs must remain stable across agents and sessions.
Changing a customer ID or assigning several IDs to one person is outside the identity guarantees of this module.
Caller aggregates are ignored.
Draft creation receives amount and domain checks but does not consume a send reservation.
`require_approval` is denied because invoice approval execution is not implemented.

## Storage and integration boundary

Apply `migrations/001-audit.sql` and then `migrations/008-invoice-policy.sql` as the trusted database owner for a new invoice-only database.
An existing database with migration 001 already applied needs only migration 008 for this module.
Do not rerun migration 001 against an existing audit installation.
Use a login granted the database's `audit.app_role()` group for the policy service, and keep the migration owner out of application configuration.
The reservation table permits application reads and writes through its constrained function, with no direct insert, update or delete privilege.
Hosted-dashboard and webhook-receiver readiness checks reject accidental access to this private schema.

Construct `InvoicePolicy(pool, { identityKey, resolver })` in trusted server code and call `evaluateAndReserve(policy, { requestId, tool, args }, { agent, customer, agg })`.
Use a stable request UUID and one persistent, secret 32-byte hexadecimal identity key per database.
The key derives domain-separated HMAC references for merchant, customer, agent, invoice and request binding; raw emails and provider invoice IDs are not stored in the reservation table.
Changing the key while history exists fails closed.
History dated after the database's current UTC date also fails closed, so a backward clock adjustment cannot reset the daily count.
The existing audit redactor stores safe amount fields and hashes arguments.

Evaluation, audit append and reservation insertion share a transaction and a database-wide advisory lock.
The module verifies that the exact reservation was stored before committing an allowance.
The current implementation reads at most 10,001 history entries and denies when more than 10,000 exist; it is a bounded local baseline, not an unbounded production ledger.
Existing invoice allowances without matching reservation records also fail closed, so a prior integration cannot silently reset the count.
Plan a reviewed migration before importing or pruning history; do not delete records to reset limits.

## Retry and delivery semantics

A fresh allowed result includes `dispatchAllowed: true`, an audit receipt and `expiresAt` at the next UTC midnight.
This is a reservation, not delivery evidence.
A future executor must bind the exact request, check the deadline and fresh provider context, and enforce provider idempotency before dispatch.
This module does not implement that executor or make a reusable result safe for repeated invocation.

While current context still resolves and matches the stored binding, repeating the same request UUID returns the original decision and receipt with `replayed: true` and `dispatchAllowed: false`.
Do not interpret an `allow` decision alone as permission to send.
A changed request binding or policy under the same UUID is denied.
A new UUID cannot reserve an invoice that already has an allowed send reservation, even on another day.
Policy changes do not erase earlier reservations from that day's count.

Reservations remain counted when delivery fails or its outcome is unknown.
There is no release or resend operation, so a lost response can conservatively consume a slot without sending an invoice.
This avoids treating an unknown delivery as a free retry.
A new invoice can receive a new reservation after UTC midnight; a previously reserved invoice remains blocked.

## Verification

```sh
node --test tests/invoice-policy.test.mjs
node scripts/test-audit-postgres.mjs --invoice-policy
node scripts/invoice-demo.mjs
```

The database tests use independent clients behind a real advisory-lock barrier, inspect committed reservations and verify the audit chain.
They also exercise altered audit linkage, a no-op storage function, revoked audit permissions, protected table writes and accidental restricted-role grants.
Rollover is simulated by moving fixture rows to yesterday using the test database owner; the service exposes no clock override.
Live provider delivery, provider idempotency, public hosting and the optional video scenario remain unverified.
