# Approval service

Apply `migrations/003-approvals.sql` as the trusted owner after `001` and `002`.
The new private schema stores authenticated encrypted request/result snapshots and durable state.
The existing database-specific app role receives only SELECT, INSERT and UPDATE for this table; bindings, execution IDs and terminal outcomes have database update guards.
Then apply `migrations/011-approval-guards.sql` as the same owner; it does not change those grants.
Its deferred checks run at commit for every role.
A new row must start pending, name the velocity `tool_call` reservation of the same approval, and have an `approval_created` event appended in the inserting transaction.
Each decision needs an `approval_decided` event (`allow` only for approval), and each execution outcome needs an `approval_executed` event (`allow` only for success), appended in the same transaction.
A success event must also carry provider status 200 and the row's execution UUID.
The recovery re-claim from `unknown` to `in_flight` writes no event and is admitted without one, because the outcome that follows it is bound.
A role that can append audit events can still forge a row or a transition, but only by appending fresh matching events in the same transaction.
This is a trusted server persistence boundary, not an approval authorization API for agents.
Human decision authentication and REST endpoints belong to #14.

## Server calls

```ts
import { ApprovalService } from './approvals/index.ts';
import {
  checkApproval,
  approvalLookup,
  approvalTool,
} from './approvals/tool.ts';

const approvals = new ApprovalService(pool, {
  merchantId: configuredMerchant,
  identityKey: serverIdentityKey,
  executor: refundExecutor,
});
const pending = await approvals.request(policy, {
  requestId: stableServerRequestId,
  context: resolution.context,
  resolvedCtx: resolution.resolvedCtx,
});
```

Use a stable private 32-byte key encoded as 64 hexadecimal characters, matching the velocity identity key.
Provide a pool with a bounded connection timeout and the real `RefundExecutor` with its persistent server-owned ledger.
Keep both PostgreSQL state and that ledger across restarts.
The service fixes its merchant and binds the executor's persisted sandbox application hash.
Trusted context must come from the server's resolver for that same account.
Only positive USD refunds supported by the existing executor are accepted.
Full-refund arguments receive the exact resolved amount before reservation, so approval never authorizes a later implicit amount.

When the policy requires approval, `request` returns `pending_approval` and the durable approval UUID without contacting PayPal.
Other decisions are returned without execution.
If creation fails after the velocity reservation, retry the same request UUID and identical trusted facts to recover the original approval.
The deadline remains 15 minutes after the original audit reservation, even after an interrupted creation.
Never replace a failed request with another UUID merely to bypass reserved capacity.

A trusted human-decision caller invokes `approve(id, currentPolicy, currentResolvedInput)` or `deny(id, trustedAgentId)`.
Approval verifies the fresh normalized binding against the encrypted stored request, then atomically commits approval, one execution UUID and the audit decision before sending the stored executable request.
The binding includes every trusted agent, customer and merchant attribute, including nested fields; changed policy-visible facts require a new decision rather than using the old approval.
Caller aggregate hints do not replace the original audit-backed capacity reservation.
The call may wait on the execution adapter; the original MCP refund request does not wait for a human decision.
Approval and execution claim are one transaction, so an approved-but-unclaimed state is impossible.
A pending approval at the exact deadline becomes expired and cannot execute.
After claim, expiry and denial cannot cancel or release an uncertain payment.

## Recovery and lookup

`recover(id, currentPolicy, currentResolvedInput)` is an explicit trusted worker operation for interrupted or unknown executions.
It reuses the original UUID and body, and does not renew the replay window.
The executor checks the persisted claim's deadline immediately before each possible POST, including after capture lookup, token refresh and queue delays.
Known refund results and attempts beyond the existing executor's conservative 24-hour window use `RefundExecutor.reconcile`, which requires an existing ledger refund reference and can only GET.
If the ledger cannot support that read-only operation, the state remains unknown for operator reconciliation.
The 24-hour boundary is the existing local safety policy, not a claim about PayPal's current retention guarantees.
Confirmed success contributes once to velocity.
Unknown and failed outcomes remain reserved under the current velocity contract.

`check({agentId, approvalId})` returns only an owned approval's status, execution state/ID and normalized result.
It never submits a payment.
A pending lookup can record expiry, and a lookup that acquires the abandoned execution lock can record an orphaned `in_flight` claim as unknown.
Database/audit failures reject with a constant safe error.
Caller code must treat those errors as denial or unavailable state, not as a new execution permission.

Use `approvalTool` and `checkApproval(approvals, authenticatedPrincipal, args)` to register the full `check_approval` MCP handler.
Protocol tests exercise pending and completed execution results through the MCP client/server transport and verify that status reads do not execute.
`approvalLookup(approvals)` also matches PR #39's authenticated lookup callback.
That PR's existing renderer exposes only the approval status; the full handler is needed to expose execution results.
The default proxy binary is not wired by this change while PR #39 remains separate.

## Verification

```sh
node --test tests/approvals.test.mjs tests/refund-execution.test.mjs
pnpm test:audit:postgres
pnpm check
trunk check --all --no-fix
docker compose --env-file .env.example config --quiet
```

The database runner uses disposable local containers and synthetic data.
The execution tests use the real refund adapter against mocked HTTP, including checks that the committed execution UUID is visible before POST.
No live payment or production database is required.
See [the approval contract](specs/2026-10-15-approvals.md) for the frozen scope and state transitions.
