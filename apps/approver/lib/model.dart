import 'dart:convert';

final _uuid = RegExp(
  r'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
  caseSensitive: false,
);
final _hash = RegExp(r'^[a-f0-9]{64}$');

bool validApprovalId(Object? value) => value is String && _uuid.hasMatch(value);

String? notificationApprovalId(Map<String, dynamic> data) =>
    data.length == 1 && validApprovalId(data['approval_id'])
    ? (data['approval_id'] as String).toLowerCase()
    : null;

// Mirrors the server's disputeIdentifier rule (apps/firewall/src/context/dispute.ts).
final _disputeId = RegExp(r'^[A-Za-z0-9-]{1,255}$');

/// A dispute deadline alert read from push data; it grants no authority.
class DisputeNotice {
  const DisputeNotice._(this.disputeId, this.stage);
  final String disputeId;

  /// The stage the server classified when it recorded the alert:
  /// `due_soon` or `overdue`.
  final String stage;
}

DisputeNotice? notificationDisputeNotice(Map<String, dynamic> data) {
  final id = data['dispute_id'], stage = data['stage'];
  return data.length == 2 &&
          id is String &&
          _disputeId.hasMatch(id) &&
          (stage == 'due_soon' || stage == 'overdue')
      ? DisputeNotice._(id, stage as String)
      : null;
}

Uri? serverOrigin(String value, {bool allowLoopbackHttp = false}) {
  final uri = Uri.tryParse(value);
  if (uri == null ||
      value != value.trim() ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      (uri.path.isNotEmpty && uri.path != '/') ||
      uri.hasQuery ||
      uri.hasFragment ||
      uri.port < 1 ||
      uri.port > 65535) {
    return null;
  }
  final loopback = ['127.0.0.1', 'localhost', '::1'].contains(uri.host);
  if (uri.scheme != 'https' &&
      !(allowLoopbackHttp && uri.scheme == 'http' && loopback)) {
    return null;
  }
  return uri.replace(path: '');
}

String _text(Object? value, {int max = 1024}) {
  if (value is! String || value.isEmpty || value.length > max) {
    throw const FormatException('Invalid approval data.');
  }
  return value;
}

DateTime _time(Object? value) {
  final text = _text(value, max: 24);
  final date = DateTime.tryParse(text);
  if (date == null || !date.isUtc || date.toIso8601String() != text) {
    throw const FormatException('Invalid approval time.');
  }
  return date;
}

Object? _ordered(Object? value) {
  if (value is Map<String, dynamic>) {
    return {
      for (final key in value.keys.toList()..sort()) key: _ordered(value[key]),
    };
  }
  if (value is List) return value.map(_ordered).toList();
  return value;
}

class Approval {
  Approval._({
    required this.id,
    required this.status,
    required this.executionState,
    required this.executionId,
    required this.refundId,
    required this.argsHash,
    required this.arguments,
    required this.captureId,
    required this.amount,
    required this.agentId,
    required this.customerId,
    required this.merchantId,
    required this.rules,
    required this.policyVersion,
    required this.createdAt,
    required this.expiresAt,
    required this.binding,
  });

  final String id, status, argsHash, arguments, captureId, amount;
  final String agentId, customerId, merchantId, policyVersion, binding;
  final String? executionState, executionId, refundId;
  final List<String> rules;
  final DateTime createdAt, expiresAt;

  bool actionableAt(DateTime now) =>
      status == 'pending' && executionState == null && now.isBefore(expiresAt);

  static Approval? parse(Object? value) {
    try {
      if (value is! Map<String, dynamic>) return null;
      final id = _text(value['approval_id']);
      final state = _text(value['status']);
      final execution = value['execution_state'];
      final executionId = value['execution_id'];
      final hash = _text(value['args_hash']);
      final version = _text(value['policy_version']);
      if (!validApprovalId(id) ||
          !['pending', 'approved', 'denied', 'expired'].contains(state) ||
          ![
            null,
            'in_flight',
            'succeeded',
            'failed',
            'unknown',
          ].contains(execution) ||
          !_hash.hasMatch(hash) ||
          !_hash.hasMatch(version) ||
          (state == 'approved' ? execution == null : execution != null) ||
          (execution != null && !validApprovalId(executionId)) ||
          (execution == null && executionId != null)) {
        return null;
      }
      final args = value['args'] as Map<String, dynamic>;
      final capture = _text(args['capture_id'], max: 32);
      final context = value['context'] as Map<String, dynamic>;
      final money = context['amount'] as Map<String, dynamic>;
      final amount = _text(money['value'], max: 12);
      if (money['currency'] != 'USD' ||
          !RegExp(r'^\d{1,9}\.\d{2}$').hasMatch(amount) ||
          BigInt.parse(amount.replaceAll('.', '')) <= BigInt.zero) {
        return null;
      }
      final agent = _text((context['agent'] as Map)['id']);
      final customer = _text((context['customer'] as Map)['id']);
      final merchant = _text((context['merchant'] as Map)['id']);
      final rawRules = value['matched_rules'] as List;
      if (rawRules.isEmpty || rawRules.length > 256) return null;
      final rules = List<String>.unmodifiable(
        rawRules.map((r) => _text(r, max: 256)),
      );
      final created = _time(value['created_at']);
      final expires = _time(value['expires_at']);
      if (!expires.isAfter(created)) return null;
      final result = value['result'];
      final refundId = result == null ? null : _text((result as Map)['id']);
      return Approval._(
        id: id.toLowerCase(),
        status: state,
        executionState: execution as String?,
        executionId: executionId as String?,
        refundId: refundId,
        argsHash: hash,
        arguments: const JsonEncoder.withIndent('  ').convert(args),
        captureId: capture,
        amount: amount,
        agentId: agent,
        customerId: customer,
        merchantId: merchant,
        rules: rules,
        policyVersion: version,
        createdAt: created,
        expiresAt: expires,
        binding: jsonEncode(
          _ordered({
            for (final field in [
              'approval_id',
              'args_hash',
              'args',
              'context',
              'matched_rules',
              'policy_version',
              'created_at',
              'expires_at',
            ])
              field: value[field],
          }),
        ),
      );
    } on Object {
      return null;
    }
  }
}
