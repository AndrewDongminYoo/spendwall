import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPolicy } from '../packages/policy/src/index.ts';
import { DeviceAuthority } from '../apps/firewall/src/approver/identity.ts';
import {
  DisputeEvents,
  DisputeTracker,
  nextCheck,
  reviewNote,
} from '../apps/firewall/src/disputes/tracking.ts';
import { fixture as disputeFixture } from './helpers/dispute-fixture.mjs';

const minute = 60_000,
  hour = 3_600_000,
  day = 86_400_000;
const now = Date.parse('2026-10-16T12:00:00.000Z');
const key = '7'.repeat(64);
const policy = () =>
  loadPolicy(`agents:
  support:
    tools:
      allow: [accept_dispute_claim]
      deny: []
rules:
  - id: acceptance
    when: tool == "accept_dispute_claim"
    then: require_approval
default: deny
`);
const devices = (merchantId = 'MERCHANT12345') =>
  new DeviceAuthority(
    {
      connect: async () => {
        throw new Error('no database');
      },
    },
    {
      identityKey: key,
      signingKey: '8'.repeat(64),
      merchantId,
      devices: () => [],
    },
  );
const iso = (ms) => new Date(ms).toISOString();

test('the schedule follows the review deadline classification', () => {
  // scheduled: the earlier of dueAt - 24h and now + 24h.
  assert.equal(
    nextCheck('scheduled', now, { dueAt: iso(now + 3 * day) }),
    now + day,
  );
  assert.equal(
    nextCheck('scheduled', now, { dueAt: iso(now + day + hour) }),
    now + hour,
  );
  assert.equal(
    nextCheck('due_soon', now, { dueAt: iso(now + hour) }),
    now + hour,
  );
  assert.equal(nextCheck('overdue', now, { dueAt: iso(now) }), undefined);
  assert.equal(nextCheck('resolved', now), undefined);
  assert.equal(nextCheck('not_provided', now), now + day);
  assert.equal(nextCheck('policy_denied', now), now + day);
  assert.throws(() => nextCheck('scheduled', now));
  assert.throws(() => nextCheck('due_soon', now, { dueAt: '2026-10-17' }));
});
test('a dispute that cannot be accepted is read hourly only inside the 24-hour window', () => {
  const due = now + 2 * day;
  assert.equal(nextCheck('not_acceptable', now), now + day);
  assert.equal(
    nextCheck('not_acceptable', now, { dueAt: iso(due) }),
    now + day,
  );
  assert.equal(
    nextCheck('not_acceptable', due - day - hour, { dueAt: iso(due) }),
    due - day,
  );
  assert.equal(
    nextCheck('not_acceptable', due - day, { dueAt: iso(due) }),
    due - day + hour,
  );
  assert.equal(
    nextCheck('not_acceptable', due - 1, { dueAt: iso(due) }),
    due - 1 + hour,
  );
  assert.equal(
    nextCheck('not_acceptable', due, { dueAt: iso(due) }),
    due + day,
  );
});
test('failed evaluations back off from one minute, doubling, capped at one hour', () => {
  const delays = [1, 2, 3, 4, 5, 6, 7, 50].map(
    (failures) => nextCheck('unmapped', now, { failures }) - now,
  );
  assert.deepEqual(delays, [
    minute,
    2 * minute,
    4 * minute,
    8 * minute,
    16 * minute,
    32 * minute,
    hour,
    hour,
  ]);
  assert.equal(
    nextCheck('dispute_unavailable', now, { failures: 2 }),
    now + 2 * minute,
  );
  assert.throws(() => nextCheck('unmapped', now, { failures: 0 }));
});
test('the review note satisfies the captured accept_dispute_claim pattern', () => {
  assert.match(reviewNote, /^[A-Za-z0-9_-]{1,255}$/);
});
test('the receiver and tracker derive the same keyed merchant reference', () => {
  const events = new DisputeEvents({
    identityKey: key,
    merchantId: 'MERCHANT12345',
    adapterRef: 'a'.repeat(64),
  });
  assert.equal(events.merchantRef, devices().merchantRef());
  assert.notEqual(events.merchantRef, devices('merchantB').merchantRef());
  for (const options of [
    {
      identityKey: 'short',
      merchantId: 'MERCHANT12345',
      adapterRef: 'a'.repeat(64),
    },
    {
      identityKey: key,
      merchantId: 'bad merchant',
      adapterRef: 'a'.repeat(64),
    },
    {
      identityKey: key,
      merchantId: 'MERCHANT12345',
      adapterRef: 'A'.repeat(64),
    },
  ])
    assert.throws(() => new DisputeEvents(options), /configuration/);
});
test('a tracker without a trusted lookup, or for another merchant, is refused', () => {
  const { resolver } = disputeFixture();
  const options = {
    pool: { connect: async () => assert.fail('no database call') },
    devices: devices(),
    resolver,
    policy: policy(),
    agentId: 'support',
    saleCustomer: async () => undefined,
  };
  assert.ok(new DisputeTracker(options));
  for (const change of [
    { saleCustomer: undefined },
    { saleCustomer: { id: 'customer-1' } },
    { devices: devices('merchantB') },
    { agentId: 'bad agent' },
    { agentId: undefined },
    { policy: undefined },
  ])
    assert.throws(
      () => new DisputeTracker({ ...options, ...change }),
      /configuration/,
    );
});
