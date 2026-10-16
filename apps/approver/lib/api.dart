import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'model.dart';

class ApiFailure implements Exception {
  const ApiFailure([this.status]);
  final int? status;
  @override
  String toString() => 'Approval service unavailable.';
}

class ApprovalPage {
  const ApprovalPage(this.items, this.nextCursor);
  final List<Approval> items;
  final String? nextCursor;
}

class Enrollment {
  const Enrollment(this.token, this.expiresIn);
  final String token;
  final int expiresIn;
}

abstract interface class ApprovalGateway {
  Future<Enrollment> enroll(
    String deviceId,
    String credential,
    String pushToken,
  );
  Future<ApprovalPage> pending(String token, {String? cursor});
  Future<Approval> detail(String token, String id);
  Future<void> decide(String token, Approval approval, String decision);
  Future<List<String>?> summary(String token, String id);
}

class ApprovalApi implements ApprovalGateway {
  ApprovalApi(this.origin, {this.timeout = const Duration(seconds: 10)});
  final Uri origin;
  final Duration timeout;

  @override
  Future<Enrollment> enroll(
    String deviceId,
    String credential,
    String pushToken,
  ) async {
    final body = await _request(
      '/devices/register',
      credential,
      body: {'device_id': deviceId, 'fcm_token': pushToken},
      accepted: {201},
    );
    final token = body['access_token'], seconds = body['expires_in'];
    if (body['token_type'] != 'Bearer' ||
        token is! String ||
        token.length > 8192 ||
        !RegExp(r'^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
            .hasMatch(token) ||
        seconds is! int ||
        seconds < 1 ||
        seconds > 900) {
      throw const ApiFailure();
    }
    return Enrollment(token, seconds);
  }

  @override
  Future<ApprovalPage> pending(String token, {String? cursor}) async {
    if (cursor != null && !validApprovalId(cursor)) throw const ApiFailure();
    final body = await _request(
      '/approvals',
      token,
      query: {'status': 'pending', 'limit': '20', 'cursor': ?cursor},
    );
    final rows = body['items'], next = body['next_cursor'];
    if (rows is! List ||
        rows.length > 20 ||
        (next != null && !validApprovalId(next)) ||
        !body.containsKey('next_cursor')) {
      throw const ApiFailure();
    }
    final items = rows.map(Approval.parse).toList();
    if (items.any((item) => item == null || item.status != 'pending') ||
        items.map((item) => item!.id).toSet().length != items.length) {
      throw const ApiFailure();
    }
    return ApprovalPage(
      List.unmodifiable(items.cast<Approval>()),
      next as String?,
    );
  }

  @override
  Future<Approval> detail(String token, String id) async {
    if (!validApprovalId(id)) throw const ApiFailure();
    final detail = Approval.parse(await _request('/approvals/$id', token));
    if (detail == null || detail.id != id.toLowerCase()) {
      throw const ApiFailure();
    }
    return detail;
  }

  @override
  Future<void> decide(String token, Approval approval, String decision) async {
    if (!['approve', 'deny'].contains(decision)) throw const ApiFailure();
    final body = await _request(
      '/approvals/${approval.id}/decision',
      token,
      body: {'decision': decision, 'args_hash': approval.argsHash},
      accepted: {200, 202},
    );
    if (body['approval_id'] != approval.id ||
        !['approved', 'denied'].contains(body['status'])) {
      throw const ApiFailure();
    }
  }

  @override
  Future<List<String>?> summary(String token, String id) async {
    if (!validApprovalId(id)) return null;
    final body = await _request('/approvals/$id/summary', token, body: {});
    final sentences = body['sentences'];
    if (body['status'] != 'available' ||
        body['advisory'] != true ||
        body['label'] != 'AI-generated reference only; not authorization' ||
        sentences is! List ||
        sentences.length < 2 ||
        sentences.length > 3 ||
        sentences.any((s) => s is! String || s.isEmpty || s.length > 1000)) {
      return null;
    }
    return List<String>.unmodifiable(sentences);
  }

  Future<Map<String, dynamic>> _request(
    String path,
    String token, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
    Set<int> accepted = const {200},
  }) async {
    if (token.isEmpty ||
        token.length > 8192 ||
        RegExp(r'[\x00-\x20\x7f]').hasMatch(token)) {
      throw const ApiFailure();
    }
    final client = HttpClient()..connectionTimeout = timeout;
    try {
      final work = () async {
        final request = await client.openUrl(
          body == null ? 'GET' : 'POST',
          origin.replace(path: path, queryParameters: query),
        );
        request.followRedirects = false;
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
        request.headers.set(HttpHeaders.acceptHeader, 'application/json');
        if (body != null) {
          request.headers.contentType = ContentType.json;
          request.write(jsonEncode(body));
        }
        final response = await request.close();
        if (!accepted.contains(response.statusCode)) {
          throw ApiFailure(response.statusCode);
        }
        if (response.headers.contentType?.mimeType != 'application/json') {
          throw const ApiFailure();
        }
        final bytes = <int>[];
        await for (final chunk in response) {
          if (bytes.length + chunk.length > 1024 * 1024) {
            throw const ApiFailure();
          }
          bytes.addAll(chunk);
        }
        final data = jsonDecode(utf8.decode(bytes));
        if (data is! Map<String, dynamic>) throw const ApiFailure();
        return data;
      }();
      return await work.timeout(timeout);
    } on ApiFailure {
      rethrow;
    } on Object {
      throw const ApiFailure();
    } finally {
      client.close(force: true);
    }
  }
}
