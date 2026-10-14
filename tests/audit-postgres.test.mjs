import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import pg from 'pg';
import { AuditLog, verifyAudit } from '../apps/firewall/src/audit/index.ts';
import { prepareEvent } from '../apps/firewall/src/audit/event.ts';

const url = process.env.AUDIT_TEST_DATABASE_URL;
const event = {
  agentId: 'support-agent',
  tool: 'create_refund',
  args: {
    amount: { value: '5.00', currency_code: 'USD' },
    secret: 'private-fixture',
  },
  resolvedCtx: { amount_minor: 500, email: 'private@example.invalid' },
  decision: 'allow',
  matchedRules: ['small-refund'],
  policyVersion: 'a'.repeat(64),
  latencyMs: 12,
  eventKind: 'tool_call',
};
const approvalId = 'e3857242-30c3-4772-8b4c-218df041e6cd';

function appUrl() {
  const target = new URL(url);
  target.username = 'audit_test_login';
  target.password = 'audit-test-only';
  return target.toString();
}

async function fixture(t) {
  const target = new URL(url);
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname),
    'Test DB must be local',
  );
  assert.equal(
    target.pathname,
    '/spendwall_audit_test',
    'Use the dedicated disposable database',
  );
  const owner = new pg.Pool({ connectionString: url });
  let app;
  let appRole;
  t.after(async () => {
    await app?.end();
    try {
      if (appRole)
        await owner.query(
          `REVOKE ${pg.escapeIdentifier(appRole)} FROM audit_test_login`,
        );
    } finally {
      await owner.end();
    }
  });
  await owner.query('DROP SCHEMA IF EXISTS audit CASCADE');
  await owner.query(
    await readFile(
      new URL('../migrations/001-audit.sql', import.meta.url),
      'utf8',
    ),
  );
  await owner.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_test_login') THEN
      CREATE ROLE audit_test_login LOGIN PASSWORD 'audit-test-only';
    END IF;
  END $$`);
  appRole = (await owner.query('SELECT audit.app_role() AS name')).rows[0].name;
  await owner.query(
    `GRANT ${pg.escapeIdentifier(appRole)} TO audit_test_login`,
  );
  app = new pg.Pool({
    connectionString: appUrl(),
    max: 12,
  });
  return { owner, app, appRole, log: new AuditLog(app) };
}

function cli() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/audit-verify.mjs'], {
      cwd: new URL('../', import.meta.url),
      env: {
        ...process.env,
        AUDIT_DATABASE_URL: appUrl(),
        PGOPTIONS: '',
      },
    });
    let output = '';
    child.stdout.on('data', (part) => (output += part));
    child.stderr.on('data', (part) => (output += part));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, output }));
  });
}

test('Postgres audit boundary', { skip: !url }, async (t) => {
  await t.test(
    'records three decisions and every approval lifecycle event without sensitive values',
    async (t) => {
      const { owner, app, log } = await fixture(t);
      for (const decision of ['allow', 'deny', 'require_approval'])
        await log.append({ ...event, decision });
      for (const eventKind of [
        'approval_created',
        'approval_decided',
        'approval_executed',
      ])
        await log.append({ ...event, eventKind, approvalId });
      const { rows } = await owner.query(
        'SELECT * FROM audit.audit_events ORDER BY id',
      );
      assert.deepEqual(
        rows.slice(0, 3).map((r) => r.decision),
        ['allow', 'deny', 'require_approval'],
      );
      assert.deepEqual(
        rows.slice(3).map((r) => r.event_kind),
        ['approval_created', 'approval_decided', 'approval_executed'],
      );
      assert.doesNotMatch(
        JSON.stringify(rows),
        /private-fixture|private@example|secret|email/,
      );
      assert.equal((await verifyAudit(app)).count, 6);
      const result = await cli();
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /Verified 6 audit events/);
    },
  );

  await t.test(
    'app role cannot mutate, forge inserts, truncate or replace audit objects',
    async (t) => {
      const { app, log } = await fixture(t);
      assert.equal(
        (await app.query('SELECT current_user')).rows[0].current_user,
        'audit_test_login',
      );
      await log.append(event);
      const statements = [
        "UPDATE audit.audit_events SET decision = 'deny'",
        'DELETE FROM audit.audit_events',
        'TRUNCATE audit.audit_events',
        'INSERT INTO audit.audit_events DEFAULT VALUES',
        "UPDATE audit.chain_head SET row_hash = repeat('0',64)",
        'DELETE FROM audit.chain_head',
        'TRUNCATE audit.chain_head',
        'ALTER TABLE audit.audit_events ADD COLUMN forged text',
        'CREATE TABLE audit.forged (id int)',
        "SELECT nextval('audit.event_ids')",
        'SET ROLE audit_test_owner',
      ];
      for (const sql of statements)
        await assert.rejects(app.query(sql), (error) => error.code === '42501');
      assert.equal((await verifyAudit(app)).count, 1);
    },
  );

  await t.test(
    'direct append function callers also receive DB redaction and fixed server IDs/hashes',
    async (t) => {
      const { owner, app } = await fixture(t);
      const payload = {
        ...prepareEvent(event),
        id: '999',
        ts: '2000-01-01T00:00:00Z',
        prev_hash: 'b'.repeat(64),
        row_hash: 'b'.repeat(64),
        args_redacted: {
          ...event.args,
          amount: {
            value: '5.00',
            currency_code: 'USD',
            token: 'private-token',
          },
        },
        resolved_ctx: {
          ...event.resolvedCtx,
          amount_minor: 0.1,
          quantity: 2,
          currency: 'USD',
        },
      };
      await app.query('SELECT * FROM audit.append_event($1::jsonb)', [
        JSON.stringify(payload),
      ]);
      const row = (await owner.query('SELECT * FROM audit.audit_events'))
        .rows[0];
      assert.equal(row.id, '1');
      assert.equal(row.prev_hash, '0'.repeat(64));
      assert.notEqual(row.row_hash, payload.row_hash);
      assert.deepEqual(row.args_redacted, {
        amount: { value: '5.00', currency_code: 'USD' },
      });
      assert.deepEqual(row.resolved_ctx, { quantity: 2, currency: 'USD' });
      assert.doesNotMatch(JSON.stringify(row), /private|secret|token|email/);
      assert.equal((await verifyAudit(app)).ok, true);
    },
  );

  await t.test(
    'verification keeps a stable snapshot while writers append across pagination',
    async (t) => {
      const { app, log } = await fixture(t);
      for (let i = 0; i < 1005; i++) await log.append(event);
      const writing = Promise.all(
        Array.from({ length: 20 }, () => log.append(event)),
      );
      const result = await verifyAudit(app);
      assert.equal(result.ok, true);
      assert.ok(result.count >= 1005 && result.count <= 1025);
      await writing;
      assert.equal((await verifyAudit(app)).count, 1025);
    },
  );

  await t.test(
    'raw SQL append cannot persist numeric identifiers in generic value fields',
    async (t) => {
      const { owner, app } = await fixture(t);
      for (const input of [
        { value: '123456' },
        { value: '123456', currency: 'USD' },
        { amount: { value: '123456' } },
        { amount: { value: '123456', currency_code: 'ZZZ' } },
        { amount: { value: '123456', currency_code: 'USD', currency: 'EUR' } },
        { amount: { value: '5.25', currency_code: 'KRW' } },
        { amount: { value: '5.00', currency_code: 'USD' } },
        { amount: { value: '5.00', currency: 'EUR' } },
        { amount: { value: '500', currency: 'KRW' } },
      ]) {
        const prepared = prepareEvent({
          ...event,
          args: input,
          resolvedCtx: input,
        });
        const payload = {
          ...prepared,
          args_redacted: input,
          resolved_ctx: input,
        };
        const receipt = (
          await app.query('SELECT * FROM audit.append_event($1::jsonb)', [
            JSON.stringify(payload),
          ])
        ).rows[0];
        const row = (
          await owner.query(
            'SELECT args_redacted, resolved_ctx FROM audit.audit_events WHERE id=$1',
            [receipt.id],
          )
        ).rows[0];
        assert.doesNotMatch(JSON.stringify(row), /123456|5\.25/);
        assert.deepEqual(row.args_redacted, prepared.args_redacted);
        assert.deepEqual(row.resolved_ctx, prepared.resolved_ctx);
      }
      assert.equal((await verifyAudit(app)).count, 9);
    },
  );

  await t.test(
    'concurrent connections produce one ordered chain; rollback changes neither events nor head',
    async (t) => {
      const { app, log } = await fixture(t);
      const appended = await Promise.all(
        Array.from({ length: 40 }, (_, latencyMs) =>
          log.append({ ...event, latencyMs }),
        ),
      );
      assert.equal(new Set(appended.map((row) => row.id)).size, 40);
      assert.equal((await verifyAudit(app)).count, 40);
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await new AuditLog(client).append(event);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      await log.append(event);
      assert.equal(
        (await verifyAudit(app)).count,
        41,
        'sequence gaps after rollback are valid',
      );
    },
  );

  await t.test(
    'nested payment JSON receives recursive DB redaction without retaining free-text keys',
    async (t) => {
      const { owner, app } = await fixture(t);
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
      const payload = {
        ...prepareEvent(event),
        args_redacted: input,
        resolved_ctx: input,
      };
      await app.query('SELECT * FROM audit.append_event($1::jsonb)', [
        JSON.stringify(payload),
      ]);
      const row = (
        await owner.query(
          'SELECT args_redacted, resolved_ctx FROM audit.audit_events',
        )
      ).rows[0];
      assert.deepEqual(row.args_redacted, expected);
      assert.deepEqual(row.resolved_ctx, expected);
      assert.doesNotMatch(JSON.stringify(row), /private-nested|123456/);
      assert.equal((await verifyAudit(app)).count, 1);
    },
  );

  await t.test(
    'adding a nullable column leaves the explicit v1 hash payload and historical chain unchanged',
    async (t) => {
      const { owner, app, log } = await fixture(t);
      await log.append(event);
      const before = await verifyAudit(app);
      await owner.query(
        'ALTER TABLE audit.audit_events ADD COLUMN future_nullable text',
      );
      const after = await verifyAudit(app);
      assert.deepEqual(after, before);
      await log.append(event);
      assert.equal((await verifyAudit(app)).count, 2);
    },
  );

  for (const position of [0, 1, 2])
    await t.test(
      `reports exact modified row at position ${position + 1}, including the tail`,
      async (t) => {
        const { owner, app, log } = await fixture(t);
        const rows = [];
        for (let i = 0; i < 3; i++) rows.push(await log.append(event));
        const id = rows[position].id;
        await owner.query(
          'UPDATE audit.audit_events SET args_redacted = \'{"amount_minor":999}\' WHERE id=$1',
          [id],
        );
        const result = await verifyAudit(app);
        assert.equal(result.ok, false);
        assert.equal(result.id, id);
        assert.equal(result.position, position + 1);
        assert.equal(result.reason, 'row_hash');
        const run = await cli();
        assert.equal(run.code, 1);
        assert.match(
          run.output,
          new RegExp(`row ${id} \\(position ${position + 1}\\): row_hash`),
        );
        assert.doesNotMatch(run.output, /private|postgres:\/\//);
      },
    );

  await t.test('every requested field participates in the hash', async (t) => {
    const { owner, app, log } = await fixture(t);
    const { id } = await log.append({
      ...event,
      approvalId,
      upstreamStatus: 200,
      upstreamResultRef: approvalId,
    });
    const changes = {
      ts: "ts + interval '1 second'",
      agent_id: "'different-agent'",
      tool: "'different_tool'",
      args_hash: "repeat('b',64)",
      resolved_ctx: '\'{"amount_minor":1}\'::jsonb',
      decision: "'deny'",
      matched_rules: "'[]'::jsonb",
      policy_version: "repeat('b',64)",
      approval_id: "'a3857242-30c3-4772-8b4c-218df041e6cd'::uuid",
      upstream_status: '500',
      upstream_result_ref: "'a3857242-30c3-4772-8b4c-218df041e6cd'::uuid",
      latency_ms: '99',
      prev_hash: "repeat('b',64)",
      row_hash: "repeat('b',64)",
      event_kind: "'approval_decided'",
      id: '999',
    };
    const original = (
      await owner.query('SELECT * FROM audit.audit_events WHERE id=$1', [id])
    ).rows[0];
    for (const [column, expression] of Object.entries(changes)) {
      await owner.query(
        `UPDATE audit.audit_events SET ${column} = ${expression} WHERE id=$1`,
        [id],
      );
      const result = await verifyAudit(app);
      assert.equal(result.ok, false, column);
      assert.equal(result.position, 1, column);
      const value = ['matched_rules', 'resolved_ctx'].includes(column)
        ? JSON.stringify(original[column])
        : original[column];
      await owner.query(
        `UPDATE audit.audit_events SET ${column}=$1 WHERE id=$2`,
        [value, column === 'id' ? '999' : id],
      );
    }
  });

  await t.test(
    'empty chains, deleted tails and damaged head are diagnosed',
    async (t) => {
      const { owner, app, log } = await fixture(t);
      assert.deepEqual(await verifyAudit(app), {
        ok: true,
        count: 0,
        headHash: '0'.repeat(64),
      });
      const first = await log.append(event);
      const last = await log.append(event);
      await owner.query('DELETE FROM audit.audit_events WHERE id=$1', [
        last.id,
      ]);
      assert.deepEqual(await verifyAudit(app), {
        ok: false,
        id: last.id,
        position: 2,
        reason: 'head',
      });
      await assert.rejects(log.append(event), /Audit append failed/);
      await owner.query('DELETE FROM audit.chain_head');
      const result = await verifyAudit(app);
      assert.equal(result.reason, 'head');
      assert.equal(first.id, '1');
    },
  );

  await t.test(
    'an app login cannot read or append audit events in another database',
    async (t) => {
      const { owner } = await fixture(t);
      await owner.query('CREATE DATABASE spendwall_audit_other_test');
      const otherUrl = new URL(url);
      otherUrl.pathname = '/spendwall_audit_other_test';
      const otherOwner = new pg.Pool({ connectionString: otherUrl.toString() });
      const otherAppUrl = new URL(appUrl());
      otherAppUrl.pathname = '/spendwall_audit_other_test';
      const otherApp = new pg.Pool({
        connectionString: otherAppUrl.toString(),
      });
      try {
        await otherOwner.query(
          await readFile(
            new URL('../migrations/001-audit.sql', import.meta.url),
            'utf8',
          ),
        );
        await assert.rejects(
          otherApp.query('SELECT * FROM audit.audit_events'),
          (error) => error.code === '42501',
        );
        await assert.rejects(
          new AuditLog(otherApp).append(event),
          /Audit append failed/,
        );
        assert.equal(
          (await otherOwner.query('SELECT count(*) FROM audit.audit_events'))
            .rows[0].count,
          '0',
        );
        const otherRole = (
          await otherOwner.query('SELECT audit.app_role() AS name')
        ).rows[0].name;
        await otherOwner.query(
          `GRANT ${pg.escapeIdentifier(otherRole)} TO audit_test_login`,
        );
        await new AuditLog(otherApp).append(event);
        assert.equal((await verifyAudit(otherApp)).count, 1);
        await otherOwner.query(
          `REVOKE ${pg.escapeIdentifier(otherRole)} FROM audit_test_login`,
        );
      } finally {
        await otherApp.end();
        await otherOwner.end();
        await owner.query('DROP DATABASE spendwall_audit_other_test');
      }
    },
  );

  await t.test(
    'migration rejects pre-existing members of the database audit group',
    async (t) => {
      const { owner, appRole } = await fixture(t);
      const client = await owner.connect();
      const group = pg.escapeIdentifier(appRole);
      try {
        await client.query(`REVOKE ${group} FROM audit_test_login`);
        await client.query('CREATE ROLE audit_test_unexpected NOLOGIN');
        await client.query(`GRANT ${group} TO audit_test_unexpected`);
        await client.query('DROP SCHEMA audit CASCADE');
        const migration = await readFile(
          new URL('../migrations/001-audit.sql', import.meta.url),
          'utf8',
        );
        await assert.rejects(
          client.query(migration),
          /Audit app group must have no existing members/,
        );
      } finally {
        await client.query('ROLLBACK');
        await client.query(`REVOKE ${group} FROM audit_test_unexpected`);
        await client.query('DROP ROLE audit_test_unexpected');
        client.release();
      }
    },
  );

  await t.test(
    'migration rejects a replication-capable app group',
    async (t) => {
      const { owner, appRole } = await fixture(t);
      const client = await owner.connect();
      try {
        await client.query(
          `REVOKE ${pg.escapeIdentifier(appRole)} FROM audit_test_login`,
        );
        await client.query(
          `ALTER ROLE ${pg.escapeIdentifier(appRole)} REPLICATION`,
        );
        await client.query('DROP SCHEMA audit CASCADE');
        const migration = await readFile(
          new URL('../migrations/001-audit.sql', import.meta.url),
          'utf8',
        );
        await assert.rejects(
          client.query(migration),
          /unprivileged NOLOGIN role/,
        );
      } finally {
        await client.query('ROLLBACK');
        await client.query(
          `ALTER ROLE ${pg.escapeIdentifier(appRole)} NOREPLICATION`,
        );
        client.release();
      }
    },
  );

  await t.test(
    'migration rejects an app group with inherited role memberships',
    async (t) => {
      const { owner, appRole } = await fixture(t);
      const client = await owner.connect();
      try {
        await client.query(
          `REVOKE ${pg.escapeIdentifier(appRole)} FROM audit_test_login`,
        );
        await client.query('CREATE ROLE audit_test_privileged NOLOGIN');
        await client.query(
          `GRANT audit_test_privileged TO ${pg.escapeIdentifier(appRole)}`,
        );
        await client.query('DROP SCHEMA audit CASCADE');
        const migration = await readFile(
          new URL('../migrations/001-audit.sql', import.meta.url),
          'utf8',
        );
        await assert.rejects(
          client.query(migration),
          /unprivileged NOLOGIN role/,
        );
      } finally {
        await client.query('ROLLBACK');
        await client.query(
          `REVOKE audit_test_privileged FROM ${pg.escapeIdentifier(appRole)}`,
        );
        await client.query('DROP ROLE audit_test_privileged');
        client.release();
      }
    },
  );
});
