import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'model.dart';

abstract interface class SessionStore {
  Future<String?> read();
  Future<void> write(String value);
  Future<void> clear();
}

abstract interface class Biometrics {
  Future<bool> available();
  Future<bool> confirm();
  Future<void> cancel();
}

class ApproverController extends ChangeNotifier {
  ApproverController({
    required this.gateway,
    required this.store,
    required this.biometrics,
    required this.pushToken,
    DateTime Function()? clock,
    this.allowLoopbackHttp = false,
  }) : clock = clock ?? DateTime.now;
  final ApprovalGateway Function(Uri) gateway;
  final SessionStore store;
  final Biometrics biometrics;
  final Future<String> Function() pushToken;
  final DateTime Function() clock;
  final bool allowLoopbackHttp;
  bool connected = false, working = false;
  bool _supported = false, _background = false, _disposed = false;
  int _epoch = 0, _authEpoch = 0;
  ApprovalGateway? _api;
  Map<String, dynamic>? _session;
  String? _latestPush;
  final Set<String> _unresolved = {};
  Future<void> _storage = Future<void>.value();
  Approval? selected;
  List<Approval> items = [];
  List<String>? summary;
  bool summarizing = false;
  String? message, nextCursor;

  /// Read-only notice from an opened dispute push; never stored or sent.
  DisputeNotice? dispute;
  bool get uncertain => _unresolved.contains(selected?.id);
  bool get biometricAvailable => _supported;
  String get endpoint => _session?['endpoint'] as String? ?? '';
  String get _token => _session!['token'] as String;
  bool get _live =>
      connected &&
      clock().isBefore(DateTime.parse(_session!['expires'] as String));
  bool get canDecide =>
      _live &&
      !_background &&
      !working &&
      _supported &&
      !uncertain &&
      (selected?.actionableAt(clock()) ?? false);
  void _emit() {
    if (!_disposed) notifyListeners();
  }

  bool _current(int epoch) => !_disposed && epoch == _epoch && _live;
  Future<void> _save() {
    final value = _session == null
        ? null
        : jsonEncode({..._session!, 'unresolved': _unresolved.toList()});
    final operation = _storage.then(
      (_) => value == null ? store.clear() : store.write(value),
    );
    _storage = operation.catchError((Object _) {});
    return operation;
  }

  Future<void> restore() async {
    if (working || connected) return;
    working = true;
    final epoch = ++_epoch;
    try {
      final raw = await store.read();
      if (raw == null) return;
      final value = jsonDecode(raw) as Map<String, dynamic>;
      final origin = serverOrigin(
        value['endpoint'] as String,
        allowLoopbackHttp: allowLoopbackHttp,
      );
      final token = value['token'];
      final unresolved = value['unresolved'] as List;
      if (origin == null ||
          token is! String ||
          token.isEmpty ||
          token.length > 8192 ||
          !clock().isBefore(DateTime.parse(value['expires'] as String)) ||
          unresolved.any((id) => !validApprovalId(id)) ||
          await pushToken() != value['push']) {
        throw const FormatException();
      }
      _supported = await biometrics.available();
      if (_disposed || epoch != _epoch) return;
      if (_latestPush != null && _latestPush != value['push']) {
        throw const FormatException();
      }
      _session = value;
      _api = gateway(origin);
      _unresolved.addAll(unresolved.cast<String>());
      connected = true;
    } on Object {
      if (epoch == _epoch) await disconnect();
      message = 'Session unavailable. Enroll again with a new credential.';
    } finally {
      working = false;
      _emit();
    }
    if (connected) await refresh();
  }

  Future<void> enroll(String endpoint, String device, String credential) async {
    if (working || connected) return;
    final origin = serverOrigin(endpoint, allowLoopbackHttp: allowLoopbackHttp);
    if (origin == null ||
        !RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(device) ||
        credential.isEmpty) {
      message =
          'Enter a valid HTTPS service, device ID and one-use credential.';
      _emit();
      return;
    }
    working = true;
    message = null;
    final epoch = ++_epoch, started = clock();
    _emit();
    try {
      final push = await pushToken();
      if (push.isEmpty) throw const ApiFailure();
      _supported = await biometrics.available();
      if (!_supported) {
        message = 'Set up biometrics on this device before enrolling.';
        return;
      }
      if (_latestPush != null && _latestPush != push) throw const ApiFailure();
      final api = gateway(origin);
      final result = await api.enroll(device, credential, push);
      if (_disposed || epoch != _epoch) return;
      if (_latestPush != null && _latestPush != push) throw const ApiFailure();
      final expires = started.add(Duration(seconds: result.expiresIn));
      if (!clock().isBefore(expires)) throw const ApiFailure();
      _session = {
        'endpoint': origin.toString(),
        'device': device,
        'token': result.token,
        'push': push,
        'expires': expires.toUtc().toIso8601String(),
      };
      await _save();
      if (_disposed || epoch != _epoch) return;
      _api = api;
      connected = true;
    } on Object {
      if (epoch == _epoch) {
        await disconnect();
        message = 'Enrollment failed. Check setup and obtain a new one-use credential.';
      }
    } finally {
      working = false;
      _emit();
    }
    if (connected) await refresh();
  }

  Future<void> open(String id) async {
    if (!_live || working || !validApprovalId(id)) return;
    working = true;
    selected = null;
    summary = null;
    message = null;
    final epoch = _epoch;
    _emit();
    try {
      final detail = await _api!.detail(_token, id);
      if (_current(epoch)) await _acceptDetail(detail);
    } on Object catch (error) {
      if (_current(epoch)) await _error(error);
    } finally {
      working = false;
      _emit();
    }
  }

  Future<void> _acceptDetail(Approval detail) async {
    selected = detail;
    if (detail.status != 'pending' && _unresolved.remove(detail.id)) {
      await _save();
    }
  }

  Future<void> decide(String decision) async {
    if (!canDecide || !['approve', 'deny'].contains(decision)) return;
    final displayed = selected!, epoch = _epoch, authEpoch = _authEpoch;
    final api = _api!, token = _token;
    working = true;
    message = null;
    _emit();
    try {
      final authenticated = await biometrics.confirm();
      if (!_current(epoch) || authEpoch != _authEpoch || _background) return;
      if (!authenticated) {
        message = 'Authentication cancelled. No decision was sent.';
        return;
      }
      if (!displayed.actionableAt(clock())) return;
      final fresh = await api.detail(token, displayed.id);
      if (!_current(epoch) || authEpoch != _authEpoch || _background) return;
      await _acceptDetail(fresh);
      if (fresh.binding != displayed.binding) {
        summary = null;
        message = 'Request details changed. Review the updated facts before deciding.';
        return;
      }
      if (!fresh.actionableAt(clock())) return;
      // Save ambiguity before sending so a restart cannot offer a blind retry.
      _unresolved.add(displayed.id);
      await _save();
      if (!_current(epoch) || authEpoch != _authEpoch || _background) return;
      await api.decide(token, displayed, decision);
      if (!_current(epoch)) return;
      final result = await api.detail(token, displayed.id);
      if (_current(epoch)) await _acceptDetail(result);
    } on Object catch (error) {
      if (_current(epoch)) {
        await _error(error);
        if (connected) {
          message = uncertain
              ? 'Outcome unconfirmed. Refresh to read the result; do not submit again.'
              : 'Authentication or verification failed. No decision was sent.';
        }
      }
    } finally {
      working = false;
      _emit();
    }
  }

  Future<void> refresh({bool more = false}) async {
    if (!_live || working) return;
    working = true;
    final epoch = _epoch;
    _emit();
    try {
      final page = await _api!.pending(
        _token,
        cursor: more ? nextCursor : null,
      );
      if (!_current(epoch)) return;
      final recovered = <String, Approval>{};
      for (final id in _unresolved.toList()) {
        final detail = await _api!.detail(_token, id);
        if (!_current(epoch)) return;
        recovered[id] = detail;
      }
      items = List.unmodifiable(
        {
          if (more) ...{for (final item in items) item.id: item},
          ...{for (final item in page.items) item.id: item},
          ...recovered,
        }.values,
      );
      nextCursor = page.nextCursor;
      final id = selected?.id;
      if (id != null) {
        final detail = await _api!.detail(_token, id);
        if (_current(epoch)) {
          if (selected?.binding != detail.binding) summary = null;
          await _acceptDetail(detail);
        }
      }
    } on Object catch (error) {
      if (_current(epoch)) await _error(error);
    } finally {
      working = false;
      _emit();
    }
  }

  Future<void> requestSummary() async {
    if (!_live || selected == null || summarizing) return;
    final epoch = _epoch, id = selected!.id, binding = selected!.binding;
    summarizing = true;
    _emit();
    try {
      final result = await _api!.summary(_token, id);
      if (_current(epoch) &&
          selected?.id == id &&
          selected?.binding == binding) {
        summary = result;
        if (result == null) {
          message = 'AI reference unavailable. Review the original facts.';
        }
      }
    } on Object catch (error) {
      if (_current(epoch)) await _error(error);
    } finally {
      summarizing = false;
      _emit();
    }
  }

  Future<void> _error(Object error) async {
    if (error is ApiFailure && error.status == 401) {
      await disconnect();
      message = 'Session expired. Enroll again with a new credential.';
    } else {
      message = 'Could not verify the request. Refresh when the service is available.';
    }
  }

  Future<void> disconnect() async {
    ++_epoch;
    ++_authEpoch;
    connected = false;
    _session = null;
    _api = null;
    _unresolved.clear();
    selected = null;
    items = [];
    summary = null;
    nextCursor = null;
    _emit();
    try {
      await biometrics.cancel();
    } on Object {
      /* Local invalidation already occurred. */
    }
    try {
      await _save();
    } on Object {
      message = 'Secure storage could not be cleared. Check device storage before enrolling.';
    }
    _emit();
  }

  Future<void> pushChanged(String token) async {
    _latestPush = token;
    if (_session != null && token != _session?['push']) {
      await disconnect();
      message =
          'Push registration changed. Enroll again with a new credential.';
      _emit();
    }
  }

  /// Shows a dispute push as a notice and reports whether the data was one.
  /// It does not need a session and makes no API call.
  bool disputeHint(Map<String, dynamic> data) {
    final notice = notificationDisputeNotice(data);
    if (notice == null) return false;
    dispute = notice;
    _emit();
    return true;
  }

  void dismissDispute() {
    dispute = null;
    _emit();
  }

  void back() {
    if (working) return;
    selected = null;
    summary = null;
    message = null;
    _emit();
  }

  void pause() {
    _background = true;
    ++_authEpoch;
    unawaited(biometrics.cancel().catchError((Object _) {}));
    _emit();
  }

  Future<void> resume() async {
    _background = false;
    tick();
    try {
      _supported = await biometrics.available();
    } on Object {
      _supported = false;
    }
    _emit();
    if (_live) await refresh();
  }

  void tick() {
    if (connected && !_live) {
      unawaited(disconnect());
      message = 'Session expired. Enroll again with a new credential.';
    }
    _emit();
  }

  @override
  void dispose() {
    _disposed = true;
    ++_epoch;
    ++_authEpoch;
    super.dispose();
  }
}
