import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:spendwall_approver/app.dart';
import 'package:spendwall_approver/controller.dart';

import '../test/fixtures.dart';
import '../test/support.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('synthetic approval UI on a native simulator', (tester) async {
    final api = ControlledGateway();
    final controller = ApproverController(
      gateway: (_) => api,
      store: MemoryStore(),
      biometrics: ControlledBiometrics(),
      pushToken: () async => 'synthetic-push',
      clock: () => testNow,
    );
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Banner(
          message: 'SYNTHETIC',
          location: BannerLocation.topEnd,
          child: ApproverApp(controller: controller),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Connect your device'), findsOneWidget);
    await binding.takeScreenshot('01-enrollment');
    await controller.enroll(
      'https://synthetic.invalid',
      'deviceA',
      'synthetic-credential',
    );
    await tester.pumpAndSettle();
    expect(find.text('Requests to review'), findsOneWidget);
    await binding.takeScreenshot('02-queue');
    await tester.tap(find.text('USD 125.40'));
    await tester.pumpAndSettle();
    expect(find.text('Review required'), findsOneWidget);
    await binding.takeScreenshot('03-detail');
    await tester.scrollUntilVisible(
      find.textContaining('AI-generated reference only'),
      350,
      scrollable: find
          .descendant(
            of: find.byType(SingleChildScrollView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.pumpAndSettle();
    await binding.takeScreenshot('04-policy-reference');
    await tester.tap(find.byTooltip('Back to requests'));
    await tester.pumpAndSettle();
    await controller.open(approvalId);
    await tester.pumpAndSettle();
    api.current = approvalJson(status: 'expired');
    await controller.refresh();
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Approve refund'),
          )
          .onPressed,
      isNull,
    );
    await binding.takeScreenshot('05-expired');
    api.current = approvalJson(status: 'approved')
      ..['execution_state'] = 'unknown';
    await controller.refresh();
    await tester.pumpAndSettle();
    expect(find.text('Execution unknown'), findsOneWidget);
    await binding.takeScreenshot('06-unknown');
    api.current = approvalJson();
    await controller.refresh();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Approve refund'));
    await tester.pumpAndSettle();
    expect(api.decisions, hasLength(1));
    expect(find.text('Refund completed'), findsOneWidget);
    await binding.takeScreenshot('07-completed');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
