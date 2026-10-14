# Durable refund approvals

Implement [issue #12](https://github.com/AndrewDongminYoo/spendwall/issues/12) on the audit and velocity boundaries merged in PRs #37 and #40.
The operator authorized implementation, commits, push, PR, and hosted review through `pr-loop`.
Merge, live payment calls, production migrations, approval REST endpoints (#14), and mobile work are outside this request.

## Boundary

Provide a trusted server-side approval service, owner-scoped `check_approval` handler and an `approvalLookup` adapter compatible with the separately pending authentication PR #39.
Do not merge or rewrite that PR's proxy/authentication files.
The standalone check handler exposes approval and execution status/result; PR #39's existing renderer only exposes approval status until its caller wires the fuller handler.
No unauthenticated HTTP approval route is introduced.
The service constructor fixes the merchant, persistence pool, stable identity key, and real refund executor.
Callers supply trusted resolved context and an immutable `LoadedPolicy`, never agent-asserted payment facts.
Current refunds remain positive USD only, matching the existing execution adapter.
Normalize executable arguments to include the exact resolved amount before reservation, including originally omitted full-refund amounts.
Reject conflicting argument/context amounts.

## Binding and private persistence

Bind normalized arguments, merchant, capture, customer, agent, amount/currency, immutable policy version, and the executor's sandbox application identity.
Bind the complete trusted agent, customer and merchant objects, including nested policy-visible attributes; matching IDs alone cannot authorize changed facts.
Velocity aggregates remain owned by the original audit-backed reservation rather than caller-supplied aggregate hints.
Source identity comes from the real executor's persisted client-ID hash, not caller arguments.
Persist authenticated encrypted request/result snapshots separately from the append-only redacted audit history.
Derive encryption and reference keys in separate domains from the configured server key.
Use the stored executable snapshot after verifying fresh trusted binding; never execute a caller's replacement payload.
Unsupported configuration, decryption, missing state or audit failures return safe errors and cannot authorize a payment.

## State transitions and time

Use PostgreSQL time and a 15-minute deadline measured from the original reservation timestamp.
Creation returns `{status: "pending_approval", approval_id}` after durable creation, without calling PayPal.
The velocity reservation commits first; creation then reuses its original approval UUID and audit receipt.
An interrupted creation retains capacity, and the same logical request repairs the gap without another reservation or renewed TTL.
Create the approval row and `approval_created` event in one transaction.

Pending approval can become denied or expired, with a matching audit denial in the same transaction.
Approval and execution claim happen atomically before the deadline: `pending → approved` and execution `null → in_flight`.
Persist one execution UUID and the bound executable request before any network call.
There is no approved-but-unclaimed state.
Once claimed, TTL and denial cannot release the reservation.
Approved execution can become succeeded, failed, or unknown.
Timeout, malformed response, pending provider result, process interruption, or lost persistence confirmation is unknown, never definite failure.
Failed and unknown outcomes remain charged under the current velocity contract.
Confirmed success converts the one pending contribution into one accepted contribution.
Every state change and corresponding audit append commit or roll back together.
Copy the original stored audit agent label, rule references, arguments hash inputs, policy version, metadata and approval UUID.

## Concurrency and recovery

Use a per-approval session advisory lock across network work and short merchant transaction locks for state/audit changes.
Do not hold an open transaction while waiting on the provider.
A second worker observing an active claim returns its status without another execution.
After a crash, reuse the persisted execution UUID and body.
Within the existing executor's conservative 24-hour replay window, unknown requests may recover with that identity.
Enforce the original claim's deadline at the actual POST boundary, including delays in the executor queue, lookup and token refresh.
Known refund references and recovery beyond that window use an explicitly read-only executor reconciliation method, which cannot create a new ledger entry or issue POST.
If read-only reconciliation is impossible, preserve unknown and capacity for operator reconciliation.
Do not interpret the local replay window as a new claim about provider retention guarantees.

## Acceptance checks

1. Binding and state validation → unit regressions fail before implementation, including changed merchant/capture/amount/currency/policy/arguments/account.
2. Durable lifecycle → real PostgreSQL verifies TTL boundaries, illegal transitions, crash-gap repair and atomic audit rollback.
3. Concurrency and recovery → independent service instances and real executor/mock REST verify one logical execution, a persisted UUID before POST, stable headers/body, restart recovery and GET-only reconciliation.
4. Reservation integrity → explicit denial/expiry releases; unknown/failed retains; confirmed success contributes once.
5. Status lookup → owner mismatch denies; status lookup cannot execute or leak another approval's payload.
6. Delivery → frozen install, `pnpm check`, full Trunk, Compose configuration, independent core reviews and current-head hosted review/CI.

Feature-specific Oracle retrieval returned `[no precedent found]`; its broader retry was `[PARTIAL]`.
Advisor required atomic audit/state transitions, original receipt recovery, and provider/account binding.
