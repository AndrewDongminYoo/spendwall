# Spendwall approver

Independent iOS and Android Flutter app for [issue 15](https://github.com/AndrewDongminYoo/spendwall/issues/15), excluded from the pnpm workspace.
It presents owned pending requests, original arguments and enriched payment facts, stored matched-rule references, optional advisory summaries and execution outcomes.
Both approve and deny require local biometric confirmation and a fresh detail comparison before submitting the displayed argument hash.
The server remains authoritative; the app contains no PayPal credentials or payment adapter.

## Local checks

Use Flutter 3.47.7 from `.flutter-version` with Dart 3.13.5.
The lockfile pins the resolved plugin graph.
From this directory:

```sh
flutter pub get --enforce-lockfile
dart format --output=none --set-exit-if-changed lib test integration_test test_driver
flutter analyze
flutter test
flutter build ios --simulator --debug
flutter build apk --debug
```

The native dependencies provide Firebase messaging, biometric confirmation and platform secure storage.
Flutter widgets, `ChangeNotifier` and Dart's HTTP client handle the remaining behavior without another state, routing or HTTP dependency.
Widget and controller fixtures are synthetic; passing them does not establish real push delivery, biometric hardware behavior or sandbox execution.
The integration fixture is a separate test entrypoint and never runs from `lib/main.dart`.

## Configure a personal device

No Firebase project, APNs credential, enrollment token or public endpoint is included.
Builds without Firebase configuration open an explanatory setup screen and disable enrollment.
Use only the operator's approved personal Spendwall Firebase project.
The generated identifiers are `dev.spendwall.spendwallApprover` on iOS and `dev.spendwall.spendwall_approver` on Android; confirm these before registration.

1. Add the corresponding Firebase `GoogleService-Info.plist` to `ios/Runner/` and `google-services.json` to `android/app/`.
   These paths are ignored by Git.
   The iOS build copies its optional file into the bundle; the Android build applies the Google services plugin only when its file exists.
2. Configure the matching Apple team and provisioning locally, enable Push Notifications and connect APNs to that same Firebase project.
   The checked-in push entitlement is for development; distribution signing and production APNs configuration remain outside this change.
3. Enable device biometrics and allow notifications.
   The app requires an APNs token on iOS and an FCM registration token before enrollment.
   It retains the HTTP v1 registration-token API for compatibility with the existing server, rather than switching the backend to Firebase's new direct-send FID contract.
4. Provision a device ID and one-use enrollment credential using the [approval API setup](../../docs/approval-api.md).
   Enter the service origin, device ID and credential in the app.
   The one-use credential is cleared from the form before registration and is never persisted.

Follow the [Firebase setup](https://firebase.google.com/docs/flutter/setup) and [messaging client](https://firebase.google.com/docs/cloud-messaging/flutter/client) instructions for the registered apps.
The repository does not create cloud resources or install to a physical device during these checks.

## Connection and session limits

The API currently listens on loopback and rejects non-local Host/Origin values.
A physical-device connection needs a separately approved private routing arrangement that preserves those server checks.
Do not expose the API publicly or change its bind address to make a demo work.
The app normally accepts only an HTTPS origin without a path, query, fragment or user information.
For an explicitly local debug run, `--dart-define=ALLOW_LOOPBACK_HTTP=true` also permits HTTP on `localhost`, `127.0.0.1` or `::1`.
Android debug network configuration allows only those loopback names; release builds do not enable this Dart option.
An Android emulator needs an explicitly configured local port forward to reach a host service.
No tunnel or device port forward is created automatically.

The server issues a session for at most 15 minutes.
The app stores it in platform secure storage with a conservative local deadline and clears local state after expiry, HTTP 401 or changed push registration.
Push registration changes during enrollment or session restoration also prevent stale session activation.
Re-enrollment needs a newly provisioned one-use credential; there is no refresh-token flow.
Biometrics gate the app's own actions but do not attest the device to the server or protect a stolen bearer token from use elsewhere.

The app blocks actions during authentication, backgrounding, expiry and completed requests.
After biometric confirmation it reloads the request and compares the facts the user saw.
Changed facts require another review.
Before sending a decision, it persists an unresolved marker so a restart cannot offer a blind retry.
Refresh also reads each unresolved request by ID, keeping its result accessible in the queue even after the server removes it from pending requests.
The marker clears only after its non-pending detail is opened or refreshed in the detail view.
An uncertain outcome permits read-only refresh; an unknown or failed execution needs administrator reconciliation.
Approval notifications carry only an approval ID and generic visible text; they never authorize a decision.
A stale or duplicate notification opens the authenticated current state.

## Dispute deadline notice

The [dispute deadline alert outbox](../../docs/dispute-policy.md#deadline-alert-outbox) for [issue 28](https://github.com/AndrewDongminYoo/spendwall/issues/28) sends a push whose data has exactly `dispute_id` and `stage` (`due_soon` or `overdue`).
Opening that push, or launching the app from it, shows a read-only "Dispute response due" notice with the dispute ID and the deadline stage that the server classified when it created the alert.
The app validates the ID with the server's rule and ignores any other payload shape; an approval push is never read as a dispute notice and the reverse.
The notice states that the deadline must be handled outside this app and can only be dismissed.
It needs no session, makes no server or network request, asks for no biometrics, offers no dispute action and is not persisted, so it disappears after dismissal or an app restart.
The app ignores a dispute push received while it is in the foreground; it does not start a refresh or show the notice.
There is no server dispute list API, no scheduler that re-evaluates disputes and no physical-device verification of this notice.

## Remaining acceptance

Keep issue 15 open until an authorized physical device receives a real push, opens the request, authenticates biometrically and observes the bound sandbox refund result.
Also verify expired/completed request actions, notification permission denial, app restart, backgrounding during authentication and push registration rotation on both native platforms.
Firebase/APNs configuration, the private device-to-server path and physical-device acceptance remain unverified.
Delivery and opening of a real dispute deadline push on a physical device are also unverified; issue 28 stays open for that, the scheduler and live sandbox disputes.
Actual deployment and trial issuance remain deferred.
