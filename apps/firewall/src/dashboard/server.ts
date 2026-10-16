import 'reflect-metadata';
import { assertReplayDatabase } from '../policy-preview/database.ts';
import { PolicyPreview, readPreviewBody } from '../policy-preview/service.ts';
import type { PreviewOptions } from '../policy-preview/service.ts';
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
import { auditQuery } from './query.ts';
import { parseIntent } from './query-contract.ts';
import type { QueryClassifier } from './query-contract.ts';
import { checkHostedReader } from './hosted-reader.ts';

export type DashboardOptions = {
  hosted?: { publicOrigin: string };
  policyPreview?: PreviewOptions;
  pool: Pick<Pool, 'connect'>;
  identityKey: string;
  merchantId: string;
  token: string;
  agents?: readonly { id: string; name: string; budgetCents?: number }[];
  staticDirectory?: string;
  port?: number;
  classify?: QueryClassifier;
  queryMode?: 'claude' | 'synthetic';
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

async function question(req: IncomingMessage): Promise<string> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') ||
    req.headers['content-encoding'] !== undefined
  )
    throw new Error();
  const timer = setTimeout(() => req.destroy(), 5000);
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const part of req.iterator({ destroyOnReturn: false })) {
      const chunk = Buffer.from(part);
      bytes += chunk.length;
      if (bytes > 8192) {
        req.resume();
        throw new Error();
      }
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !('question' in value) ||
      typeof value.question !== 'string' ||
      !value.question.trim() ||
      value.question.length > 2000
    )
      throw new Error();
    return value.question.trim();
  } finally {
    clearTimeout(timer);
  }
}

export async function startDashboardServer(options: DashboardOptions) {
  let hostedOrigin: string | undefined;
  if (options.hosted !== undefined) {
    try {
      const value = options.hosted.publicOrigin;
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.origin !== value ||
        options.policyPreview !== undefined ||
        options.classify !== undefined ||
        options.queryMode !== undefined ||
        options.staticDirectory !== undefined
      )
        throw new Error();
      hostedOrigin = value;
    } catch {
      throw new Error('Invalid hosted dashboard configuration.');
    }
  }
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
  const policyAccess = options.policyPreview?.accessToken;
  if (options.policyPreview) {
    if (
      typeof policyAccess !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(policyAccess) ||
      [options.identityKey, options.token].some(
        (key) => key.toLowerCase() === policyAccess.toLowerCase(),
      )
    )
      throw new Error('Invalid policy reviewer configuration.');
    options.policyPreview.replay.assertIndependent(policyAccess);
  }
  const policyTokenHash = policyAccess ? hash(policyAccess) : undefined;
  options.policyPreview?.replay.assertIndependent(options.identityKey);
  options.policyPreview?.replay.assertIndependent(options.token);
  if (options.policyPreview)
    await assertReplayDatabase(options.pool, options.policyPreview.pool);
  const preview = options.policyPreview
    ? new PolicyPreview(options.policyPreview)
    : undefined;
  const tokenHash = hash(options.token);
  const exactSupport = options.agents?.find((a) => a.id === 'support-bot');
  const supportRef = exactSupport
    ? `agent:${reference('agent', exactSupport.id)}`
    : undefined;
  const app = await NestFactory.create(DashboardModule, {
    logger: false,
    bodyParser: false,
    abortOnError: false,
  });
  let origin = '',
    active = 0,
    checkingHealth = false,
    querying = false;
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
      if (
        hostedOrigin &&
        !['/healthz', '/audit', '/stats'].includes(url.pathname)
      ) {
        reply(res, 404, { error: 'Not found.' });
        return;
      }
      const isPolicy = [
        '/policy',
        '/policy/propose',
        '/policy/dry-run',
        '/policy/export',
      ].includes(url.pathname);
      const isQuery = url.pathname === '/query';
      if (
        req.method !==
        (isQuery || (isPolicy && url.pathname !== '/policy') ? 'POST' : 'GET')
      ) {
        reply(res, 405, { error: 'Read-only dashboard.' });
        return;
      }
      if (url.search) {
        reply(res, 400, { error: 'Invalid request.' });
        return;
      }
      if (hostedOrigin && url.pathname === '/healthz') {
        if (checkingHealth || active >= 4) {
          reply(res, 503, { ready: false });
          return;
        }
        checkingHealth = true;
        active++;
        try {
          await checkHostedReader(options.pool);
          reply(res, 200, { ready: true });
        } catch {
          reply(res, 503, { ready: false });
        } finally {
          active--;
          checkingHealth = false;
        }
        return;
      }
      if (
        !isQuery &&
        !isPolicy &&
        url.pathname !== '/audit' &&
        url.pathname !== '/stats'
      ) {
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
      if (isPolicy) {
        const reviewer = req.headers['x-spendwall-policy-token'];
        if (
          !policyTokenHash ||
          typeof reviewer !== 'string' ||
          !/^[a-f0-9]{64}$/i.test(reviewer) ||
          !timingSafeEqual(hash(reviewer), policyTokenHash)
        ) {
          reply(res, 401, {
            error: 'Policy reviewer authentication required.',
          });
          return;
        }
      }
      if (active >= 4 || (isQuery && querying)) {
        reply(res, 503, { error: 'Dashboard busy.' });
        return;
      }
      active++;
      if (isQuery) querying = true;
      let client;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.once('close', cancel);
      try {
        if (isPolicy) {
          if (!preview) {
            reply(res, 404, { error: 'Policy preview is not configured.' });
            return;
          }
          try {
            const input =
              req.method === 'GET' ? {} : await readPreviewBody(req);
            const result = await preview.run(
              url.pathname,
              input,
              { merchantRef, keyId },
              controller.signal,
            );
            reply(res, 200, result);
          } catch {
            reply(res, 400, {
              error:
                'Policy preview unavailable. Check the draft and reload the current policy.',
            });
          }
          return;
        }
        let intent;
        if (isQuery) {
          let text;
          try {
            text = await question(req);
          } catch {
            reply(res, 400, { error: 'Invalid query.' });
            return;
          }
          if (!options.classify) {
            reply(res, 503, { error: 'Audit agent is not configured.' });
            return;
          }
          const timer = setTimeout(cancel, 10000);
          try {
            controller.signal.throwIfAborted();
            const stopped = new Promise<never>((_, reject) =>
              controller.signal.addEventListener(
                'abort',
                () => reject(new Error('Query cancelled.')),
                { once: true },
              ),
            );
            intent = parseIntent(
              await Promise.race([
                options.classify(text, controller.signal),
                stopped,
              ]),
            );
          } finally {
            clearTimeout(timer);
          }
          if (intent === 'unsupported') {
            reply(res, 422, {
              error:
                'Use one complete question matching the three supported audit queries.',
            });
            return;
          }
          controller.signal.throwIfAborted();
        }
        client = await options.pool.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout = '5s'");
        const continuity = await client.query<{ mismatch: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM audit.audit_events WHERE tool='create_refund' AND resolved_ctx ? 'velocity' AND (jsonb_typeof(resolved_ctx->'velocity'->'key_id') IS DISTINCT FROM 'string' OR resolved_ctx->'velocity'->>'key_id' IS DISTINCT FROM $1)) AS mismatch`,
          [keyId],
        );
        if (continuity.rows[0]?.mismatch !== false) throw new Error();
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
        const projectionOptions = {
          now,
          merchantRef,
          keyId,
          agents,
          approvals,
        };
        if (isQuery && intent) {
          const result = auditQuery(intent, rows, {
            ...projectionOptions,
            ...(supportRef ? { supportRef } : {}),
          });
          controller.signal.throwIfAborted();
          // Finish the snapshot before acknowledging a query; an immediate next
          // question must not race the previous response's transaction cleanup.
          await client.query('ROLLBACK');
          client.release();
          client = undefined;
          reply(res, 200, result);
          return;
        }
        const result = dashboardData(rows, projectionOptions);
        reply(
          res,
          200,
          url.pathname === '/audit'
            ? {
                as_of: result.as_of,
                coverage: result.coverage,
                items: result.audit,
              }
            : (({ audit: _audit, ...stats }) => ({
                ...stats,
                policy_preview_mode: preview
                  ? options.policyPreview!.generate
                    ? (options.policyPreview!.mode ?? 'claude')
                    : 'disabled'
                  : 'disabled',
                query_mode: options.classify
                  ? (options.queryMode ?? 'claude')
                  : 'disabled',
              }))(result),
        );
      } catch {
        reply(res, 503, { error: 'Dashboard data unavailable.' });
      } finally {
        res.removeListener('close', cancel);
        controller.abort();
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
        if (isQuery) querying = false;
      }
    })().catch(() => {
      if (!res.headersSent)
        reply(res, 503, { error: 'Dashboard unavailable.' });
      else res.destroy();
    });
  });
  try {
    await app.listen(port, hostedOrigin ? '0.0.0.0' : '127.0.0.1');
    origin = hostedOrigin ?? (await app.getUrl());
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    url: origin,
    listenUrl: await app.getUrl(),
    close: () => app.close(),
  };
}
