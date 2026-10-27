# Approver iOS edge checks

## Scope and revision

On October 27, 2026, between 07:18 and 07:55 UTC, the operator ran the iOS checks of [#103](https://github.com/AndrewDongminYoo/spendwall/issues/103) on an iPhone 16 Pro with the personal Firebase/APNs configuration.
The app was a release build of branch `fix/103-notification-permission-message` at `f2569371b547d43598c6c8c34858d509614f3467`, installed over the existing app with `flutter run --release`; the install output had no `Uninstalling` line.
The server was `apps/agent-demo/src/recording-index.ts` with `--fcm spendwall-approver`, synthetic payments and the tailnet HTTPS forwarder, under Node 24.22.1.
Android is not covered.

The operator reported each screen; the session read the server state from the run's disposable PostgreSQL database (`approvals.requests`, `approvals.devices`, `approvals.used_enrollments`).
Every enrollment used a new one-use credential whose digest replaced the device's `enrollmentHash` in the private configuration during the run, as the [recording runbook](../recording-approval.md) allows; no credential was printed.

## Results

| Check                                   | What the operator saw                                                                                                                                                                                                                           | Server evidence                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Backgrounding during Face ID            | After Approve, with the Face ID sheet open and the camera covered, the operator swiped home and returned: `Authentication cancelled. No decision was sent.`                                                                                     | Request `9d340fb6-e37f-4260-b87f-7f525aca1da5` stayed `pending` with no execution state.                   |
| App restart with a live session         | After a force quit and relaunch, the queue showed the same request.                                                                                                                                                                             | —                                                                                                          |
| Notification permission denied          | With **Allow Notifications** off, one Connect press showed `Allow notifications for this app in Settings, then enroll again. The credential was not used.`                                                                                      | The consumed-enrollment count stayed at 3 and the device generation at 3, so that credential was not used. |
| Enrollment after allowing notifications | The same credential then enrolled successfully.                                                                                                                                                                                                 | Consumed at 07:30:47 UTC; generation 4.                                                                    |
| Expired request                         | With the request's detail open across its 07:33:49 UTC expiry, both actions became disabled.                                                                                                                                                    | The runner printed `status: expired` with `synthetic executions=0`.                                        |
| Restart after session expiry            | After 07:45:47 UTC (15 minutes after enrollment), a force quit and relaunch showed the enrollment screen without earlier data.                                                                                                                  | —                                                                                                          |
| Reinstallation                          | After a fresh enrollment at 07:52:40 UTC, the operator deleted the app; the session reinstalled it with `flutter run --release`. On launch the app showed the enrollment screen with `Session unavailable. Enroll again with a new credential.` | —                                                                                                          |

## Interpretation and limits

The notification check first appeared to fail: a credential was consumed at 07:27:45 UTC although the new message was shown.
The consistent explanation is a second Connect press made while notifications were still allowed, so the check was repeated with a new credential and exactly one press, and that credential stayed unused.
An earlier credential had been consumed at 07:22:17 UTC, before notifications were turned off; a later attempt with it showed what the operator described as a wrong-credential failure, which is expected for a used credential.

The reinstallation result shows that the stored session survived deletion (otherwise `restore()` returns without a message) and that `restore()` rejected it.
The session was still within its 15-minute window and pointed at the same server, so the rejection came from the push check: either the new install's registration token differed from the stored one or it was not yet available.
The message does not separate those two cases, and no token value was recorded.
`controller_test.dart` covers the explicit `pushChanged` path with a rotated token.

The notification-permission message comes from #109; before that change the same denial showed the generic enrollment failure.
Payments were synthetic, and no PayPal request was made.
After the run the recording server was stopped, its database removed, the private configuration restored to its original device digest and sandbox object, and the extra credentials deleted.
The reinstalled build stays on the phone without a session.
