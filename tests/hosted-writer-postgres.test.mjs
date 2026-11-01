import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import pg from 'pg';
import { checkHostedReader } from '../apps/firewall/src/dashboard/hosted-reader.ts';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';

const url = process.env.AUDIT_TEST_DATABASE_URL;
const key = '7'.repeat(64),
  token = '8'.repeat(64),
  readerPassword = 'reader-test-only-0123456789',
  writerPassword = 'writer-test-only-0123456789';

function script(name, env) {
  return spawnSync(process.execPath, [`scripts/${name}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}
async function reset(owner) {
  await owner.query('DROP SCHEMA IF EXISTS approvals CASCADE');
  await owner.query('DROP SCHEMA IF EXISTS audit CASCADE');
  for (const role of ['spendwall_dashboard_reader', 'spendwall_demo_writer']) {
    const found = await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [
      role,
    ]);
    if (found.rowCount) {
      await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(role)}`);
      await owner.query(`DROP ROLE ${pg.escapeIdentifier(role)}`);
    }
  }
  const groups = await owner.query(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'spendwall_audit_app_%'",
  );
  for (const { rolname } of groups.rows) {
    await owner.query(`DROP OWNED BY ${pg.escapeIdentifier(rolname)}`);
    await owner.query(`DROP ROLE ${pg.escapeIdentifier(rolname)}`);
  }
}

test(
  'hosted setup and synthetic writer populate the restricted dashboard',
  { skip: !url },
  async (t) => {
    const owner = new pg.Pool({ connectionString: url });
    const directory = await mkdtemp(join(tmpdir(), 'spendwall-hosted-'));
    let reader, server;
    t.after(async () => {
      await server?.close();
      await reader?.end();
      await reset(owner);
      await owner.end();
      await rm(directory, { recursive: true, force: true });
    });
    await reset(owner);
    const config = join(directory, 'dashboard.json');
    await writeFile(
      config,
      JSON.stringify({
        identityKey: key,
        token,
        merchantId: 'merchantA',
        agents: [
          { id: 'support', name: 'Support bot', budgetCents: 20000 },
          { id: 'returns', name: 'Returns bot', budgetCents: 10000 },
        ],
        databaseTls: 'disable',
      }),
    );
    const setupEnv = {
      SPENDWALL_SETUP_DATABASE_TLS: 'disable',
      SPENDWALL_SETUP_DATABASE_URL: url,
      SPENDWALL_READER_PASSWORD: readerPassword,
      SPENDWALL_WRITER_PASSWORD: writerPassword,
    };
    assert.equal(
      script('hosted-setup.mjs', {
        ...setupEnv,
        SPENDWALL_WRITER_PASSWORD: readerPassword,
      }).status,
      1,
      'reused password must be refused',
    );
    const setup = script('hosted-setup.mjs', setupEnv);
    assert.equal(setup.status, 0, setup.stderr);
    assert.doesNotMatch(setup.stdout + setup.stderr, /test-only/);
    assert.equal(
      script('hosted-setup.mjs', setupEnv).status,
      2,
      'a second setup must not touch existing schemas',
    );
    const writerUrl = new URL(url);
    writerUrl.username = 'spendwall_demo_writer';
    writerUrl.password = writerPassword;
    for (let i = 0; i < 2; i++) {
      const run = script('hosted-writer.mjs', {
        SPENDWALL_DASHBOARD_CONFIG: config,
        SPENDWALL_WRITER_DATABASE_URL: writerUrl.toString(),
      });
      assert.equal(run.status, 0, run.stderr);
    }
    // A storage failure surfaces as a velocity denial, not an exception. Fail
    // only the denied refund's audit row, so the later approval still succeeds
    // and only the result check can report the batch as failed.
    await owner.query(
      "CREATE FUNCTION public.fail_denied_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.decision = 'deny' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$",
    );
    await owner.query(
      'CREATE TRIGGER fail_denied_refund BEFORE INSERT ON audit.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_denied_refund()',
    );
    try {
      const failed = script('hosted-writer.mjs', {
        SPENDWALL_DASHBOARD_CONFIG: config,
        SPENDWALL_WRITER_DATABASE_URL: writerUrl.toString(),
      });
      assert.equal(failed.status, 1, 'a skipped refund must fail the run');
    } finally {
      await owner.query(
        'DROP TRIGGER fail_denied_refund ON audit.audit_events',
      );
      await owner.query('DROP FUNCTION public.fail_denied_refund()');
    }
    const readerUrl = new URL(url);
    readerUrl.username = 'spendwall_dashboard_reader';
    readerUrl.password = readerPassword;
    reader = new pg.Pool({
      connectionString: readerUrl.toString(),
      connectionTimeoutMillis: 2000,
    });
    await checkHostedReader(reader);
    const writer = new pg.Pool({ connectionString: writerUrl.toString() });
    try {
      await assert.rejects(checkHostedReader(writer), /unavailable/);
      await assert.rejects(writer.query('DELETE FROM audit.audit_events'), {
        code: '42501',
      });
    } finally {
      await writer.end();
    }
    const origin = 'https://dashboard.example.invalid';
    server = await startDashboardServer({
      pool: reader,
      identityKey: key,
      token,
      merchantId: 'merchantA',
      agents: [
        { id: 'support', name: 'Support bot', budgetCents: 20000 },
        { id: 'returns', name: 'Returns bot', budgetCents: 10000 },
      ],
      hosted: { publicOrigin: origin },
    });
    const address = new URL(server.listenUrl ?? server.url);
    address.hostname = '127.0.0.1';
    const stats = await new Promise((resolve, reject) => {
      http
        .get(
          new URL('/stats', address),
          {
            headers: {
              host: new URL(origin).host,
              authorization: `Bearer ${token}`,
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode, body }));
          },
        )
        .on('error', reject);
    });
    assert.equal(stats.status, 200);
    const data = JSON.parse(stats.body);
    const count = (decision) =>
      data.decisions.find((d) => d.decision === decision).count;
    // Two full batches plus the two allowed refunds of the failed run.
    assert.equal(count('allow'), 6);
    assert.equal(count('deny'), 2);
    assert.equal(count('require_approval'), 2);
    assert.ok(data.confirmed_usd > 0);
    assert.deepEqual(data.rules.length > 0, true);
  },
);
