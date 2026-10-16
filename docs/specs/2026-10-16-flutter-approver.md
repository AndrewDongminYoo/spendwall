# Flutter human approval app

## Contract and authority

Implement [issue 15](https://github.com/AndrewDongminYoo/spendwall/issues/15) against the existing [approval API](../approval-api.md).
The operator requested implementation, verification and a PR through pr-loop on 2026-10-16.
Real deployment and trial issuance remain deferred.
The app must not contain PayPal credentials or perform provider refunds itself.
The server remains authoritative for ownership, argument binding, policy, expiry and execution.

## Current constraints

The verified base is `4f4f94fffbc15ce4a8d5c3258d4c1c1c6e04b40b`.
`apps/approver` contains only a reserved README.
The approval API binds to loopback and requires one-use device enrollment followed by a 15-minute JWT.
An expired session or changed FCM registration needs a newly provisioned enrollment credential; this work does not invent a refresh credential.
The API currently omits matched rules from its safe detail projection, although the stored approval audit row includes them.
FCM currently sends only data, which does not establish a visible background notification.
Personal Firebase/APNs configuration and a reachable private device-to-server connection have not been supplied.
No cloud resource creation, public tunnel, device installation, real notification or real refund is authorized by this document alone.

## App scope

Create an independent Flutter app for iOS and Android, outside pnpm.
Use Flutter's existing widgets and ChangeNotifier state management without an additional router or state framework.
Use `local_auth` for native biometric confirmation, `firebase_core` and `firebase_messaging` for FCM, and `flutter_secure_storage` for the short-lived bearer session.
These platform facilities are not provided by the repository's TypeScript tools or Dart core libraries.
Use Dart's HTTP client with bounded responses, timeouts and redirects disabled.
Pin the Flutter SDK used by CI and commit the generated package lockfile.

Provide enrollment, pending queue, detail and result states in a dark theme with prominent money values.
Keep normalized original arguments and resolved amount, customer, merchant and agent first, matched rule IDs second, and an explicitly advisory summary last.
Render remote text as plain text.
Never interpolate model text into a decision or route.
Fetch summaries only on request; unavailable summaries must not block decisions.

Enrollment accepts a configured server URL, provisioned device ID and private one-use credential.
Never persist the enrollment credential or print authentication/notification values.
Persist the resulting session through native secure storage with its conservative expiry and endpoint binding.
Only explicit debug loopback HTTP is allowed; normal endpoints require HTTPS with standard certificate validation.
Do not relax server network binding or add a public gateway to reach a physical phone.
Treat 401 and local session expiry as a need to enroll again.
Discard the local session when the FCM token changes rather than silently using a stale delivery registration.

Both approve and deny require an explicit user action and successful biometric confirmation.
Unavailable biometrics, cancellation and lockout must not submit a decision, and there is no device-passcode fallback.
Before submitting, reload the selected approval and compare the displayed binding and status after authentication.
If its displayed facts or expiry changed, require review again.
Send only the decision and the exact displayed `args_hash`.
Disable actions while a decision is in progress, when the local deadline has elapsed, when authentication is unavailable, and for non-pending statuses.
Suspend actions while the app is backgrounded and refresh authority on resume.
Never automatically repeat a decision after timeout, 202 or an ambiguous response.
Show the uncertain or in-flight state and retrieve the existing approval result.

Treat an FCM `approval_id` as an untrusted navigation hint.
Accept only a UUID, load its detail through the authenticated API, and never approve from a notification.
Support foreground reception, notification-open events and cold-start notification handoff.
Preserve the selected ID through enrollment, but do not trust payment facts in the push payload.
Add only generic, non-sensitive notification text to the server's existing FCM payload so a background notification can be opened.
Duplicate and stale notifications must lead to the current server state.

## Boundaries and evidence

Biometrics are a client-side confirmation gate, not server-verified device attestation.
A stolen valid JWT retains the existing demo API's authority until expiry or server revocation.
No production identity system, background payment execution, credential refresh, account selection, public hosting or licensed dashboard release is added.
Firebase configuration is operator-provided and must not be borrowed from another project or account.
Native project generation is authorized by the selected mobile issue; no App Store or Play publication is included.

Oracle source `wiki/entities/flutter-ui-ux-review.md` at `c1681868ac634e4b2414874716bb75a7864113c4` confirms that analyzer, widget, rendered and native-device evidence establish different properties.
This keeps biometric/FCM/device acceptance separate from synthetic tests and screenshots.
Oracle freshness is unverified; no Spendwall-specific precedent was retrieved, and the broad fallback search was not exhaustive.
Official package and Firebase setup documentation were checked on 2026-10-16.

## Acceptance checks

1. Approval API projection and notification privacy → Node regressions plus the real PostgreSQL approval API suite prove stored matched rules are exposed only through the existing owner boundary and pushes contain no payment or credential facts.
2. Client safety → real local HTTP fixtures and controller tests prove endpoint validation, redirect refusal, expiry, exact hash binding, authentication cancellation, duplicate-tap suppression and no automatic decision retry.
3. UI → widget tests exercise actual pending, expired, completed, authentication failure and uncertain-result states; rendered evidence shows the required information hierarchy and accessible actions.
4. Native integration → analyze, format, tests and a native build verify plugin integration; simulator interactions and screenshots establish only their stated local scenarios.
5. Full issue completion → an explicitly authorized physical device receives a real push, opens the bound detail, authenticates biometrically and observes the sandbox execution; expired/completed requests remain disabled.
6. Delivery → repository gates, Flutter checks, local adversarial review and current-head hosted reviews pass; the operator reviews visual artifacts before merge.

If external configuration or a private connection prevents check 5, retain the exact prerequisite as incomplete and do not close issue 15 or describe synthetic success as real-device acceptance.
