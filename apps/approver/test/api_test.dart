import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:spendwall_approver/api.dart';
import 'package:spendwall_approver/model.dart';

import 'fixtures.dart';

Future<HttpServer> serve(Future<void> Function(HttpRequest) handler) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen(handler);
  addTearDown(() => server.close(force: true));
  return server;
}

Future<void> respond(
  HttpRequest request,
  Object body, {
  int status = 200,
}) async {
  request.response.statusCode = status;
  request.response.headers.contentType = ContentType.json;
  request.response.write(jsonEncode(body));
  await request.response.close();
}

Uri origin(HttpServer server) => Uri.parse('http://127.0.0.1:${server.port}');

void main() {
  test(
    'real HTTP enrolls, reads owned pages and posts only the bound decision',
    () async {
      final observed = <List<Object?>>[];
      final server = await serve((request) async {
        final text = await utf8.decoder.bind(request).join();
        observed.add([
          request.uri.toString(),
          request.headers.value('authorization')!,
          text.isEmpty ? null : jsonDecode(text),
        ]);
        switch (request.uri.path) {
          case '/devices/register':
            await respond(request, {
              'access_token': 'header.payload.signature',
              'token_type': 'Bearer',
              'expires_in': 900,
            }, status: 201);
          case '/approvals':
            await respond(request, {
              'items': [approvalJson()],
              'next_cursor': otherApprovalId,
            });
          case '/approvals/$approvalId':
            await respond(request, approvalJson());
          case '/approvals/$approvalId/decision':
            await respond(request, {
              'approval_id': approvalId,
              'status': 'approved',
              'execution_state': 'in_flight',
              'execution_id': otherApprovalId,
              'result': null,
            }, status: 202);
        }
      });
      final api = ApprovalApi(origin(server));
      final enrolled = await api.enroll(
        'deviceA',
        'private-enrollment',
        'push-address',
      );
      final page = await api.pending(enrolled.token);
      expect(page.items.single.id, approvalId);
      expect(page.nextCursor, otherApprovalId);
      final detail = await api.detail(enrolled.token, approvalId);
      await api.decide(enrolled.token, detail, 'approve');
      expect(observed, [
        [
          '/devices/register',
          'Bearer private-enrollment',
          {'device_id': 'deviceA', 'fcm_token': 'push-address'},
        ],
        [
          '/approvals?status=pending&limit=20',
          'Bearer header.payload.signature',
          null,
        ],
        ['/approvals/$approvalId', 'Bearer header.payload.signature', null],
        [
          '/approvals/$approvalId/decision',
          'Bearer header.payload.signature',
          {'decision': 'approve', 'args_hash': 'a' * 64},
        ],
      ]);
    },
  );

  test(
    'redirects never forward bearer credentials to another endpoint',
    () async {
      var redirected = 0;
      final target = await serve((request) async {
        redirected++;
        await respond(request, approvalJson());
      });
      final source = await serve((request) async {
        request.response.statusCode = 307;
        request.response.headers.set(
          'location',
          '${origin(target)}/approvals/$approvalId',
        );
        await request.response.close();
      });
      await expectLater(
        ApprovalApi(origin(source)).detail('secret-session', approvalId),
        throwsA(isA<ApiFailure>()),
      );
      expect(redirected, 0);
    },
  );

  test(
    'timed out decisions are sent once and provider text stays private',
    () async {
      var posts = 0;
      final server = await serve((request) async {
        posts++;
        await request.drain<void>();
        await Future<void>.delayed(const Duration(milliseconds: 150));
        await respond(request, {'error': 'private-provider-data'}, status: 503);
      });
      final api = ApprovalApi(
        origin(server),
        timeout: const Duration(milliseconds: 50),
      );
      await expectLater(
        api.decide('session', Approval.parse(approvalJson())!, 'approve'),
        throwsA(isA<ApiFailure>()),
      );
      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(posts, 1);
      expect(
        const ApiFailure(503).toString(),
        isNot(contains('private-provider-data')),
      );
    },
  );

  test(
    'malformed or mismatched detail, cursor and oversized bodies fail closed',
    () async {
      Object body = approvalJson()..['approval_id'] = otherApprovalId;
      final server = await serve((request) => respond(request, body));
      final api = ApprovalApi(origin(server));
      await expectLater(
        api.detail('session', approvalId),
        throwsA(isA<ApiFailure>()),
      );
      body = {
        'items': [approvalJson()],
        'next_cursor': '../devices/register',
      };
      await expectLater(api.pending('session'), throwsA(isA<ApiFailure>()));
      body = {'items': [], 'next_cursor': null, 'padding': 'x' * 1100000};
      await expectLater(api.pending('session'), throwsA(isA<ApiFailure>()));
    },
  );

  test(
    'summary keeps the fixed advisory contract and never invokes a decision',
    () async {
      final paths = <String>[];
      Object body = {
        'status': 'available',
        'advisory': true,
        'label': 'AI-generated reference only; not authorization',
        'sentences': [
          'Customer reports a duplicate.',
          'Original facts require review.',
        ],
        'risk_flags': [],
      };
      final server = await serve((request) async {
        paths.add(request.uri.path);
        await respond(request, body);
      });
      final api = ApprovalApi(origin(server));
      expect(await api.summary('session', approvalId), hasLength(2));
      body = {
        'status': 'available',
        'advisory': false,
        'label': 'Approved',
        'sentences': ['Pay now'],
        'risk_flags': [],
      };
      expect(await api.summary('session', approvalId), isNull);
      expect(paths, [
        '/approvals/$approvalId/summary',
        '/approvals/$approvalId/summary',
      ]);
    },
  );
}
