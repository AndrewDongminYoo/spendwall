import 'package:spendwall_approver/api.dart';
import 'package:spendwall_approver/controller.dart';
import 'package:spendwall_approver/model.dart';

import 'fixtures.dart';

class MemoryStore implements SessionStore {
  String? value;
  bool failWrites = false;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String value) async {
    if (failWrites) throw StateError('storage unavailable');
    this.value = value;
  }

  @override
  Future<void> clear() async => value = null;
}

class ControlledBiometrics implements Biometrics {
  bool supported = true;
  int confirmations = 0;
  Future<bool> Function() authenticate = () async => true;
  @override
  Future<bool> available() async => supported;
  @override
  Future<bool> confirm() {
    confirmations++;
    return authenticate();
  }

  @override
  Future<void> cancel() async {}
}

class ControlledGateway implements ApprovalGateway {
  Map<String, dynamic> current = approvalJson();
  final decisions = <(String, String, String)>[];
  Future<void> Function()? beforeDecision;
  Future<void> Function()? beforeEnrollment;
  Object? readError;
  int reads = 0, pages = 0;
  @override
  Future<Enrollment> enroll(
    String deviceId,
    String credential,
    String pushToken,
  ) async {
    await beforeEnrollment?.call();
    return const Enrollment('header.payload.signature', 900);
  }

  @override
  Future<ApprovalPage> pending(String token, {String? cursor}) async {
    pages++;
    return ApprovalPage(
      current['status'] == 'pending' ? [Approval.parse(current)!] : [],
      null,
    );
  }

  @override
  Future<Approval> detail(String token, String id) async {
    reads++;
    if (readError != null) throw readError!;
    return Approval.parse(current)!;
  }

  @override
  Future<void> decide(String token, Approval approval, String decision) async {
    decisions.add((approval.id, approval.argsHash, decision));
    await beforeDecision?.call();
    current = approvalJson(
      status: decision == 'approve' ? 'approved' : 'denied',
    );
  }

  @override
  Future<List<String>?> summary(String token, String id) async => null;
}
