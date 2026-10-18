import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:spendwall_approver/app.dart';
import 'package:spendwall_approver/api.dart';
import 'package:spendwall_approver/controller.dart';

import 'support.dart' show ControlledGateway, ControlledBiometrics, MemoryStore;
import 'fixtures.dart';

void main() {
  late ControlledGateway api;
  late ControlledBiometrics auth;
  late ApproverController controller;
  setUp(() {
    api = ControlledGateway();
    auth = ControlledBiometrics();
    controller = ApproverController(
      gateway: (_) => api,
      store: MemoryStore(),
      biometrics: auth,
      pushToken: () async => 'push',
      clock: () => testNow,
    );
  });
  tearDown(() => controller.dispose());
  Future<void> detail(WidgetTester tester) async {
    await tester.runAsync(() async {
      await controller.enroll('https://example.com', 'deviceA', 'credential');
      await controller.open(approvalId);
    });
    await tester.pumpWidget(ApproverApp(controller: controller));
  }

  testWidgets('enrollment explains setup and conceals the one-use credential', (
    tester,
  ) async {
    await tester.pumpWidget(
      ApproverApp(
        controller: controller,
        setupMessage: 'Firebase setup required.',
      ),
    );
    expect(find.text('Connect your device'), findsOneWidget);
    expect(find.text('Firebase setup required.'), findsOneWidget);
    final credential = tester.widget<TextField>(
      find.byKey(const Key('credential')),
    );
    expect(credential.obscureText, isTrue);
    expect(credential.enableSuggestions, isFalse);
  });
  testWidgets(
    'detail presents amount, original facts, rules and advisory below actions',
    (tester) async {
      await detail(tester);
      expect(find.text('USD 125.40'), findsOneWidget);
      expect(find.text('customerA'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('refund-requires-human'),
        200,
        scrollable: find
            .descendant(
              of: find.byType(SingleChildScrollView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(find.text('refund-requires-human'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.textContaining('AI-generated reference only'),
        200,
        scrollable: find
            .descendant(
              of: find.byType(SingleChildScrollView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(
        find.textContaining('AI-generated reference only'),
        findsOneWidget,
      );
      expect(find.text('Approve refund'), findsOneWidget);
      expect(find.text('Deny request'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'cancel and uncertain result remain visible without a second POST',
    (tester) async {
      await detail(tester);
      auth.authenticate = () async => false;
      await tester.runAsync(() async {
        await tester.tap(find.text('Approve refund'));
        await Future<void>.delayed(const Duration(milliseconds: 10));
      });
      await tester.pumpAndSettle();
      expect(find.textContaining('Authentication cancelled'), findsOneWidget);
      expect(api.decisions, isEmpty);
      auth.authenticate = () async => true;
      api.beforeDecision = () async => throw const ApiFailure();
      await tester.runAsync(() async {
        await tester.tap(find.text('Approve refund'));
        await Future<void>.delayed(const Duration(milliseconds: 10));
      });
      await tester.pumpAndSettle();
      expect(find.text('Outcome unconfirmed'), findsOneWidget);
      final approve = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Approve refund'),
      );
      expect(approve.onPressed, isNull);
      await tester.runAsync(controller.refresh);
      await tester.pumpAndSettle();
      expect(api.decisions, hasLength(1));
    },
  );
  testWidgets('expired and unknown execution states disable decisions', (
    tester,
  ) async {
    api.current = approvalJson(status: 'expired');
    await detail(tester);
    expect(find.text('Expired'), findsWidgets);
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Approve refund'),
          )
          .onPressed,
      isNull,
    );
    api.current = approvalJson(status: 'approved')
      ..['execution_state'] = 'unknown';
    await tester.runAsync(controller.refresh);
    await tester.pumpAndSettle();
    expect(find.text('Execution unknown'), findsOneWidget);
    expect(find.textContaining('Do not retry'), findsOneWidget);
    expect(api.decisions, isEmpty);
  });
  testWidgets('small screen with large text and long facts does not overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 700);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    api.current['context']['customer']['id'] = 'long-customer-' * 30;
    await tester.runAsync(() async {
      await controller.enroll('https://example.com', 'deviceA', 'credential');
      await controller.open(approvalId);
    });
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(textScaler: TextScaler.linear(2)),
        child: ApproverApp(controller: controller),
      ),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a dispute notice is read-only and dismisses', (tester) async {
    controller.disputeHint({'dispute_id': 'PP-D-27803', 'stage': 'due_soon'});
    await tester.pumpWidget(ApproverApp(controller: controller));
    final notice = find.byKey(const Key('dispute-notice'));
    expect(notice, findsOneWidget);
    expect(
      find.descendant(of: notice, matching: find.text('PP-D-27803')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: notice, matching: find.text('Due within 24 hours')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: notice, matching: find.byType(FilledButton)),
      findsNothing,
    );
    expect(
      find.descendant(of: notice, matching: find.byType(OutlinedButton)),
      findsNothing,
    );
    expect(find.text('Approve refund'), findsNothing);
    expect(find.text('Deny request'), findsNothing);
    controller.disputeHint({'dispute_id': 'PP-D-27803', 'stage': 'overdue'});
    await tester.pump();
    expect(
      find.descendant(of: notice, matching: find.text('Overdue')),
      findsOneWidget,
    );
    await tester.tap(find.text('Dismiss notice'));
    await tester.pump();
    expect(find.byKey(const Key('dispute-notice')), findsNothing);
    expect(find.text('Connect your device'), findsOneWidget);
    expect(api.reads, 0);
    expect(api.pages, 0);
    expect(auth.confirmations, 0);
  });

  testWidgets('a dispute notice opened while scrolled down is shown', (
    tester,
  ) async {
    await detail(tester);
    final scrollable = find.byType(Scrollable).first;
    await tester.scrollUntilVisible(
      find.text('Load optional reference'),
      200,
      scrollable: scrollable,
    );
    expect(
      tester.state<ScrollableState>(scrollable).position.pixels,
      greaterThan(0),
    );
    controller.disputeHint({'dispute_id': 'PP-D-27803', 'stage': 'overdue'});
    await tester.pump();
    await tester.pump();
    expect(tester.state<ScrollableState>(scrollable).position.pixels, 0);
    expect(
      find.byKey(const Key('dispute-notice')).hitTestable(),
      findsOneWidget,
    );
    expect(find.text('PP-D-27803').hitTestable(), findsOneWidget);
  });

  testWidgets('a long dispute ID with large text does not overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 700);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    controller.disputeHint({'dispute_id': 'A' * 255, 'stage': 'overdue'});
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(textScaler: TextScaler.linear(2)),
        child: ApproverApp(controller: controller),
      ),
    );
    expect(find.byKey(const Key('dispute-notice')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a recovered completed outcome can be opened from the queue', (
    tester,
  ) async {
    await detail(tester);
    api.beforeDecision = () async {
      api.current = approvalJson(status: 'approved');
      throw const ApiFailure();
    };
    await tester.runAsync(() async {
      await controller.decide('approve');
      controller.back();
      await controller.refresh();
    });
    await tester.pumpAndSettle();
    expect(find.text('Refund completed'), findsOneWidget);
    await tester.runAsync(() async {
      await tester.tap(find.text('USD 125.40'));
    });
    await tester.pumpAndSettle();
    expect(find.text('REFUND REQUEST'), findsOneWidget);
    expect(controller.canDecide, isFalse);
    expect(api.decisions, hasLength(1));
  });
}
