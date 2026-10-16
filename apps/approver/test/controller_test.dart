import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:spendwall_approver/api.dart';
import 'package:spendwall_approver/controller.dart';

import 'fixtures.dart';
import 'support.dart';

void main() {
  late ControlledGateway api;
  late ControlledBiometrics auth;
  late MemoryStore store;
  late ApproverController controller;
  late DateTime now;
  setUp(() {
    api = ControlledGateway();
    auth = ControlledBiometrics();
    store = MemoryStore();
    now = testNow;
    controller = ApproverController(
      gateway: (_) => api,
      store: store,
      biometrics: auth,
      pushToken: () async => 'push-token',
      clock: () => now,
    );
  });
  tearDown(() => controller.dispose());
  Future<void> connect() async {
    await controller.enroll(
      'https://approvals.example',
      'deviceA',
      'private-one-use-token',
    );
    expect(controller.connected, isTrue);
    await controller.open(approvalId);
    expect(controller.selected?.id, approvalId);
  }

  test('approval authenticates, refreshes facts and submits the displayed hash once', () async {
    await connect();
    final held = Completer<bool>();
    auth.authenticate = () => held.future;
    final deciding = controller.decide('approve');
    await controller.decide('approve');
    expect(controller.canDecide, isFalse);
    expect(api.decisions, isEmpty);
    held.complete(true);
    await deciding;
    expect(auth.confirmations, 1);
    expect(api.decisions, [(approvalId, 'a' * 64, 'approve')]);
    expect(api.reads, 3);
    expect(controller.selected?.executionState, 'succeeded');
    expect(controller.canDecide, isFalse);
    expect(store.value, isNot(contains('private-one-use-token')));
  });

  test(
    'cancelled, unavailable or failed biometrics cannot approve or deny',
    () async {
      await connect();
      for (final decision in ['approve', 'deny']) {
        auth.authenticate = () async => false;
        await controller.decide(decision);
        auth.authenticate = () async => throw StateError('biometric lockout');
        await controller.decide(decision);
      }
      expect(api.decisions, isEmpty);
      auth.supported = false;
      await controller.resume();
      expect(controller.canDecide, isFalse);
    },
  );

  test('expiry during authentication cannot submit a decision', () async {
    await connect();
    final held = Completer<bool>();
    auth.authenticate = () => held.future;
    final deciding = controller.decide('approve');
    now = DateTime.utc(2026, 10, 16, 12, 10);
    controller.tick();
    held.complete(true);
    await deciding;
    expect(api.decisions, isEmpty);
    expect(controller.canDecide, isFalse);
  });

  test(
    'changed authoritative facts after biometrics require another review',
    () async {
      await connect();
      auth.authenticate = () async {
        api.current['context']['amount']['value'] = '500.00';
        return true;
      };
      await controller.decide('approve');
      expect(api.decisions, isEmpty);
      expect(controller.selected?.amount, '500.00');
      expect(controller.message, contains('changed'));
    },
  );

  test('timeout retains uncertainty and refreshing never resubmits', () async {
    await connect();
    api.beforeDecision = () async => throw const ApiFailure();
    await controller.decide('approve');
    expect(controller.uncertain, isTrue);
    await controller.refresh();
    await controller.decide('approve');
    expect(api.decisions, hasLength(1));
    expect(controller.canDecide, isFalse);
    api.current = approvalJson(status: 'approved');
    await controller.refresh();
    expect(controller.uncertain, isFalse);
    expect(controller.selected?.status, 'approved');
  });

  test(
    'backgrounding and session loss invalidate a pending biometric decision',
    () async {
      await connect();
      final held = Completer<bool>();
      auth.authenticate = () => held.future;
      final deciding = controller.decide('approve');
      controller.pause();
      held.complete(true);
      await deciding;
      expect(api.decisions, isEmpty);
      await controller.resume();
      api.readError = const ApiFailure(401);
      await controller.refresh();
      expect(controller.connected, isFalse);
      expect(store.value, isNull);
      expect(controller.selected, isNull);
    },
  );

  test(
    'expired and completed requests never ask for biometric approval',
    () async {
      await connect();
      for (final status in ['expired', 'denied', 'approved']) {
        api.current = approvalJson(status: status);
        await controller.refresh();
        expect(controller.canDecide, isFalse);
        await controller.decide('approve');
      }
      expect(auth.confirmations, 0);
      expect(api.decisions, isEmpty);
    },
  );

  test('session expiry clears storage and failed storage cannot activate a session', () async {
    await connect();
    now = DateTime.utc(2026, 10, 16, 12, 15);
    controller.tick();
    await Future<void>.delayed(Duration.zero);
    expect(controller.connected, isFalse);
    expect(store.value, isNull);
    store.failWrites = true;
    await controller.enroll(
      'https://approvals.example',
      'deviceA',
      'new-private-token',
    );
    expect(controller.connected, isFalse);
  });
  test('restart preserves an ambiguous decision and token rotation revokes it locally', () async {
    await connect();
    api.beforeDecision = () async => throw const ApiFailure();
    await controller.decide('approve');
    final restored = ApproverController(
      gateway: (_) => api,
      store: store,
      biometrics: auth,
      pushToken: () async => 'push-token',
      clock: () => now,
    );
    addTearDown(restored.dispose);
    await restored.restore();
    await restored.open(approvalId);
    expect(restored.uncertain, isTrue);
    await restored.decide('approve');
    expect(api.decisions, hasLength(1));
    await restored.pushChanged('push-token');
    expect(restored.connected, isTrue);
    await restored.pushChanged('rotated-token');
    expect(restored.connected, isFalse);
    expect(store.value, isNull);
  });

  test('a failure to persist decision ambiguity prevents sending', () async {
    await connect();
    store.failWrites = true;
    await controller.decide('deny');
    expect(api.decisions, isEmpty);
    expect(controller.canDecide, isFalse);
  });

  for (final outcome in ['approved', 'denied']) {
    test(
      'restart exposes a lost $outcome outcome outside the pending queue',
      () async {
        await connect();
        api.beforeDecision = () async {
          api.current = approvalJson(status: outcome);
          throw const ApiFailure();
        };
        await controller.decide('approve');
        final restored = ApproverController(
          gateway: (_) => api,
          store: store,
          biometrics: auth,
          pushToken: () async => 'push-token',
          clock: () => now,
        );
        addTearDown(restored.dispose);
        await restored.restore();
        expect(restored.items.map((item) => item.id), contains(approvalId));
        await restored.open(restored.items.single.id);
        expect(restored.selected?.status, outcome);
        expect(restored.uncertain, isFalse);
        await restored.decide('approve');
        expect(api.decisions, hasLength(1));
      },
    );
  }

  test('push rotation during enrollment prevents session activation', () async {
    api.beforeEnrollment = () => controller.pushChanged('rotated-token');
    await controller.enroll(
      'https://approvals.example',
      'deviceA',
      'private-one-use-token',
    );
    expect(controller.connected, isFalse);
    expect(store.value, isNull);
    expect(controller.message, contains('Enrollment failed'));
  });

  test(
    'revocation during post-decision lookup cannot restore a cleared view',
    () async {
      await connect();
      api.beforeDecision = () async {
        await controller.disconnect();
      };
      await controller.decide('approve');
      expect(controller.connected, isFalse);
      expect(controller.selected, isNull);
      expect(store.value, isNull);
    },
  );

  test(
    'a rotated push registration refuses the saved credential on restart',
    () async {
      await connect();
      final restored = ApproverController(
        gateway: (_) => api,
        store: store,
        biometrics: auth,
        pushToken: () async => 'rotated-token',
        clock: () => now,
      );
      addTearDown(restored.dispose);
      await restored.restore();
      expect(restored.connected, isFalse);
      expect(store.value, isNull);
    },
  );
}
