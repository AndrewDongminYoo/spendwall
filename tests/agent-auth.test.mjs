import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { authenticateAgent, issueAgentKey } from '../apps/firewall/src/auth.ts';
import { SqlAgentKeyStore } from '../apps/firewall/src/agent-key-store.ts';

const key = 'synthetic-agent-key-A-with-at-least-32-characters';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const record = () => ({
  keyHash: hash(key),
  agentId: 'agent-A',
  allowedTools: ['get_order'],
  enabled: true,
  revoked: false,
});

test('issuance returns a random key once and sends only its hash and agent ID to storage', async () => {
  const written = [];
  const store = {
    async insertKey(value) {
      written.push(structuredClone(value));
    },
  };
  const first = await issueAgentKey(store, 'agent-A');
  const second = await issueAgentKey(store, 'agent-A');
  assert.match(first, /^sw_agent_[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.deepEqual(written[0], { agentId: 'agent-A', keyHash: hash(first) });
  assert.doesNotMatch(JSON.stringify(written), new RegExp(first));
  await assert.rejects(
    issueAgentKey(
      {
        async insertKey() {
          throw new Error(key);
        },
      },
      'agent-A',
    ),
    { message: 'Agent key issuance failed.' },
  );
});

test('authentication passes only a hash to storage and snapshots an immutable principal', async () => {
  const row = record();
  const observed = [];
  const principal = await authenticateAgent(
    {
      async findByHash(value) {
        observed.push(value);
        return row;
      },
    },
    `Bearer ${key}`,
  );
  assert.deepEqual(observed, [hash(key)]);
  assert.deepEqual(principal, {
    agentId: 'agent-A',
    allowedTools: ['get_order'],
  });
  row.agentId = 'other';
  row.allowedTools.push('create_refund');
  assert.equal(principal.agentId, 'agent-A');
  assert.deepEqual(principal.allowedTools, ['get_order']);
  assert.ok(Object.isFrozen(principal));
  assert.ok(Object.isFrozen(principal.allowedTools));
});

test('unknown, disabled, revoked, malformed rows and lookup failures fail closed', async () => {
  const bad = [
    null,
    { ...record(), enabled: false },
    { ...record(), revoked: true },
    { ...record(), keyHash: hash('other') },
    { ...record(), agentId: '__proto__' },
    { ...record(), allowedTools: ['get_order', 'get_order'] },
    { ...record(), allowedTools: ['*'] },
    { ...record(), enabled: 'true' },
  ];
  for (const row of bad)
    assert.equal(
      await authenticateAgent(
        {
          async findByHash() {
            return row;
          },
        },
        `Bearer ${key}`,
      ),
      null,
    );
  assert.equal(
    await authenticateAgent(
      {
        async findByHash() {
          throw new Error(key);
        },
      },
      `Bearer ${key}`,
    ),
    null,
  );
  let calls = 0;
  for (const header of [
    undefined,
    '',
    `Basic ${key}`,
    `Bearer ${key} extra`,
    'Bearer short',
  ]) {
    assert.equal(
      await authenticateAgent(
        {
          async findByHash() {
            calls++;
            return record();
          },
        },
        header,
      ),
      null,
    );
  }
  assert.equal(calls, 0);
});

test('the SQL adapter binds hashes and safe IDs rather than plaintext or interpolated SQL', async () => {
  const calls = [];
  const store = new SqlAgentKeyStore({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [record()] };
    },
  });
  assert.deepEqual(await store.findByHash(hash(key)), record());
  await store.insertKey({ agentId: 'agent-A', keyHash: hash(key) });
  assert.deepEqual(
    calls.map((call) => call.params),
    [[hash(key)], [hash(key), 'agent-A']],
  );
  assert.match(calls[0].sql, /\$1/);
  assert.match(calls[1].sql, /\$1.*\$2/);
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(key));
  await assert.rejects(
    store.insertKey({
      agentId: "agent'; DROP TABLE agents;--",
      keyHash: hash(key),
    }),
  );
  assert.equal(calls.length, 2);
});

test('a stalled authentication lookup reaches a bounded denial', async () => {
  const started = Date.now();
  const result = await authenticateAgent(
    { findByHash: () => new Promise(() => {}) },
    `Bearer ${key}`,
    20,
  );
  assert.equal(result, null);
  assert.ok(Date.now() - started < 1000);
});
