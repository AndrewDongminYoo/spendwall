import 'reflect-metadata';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import { identifier } from '../context/json.ts';
import { dashboardData } from './data.ts';
import type { ApprovalRow } from './data.ts';
import type { HistoryRow } from '../velocity/aggregate.ts';

export type DashboardOptions = {
  pool: Pick<Pool, 'connect'>;
  identityKey: string;
  merchantId: string;
  token: string;
  agents?: readonly { id: string; name: string; budgetCents?: number }[];
  staticDirectory?: string;
  port?: number;
};
class DashboardModule {}
Module({})(DashboardModule);
const hash = (value: string) => createHash('sha256').update(value).digest();
function reply(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

export async function startDashboardServer(options: DashboardOptions) {
  if (
    !/^[a-f0-9]{64}$/i.test(options.identityKey) ||
    !/^[a-f0-9]{64}$/i.test(options.token) ||
    options.identityKey.toLowerCase() === options.token.toLowerCase()
  )
    throw new Error('Invalid dashboard configuration.');
  identifier(options.merchantId);
  const port = options.port ?? 0;
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    (options.agents?.length ?? 0) > 100
  )
    throw new Error('Invalid dashboard configuration.');
  const reference = (domain: string, value: string) =>
    createHmac('sha256', Buffer.from(options.identityKey, 'hex'))
      .update(JSON.stringify(['spendwall/velocity', 1, domain, value]))
      .digest('hex');
  const merchantRef = reference('merchant', options.merchantId),
    keyId = reference('key', 'continuity');
  const agents = (options.agents ?? []).map((agent) => {
    identifier(agent.id);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(agent.name) ||
      (agent.budgetCents !== undefined &&
        (!Number.isSafeInteger(agent.budgetCents) ||
          agent.budgetCents < 1 ||
          agent.budgetCents > 1_000_000_000))
    )
      throw new Error('Invalid dashboard configuration.');
    return {
      ref: `agent:${reference('agent', agent.id)}`,
      name: agent.name,
      ...(agent.budgetCents === undefined
        ? {}
        : { budgetCents: agent.budgetCents }),
    };
  });
  if (
    new Set(agents.map((a) => a.ref)).size !== agents.length ||
    new Set(agents.map((a) => a.name)).size !== agents.length
  )
    throw new Error('Invalid dashboard configuration.');
  const tokenHash = hash(options.token);
  const app = await NestFactory.create(DashboardModule, {
    logger: false,
    bodyParser: false,
    abortOnError: false,
  });
  let origin = '',
    active = 0;
  app.use((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin !== undefined && req.headers.origin !== origin)
      ) {
        reply(res, 403, { error: 'Forbidden origin or host.' });
        return;
      }
      const url = new URL(req.url ?? '/', origin);
      if (req.method !== 'GET') {
        reply(res, 405, { error: 'Read-only dashboard.' });
        return;
      }
      if (url.search) {
        reply(res, 400, { error: 'Invalid request.' });
        return;
      }
      if (url.pathname !== '/audit' && url.pathname !== '/stats') {
        const asset = /^\/assets\/[A-Za-z0-9_-]+\.(js|css|woff2)$/.exec(
          url.pathname,
        );
        if (!options.staticDirectory || (url.pathname !== '/' && !asset)) {
          reply(res, 404, { error: 'Not found.' });
          return;
        }
        try {
          const body = await readFile(
            resolve(
              options.staticDirectory,
              url.pathname === '/' ? 'index.html' : url.pathname.slice(1),
            ),
          );
          res.writeHead(200, {
            'content-type': asset
              ? ({
                  js: 'text/javascript',
                  css: 'text/css',
                  woff2: 'font/woff2',
                }[asset[1]!] ?? 'application/octet-stream')
              : 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
          });
          res.end(body);
        } catch {
          reply(res, 404, { error: 'Not found.' });
        }
        return;
      }
      const authorization = req.headers.authorization;
      if (
        typeof authorization !== 'string' ||
        !/^Bearer [a-f0-9]{64}$/i.test(authorization) ||
        !timingSafeEqual(hash(authorization.slice(7)), tokenHash)
      ) {
        reply(res, 401, { error: 'Dashboard authentication required.' });
        return;
      }
      if (active >= 4) {
        reply(res, 503, { error: 'Dashboard busy.' });
        return;
      }
      active++;
      let client;
      try {
        client = await options.pool.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout = '5s'");
        const { rows } = await client.query<HistoryRow>(
          `SELECT e.id::text, row_hash, (extract(epoch FROM ts)*1000)::float8 AS ts_ms, agent_id, tool, args_hash, decision, event_kind, approval_id, upstream_status, upstream_result_ref, policy_version, matched_rules, resolved_ctx FROM audit.audit_events e WHERE tool='create_refund' AND resolved_ctx->'velocity'->>'merchant_ref'=$1 ORDER BY e.id LIMIT 10001`,
          [merchantRef],
        );
        const { rows: approvals } = await client.query<ApprovalRow>(
          `SELECT a.approval_id, a.reservation_id::text, a.approval_state, a.execution_state, a.execution_id::text, (extract(epoch FROM a.expires_at)*1000)::float8 AS expires_ms FROM approvals.requests a JOIN audit.audit_events e ON e.id=a.reservation_id WHERE e.resolved_ctx->'velocity'->>'merchant_ref'=$1 ORDER BY a.reservation_id LIMIT 10001`,
          [merchantRef],
        );
        if (approvals.length > 10000) throw new Error();
        const now = (
          await client.query<{ now: number }>(
            'SELECT (extract(epoch FROM clock_timestamp()::timestamptz(3))*1000)::float8 AS now',
          )
        ).rows[0]!.now;
        const result = dashboardData(rows, {
          now,
          merchantRef,
          keyId,
          agents,
          approvals,
        });
        reply(
          res,
          200,
          url.pathname === '/audit'
            ? {
                as_of: result.as_of,
                coverage: result.coverage,
                items: result.audit,
              }
            : (({ audit: _audit, ...stats }) => stats)(result),
        );
      } catch {
        reply(res, 503, { error: 'Dashboard data unavailable.' });
      } finally {
        if (client) {
          let discard = false;
          try {
            await client.query('ROLLBACK');
          } catch {
            discard = true;
          }
          client.release(discard);
        }
        active--;
      }
    })().catch(() => {
      if (!res.headersSent)
        reply(res, 503, { error: 'Dashboard unavailable.' });
      else res.destroy();
    });
  });
  try {
    await app.listen(port, '127.0.0.1');
    origin = await app.getUrl();
  } catch (error) {
    await app.close();
    throw error;
  }
  return { url: origin, close: () => app.close() };
}
