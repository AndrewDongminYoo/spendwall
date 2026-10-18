import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';

import 'controller.dart';
import 'model.dart';

class SecureSessionStore implements SessionStore {
  static const _key = 'spendwall.approver.session.v1';
  final _storage = const FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.unlocked_this_device,
    ),
    aOptions: AndroidOptions(resetOnError: false),
  );
  @override
  Future<String?> read() => _storage.read(key: _key);
  @override
  Future<void> write(String value) => _storage.write(key: _key, value: value);
  @override
  Future<void> clear() => _storage.delete(key: _key);
}

class NativeBiometrics implements Biometrics {
  final _auth = LocalAuthentication();
  @override
  Future<bool> available() async =>
      await _auth.canCheckBiometrics &&
      (await _auth.getAvailableBiometrics()).isNotEmpty;
  @override
  Future<bool> confirm() => _auth.authenticate(
    localizedReason:
        'Confirm your Spendwall decision for the request you reviewed.',
    biometricOnly: true,
    sensitiveTransaction: true,
    persistAcrossBackgrounding: false,
  );
  @override
  Future<void> cancel() async {
    await _auth.stopAuthentication();
  }
}

class PushInbox {
  FirebaseMessaging? _messaging;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  ApproverController? _controller;
  String? _pending;
  bool _scheduled = false;

  Future<String?> initialize() async {
    try {
      // Native configuration is optional for local builds, mandatory for enrollment.
      await Firebase.initializeApp();
      _messaging = FirebaseMessaging.instance;
      await _messaging!.setForegroundNotificationPresentationOptions(
        alert: false,
        badge: false,
        sound: false,
      );
      return null;
    } on Object {
      return 'Firebase setup required. Add the app configuration before connecting a device.';
    }
  }

  Future<String> token() async {
    final messaging = _messaging;
    if (messaging == null) throw StateError('Push configuration unavailable.');
    final permission = await messaging.requestPermission(
      alert: true,
      badge: false,
      sound: true,
      provisional: false,
    );
    if (permission.authorizationStatus != AuthorizationStatus.authorized) {
      throw StateError('Notification permission required.');
    }
    if (Platform.isIOS && await messaging.getAPNSToken() == null) {
      throw StateError('APNs registration unavailable.');
    }
    // The server uses HTTP v1 message.token, not the new direct-send FID contract.
    // ignore: deprecated_member_use
    final token = await messaging.getToken();
    if (token == null || token.isEmpty) {
      throw StateError('Push registration unavailable.');
    }
    return token;
  }

  Future<void> attach(ApproverController controller) async {
    if (_messaging == null) return;
    _controller = controller;
    controller.addListener(_drain);
    _subscriptions.add(
      FirebaseMessaging.onMessageOpenedApp.listen(
        (message) => _hint(message.data),
      ),
    );
    _subscriptions.add(
      FirebaseMessaging.onMessage.listen((message) {
        if (notificationApprovalId(message.data) != null) {
          unawaited(controller.refresh());
        }
      }),
    );
    // Keep the same registration-token contract as getToken above.
    _subscriptions.add(
      // ignore: deprecated_member_use
      _messaging!.onTokenRefresh.listen(
        (token) => unawaited(controller.pushChanged(token)),
      ),
    );
    final initial = await _messaging!.getInitialMessage();
    if (initial != null) _hint(initial.data);
  }

  void _hint(Map<String, dynamic> data) {
    if (_controller?.disputeHint(data) ?? false) return;
    final id = notificationApprovalId(data);
    if (id == null) return;
    _pending = id;
    _drain();
  }

  void _drain() {
    final controller = _controller;
    if (_scheduled ||
        _pending == null ||
        controller == null ||
        !controller.connected ||
        controller.working) {
      return;
    }
    _scheduled = true;
    scheduleMicrotask(() {
      _scheduled = false;
      if (_controller != controller ||
          !controller.connected ||
          controller.working) {
        return;
      }
      final id = _pending;
      _pending = null;
      if (id != null) unawaited(controller.open(id));
    });
  }

  Future<void> dispose() async {
    _controller?.removeListener(_drain);
    _controller = null;
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
  }
}
