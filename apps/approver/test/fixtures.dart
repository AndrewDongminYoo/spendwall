const approvalId = '00000000-0000-4000-8000-000000000001';
const otherApprovalId = '00000000-0000-4000-8000-000000000002';
final testNow = DateTime.utc(2026, 10, 16, 12);

Map<String, dynamic> approvalJson({String status = 'pending'}) => {
  'approval_id': approvalId,
  'status': status,
  'execution_state': status == 'approved' ? 'succeeded' : null,
  'execution_id': status == 'approved' ? otherApprovalId : null,
  'result': null,
  'args_hash': 'a' * 64,
  'args': {
    'capture_id': 'CAPTURE12345678901',
    'note_to_payer': 'Duplicate charge for order 1042',
  },
  'context': {
    'agent': {'id': 'support'},
    'customer': {'id': 'customerA'},
    'merchant': {'id': 'merchantA'},
    'amount': {'value': '125.40', 'currency': 'USD'},
  },
  'matched_rules': ['refund-requires-human'],
  'policy_version': 'b' * 64,
  'created_at': '2026-10-16T11:55:00.000Z',
  'expires_at': '2026-10-16T12:10:00.000Z',
};
