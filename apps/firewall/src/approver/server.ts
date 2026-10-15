import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import {
  ApprovalService,
  ApprovalConflictError,
  ApprovalNotFoundError,
  ApprovalAuthorizationError,
} from '../approvals/index.ts';
import type { ApprovalDetails, ApprovalRefresh } from '../approvals/index.ts';
import { approvalId } from '../approvals/binding.ts';
import { object, snapshot } from '../context/json.ts';
import type { RefundExecutor } from '../refunds.ts';
import { DeviceAuthority, ApproverAuthError } from './identity.ts';
import type { DeviceGrant } from './identity.ts';
import { ApprovalDelivery } from './delivery.ts';

export type ApproverOptions = {
  pool: Pick<Pool, 'connect'>;
  merchantId: string;
  identityKey: string;
  signingKey: string;
  devices: () => readonly DeviceGrant[];
  executor: Pick<RefundExecutor, 'identity' | 'execute' | 'reconcile'>;
  refresh: ApprovalRefresh;
  notifier?: { send(token: string, approvalId: string): Promise<void> };
  port?: number;
  pollIntervalMs?: number;
  clock?: () => number | undefined;
};
class ApproverModule {}
Module({})(ApproverModule);
class HttpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
function reject(code: number, message: string): never {
  throw new HttpError(code, message);
}
function reply(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}
function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  if (
    typeof value !== 'string' ||
    !value.startsWith('Bearer ') ||
    value.length > 8192
  )
    throw new ApproverAuthError();
  return value.slice(7);
}
async function json(req: IncomingMessage) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    reject(415, 'JSON is required.');
  if (req.headers['content-encoding'] !== undefined)
    reject(415, 'Encoded bodies are unsupported.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  req.setTimeout(5000, () => req.destroy());
  try {
    for await (const part of req.iterator({ destroyOnReturn: false })) {
      const chunk = Buffer.from(part);
      bytes += chunk.length;
      if (bytes > 16384) {
        req.resume();
        reject(413, 'Request is too large.');
      }
      chunks.push(chunk);
    }
    try {
      return object(
        snapshot(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
      );
    } catch {
      return reject(400, 'Invalid request.');
    }
  } finally {
    req.setTimeout(0);
  }
}
function publicDetails(detail: ApprovalDetails) {
  const context = detail.input.context;
  return {
    approval_id: detail.approval_id,
    status: detail.status,
    execution_state: detail.execution_state,
    execution_id: detail.execution_id,
    result: detail.result,
    args_hash: detail.args_hash,
    args: context.args,
    context: {
      agent: { id: context.agent.id },
      customer: { id: context.customer.id },
      merchant: { id: context.merchant.id },
      amount: context.amount,
    },
    policy_version: detail.policy_version,
    created_at: detail.created_at,
    expires_at: detail.expires_at,
  };
}
export async function startApproverServer(options: ApproverOptions) {
  if (typeof options.refresh !== 'function')
    throw new Error('Approver configuration unavailable.');
  const port = options.port ?? 0,
    poll = options.pollIntervalMs ?? 1000;
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !Number.isInteger(poll) ||
    poll < 0 ||
    poll > 60000
  )
    throw new Error('Approver configuration unavailable.');
  const authority = new DeviceAuthority(options.pool, options),
    delivery = new ApprovalDelivery(options.pool, authority, options.notifier);
  const service = new ApprovalService(options.pool, {
    identityKey: options.identityKey,
    merchantId: options.merchantId,
    executor: options.executor,
    onCreated: delivery.enqueue,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const app = await NestFactory.create(ApproverModule, {
    logger: false,
    bodyParser: false,
    abortOnError: false,
  });
  let origin = '',
    closing = false;
  app.use((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        if (closing) reject(503, 'Approval unavailable.');
        if (
          req.headers.host !== new URL(origin).host ||
          (req.headers.origin !== undefined && req.headers.origin !== origin)
        )
          reject(403, 'Forbidden origin or host.');
        const url = new URL(req.url ?? '/', origin);
        if (url.pathname === '/devices/register') {
          if (req.method !== 'POST') reject(405, 'Method not allowed.');
          if (url.search) reject(400, 'Invalid request.');
          const token = bearer(req),
            body = await json(req);
          if (
            Object.keys(body).length !== 2 ||
            typeof body.device_id !== 'string' ||
            typeof body.fcm_token !== 'string'
          )
            reject(400, 'Invalid request.');
          reply(
            res,
            201,
            await authority.enroll(body.device_id, body.fcm_token, token),
          );
          return;
        }
        const principal = await authority.authenticate(bearer(req));
        if (url.pathname === '/approvals') {
          if (req.method !== 'GET') reject(405, 'Method not allowed.');
          const params = url.searchParams;
          if (
            [...params.keys()].some(
              (k) => !['status', 'cursor', 'limit'].includes(k),
            ) ||
            [...new Set(params.keys())].some(
              (k) => params.getAll(k).length !== 1,
            ) ||
            params.get('status') !== 'pending'
          )
            reject(400, 'Invalid request.');
          const rawLimit = params.get('limit');
          if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
            reject(400, 'Invalid request.');
          const cursor = params.get('cursor');
          if (cursor !== null)
            try {
              approvalId(cursor);
            } catch {
              reject(400, 'Invalid request.');
            }
          const listed = await service.pending({
            agentId: principal.agentId,
            ...(cursor !== null ? { cursor } : {}),
            ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
          });
          reply(res, 200, {
            items: listed.items.map(publicDetails),
            next_cursor: listed.next_cursor,
          });
          return;
        }
        const path = /^\/approvals\/([^/]+)(\/decision)?$/.exec(url.pathname);
        if (!path) reject(404, 'Approval not found.');
        let id: string;
        try {
          id = approvalId(path[1]);
        } catch {
          return reject(400, 'Invalid request.');
        }
        if (url.search) reject(400, 'Invalid request.');
        if (!path[2]) {
          if (req.method !== 'GET') reject(405, 'Method not allowed.');
          reply(
            res,
            200,
            publicDetails(
              await service.details({
                agentId: principal.agentId,
                approvalId: id,
              }),
            ),
          );
          return;
        }
        if (req.method !== 'POST') reject(405, 'Method not allowed.');
        const body = await json(req);
        if (
          Object.keys(body).length !== 2 ||
          typeof body.decision !== 'string' ||
          !['approve', 'deny'].includes(body.decision) ||
          typeof body.args_hash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(body.args_hash)
        )
          reject(400, 'Invalid request.');
        const result = await service.decide(
          {
            approvalId: id,
            agentId: principal.agentId,
            decision: body.decision as 'approve' | 'deny',
            argsHash: body.args_hash,
          },
          options.refresh,
          (client) => authority.authorize(client, principal),
        );
        if (
          result.status === 'expired' ||
          result.status === 'pending' ||
          (body.decision === 'deny' && result.status !== 'denied')
        )
          reject(409, 'Approval changed or busy.');
        reply(
          res,
          result.execution_state === 'in_flight' ||
            result.execution_state === 'unknown'
            ? 202
            : 200,
          result,
        );
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error instanceof HttpError)
          reply(res, error.code, { error: error.message });
        else if (
          error instanceof ApproverAuthError ||
          error instanceof ApprovalAuthorizationError
        )
          reply(res, 401, { error: 'Approver authentication required.' });
        else if (error instanceof ApprovalNotFoundError)
          reply(res, 404, { error: 'Approval not found.' });
        else if (error instanceof ApprovalConflictError)
          reply(res, 409, { error: 'Approval changed.' });
        else reply(res, 503, { error: 'Approval unavailable.' });
      }
    })();
  });
  try {
    await app.listen(port, '127.0.0.1');
    origin = await app.getUrl();
  } catch (error) {
    await app.close();
    throw error;
  }
  const timer =
    poll > 0 && options.notifier
      ? setInterval(() => {
          void delivery.drain().catch(() => {});
        }, poll)
      : undefined;
  timer?.unref();
  let shutdown: Promise<void> | undefined;
  return {
    url: origin,
    service,
    drainNotifications: () => delivery.drain(),
    close: () => {
      shutdown ??= (async () => {
        closing = true;
        if (timer) clearInterval(timer);
        await delivery.close();
        await app.close();
      })();
      return shutdown;
    },
  };
}
