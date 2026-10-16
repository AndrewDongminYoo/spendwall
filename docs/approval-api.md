# Human approval API

The #14 server exposes human approval endpoints on `127.0.0.1` using the existing #12 service.
It is separate from the W0 MCP binary and the agent authentication boundary in PR #39.
An application supplies the database pool, refund executor, current trusted-context refresh and provisioned devices; it adopts the returned `service.request` when a policy can require approval.
No agent-facing create-approval or public payment-recovery route is added.
See [the contract](specs/2026-10-15-approval-api.md) and [the underlying service](approvals.md).

## Storage and server composition

Apply `migrations/004-approval-api.sql` as the trusted owner after `001` through `003`.
The existing database app group gains SELECT/INSERT/UPDATE on private device and delivery tables, and SELECT/INSERT only on consumed enrollment digests.
Its existing audit privileges are unchanged.
Keep the identity key, database and refund executor ledger stable across restarts.
Use an independently generated 32-byte signing key encoded as 64 hexadecimal characters; the signing and identity keys must differ.

The following is a composition example inside trusted server code.
The pool, executor, keys, device configuration and refresh function come from the application, not HTTP bodies.

```ts
import { startApproverServer } from './apps/firewall/src/approver/server.ts';
import { FcmSender } from './apps/firewall/src/approver/fcm.ts';

const api = await startApproverServer({
  pool,
  merchantId,
  identityKey,
  signingKey,
  executor,
  devices: () => provisionedDevices,
  refresh,
  notifier: new FcmSender({ projectId: firebaseProjectId }),
  port: 3002,
});

const pending = await api.service.request(policy, trustedResolvedInput);
// The application closes the API before closing its pool and executor.
await api.close();
```

`refresh({input, policyVersion}, signal)` must reload the current immutable policy and authoritative agent/customer/merchant facts, invalidate any cached capture facts, and resolve the original refund arguments through the server's resolver.
Preserve the stored request UUID and action arguments, and return `{policy, input}` in the #12 service input shape.
The complete current binding must still equal the stored binding; changed policy, identity, action or payment facts reject approval.
The guarded refresh also compares the request UUID and canonical resolved payment facts against the authenticated stored snapshot without changing the existing persisted binding format.
Respect the abort signal; refresh is bounded to five seconds and runs outside a SQL transaction while holding the approval session lock.
The server rechecks device authority and original TTL before committing the execution claim.
The claim UPDATE itself checks PostgreSQL time against the original expiry, so a delay after the preliminary check cannot authorize an expired request.
Do not implement production refresh by copying the stored snapshot, as the synthetic fixture does.
No live payment-context or production integration is established by that fixture.
After applying migration `007`, trusted compositions can set `reconciliation: true` to record completed provider refund receipts atomically with approval completion.
See [webhook reconciliation](webhooks.md#record-execution-evidence) for storage, failure handling and coverage limits.

## Provisioning and JWTs

Provision entries shaped as `{deviceId, agentId, enrollmentHash}` for a fixed merchant.
`enrollmentHash` is SHA-256 of a random 32-byte base64url enrollment token.
The server stores consumed digests, never the raw enrollment token.
Deliver the raw token privately to its intended device and retain it outside logs and Git.
An FCM registration token is a notification address, not an authentication credential.

`POST /devices/register` requires `Authorization: Bearer <enrollment token>` and exactly `{device_id, fcm_token}`.
It consumes the digest atomically once, encrypts the FCM token and returns `{access_token, token_type: "Bearer", expires_in: 900}`.
Parallel registration with the same credential has one winner.
Re-registration requires a new provisioned token and increments the device generation, revoking old JWTs.
Previously consumed credentials remain unusable even if an old configuration is restored.
Removing a device or changing its assigned agent in the current configuration rejects its existing sessions.
Use a new device ID to move an existing device record to another agent scope.

JWT verification fixes HS256, issuer, merchant-specific audience, type, subject, generation and a 15-minute lifetime.
The principal comes from the current configured device and active DB row.
The decision transaction locks and validates that generation again after trusted refresh, so re-registration during refresh prevents the claim.

This is a demo enrollment model: an expired JWT needs a newly provisioned enrollment token; no refresh/login flow, user directory, device attestation or server-side biometric verification is implemented.
The [Flutter approver](../apps/approver/README.md) adds a local biometric confirmation gate; it does not change this server trust model.
A stolen unconsumed enrollment credential can register a device, and a stolen JWT can act within its remaining lifetime and assigned scope.
Production deployment needs an appropriate identity system, HTTPS and operational revocation policy.
Do not expose the W0 MCP proxy publicly as a substitute for this human authorization.

## HTTP contract

All approval endpoints require the returned bearer JWT.
The server enforces local Host/Origin, JSON decision bodies up to 16 KiB, bounded requests, strict fields and `Cache-Control: no-store`.
Cookies and CORS credential grants are not provided.

| Request                                                | Result                                                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /approvals?status=pending&limit=20&cursor=<uuid>` | Owned pending items and `next_cursor`; limit 1–100, default 20                                                                                      |
| `GET /approvals/:id`                                   | Owned status/result, normalized arguments, safe identity IDs, amount, stored `matched_rules` references, policy version, timestamps and `args_hash` |
| `POST /approvals/:id/decision`                         | Exact body `{decision: "approve" \| "deny", args_hash}`                                                                                             |

The hash remains the audit SHA-256 of canonical normalized original arguments, not a JWT or a replacement for the complete approval binding.
Compare the value obtained from detail; a mismatch returns 409 before refresh, expiry mutation, audit append, delivery work or payment execution.
Additional identity, context, amount or policy fields are rejected.
Cross-owner and unknown approvals return 404; missing, invalid, expired or revoked authentication returns 401.
Expired/conflicting decisions and a busy unclaimed approval return 409.
An active or unknown execution can return 202; a final outcome returns 200.
Repeated approval uses the existing execution UUID and never creates another execution.
Deny does not resolve payment context or submit a payment.
Pending pages can omit approvals that expire while the page is read; follow `next_cursor` when present, then refresh from the first page to see new arrivals.

Use ordinary curl requests against the application URL after provisioning a device.
The executable verification below performs registration, lookup, mismatch and final decision with actual curl subprocesses, without exposing a public test-creation endpoint.

## Optional advisory summaries

`POST /approvals/:id/summary` accepts exactly an empty JSON object and requires the same owned approver JWT as detail.
It returns either `{status: "unavailable", advisory: true}` or an available result with `label`, two or three `sentences`, and `risk_flags`.
The successful label is `AI-generated reference only; not authorization`.
Render these strings as plain text below the original payment facts and matched rules; never use them as decision inputs or authorization.
Risk flags (`instruction_like_content`, `conflicting_payment_claims`, `pressure_to_approve`) are unverified model observations, not policy decisions.
Structural validation cannot guarantee that generated prose follows instructions or states correct facts.
Even text that claims to authorize a payment remains untrusted reference material; clients must retain the fixed server label and original authoritative facts, and must not feed generated text into decisions.

Generation is disabled unless the trusted application supplies `summary` options:

```ts
import { claudeSummary } from './apps/firewall/src/approver/claude-summary.ts';

const summary = {
  loadText: async (approvalId, signal) => {
    // Load only this approval's redacted, bounded support text from your application.
    // Return {agentReason, ticketExcerpt}; never load another tenant's ticket.
    return supportTextForApproval(approvalId, signal);
  },
  generate: claudeSummary({ apiKey: configuredApiKey, model: configuredModel }),
};
// Pass summary to startApproverServer alongside the existing required options.
```

There is no new ticket store or agent reason field in sealed approval data.
The application must retain the approval-to-ticket mapping and remove credentials or unnecessary personal data before its loader returns text.
The summary module takes only capture, normalized amount/currency, and identity IDs from validated approval details.
It never forwards the raw trusted context, provider result, argument hash, or executor credentials.
It limits the agent reason to 500 characters and ticket excerpt to 2,000 characters, encoding both as untrusted JSON data in a user message separate from system instructions.
These bounds are not secret redaction and do not prove prompt-injection resistance.

The adapter uses the [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create) with [structured JSON output](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), no tools, no redirects, no automatic retries, and at most 600 output tokens.
Supply an explicit model that supports structured output and an API key through trusted configuration; no environment file is loaded automatically.
Enabling this optional adapter can incur provider charges and sends the allowlisted context and redacted excerpt to Anthropic.
Local tests substitute the provider and incur no model charges.

The complete loader/model operation has a three-second deadline, configurable from 1 to 10,000 milliseconds through `timeoutMs`.
Malformed, refused, truncated, oversized, failed, or timed-out responses return unavailable.
Generation has at most four active operations and 100 cached approval attempts per server instance, including failures; concurrent repeated requests share one attempt.
Timed-out operations that ignore cancellation continue to occupy their active slot until they settle.
A full cache returns unavailable for new approvals until restart; this prototype limit is not a persistent or distributed spending quota.
Only pending approvals generate summaries, and the server rechecks authentication and approval status before returning generated content.
Server shutdown aborts generation.

Summary requests do not participate in approval transactions, change hashes, update policy, or invoke payments.
Existing list, detail, decision, and notification routes never wait for a summary.
An unavailable summary must leave the client able to review original facts and submit the original bound decision.

## Notification delivery

Approval creation enqueues deliveries for matching devices already registered at that transaction.
The approval row, `approval_created` audit event and queue insert share one transaction.
Request replay does not duplicate delivery rows; no Google call runs inside the transaction.
Devices registered later use the pending-list endpoint; there is no catch-up campaign.

The worker processes at most ten jobs per drain, uses a 30-second persisted claim lease, and validates current device generation and pending state before sending.
FCM HTTP v1 uses [Google ADC and short-lived OAuth authorization](https://firebase.google.com/docs/cloud-messaging/send/v1-api) with the messaging scope.
Keep Google credentials private and configure ADC outside the repository.
The message contains only `{approval_id}` in its data payload plus the target registration token.
Its visible notification uses the fixed title `Approval requested` and body `Open Spendwall to review the request.`.
No amount, customer identity, JWT or provider secret is sent in the data.
Token acquisition and HTTP delivery are bounded; ambiguous provider/authentication failures retry with backoff until expiry.
Only an explicit FCM `UNREGISTERED` device error terminates provider retries.
The queue preserves `Retry-After` and a minimum one-minute delay for HTTP 429, following the [FCM error contract](https://firebase.google.com/docs/cloud-messaging/error-codes).
Only the matching claim UUID can record an outcome, so an abandoned worker cannot overwrite a newer claim.

Delivery is advisory and at least once across crashes.
A decision can complete after the worker's pending-state check; a late or duplicate push must only open the authenticated status screen.
FCM failure never releases the payment reservation or deletes the approval.
The default poll interval is one second; set `pollIntervalMs: 0` for explicit drains in tests.
`close()` stops new drains and waits for active delivery work without starting queued notifications.
The Flutter app validates the ID and loads authenticated detail when the notification is opened.
Real Android/iOS background delivery, APNs configuration and physical-device behavior remain unverified for #15; a notification payload alone does not prove delivery.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm test:approval-api
pnpm check
trunk check --all --no-fix
docker compose --env-file .env.example config --quiet
```

The focused command creates and removes one runner-owned disposable PostgreSQL container and uses synthetic enrollment, JWT, PayPal and FCM providers.
It executes real HTTP/curl requests, the real refund executor, database authorization/queue state, concurrency and restart recovery.
The full suite additionally retains the #12 approval/executor and audit/velocity regressions.
No real payment, notification, credential enrollment, mobile device write or production migration is required for these checks.
