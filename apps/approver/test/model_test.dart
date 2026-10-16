import 'package:flutter_test/flutter_test.dart';
import 'package:spendwall_approver/model.dart';

import 'fixtures.dart';

void main() {
  test('reads the authoritative pending and completed API projections', () {
    expect(Approval.parse(approvalJson()), isNotNull);
    expect(Approval.parse(approvalJson(status: 'approved')), isNotNull);
    expect(Approval.parse(approvalJson(status: 'expired')), isNotNull);
    expect(Approval.parse(approvalJson(status: 'denied')), isNotNull);
  });

  test('missing binding, invalid money and unknown states fail closed', () {
    for (final field in [
      'args_hash',
      'matched_rules',
      'policy_version',
      'expires_at',
      'context',
    ]) {
      expect(Approval.parse(approvalJson()..remove(field)), isNull);
    }
    for (final invalid in [
      approvalJson()..['status'] = 'authorized-by-ai',
      approvalJson()..['args_hash'] = 'not-a-hash',
      approvalJson()..['expires_at'] = '2026-02-31T12:10:00.000Z',
      approvalJson()..['execution_state'] = 'unknown',
      approvalJson()..['matched_rules'] = [42],
    ]) {
      expect(Approval.parse(invalid), isNull);
    }
    for (final money in ['-1', 'NaN', '0.00', '1.234', '1e9']) {
      final invalid = approvalJson();
      invalid['context']['amount']['value'] = money;
      expect(Approval.parse(invalid), isNull);
    }
  });

  test(
    'only HTTPS origins or an explicit debug loopback origin are accepted',
    () {
      expect(
        serverOrigin('https://approvals.example'),
        Uri.https('approvals.example'),
      );
      expect(
        serverOrigin('http://127.0.0.1:3002', allowLoopbackHttp: true),
        Uri.parse('http://127.0.0.1:3002'),
      );
      for (final invalid in [
        'http://127.0.0.1:3002',
        'http://approvals.example',
        'https://user:secret@approvals.example',
        'https://approvals.example/path',
        'https://approvals.example?token=value',
        'https://approvals.example#fragment',
        'https://approvals.example:0',
      ]) {
        expect(serverOrigin(invalid), isNull, reason: invalid);
      }
      expect(
        serverOrigin('http://192.168.1.2:3002', allowLoopbackHttp: true),
        isNull,
      );
    },
  );

  test('push data selects one valid UUID and grants no authority', () {
    expect(notificationApprovalId({'approval_id': approvalId}), approvalId);
    expect(
      notificationApprovalId({'approval_id': '../devices/register'}),
      isNull,
    );
    expect(
      notificationApprovalId({'approval_id': approvalId, 'approve': true}),
      isNull,
    );
    expect(notificationApprovalId({'approval_id': 123}), isNull);
  });
}
