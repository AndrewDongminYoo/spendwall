import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import http from 'node:http';
import {
  dashboardFixture,
  key,
  token,
  request,
  policy,
} from './helpers/dashboard-fixture.mjs';
import { checkHostedReader } from '../apps/firewall/src/dashboard/hosted-reader.ts';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';

const url = process.env.AUDIT_TEST_DATABASE_URL;
test(
  'hosted reader uses actual restricted PostgreSQL permissions',
  { skip: !url },
  async (t) => {
    const fixture = await dashboardFixture(url);
    let reader, server;
    t.after(async () => {
      await server?.close();
      await reader?.end();
      await fixture.owner.query('DROP OWNED BY spendwall_dashboard_reader');
      await fixture.owner.query('DROP ROLE spendwall_dashboard_reader');
      await fixture.close();
    });
    await fixture.owner.query(
      await readFile(
        new URL('../scripts/hosting-reader.sql', import.meta.url),
        'utf8',
      ),
    );
    await fixture.owner.query(
      "ALTER ROLE spendwall_dashboard_reader PASSWORD 'hosting-test-only'",
    );
    const target = new URL(url);
    target.username = 'spendwall_dashboard_reader';
    target.password = 'hosting-test-only';
    reader = new pg.Pool({
      connectionString: target.toString(),
      connectionTimeoutMillis: 2000,
    });
    await checkHostedReader(reader);
    await assert.rejects(checkHostedReader(fixture.owner), /unavailable/);
    await assert.rejects(checkHostedReader(fixture.app), /unavailable/);
    for (const sql of [
      'DELETE FROM audit.audit_events',
      'UPDATE approvals.requests SET approval_state=approval_state',
      'SELECT request_sealed FROM approvals.requests',
    ])
      await assert.rejects(reader.query(sql), { code: '42501' });
    const origin = 'https://dashboard.example.invalid';
    server = await startDashboardServer({
      pool: reader,
      identityKey: key,
      token,
      merchantId: 'merchantA',
      hosted: { publicOrigin: origin },
    });
    const local = new URL(server.listenUrl);
    local.hostname = '127.0.0.1';
    const get = (path) =>
      new Promise((resolve, reject) => {
        http
          .get(
            new URL(path, local),
            {
              headers: {
                host: new URL(origin).host,
                authorization: `Bearer ${token}`,
              },
            },
            (res) => {
              const chunks = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () =>
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: res.statusCode,
                  }),
                ),
              );
            },
          )
          .on('error', reject);
      });
    assert.equal((await get('/healthz')).status, 200);
    assert.equal((await (await get('/audit')).json()).items.length, 0);
    await fixture.velocity.evaluateAndReserve(
      policy('allow'),
      request('12.00'),
    );
    assert.equal((await (await get('/audit')).json()).items.length, 1);
    const stats = await (await get('/stats')).json();
    assert.equal(stats.confirmed_usd, 0);
    assert.equal(stats.query_mode, 'disabled');
    assert.equal(stats.policy_preview_mode, 'disabled');
    const before = (
      await fixture.owner.query(
        'SELECT count(*)::int AS n FROM audit.audit_events',
      )
    ).rows[0].n;
    assert.equal((await get('/policy')).status, 404);
    assert.equal(
      (
        await fixture.owner.query(
          'SELECT count(*)::int AS n FROM audit.audit_events',
        )
      ).rows[0].n,
      before,
    );
    for (const [grant, revoke] of [
      [
        'GRANT UPDATE ON audit.audit_events TO spendwall_dashboard_reader',
        'REVOKE UPDATE ON audit.audit_events FROM spendwall_dashboard_reader',
      ],
      [
        'GRANT UPDATE (approval_state) ON approvals.requests TO spendwall_dashboard_reader',
        'REVOKE UPDATE (approval_state) ON approvals.requests FROM spendwall_dashboard_reader',
      ],
      [
        'ALTER ROLE spendwall_dashboard_reader CREATEROLE',
        'ALTER ROLE spendwall_dashboard_reader NOCREATEROLE',
      ],
    ]) {
      await fixture.owner.query(grant);
      try {
        await assert.rejects(checkHostedReader(reader), /unavailable/, grant);
        assert.equal((await get('/healthz')).status, 503);
      } finally {
        await fixture.owner.query(revoke);
      }
      assert.equal((await get('/healthz')).status, 200);
    }
    await fixture.owner.query(
      'REVOKE SELECT (expires_at) ON approvals.requests FROM spendwall_dashboard_reader',
    );
    assert.equal((await get('/healthz')).status, 503);
    assert.equal((await get('/stats')).status, 503);
    // The error response can arrive before the server's ROLLBACK completes.
    for (let i = 0; i < 50 && reader.totalCount !== reader.idleCount; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(reader.totalCount, reader.idleCount);
  },
);
