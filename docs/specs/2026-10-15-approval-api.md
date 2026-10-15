# Human approval API and delivery

Implement [issue #14](https://github.com/AndrewDongminYoo/spendwall/issues/14) on merge `ad68b13b8fe012ad994c483c70f458071379341e` and the durable approval service from #12.
The operator authorized implementation, checks, commits, push, PR and hosted review through `pr-loop`.
Merge, live payments, live notifications, production migration, issue edits and post-merge cleanup/recording are not authorized.
The security-review exception for PR #41 does not cover this issue.

## Boundary and ownership

Provide a separate loopback Nest HTTP server with explicit trusted service composition, leaving the W0 MCP entry point and open authentication PR #39 untouched.
Expose actual HTTP endpoints and a synthetic executable curl fixture; hosting and mobile delivery verification remain #20 and #15.
The server constructs the real ApprovalService from caller-supplied dependencies and a trusted refresh callback for current policy, identity and payment facts.
No decision body can supply agent, merchant, customer, policy, amount, arguments or resolved context.
Use current strict TypeScript, existing Nest/pg/Node testing tools, and the existing approval locks, encrypted snapshots, audit and executor.
Promote installed `jose@6.2.12` to a direct dependency for standard JWT signing/verification; add pinned `google-auth-library@11.3.0` for ADC OAuth credential refresh rather than implementing that lifecycle locally.
No existing dependency upgrade or existing migration rewrite is intended.

## Enrollment and session authority

The trusted server configuration provisions a device ID, one authorized agent ID, and a SHA-256 digest of a high-entropy enrollment token under one fixed merchant.
An FCM registration token is a delivery address and never grants approval authority.
`POST /devices/register` authenticates the enrollment bearer and accepts only `{device_id, fcm_token}`.
Consume its digest atomically once in PostgreSQL, store only the digest and encrypted FCM token, and issue a 15-minute HS256 JWT.
Re-registration requires a newly provisioned token; retain consumed digests so old configuration cannot replay an earlier credential.
Bind JWT issuer, audience, algorithm, expiry, subject device reference and generation; derive the principal from the current configured device and active database row rather than client claims.
Re-registration increments generation and invalidates old sessions.
Configuration removal, changed scope or unavailable device state fails closed.
Signing and identity keys are separate stable private keys.
No public signup, cookie auth, refresh endpoint, device attestation or production identity claim is included.
Document that expiry needs operator reprovisioning in this demo and that a stolen unconsumed enrollment token can enroll a device.
Do not log or return enrollment credentials, signing keys, Google credentials or FCM tokens.

## HTTP contract

Require bearer JWT for `GET /approvals?status=pending`, `GET /approvals/:id` and `POST /approvals/:id/decision`.
Use owner-scoped lookup and a bounded UUID keyset cursor for pending lists; cross-owner and unknown approvals return 404.
Responses use an explicit allowlist: approval/status/execution/result, immutable `args_hash`, normalized action arguments, safe identity IDs, amount, policy version and timestamps.
Do not expose the internal encrypted-request snapshot, arbitrary identity attributes or diagnostics in JSON.
Send `Cache-Control: no-store`; enforce local Host/Origin, JSON media type, bounded bodies and request timeouts, strict methods and schemas, and constant safe errors.
A decision body is exactly `{decision: "approve" | "deny", args_hash: "<64 lowercase hex>"}`.
The hash retains the existing audit meaning: SHA-256 of canonical normalized original action arguments.
Compare it inside the existing per-approval locked state path, before trusted refresh, expiry/audit changes or executor calls; mismatch returns 409 without side effects.
Refresh runs outside a SQL transaction while holding the session lock, with a bounded timeout.
Re-read state and PostgreSQL time under the merchant transaction lock afterward, verify the complete original binding and claim only before the original TTL.
Compare the refreshed request UUID and canonical resolved payment facts with the authenticated snapshot in the new guarded path, preserving the existing persisted binding format.
The pending-to-approved UPDATE must itself check PostgreSQL time against the original expiry.
Refresh cannot replace the approved action arguments, request UUID, policy version or trusted identity attributes.
Reuse the original execution UUID/body for repeated approval; no new public recovery/re-execution permission is introduced.
A conflicting decision, expired approval, or busy unclaimed approval returns 409; active execution can return 202 and final outcomes return 200.
Deny never refreshes or submits a payment.

## Notification persistence

Add owner-applied migration `004` after `001`–`003` for private device, consumed-enrollment and delivery tables.
Do not relax existing audit or approval privileges.
An optional trusted transactional creation hook on ApprovalService enqueues one delivery for each already-enrolled matching device only for a newly created unexpired approval.
Approval creation, audit append and enqueue commit or roll back together; replay does not duplicate a delivery.
No network operation runs inside that transaction.
A bounded worker claims deliveries with a persisted lease/claim UUID, then sends outside a transaction and records the matching claim outcome.
Check current device generation/configuration and pending approval/expiry before sending.
Retry transient or ambiguous failures with bounded backoff until expiry; terminal device errors do not authorize payments or remove approval state.
Delivery is advisory and at least once across crashes; clients deduplicate by approval UUID and always fetch authenticated state.
The FCM HTTP v1 data payload contains only `approval_id`; provider credentials and identity/payment data never enter it.
Devices registered after creation use authenticated pending-list polling; no catch-up campaign is added.
Actual background/device delivery, credentials, APNs entitlements and production hosting remain unverified here.

## Acceptance and evidence

1. Enrollment and JWT → observed failing tests for enrollment replay/concurrency, incorrect credential/device, wrong issuer/audience/algorithm, expired/forged JWT and generation/config revocation.
2. Actual HTTP curl flow → register, pending list/detail, mismatch409 before refresh or payment, deny and approved result with the real PostgreSQL service and real executor/mock REST.
3. Authorization → cross-owner404, strict body rejection, credential-free allowlisted JSON and data payload, hash mismatch with zero audit/execution/outbox changes.
4. Payment invariants → concurrent approve/deny/repeated approval, exact TTL, refresh failure/change and existing restart behavior retain one execution and correct reservations.
5. Delivery → queue atomicity/replay, failed push with durable approval, lease recovery, stale device generation and expiry skip, mock HTTP v1 header/body inspection.
6. Delivery gates → dependency lockfile/frozen install, `pnpm check`, full Trunk, Compose configuration, independent authentication and transaction/delivery reviews, current-head hosted CI/review.

Feature-specific Oracle retrieval returned `[no precedent found]`; broader retrieval was `[PARTIAL]`.
Advisor required one-time enrollment, locked hash validation, trusted action-preserving refresh and allowlisted responses.
FCM authorization follows [Firebase HTTP v1 guidance](https://firebase.google.com/docs/cloud-messaging/send/v1-api) and the [official Google auth implementation](https://github.com/googleapis/google-cloud-node/tree/main/core/packages/google-auth-library-nodejs).
