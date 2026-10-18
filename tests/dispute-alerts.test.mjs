import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FcmSender } from '../apps/firewall/src/approver/fcm.ts';

const approval = '00000000-0000-4000-8000-000000000001';
function sender(
  response = () =>
    Response.json({ name: 'projects/synthetic-project/messages/one' }),
) {
  const seen = [];
  let tokens = 0;
  return {
    seen,
    tokens: () => tokens,
    fcm: new FcmSender({
      projectId: 'synthetic-project',
      getAccessToken: async () => {
        tokens++;
        return 'synthetic-google-token';
      },
      fetchImpl: async (url, options) => {
        seen.push({ url, options });
        return response();
      },
    }),
  };
}

test('dispute deadline push carries only the dispute ID and stage', async () => {
  for (const stage of ['due_soon', 'overdue']) {
    const s = sender();
    await s.fcm.sendDisputeDeadline(
      'synthetic-device-token',
      'PP-D-SYNTHETIC',
      stage,
    );
    assert.equal(s.seen.length, 1);
    assert.equal(
      s.seen[0].url,
      'https://fcm.googleapis.com/v1/projects/synthetic-project/messages:send',
    );
    assert.equal(s.seen[0].options.method, 'POST');
    assert.equal(s.seen[0].options.redirect, 'error');
    assert.equal(
      s.seen[0].options.headers.authorization,
      'Bearer synthetic-google-token',
    );
    assert.deepEqual(JSON.parse(s.seen[0].options.body), {
      message: {
        token: 'synthetic-device-token',
        data: { dispute_id: 'PP-D-SYNTHETIC', stage },
        notification: {
          title: 'Dispute response due',
          body: 'Open Spendwall to review the dispute deadline.',
        },
      },
    });
  }
});

test('invalid dispute IDs, stages and tokens are refused before any request', async () => {
  for (const [token, dispute, stage] of [
    ['synthetic-device-token', 'PP-D/../other', 'due_soon'],
    ['synthetic-device-token', '', 'due_soon'],
    ['synthetic-device-token', 'A'.repeat(256), 'due_soon'],
    ['synthetic-device-token', 42, 'due_soon'],
    ['synthetic-device-token', 'PP-D-SYNTHETIC', 'scheduled'],
    ['synthetic-device-token', 'PP-D-SYNTHETIC', 'not_provided'],
    ['synthetic-device-token', 'PP-D-SYNTHETIC', undefined],
    ['bad token', 'PP-D-SYNTHETIC', 'overdue'],
    ['', 'PP-D-SYNTHETIC', 'overdue'],
  ]) {
    const s = sender();
    await assert.rejects(
      s.fcm.sendDisputeDeadline(token, dispute, stage),
      (error) =>
        error.name === 'FcmFailure' &&
        error.message === 'Notification unavailable.' &&
        error.retryable === false,
    );
    assert.equal(s.seen.length, 0);
    assert.equal(s.tokens(), 0);
  }
});

test('an unregistered device ends dispute delivery while other errors retry', async () => {
  for (const [status, body, retryable] of [
    [503, { error: { status: 'UNAVAILABLE' } }, true],
    [404, { error: { status: 'NOT_FOUND' } }, true],
    [
      404,
      {
        error: {
          status: 'NOT_FOUND',
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'UNREGISTERED',
            },
          ],
        },
      },
      false,
    ],
  ]) {
    const s = sender(() => Response.json(body, { status }));
    await assert.rejects(
      s.fcm.sendDisputeDeadline(
        'synthetic-device-token',
        'PP-D-SYNTHETIC',
        'overdue',
      ),
      (error) =>
        error.message === 'Notification unavailable.' &&
        error.retryable === retryable,
    );
  }
});

test('dispute push keeps the response-name, size and Retry-After checks', async () => {
  for (const response of [
    () => Response.json({ name: 'projects/other-project/messages/wrong' }),
    () => new Response('x'.repeat(9000), { status: 200 }),
  ]) {
    const s = sender(response);
    await assert.rejects(
      s.fcm.sendDisputeDeadline(
        'synthetic-device-token',
        'PP-D-SYNTHETIC',
        'due_soon',
      ),
      (error) => error.retryable === true,
    );
  }
  const limited = sender(() => Response.json({ error: {} }, { status: 429 }));
  await assert.rejects(
    limited.fcm.sendDisputeDeadline(
      'synthetic-device-token',
      'PP-D-SYNTHETIC',
      'due_soon',
    ),
    (error) => error.retryable && error.retryAfterSeconds >= 60,
  );
});

test('the approval send payload is unchanged by the dispute path', async () => {
  const s = sender();
  await s.fcm.send('synthetic-device-token', approval);
  assert.deepEqual(JSON.parse(s.seen[0].options.body), {
    message: {
      token: 'synthetic-device-token',
      data: { approval_id: approval },
      notification: {
        title: 'Approval requested',
        body: 'Open Spendwall to review the request.',
      },
    },
  });
  const invalid = sender();
  await assert.rejects(
    invalid.fcm.send('synthetic-device-token', 'PP-D-SYNTHETIC'),
    (error) => error.name === 'FcmFailure' && error.retryable === true,
  );
  assert.equal(invalid.seen.length, 0);
});
