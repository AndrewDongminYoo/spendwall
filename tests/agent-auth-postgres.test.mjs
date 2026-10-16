import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  AgentAuthority,
  issueAgentKey,
  revokeAgentKey,
} from '../apps/firewall/src/agent-auth.ts';

const url = process.env.AUDIT_TEST_DATABASE_URL;
test('Postgres agent credential boundary', { skip: !url }, async (t) => {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/spendwall_audit_test');
  const owner = new pg.Pool({ connectionString: url });
  let runtime, group;
  t.after(async () => {
    await runtime?.end();
    await owner.query('DROP SCHEMA IF EXISTS agent_auth CASCADE');
    if (group) {
      await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(group)}`);
      await owner.query(`DROP ROLE ${pg.escapeIdentifier(group)}`);
    }
    await owner.end();
  });
  await owner.query('DROP SCHEMA IF EXISTS agent_auth CASCADE');
  await owner.query(
    await readFile(
      new URL('../migrations/005-agent-auth.sql', import.meta.url),
      'utf8',
    ),
  );
  group = (await owner.query('SELECT agent_auth.reader_role() AS name')).rows[0]
    .name;
  await owner.query(
    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='agent_test_login') THEN CREATE ROLE agent_test_login LOGIN PASSWORD 'agent-test-only'; END IF; END $$",
  );
  await owner.query(`GRANT ${pg.escapeIdentifier(group)} TO agent_test_login`);
  target.username = 'agent_test_login';
  target.password = 'agent-test-only';
  runtime = new pg.Pool({
    connectionString: target.toString(),
    connectionTimeoutMillis: 1000,
  });
  const authority = new AgentAuthority(runtime, 'merchantA');
  const issued = await issueAgentKey(owner, 'merchantA', 'support', [
    'get_order',
  ]);
  assert.ok(issued, 'Issuance must return a generated credential');
  assert.match(issued.key, /^sw_agent_[A-Za-z0-9_-]{43}$/);
  const other = await issueAgentKey(owner, 'merchantA', 'returns', [
    'get_refund',
  ]);
  assert.notEqual(other.key, issued.key);
  await t.test(
    'database stores a digest and identities, never the raw credential',
    async () => {
      const row = (
        await owner.query('SELECT * FROM agent_auth.credentials WHERE id=$1', [
          issued.id,
        ])
      ).rows[0];
      assert.equal(
        row.key_hash,
        createHash('sha256').update(issued.key).digest('hex'),
      );
      assert.ok(!JSON.stringify(row).includes(issued.key));
      assert.deepEqual(await authority.authenticate(issued.key), {
        merchantId: 'merchantA',
        agentId: 'support',
        tools: ['get_order'],
      });
      assert.deepEqual(await authority.authenticate(other.key), {
        merchantId: 'merchantA',
        agentId: 'returns',
        tools: ['get_refund'],
      });
      assert.equal(
        await new AgentAuthority(runtime, 'merchantB').authenticate(issued.key),
        null,
      );
      assert.equal(
        await authority.authenticate('sw_agent_' + 'a'.repeat(43)),
        null,
      );
      assert.equal(await authority.authenticate('invalid'), null);
    },
  );
  await t.test(
    'runtime role cannot issue, revoke, modify grants or bypass lookup ownership',
    async () => {
      await assert.rejects(
        issueAgentKey(runtime, 'merchantA', 'evil', ['create_refund']),
        /permission denied/,
      );
      await assert.rejects(
        revokeAgentKey(runtime, 'merchantA', issued.id),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query(
          "UPDATE agent_auth.credentials SET tools=ARRAY['create_refund']",
        ),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query('DELETE FROM agent_auth.credentials'),
        /permission denied/,
      );
    },
  );
  await t.test(
    'empty grants and revocation remain effective without a cache',
    async () => {
      await owner.query(
        "UPDATE agent_auth.credentials SET tools='{}' WHERE id=$1",
        [issued.id],
      );
      assert.deepEqual((await authority.authenticate(issued.key)).tools, []);
      assert.equal(await revokeAgentKey(owner, 'merchantB', issued.id), false);
      assert.equal(await revokeAgentKey(owner, 'merchantA', issued.id), true);
      assert.equal(await authority.authenticate(issued.key), null);
      assert.equal(await revokeAgentKey(owner, 'merchantA', issued.id), true);
      assert.ok(await authority.authenticate(other.key));
    },
  );
  await t.test(
    'key CLI writes a private new file, never prints secrets, refuses overwrite and revokes',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'spendwall-agent-keys-'));
      try {
        const config = join(dir, 'config.json'),
          output = join(dir, 'credential.json');
        await writeFile(
          config,
          JSON.stringify({
            databaseUrl: url,
            merchantId: 'merchantA',
            agentId: 'cli-agent',
            tools: ['get_order'],
          }),
          { mode: 0o600 },
        );
        const run = (action, extra = []) =>
          spawnSync(
            process.execPath,
            ['scripts/agent-keys.mjs', action, '--config', config, ...extra],
            { encoding: 'utf8', timeout: 5000 },
          );
        const result = run('issue', ['--output', output]);
        assert.equal(result.status, 0, result.stderr);
        const credential = JSON.parse(await readFile(output, 'utf8'));
        assert.equal((await stat(output)).mode & 0o777, 0o600);
        assert.ok(!JSON.stringify(result).includes(credential.key));
        assert.equal(
          (await authority.authenticate(credential.key)).agentId,
          'cli-agent',
        );
        const before = (
          await owner.query('SELECT count(*) FROM agent_auth.credentials')
        ).rows[0].count;
        assert.notEqual(run('issue', ['--output', output]).status, 0);
        assert.equal(
          (await owner.query('SELECT count(*) FROM agent_auth.credentials'))
            .rows[0].count,
          before,
        );
        assert.equal(
          JSON.parse(await readFile(output, 'utf8')).key,
          credential.key,
        );
        await writeFile(
          config,
          JSON.stringify({
            databaseUrl: url,
            merchantId: 'merchantA',
            keyId: credential.id,
          }),
          { mode: 0o600 },
        );
        assert.equal(run('revoke').status, 0);
        assert.equal(await authority.authenticate(credential.key), null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  await t.test(
    'invalid grant input cannot create credential rows',
    async () => {
      const before = (
        await owner.query('SELECT count(*) FROM agent_auth.credentials')
      ).rows[0].count;
      for (const tools of [
        ['get_order', 'get_order'],
        ['bad tool'],
        Array(129).fill('get_order'),
        null,
      ])
        await assert.rejects(
          issueAgentKey(owner, 'merchantA', 'support', tools),
        );
      assert.equal(
        (await owner.query('SELECT count(*) FROM agent_auth.credentials'))
          .rows[0].count,
        before,
      );
    },
  );
  await t.test(
    'malformed trusted grants and unavailable database never yield a principal',
    async () => {
      await owner.query(
        "UPDATE agent_auth.credentials SET tools=ARRAY['bad tool'] WHERE id=$1",
        [other.id],
      );
      await assert.rejects(authority.authenticate(other.key));
      await owner.query('DROP TABLE agent_auth.credentials');
      await assert.rejects(authority.authenticate(other.key));
    },
  );
});
