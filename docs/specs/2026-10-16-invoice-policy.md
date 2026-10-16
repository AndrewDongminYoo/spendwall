# Invoice policy baseline

## Problem and scope

Issue #27 requires amount caps, recipient-domain restrictions and a per-customer daily limit for invoice tools.
Use the existing resolver and CEL policy engine for `create_invoice` and `send_invoice` without introducing a new policy language or dependencies.
Provide a synthetic console composition that does not send provider requests.

## Contract

- Resolve raw tool arguments with `ContextResolver` and trusted server customer/agent identity before evaluation.
- Derive `customer.email_domain` from the verified recipient email; discard caller aggregates and derive `agg.invoice_send_count_day` from committed reservations.
- Apply the example USD amount cap and exact domain allowlist to both invoice tools; deny unsupported currency in the example policy.
- Count allowed `send_invoice` reservations per merchant and stable customer ID across agents and policy versions in the database UTC calendar day.
  Draft creation does not consume a send slot.
- Serialize evaluation, audit append and reservation insert in one transaction with a fixed database advisory lock.
  The initial baseline favors correctness over parallel merchant throughput.
- Store only HMAC references, request UUIDs, policy/argument bindings and linked audit receipts in the reservation table.
  Use one persistent identity key per database; key changes fail closed.
- A same-ID retry returns its original decision and receipt with `replayed: true` and `dispatchAllowed: false`.
  A fresh allowed decision has `dispatchAllowed: true` only until the recorded UTC day ends.
  Changed binding or policy with the same ID is denied.
  An invoice already reserved for sending cannot obtain another allowance under a fresh request ID, including after midnight.
- Keep reservations after unknown or failed delivery; no automatic release or resend is supported.
  This is a conservative authorized-attempt limit, not a count of delivered invoices.
- Fail closed for resolution, storage, integrity, unavailable schema and unsupported `require_approval` decisions.
  No allowance is returned before commit.
- Hosted readers and webhook receivers must continue to reject access to the new private policy schema.

## Non-goals and limits

No provider write, invoice executor, public route, approval workflow, video, dashboard UI, deployment or mobile change is included.
The existing W0 proxy and refund demo do not automatically gain invoice protection.
A future executor must consume only fresh `dispatchAllowed` results before their expiry, bind exact arguments and enforce provider idempotency plus fresh provider context.
The trusted server must keep customer IDs stable; aliases are not automatically deduplicated.
Database owners and application policy configuration are trusted.

## Acceptance

1. Real resolver plus policy rejects excessive amounts, disallowed exact domains, forged domain/aggregate inputs and invalid recipients; valid draft and send cases succeed.
2. Concurrent sends at a one-slot customer limit produce exactly one dispatchable allowance, including requests from different agents.
3. Retries retain one receipt and one reservation; changed arguments, policies, identity keys and fresh-ID resends cannot bypass limits.
4. Audit and reservation writes commit or roll back together, and application credentials cannot modify or delete reservations.
5. UTC rollover permits a new invoice while retaining prior-day send deduplication; reservation or audit inconsistency fails closed.
6. Existing declared repository gates pass and the synthetic example reports expected denials without contacting PayPal.

## Precedent

The personal `spendwall` Oracle query returned [no precedent found] for invoice and reservation topics.
No retrieved precedent was used as design authority.
