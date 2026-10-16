import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'api.dart';
import 'app.dart';
import 'controller.dart';
import 'native_services.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final inbox = PushInbox();
  final setupMessage = await inbox.initialize();
  final controller = ApproverController(
    gateway: ApprovalApi.new,
    store: SecureSessionStore(),
    biometrics: NativeBiometrics(),
    pushToken: inbox.token,
    allowLoopbackHttp:
        kDebugMode && const bool.fromEnvironment('ALLOW_LOOPBACK_HTTP'),
  );
  runApp(ApproverApp(controller: controller, setupMessage: setupMessage));
  if (setupMessage == null) {
    await inbox.attach(controller);
    unawaited(controller.restore());
  }
}
