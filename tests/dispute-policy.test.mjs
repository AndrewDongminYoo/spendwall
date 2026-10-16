import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPolicy } from '../packages/policy/src/index.ts';
import { DisputePolicy } from '../apps/firewall/src/disputes/index.ts';
import {
  accept,
  disputeId,
  fixture,
  trusted,
} from './helpers/dispute-fixture.mjs';

test('dispute resolution binds the real merchant transaction and amount before approval', async () => {
  const f = fixture();
  const result = await f.resolver.resolve(accept(), trusted);
  assert.equal(result.ok, true, 'a verified supported dispute must resolve');
  assert.equal(result.amount.usd, 25);
  assert.equal(result.resolvedCtx.dispute.dispute_id, disputeId);
  assert.equal(
    result.resolvedCtx.dispute.seller_transaction_id,
    trusted.customer.seller_transaction_id,
  );
  assert.equal(
    result.resolvedCtx.dispute.status,
    'WAITING_FOR_SELLER_RESPONSE',
  );
  assert.equal(f.seen.length, 1);
});

function policy(decision = 'allow') {
  return loadPolicy(`agents:
  support:
    tools:
      allow: [accept_dispute_claim]
      deny: []
rules:
  - id: acceptance
    when: tool == "accept_dispute_claim"
    then: ${decision}
default: deny
`);
}

test('even a permissive loaded policy requires approval and never grants dispatch', async () => {
  const f = fixture();
  const service = new DisputePolicy({ resolver: f.resolver, now: f.now });
  const result = await service.evaluate(policy(), accept(), trusted);
  assert.equal(result.decision, 'require_approval');
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.reason, 'dispute_acceptance_requires_approval');
  assert.equal(result.review.deadline.status, 'due_soon');
  assert.equal(result.review.context.amount.value, '25.00');
  assert.equal(result.review.bindingHash.length, 64);
  assert.equal(result.approvalId, undefined);
});

const corruptions = [
  [
    'wrong dispute',
    (r) => {
      r.dispute_id = 'PP-D-OTHER';
    },
  ],
  [
    'missing merchant',
    (r) => {
      delete r.disputed_transactions[0].seller.merchant_id;
    },
  ],
  [
    'foreign merchant',
    (r) => {
      r.disputed_transactions[0].seller.merchant_id = 'OTHER';
    },
  ],
  [
    'wrong merchant email',
    (r) => {
      r.disputed_transactions[0].seller.email = 'other@example.invalid';
    },
  ],
  [
    'wrong transaction',
    (r) => {
      r.disputed_transactions[0].seller_transaction_id = 'OTHER';
    },
  ],
  [
    'absent transactions',
    (r) => {
      delete r.disputed_transactions;
    },
  ],
  [
    'empty transactions',
    (r) => {
      r.disputed_transactions = [];
    },
  ],
  [
    'multiple transactions',
    (r) => {
      r.disputed_transactions.push(structuredClone(r.disputed_transactions[0]));
    },
  ],
  [
    'refunded transaction',
    (r) => {
      r.disputed_transactions[0].transaction_status = 'REFUNDED';
    },
  ],
  [
    'coercible transaction status',
    (r) => {
      r.disputed_transactions[0].transaction_status = ['COMPLETED'];
    },
  ],
  [
    'missing amount',
    (r) => {
      delete r.dispute_amount;
    },
  ],
  [
    'zero amount',
    (r) => {
      r.dispute_amount.value = '0';
    },
  ],
  [
    'negative amount',
    (r) => {
      r.dispute_amount.value = '-1';
    },
  ],
  [
    'numeric amount',
    (r) => {
      r.dispute_amount.value = 25;
    },
  ],
  [
    'excess amount',
    (r) => {
      r.dispute_amount.value = '100.01';
    },
  ],
  [
    'currency mismatch',
    (r) => {
      r.disputed_transactions[0].gross_amount.currency_code = 'EUR';
    },
  ],
  [
    'unknown currency',
    (r) => {
      r.dispute_amount.currency_code = 'XYZ';
    },
  ],
  [
    'disputed asset',
    (r) => {
      r.dispute_asset = {};
    },
  ],
  [
    'gross asset',
    (r) => {
      r.disputed_transactions[0].gross_asset = {};
    },
  ],
  [
    'resolved dispute',
    (r) => {
      r.status = 'RESOLVED';
    },
  ],
  [
    'unknown status',
    (r) => {
      r.status = 'OTHER';
    },
  ],
  [
    'missing status',
    (r) => {
      delete r.status;
    },
  ],
  [
    'unknown stage',
    (r) => {
      r.dispute_life_cycle_stage = 'UNKNOWN';
    },
  ],
  [
    'missing capability',
    (r) => {
      delete r.allowed_response_options;
    },
  ],
  [
    'partial only',
    (r) => {
      r.allowed_response_options.accept_claim.accept_claim_types = [
        'PARTIAL_REFUND',
      ];
    },
  ],
  [
    'unknown capability',
    (r) => {
      r.allowed_response_options.accept_claim.accept_claim_types.push(
        'UNKNOWN',
      );
    },
  ],
  [
    'missing link',
    (r) => {
      delete r.links;
    },
  ],
  [
    'foreign link',
    (r) => {
      r.links[0].href = 'https://example.invalid/accept-claim';
    },
  ],
  [
    'wrong link method',
    (r) => {
      r.links[0].method = 'GET';
    },
  ],
  [
    'duplicate link',
    (r) => {
      r.links.push({ ...r.links[0] });
    },
  ],
  [
    'impossible deadline',
    (r) => {
      r.seller_response_due_date = '2026-02-30T12:00:00Z';
    },
  ],
  [
    'null deadline',
    (r) => {
      r.seller_response_due_date = null;
    },
  ],
  [
    'token echo',
    (r) => {
      r.private = 'synthetic-dispute-token';
    },
  ],
];
for (const [name, corrupt] of corruptions)
  test(`dispute rejects ${name}`, async () => {
    const f = fixture();
    corrupt(f.record);
    const result = await f.resolver.resolve(accept(), trusted);
    assert.equal(result.ok, false);
    assert.equal(result.decision, 'deny');
    assert.doesNotMatch(
      JSON.stringify(result),
      /token|buyer|merchant|https:|PRIVATE/,
    );
  });

test('approval policy, deny policy and agent authorization retain their meaning', async () => {
  const f = fixture();
  const service = new DisputePolicy({ resolver: f.resolver, now: f.now });
  assert.equal(
    (await service.evaluate(policy('require_approval'), accept(), trusted))
      .decision,
    'require_approval',
  );
  const denied = await service.evaluate(policy('deny'), accept(), trusted);
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.reason, 'policy_denied');
  assert.equal(denied.review, undefined);
  const unknown = await service.evaluate(policy(), accept(), {
    ...trusted,
    agent: { id: 'unknown' },
  });
  assert.equal(unknown.decision, 'deny');
  assert.equal(unknown.review, undefined);
  const aggregatePolicy = loadPolicy(`agents:
  support:
    tools: { allow: [accept_dispute_claim], deny: [] }
rules:
  - id: needs_trusted_ledger
    when: agg.remaining > 0
    then: allow
default: deny
`);
  assert.equal(
    (
      await service.evaluate(aggregatePolicy, accept(), {
        ...trusted,
        agg: { remaining: 100 },
      })
    ).decision,
    'deny',
  );
});

test('malformed envelopes and unsupported tools fail before any lookup', async () => {
  const f = fixture();
  const service = new DisputePolicy({ resolver: f.resolver });
  for (const input of [
    null,
    {},
    { tool: 'get_dispute', args: { dispute_id: disputeId } },
    { ...accept(), trusted: true },
    {
      tool: 'accept_dispute_claim',
      args: {
        ...accept().args,
        amount: { value: '1.00', currency_code: 'USD' },
      },
    },
    {
      tool: 'accept_dispute_claim',
      args: { dispute_id: '../escape', note: 'valid' },
    },
    {
      tool: 'accept_dispute_claim',
      args: { dispute_id: disputeId, note: 'not allowed by captured schema' },
    },
  ]) {
    const result = await service.evaluate(policy(), input, trusted);
    assert.equal(result.decision, 'deny');
    assert.equal(result.dispatchAllowed, false);
    assert.equal(result.review, undefined);
  }
  let called = false;
  const input = {
    tool: 'accept_dispute_claim',
    get args() {
      called = true;
      return accept().args;
    },
  };
  assert.equal(
    (await service.evaluate(policy(), input, trusted)).decision,
    'deny',
  );
  assert.equal(called, false);
  assert.equal(f.seen.length, 0);
});

test('provider facts can be shared without sharing a caller identity decision', async () => {
  const f = fixture();
  const wrong = {
    ...trusted,
    customer: { ...trusted.customer, seller_transaction_id: 'OTHER' },
  };
  const [a, b] = await Promise.all([
    f.resolver.resolve(accept(), trusted),
    f.resolver.resolve(accept(), wrong),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(f.seen.length, 1);
  const missing = structuredClone(trusted);
  delete missing.customer.seller_transaction_id;
  assert.equal((await f.resolver.resolve(accept(), missing)).ok, false);
  assert.equal((await f.resolver.resolve(accept(), trusted)).ok, true);
});

test('terminal disputes resolve for inspection but never acceptance', async () => {
  const f = fixture();
  f.record.status = 'RESOLVED';
  delete f.record.allowed_response_options;
  delete f.record.links;
  const result = await f.resolver.resolve(
    { tool: 'get_dispute', args: { dispute_id: disputeId } },
    trusted,
  );
  assert.equal(result.ok, true);
  assert.equal(result.resolvedCtx.dispute.can_accept, false);
  assert.equal((await f.resolver.resolve(accept(), trusted)).ok, false);
});

for (const [offset, status] of [
  [-1, 'overdue'],
  [0, 'overdue'],
  [1, 'due_soon'],
  [86_400_000, 'due_soon'],
  [86_400_001, 'scheduled'],
]) {
  test(`seller deadline offset ${offset} is ${status} without authorizing execution`, async () => {
    const f = fixture();
    f.record.seller_response_due_date = new Date(
      f.now() + offset,
    ).toISOString();
    const service = new DisputePolicy({ resolver: f.resolver, now: f.now });
    const result = await service.evaluate(policy(), accept(), trusted);
    assert.equal(result.decision, 'require_approval');
    assert.equal(result.dispatchAllowed, false);
    assert.equal(result.review.deadline.status, status);
    assert.equal(result.review.deadline.remainingMs, Math.max(0, offset));
  });
}

test('missing deadlines stay unknown and cached facts do not cache urgency', async () => {
  const f = fixture();
  delete f.record.seller_response_due_date;
  const service = new DisputePolicy({ resolver: f.resolver, now: f.now });
  assert.deepEqual(
    (await service.evaluate(policy(), accept(), trusted)).review.deadline,
    { status: 'not_provided' },
  );
  f.resolver.invalidateDispute(disputeId);
  f.record.seller_response_due_date = new Date(f.now() + 1).toISOString();
  const before = await service.evaluate(policy(), accept(), trusted);
  assert.equal(before.review.deadline.status, 'due_soon');
  f.setClock(f.now() + 1);
  const after = await service.evaluate(policy(), accept(), trusted);
  assert.equal(after.review.deadline.status, 'overdue');
  assert.equal(before.review.bindingHash, after.review.bindingHash);
  assert.equal(f.seen.length, 2);
});

test('malformed date values and invalid policy clocks cannot produce review results', async () => {
  for (const due of [
    '2026-10-17',
    '2026-10-17T25:00:00Z',
    '2026-10-17T12:00:00+00:00',
    '2026-10-17T12:00:00.12Z',
    0,
  ]) {
    const f = fixture();
    f.record.seller_response_due_date = due;
    const service = new DisputePolicy({ resolver: f.resolver, now: f.now });
    assert.equal(
      (await service.evaluate(policy(), accept(), trusted)).decision,
      'deny',
    );
  }
  for (const now of [NaN, Infinity, -1, 1.5]) {
    const f = fixture();
    const service = new DisputePolicy({ resolver: f.resolver, now: () => now });
    assert.equal(
      (await service.evaluate(policy(), accept(), trusted)).decision,
      'deny',
    );
  }
});

test('fingerprint binds reviewed arguments, full trusted identities, facts and policy version', async () => {
  const f = fixture();
  const service = new DisputePolicy({ resolver: f.resolver, now: f.now });
  const loaded = policy();
  const baseline = await service.evaluate(loaded, accept(), trusted);
  const hash = baseline.review.bindingHash;
  assert.equal(
    (await service.evaluate(loaded, accept(), trusted)).review.bindingHash,
    hash,
  );
  const variants = [
    [
      loaded,
      {
        tool: 'accept_dispute_claim',
        args: { ...accept().args, note: 'Different_reason' },
      },
      trusted,
    ],
    [
      loaded,
      accept(),
      { ...trusted, agent: { ...trusted.agent, nested: { restricted: true } } },
    ],
    [
      loaded,
      accept(),
      { ...trusted, customer: { ...trusted.customer, vip: true } },
    ],
    [policy('require_approval'), accept(), trusted],
  ];
  for (const args of variants)
    assert.notEqual((await service.evaluate(...args)).review.bindingHash, hash);
  for (const mutate of [
    (r) => {
      r.dispute_amount.value = '26.00';
    },
    (r) => {
      r.disputed_transactions[0].gross_amount.value = '101.00';
    },
    (r) => {
      r.disputed_transactions[0].transaction_status = 'HELD';
    },
    (r) => {
      r.status = 'OPEN';
    },
    (r) => {
      r.seller_response_due_date = '2026-10-18T12:00:00Z';
    },
  ]) {
    const changed = fixture();
    mutate(changed.record);
    const changedService = new DisputePolicy({
      resolver: changed.resolver,
      now: changed.now,
    });
    assert.notEqual(
      (await changedService.evaluate(loaded, accept(), trusted)).review
        .bindingHash,
      hash,
    );
  }
  assert.throws(() => {
    baseline.review.context.args.note = 'mutated';
  }, TypeError);
  assert.throws(() => {
    baseline.review.context.customer.id = 'mutated';
  }, TypeError);
  assert.throws(() => {
    baseline.review.resolvedCtx.dispute.amount.value = '0.01';
  }, TypeError);
});

test('caller mutation during a provider read cannot change the reviewed command', async () => {
  let reached, release;
  const reading = new Promise((r) => {
    reached = r;
  });
  const barrier = new Promise((r) => {
    release = r;
  });
  const f = fixture({
    fetch: async (record) => {
      reached();
      await barrier;
      return Response.json(record);
    },
  });
  const service = new DisputePolicy({ resolver: f.resolver, now: f.now });
  const input = accept(),
    identity = structuredClone(trusted);
  const pending = service.evaluate(policy(), input, identity);
  await reading;
  input.args.note = 'Changed_note';
  identity.agent.region = 'Changed_region';
  release();
  const result = await pending;
  assert.equal(result.review.context.args.note, 'Accept_reviewed_claim');
  assert.equal(result.review.context.agent.region, 'local');
});

test('expired and invalidated dispute leases refresh or deny without stale fallback', async () => {
  const f = fixture();
  assert.equal((await f.resolver.resolve(accept(), trusted)).amount.usd, 25);
  f.record.dispute_amount.value = '30.00';
  f.setClock(f.now() + 2000);
  assert.equal((await f.resolver.resolve(accept(), trusted)).amount.usd, 30);
  f.record.status = 'RESOLVED';
  f.resolver.invalidateDispute(disputeId);
  assert.equal((await f.resolver.resolve(accept(), trusted)).ok, false);
  assert.equal(f.seen.length, 3);
  let reached, release;
  const reading = new Promise((r) => {
    reached = r;
  });
  const barrier = new Promise((r) => {
    release = r;
  });
  const inflight = fixture({
    fetch: async (record) => {
      reached();
      await barrier;
      return Response.json(record);
    },
  });
  const pending = inflight.resolver.resolve(accept(), trusted);
  await reading;
  inflight.resolver.invalidateDispute(disputeId);
  release();
  assert.equal((await pending).reason, 'stale_context');
});

test('provider failures are redacted and do not become approval requirements', async () => {
  for (const fetch of [
    async () => {
      throw new Error('PRIVATE_TOKEN');
    },
    async () => Response.json({ private: 'PRIVATE_RESPONSE' }, { status: 404 }),
    async () =>
      new Response('PRIVATE_HTML', {
        headers: { 'content-type': 'text/html' },
      }),
  ]) {
    const f = fixture({ fetch });
    const service = new DisputePolicy({ resolver: f.resolver, now: f.now });
    const result = await service.evaluate(policy(), accept(), trusted);
    assert.equal(result.decision, 'deny');
    assert.equal(result.review, undefined);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|token|https:/);
  }
});
