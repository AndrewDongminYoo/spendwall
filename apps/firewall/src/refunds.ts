import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createTokenManager } from './token.ts';
import type { TokenOptions } from './token.ts';

const api = 'https://api-m.sandbox.paypal.com';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifier = /^[A-Za-z0-9_-]{15,32}$/;
const replayMs = 24 * 60 * 60 * 1_000;
const unknownMessage =
  'Refund outcome unknown; reuse the same execution ID for recovery.';

type Money = { value: string; currency_code: 'USD' };
type RefundArgs = {
  capture_id: string;
  amount?: Money;
  invoice_id?: string;
  note_to_payer?: string;
};
type RefundBody = {
  amount: Money;
  invoice_id?: string;
  note_to_payer?: string;
};
export type RefundResult = {
  executionId: string;
  captureId: string;
  id: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'CANCELLED';
  amount: Money;
};
type Execution = {
  args: RefundArgs;
  body: RefundBody;
  bodyHash: string;
  startedAt: number;
  status: 'unknown' | 'completed' | 'pending' | 'failed';
  result?: RefundResult;
};
type Ledger = {
  schemaVersion: 1;
  environment: 'sandbox';
  clientIdHash: string;
  executions: Record<string, Execution>;
};
type Options = TokenOptions & {
  ledgerPath: string;
  timeoutMs?: number;
  tokens?: ReturnType<typeof createTokenManager>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function money(value: unknown): Money {
  if (
    !isRecord(value) ||
    value.currency_code !== 'USD' ||
    typeof value.value !== 'string' ||
    !/^\d{1,9}(\.\d{1,2})?$/.test(value.value) ||
    Object.keys(value).some((key) => !['value', 'currency_code'].includes(key))
  )
    throw new Error('A positive USD amount is required.');
  const [whole, fraction = ''] = value.value.split('.');
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n) throw new Error('A positive USD amount is required.');
  return {
    value: `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`,
    currency_code: 'USD',
  };
}

function cents(value: Money) {
  return BigInt(value.value.replace('.', ''));
}

function normalizeArgs(value: unknown): RefundArgs {
  if (
    !isRecord(value) ||
    typeof value.capture_id !== 'string' ||
    !identifier.test(value.capture_id) ||
    Object.keys(value).some(
      (key) =>
        !['capture_id', 'amount', 'invoice_id', 'note_to_payer'].includes(key),
    )
  )
    throw new Error('Invalid refund arguments.');
  const args: RefundArgs = { capture_id: value.capture_id };
  if (value.amount !== undefined) args.amount = money(value.amount);
  if (value.invoice_id !== undefined) {
    if (
      typeof value.invoice_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,127}$/.test(value.invoice_id)
    )
      throw new Error('Invalid invoice ID.');
    args.invoice_id = value.invoice_id;
  }
  if (value.note_to_payer !== undefined) {
    if (
      typeof value.note_to_payer !== 'string' ||
      value.note_to_payer.length > 255
    )
      throw new Error('Invalid payer note.');
    args.note_to_payer = value.note_to_payer;
  }
  return args;
}

function parseRefund(
  value: unknown,
  executionId: string,
  entry: Execution,
): RefundResult {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !identifier.test(value.id) ||
    !['COMPLETED', 'PENDING', 'FAILED', 'CANCELLED'].includes(
      String(value.status),
    )
  )
    throw new Error(unknownMessage);
  const amount = money(value.amount);
  if (canonical(amount) !== canonical(entry.body.amount))
    throw new Error(unknownMessage);
  if (
    !Array.isArray(value.links) ||
    !value.links.some(
      (link) =>
        isRecord(link) &&
        link.rel === 'up' &&
        [api, 'https://api.sandbox.paypal.com'].some(
          (origin) =>
            link.href ===
            `${origin}/v2/payments/captures/${entry.args.capture_id}`,
        ),
    )
  )
    throw new Error(unknownMessage);
  return {
    executionId,
    captureId: entry.args.capture_id,
    id: value.id,
    status: value.status as RefundResult['status'],
    amount,
  };
}

function validateLedger(value: unknown, clientIdHash: string): Ledger {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.environment !== 'sandbox' ||
    !isRecord(value.executions) ||
    Object.keys(value).some(
      (key) =>
        ![
          'schemaVersion',
          'environment',
          'clientIdHash',
          'executions',
        ].includes(key),
    )
  )
    throw new Error('Invalid refund ledger.');
  if (value.clientIdHash !== clientIdHash)
    throw new Error('Refund ledger belongs to a different sandbox app.');
  try {
    for (const [id, candidate] of Object.entries(value.executions)) {
      if (
        !uuid.test(id) ||
        !isRecord(candidate) ||
        !isRecord(candidate.body) ||
        typeof candidate.startedAt !== 'number' ||
        !Number.isSafeInteger(candidate.startedAt) ||
        !['unknown', 'completed', 'pending', 'failed'].includes(
          String(candidate.status),
        )
      )
        throw new Error();
      const args = normalizeArgs(candidate.args);
      const body = normalizeArgs({
        ...candidate.body,
        capture_id: args.capture_id,
      });
      delete (body as Partial<RefundArgs>).capture_id;
      if (
        !body.amount ||
        candidate.bodyHash !== hash(canonical(candidate.body)) ||
        canonical(body) !== canonical(candidate.body) ||
        canonical(args) !== canonical(candidate.args)
      )
        throw new Error();
      if (args.amount && canonical(args.amount) !== canonical(body.amount))
        throw new Error();
      if (
        args.invoice_id !== body.invoice_id ||
        args.note_to_payer !== body.note_to_payer
      )
        throw new Error();
      if (candidate.result !== undefined) {
        if (
          !isRecord(candidate.result) ||
          candidate.result.executionId !== id ||
          candidate.result.captureId !== args.capture_id ||
          typeof candidate.result.id !== 'string' ||
          !identifier.test(candidate.result.id) ||
          canonical(money(candidate.result.amount)) !== canonical(body.amount)
        )
          throw new Error();
        const expected =
          candidate.result.status === 'COMPLETED'
            ? 'completed'
            : candidate.result.status === 'PENDING'
              ? 'pending'
              : ['FAILED', 'CANCELLED'].includes(
                    String(candidate.result.status),
                  )
                ? 'failed'
                : null;
        if (candidate.status !== expected) throw new Error();
      } else if (['completed', 'pending'].includes(String(candidate.status)))
        throw new Error();
    }
  } catch {
    throw new Error('Invalid refund ledger.');
  }
  return value as Ledger;
}

export class RefundExecutor {
  private options: Options;
  private ledger: Ledger;
  private lock: FileHandle;
  private tokens: ReturnType<typeof createTokenManager>;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private persistenceFailed = false;

  private constructor(options: Options, ledger: Ledger, lock: FileHandle) {
    this.options = options;
    this.ledger = ledger;
    this.lock = lock;
    this.tokens = options.tokens ?? createTokenManager(options);
  }

  static async open(options: Options): Promise<RefundExecutor> {
    const env = options.env ?? process.env;
    if (!env.PAYPAL_CLIENT_ID?.trim() || !env.PAYPAL_CLIENT_SECRET?.trim())
      throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET locally.');
    await mkdir(dirname(options.ledgerPath), { recursive: true, mode: 0o700 });
    let lock: FileHandle;
    try {
      lock = await open(`${options.ledgerPath}.lock`, 'wx', 0o600);
    } catch {
      throw new Error('Refund ledger locked; check for a running proxy.');
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      const clientIdHash = hash(env.PAYPAL_CLIENT_ID);
      let ledger: Ledger;
      try {
        ledger = validateLedger(
          JSON.parse(await readFile(options.ledgerPath, 'utf8')),
          clientIdHash,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error instanceof SyntaxError
            ? new Error('Invalid refund ledger.')
            : error;
        ledger = {
          schemaVersion: 1,
          environment: 'sandbox',
          clientIdHash,
          executions: {},
        };
      }
      return new RefundExecutor(options, ledger, lock);
    } catch (error) {
      await lock.close();
      await rm(`${options.ledgerPath}.lock`);
      throw error;
    }
  }

  private async save() {
    const temporary = `${this.options.ledgerPath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(this.ledger, null, 2) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.options.ledgerPath);
      const directory = await open(dirname(this.options.ledgerPath), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      this.persistenceFailed = true;
      throw new Error(
        'Refund ledger could not be saved; stop and reconcile before retrying.',
      );
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async request(
    path: string,
    body?: RefundBody,
    executionId?: string,
  ): Promise<{ status: number; data: unknown }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokens.get();
      const response = await (this.options.fetchImpl ?? fetch)(
        `${api}${path}`,
        {
          method: body ? 'POST' : 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            ...(executionId ? { 'PayPal-Request-Id': executionId } : {}),
          },
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
          ...(body ? { body: canonical(body) } : {}),
        },
      );
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        this.tokens.invalidate(token);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, data: null };
      }
      return { status: response.status, data: await response.json() };
    }
    throw new Error('PayPal authentication failed.');
  }

  execute(executionId: string, value: unknown): Promise<RefundResult> {
    if (this.closed)
      return Promise.reject(new Error('Refund executor is closed.'));
    const result = this.queue.then(() => this.executeOne(executionId, value));
    this.queue = result.catch(() => {});
    return result;
  }

  private async executeOne(
    executionId: string,
    value: unknown,
  ): Promise<RefundResult> {
    if (this.persistenceFailed)
      throw new Error(
        'Refund ledger save failed; stop and reconcile before retrying.',
      );
    if (!uuid.test(executionId))
      throw new Error('A UUID execution ID is required.');
    executionId = executionId.toLowerCase();
    const args = normalizeArgs(value);
    let entry = this.ledger.executions[executionId];
    const now = (this.options.now ?? Date.now)();
    if (entry) {
      if (canonical(entry.args) !== canonical(args))
        throw new Error('Execution ID is bound to different refund arguments.');
      if (entry.status === 'completed' && entry.result)
        return structuredClone(entry.result);
      if (entry.status === 'failed')
        throw new Error(
          'Refund execution failed; reconcile before creating another operation.',
        );
      if (
        !entry.result &&
        (now < entry.startedAt || now - entry.startedAt >= replayMs)
      )
        throw new Error('Refund replay expired; reconciliation is required.');
    } else {
      let capture: unknown;
      try {
        const response = await this.request(
          `/v2/payments/captures/${args.capture_id}`,
        );
        if (response.status !== 200) throw new Error();
        capture = response.data;
      } catch {
        throw new Error(
          'Sandbox capture lookup failed; no refund was submitted.',
        );
      }
      if (
        !isRecord(capture) ||
        capture.id !== args.capture_id ||
        capture.status !== 'COMPLETED'
      )
        throw new Error(
          'W0 refunds require a completed, not partially refunded, capture.',
        );
      const capturedAmount = money(capture.amount);
      const amount = args.amount ?? capturedAmount;
      if (cents(amount) > cents(capturedAmount))
        throw new Error('Refund exceeds the captured amount.');
      const { capture_id: _captureId, ...optional } = args;
      const body: RefundBody = { ...optional, amount };
      entry = {
        args,
        body,
        bodyHash: hash(canonical(body)),
        startedAt: now,
        status: 'unknown',
      };
      this.ledger.executions[executionId] = entry;
      await this.save();
    }
    let response: { status: number; data: unknown };
    const knownRefund = entry.result;
    try {
      response = knownRefund
        ? await this.request(`/v2/payments/refunds/${knownRefund.id}`)
        : await this.request(
            `/v2/payments/captures/${args.capture_id}/refund`,
            entry.body,
            executionId,
          );
    } catch {
      throw new Error(unknownMessage);
    }
    if (![200, 201].includes(response.status)) {
      throw new Error(
        `Refund outcome unknown (HTTP ${response.status}); preserve the execution ID and reconcile.`,
      );
    }
    let result: RefundResult;
    try {
      result = parseRefund(response.data, executionId, entry);
    } catch {
      throw new Error(unknownMessage);
    }
    if (knownRefund && result.id !== knownRefund.id)
      throw new Error(unknownMessage);
    entry.result = result;
    entry.status =
      result.status === 'COMPLETED'
        ? 'completed'
        : result.status === 'PENDING'
          ? 'pending'
          : 'failed';
    await this.save();
    return structuredClone(result);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.lock.close();
    await rm(`${this.options.ledgerPath}.lock`);
  }
}
