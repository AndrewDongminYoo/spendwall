import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { prepareEvent } from '../apps/firewall/src/audit/event.ts';
import { AuditLog } from '../apps/firewall/src/audit/index.ts';

const event = {
  agentId: 'support-agent',
  tool: 'create_refund',
  args: { amount: { value: '5.00', currency_code: 'USD' } },
  resolvedCtx: { amount_minor: 500, status: 'COMPLETED' },
  decision: 'allow',
  matchedRules: ['small-refund'],
  policyVersion: 'a'.repeat(64),
  latencyMs: 12,
  eventKind: 'tool_call',
};

test('canonical original args hash is stable and distinct from redacted args', () => {
  const one = prepareEvent({ ...event, args: { b: 'private', a: 1 } });
  const two = prepareEvent({ ...event, args: { a: 1, b: 'private' } });
  assert.equal(one.args_hash, two.args_hash);
  assert.equal(
    one.args_hash,
    createHash('sha256').update('{"a":1,"b":"private"}').digest('hex'),
  );
  assert.deepEqual(one.args_redacted, {});
  assert.notEqual(
    one.args_hash,
    prepareEvent({ ...event, args: { a: 1 } }).args_hash,
  );
});

test('credentials, PII, arbitrary keys and free text never enter persisted fields', () => {
  const secret = 'synthetic-private-value';
  const prepared = prepareEvent({
    ...event,
    args: {
      ...event.args,
      headers: { Authorization: secret },
      password: secret,
      email: 'person@example.invalid',
      arbitrary: secret,
      [secret]: secret,
      note: secret,
      status: secret,
      value: secret,
      amount_minor: secret,
      currency_code: secret,
      amount: { value: '5.00', currency_code: 'USD', token: secret },
    },
    resolvedCtx: {
      ...event.resolvedCtx,
      access_token: secret,
      customer: { email: secret },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(prepared),
    /synthetic-private|person@|Authorization|password|customer/,
  );
  assert.deepEqual(prepared.args_redacted, {
    amount: { value: '5.00', currency_code: 'USD' },
  });
  assert.deepEqual(prepared.resolved_ctx, event.resolvedCtx);
});

test('invalid JSON and malformed metadata fail without echoing input', () => {
  const cycle = {};
  cycle.amount = cycle;
  for (const args of [
    cycle,
    { x: undefined },
    { x: Infinity },
    { x: 1n },
    new Date(),
    { x: () => 1 },
    JSON.parse('{"__proto__":{"x":1}}'),
  ]) {
    assert.throws(
      () => prepareEvent({ ...event, args }),
      /Invalid audit event/,
    );
  }
  for (const changes of [
    { decision: 'approve' },
    { eventKind: 'unknown' },
    { latencyMs: -1 },
    { policyVersion: 'secret' },
    { upstreamStatus: 999 },
    { upstreamResultRef: 'https://private.example/secret' },
    { approvalId: 'raw-private-value' },
    { tool: 'Bearer private-value' },
    { matchedRules: ['secret\nvalue'] },
    { eventKind: 'approval_created' },
  ])
    assert.throws(
      () => prepareEvent({ ...event, ...changes }),
      /Invalid audit event/,
    );
  let called = false;
  const accessor = {
    get amount() {
      called = true;
      return {};
    },
  };
  assert.throws(
    () => prepareEvent({ ...event, args: accessor }),
    /Invalid audit event/,
  );
  assert.equal(called, false);
});

test('numeric identifiers survive only as value in a validated amount/currency pair', () => {
  for (const input of [
    { value: '123456' },
    { value: '123456', currency: 'USD' },
    { amount: { value: '123456' } },
    { amount: { value: '123456', currency_code: 'ZZZ' } },
    { amount: { value: '123456', currency_code: 'USD', currency: 'EUR' } },
    { amount: { value: '5.25', currency_code: 'KRW' } },
  ]) {
    const prepared = prepareEvent({
      ...event,
      args: input,
      resolvedCtx: input,
    });
    assert.doesNotMatch(JSON.stringify(prepared.args_redacted), /123456|5\.25/);
    assert.doesNotMatch(JSON.stringify(prepared.resolved_ctx), /123456|5\.25/);
  }
  for (const amount of [
    { value: '5.00', currency_code: 'USD' },
    { value: '5.00', currency: 'EUR' },
    { value: '500', currency: 'KRW' },
  ])
    assert.deepEqual(
      prepareEvent({ ...event, args: { amount } }).args_redacted,
      { amount },
    );
});

test('input limits reject oversized and excessively nested data', () => {
  assert.throws(
    () => prepareEvent({ ...event, args: { note: 'x'.repeat(70_000) } }),
    /Invalid audit event/,
  );
  let args = {};
  for (let i = 0; i < 40; i++) args = { amount: args };
  assert.throws(() => prepareEvent({ ...event, args }), /Invalid audit event/);
});

test('nested payment containers retain safe fields while arbitrary keys and item text are discarded', () => {
  const input = {
    capture: {
      amount: { value: '5.00', currency_code: 'USD' },
      remaining_minor: 500,
      status: 'COMPLETED',
      email: 'private-nested',
    },
    order: {
      items: [
        {
          refund: {
            amount: { value: '1.00', currency: 'EUR' },
            note: 'private-nested',
          },
        },
        'private-nested',
      ],
    },
    'private-nested': { value: '123456', token: 'private-nested' },
  };
  const expected = {
    capture: {
      amount: { value: '5.00', currency_code: 'USD' },
      remaining_minor: 500,
      status: 'COMPLETED',
    },
    order: {
      items: [{ refund: { amount: { value: '1.00', currency: 'EUR' } } }],
    },
  };
  const prepared = prepareEvent({ ...event, args: input, resolvedCtx: input });
  assert.deepEqual(prepared.args_redacted, expected);
  assert.deepEqual(prepared.resolved_ctx, expected);
  assert.doesNotMatch(JSON.stringify(prepared), /private-nested|123456/);
});

test('order ids, sandbox approve links and Orders v2 statuses are retained only in their validated shapes', () => {
  const link =
    'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T';
  const input = {
    order: {
      order_id: '5O190127TN364715T',
      approve_url: link,
      status: 'CREATED',
      token: 'private-order',
    },
    order_id: 'private-order',
    approve_url: 'https://www.paypal.com/checkoutnow?token=private-order',
    status: 'APPROVED',
    links: [{ rel: 'approve', href: link }],
  };
  const expected = {
    order: {
      order_id: '5O190127TN364715T',
      approve_url: link,
      status: 'CREATED',
    },
    status: 'APPROVED',
  };
  const prepared = prepareEvent({ ...event, args: input, resolvedCtx: input });
  assert.deepEqual(prepared.args_redacted, expected);
  assert.deepEqual(prepared.resolved_ctx, expected);
  assert.doesNotMatch(
    JSON.stringify(prepared),
    /private-order|www\.paypal\.com/,
  );
  for (const approve_url of [
    `https://www.sandbox.paypal.com/${'a'.repeat(482)}`,
    'https://www.sandbox.paypal.com/checkout now',
    'https://www.sandbox.paypal.com/',
    'http://www.sandbox.paypal.com/checkoutnow',
  ])
    assert.deepEqual(
      prepareEvent({ ...event, args: { approve_url } }).args_redacted,
      {},
      approve_url,
    );
});

test('database append failures expose no payload, credentials or database error details', async () => {
  const log = new AuditLog({
    async query() {
      throw new Error('private-database-credential and SQL payload');
    },
  });
  await assert.rejects(
    log.append(event),
    (error) =>
      error.message === 'Audit append failed.' && error.cause === undefined,
  );
});
