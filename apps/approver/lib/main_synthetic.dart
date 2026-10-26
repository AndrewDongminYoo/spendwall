import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'api.dart';
import 'app.dart';
import 'controller.dart';
import 'native_services.dart';

/// Simulator entrypoint for the synthetic recording rehearsal in
/// docs/recording-approval.md. It never initializes Firebase: the push address
/// is a fixed synthetic value and the recording server sends no notification.
/// Biometrics, secure storage and the approval API stay real.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (!kDebugMode) {
    throw StateError('The synthetic entrypoint runs only in debug builds.');
  }
  final controller = ApproverController(
    gateway: ApprovalApi.new,
    store: SecureSessionStore(),
    biometrics: NativeBiometrics(),
    pushToken: () async => 'synthetic-simulator-push',
    allowLoopbackHttp: true,
  );
  runApp(ApproverApp(controller: controller));
  unawaited(_connect(controller));
}

// The Simulator pasteboard is not reliable, so a rehearsal can pass the
// disposable enrollment with --dart-define-from-file instead of typing it.
Future<void> _connect(ApproverController controller) async {
  await controller.restore();
  const endpoint = String.fromEnvironment('SPENDWALL_ENDPOINT');
  const device = String.fromEnvironment('SPENDWALL_DEVICE_ID');
  const credential = String.fromEnvironment('SPENDWALL_ENROLLMENT');
  if (controller.connected || endpoint.isEmpty || credential.isEmpty) return;
  await controller.enroll(endpoint, device, credential);
}
