import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { evaluatePolicy } from '../../../../packages/policy/src/index.ts';
import type {
  LoadedPolicy,
  PolicyDecision,
} from '../../../../packages/policy/src/index.ts';
import { AuditLog } from '../audit/index.ts';
import type { AuditReceipt } from '../audit/index.ts';
import { prepareEvent } from '../audit/event.ts';
import type { AuditEvent } from '../audit/event.ts';
import { orderIdentifier } from '../context/index.ts';
import type { ContextResolver, PolicyContext } from '../context/index.ts';
import { freeze, identifier, object, snapshot } from '../context/json.ts';
import type { DenyReason } from '../context/json.ts';
import { createOrder } from '../context/order.ts';
import { canonical } from '../refunds.ts';
import { encodeRuleReferences } from '../velocity/references.ts';

const api = 'https://api-m.sandbox.paypal.com';
const approveOrigin = 'https://www.sandbox.paypal.com/';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const advisoryLock = 'spendwall/orders/v1';
// PayPal documents six-hour Orders v2 idempotency retention; five hours keeps a
// margin (docs/specs/2026-10-13-sandbox-seed.md). After that, reconciliation
// is required and no request is resent under the identifier.
const replayMs = 5 * 60 * 60 * 1_000;

export type Money = { value: string; currency_code: 'USD' };
export type OrderDenyReason =
  | DenyReason
  | 'orders_unavailable'
  | 'request_conflict'
  | 'approval_unsupported'
  | 'order_unknown'
  | 'order_not_approved'
  | 'order_capture_reserved'
  | 'provider_rejected';
export type CreatedOrder = Readonly<{
  id: string;
  status: 'CREATED';
  amount: Money;
  approveUrl: string;
}>;
export type CompletedCapture = Readonly<{
  executionId: string;
  orderId: string;
  id: string;
  status: 'COMPLETED';
  amount: Money;
}>;
export type OrderResult<T> = PolicyDecision &
  Readonly<{
    replayed: boolean;
    receipt?: AuditReceipt;
    reason?: OrderDenyReason;
    result?: T;
  }>;
export class OrderOutcomeUnknownError extends Error {
  readonly id: string;
  constructor(message: string, id: string) {
    super(message);
    this.id = id;
  }
}
export type OrderOptions = {
  identityKey: string;
  resolver: ContextResolver;
  tokens: {
    get(): Promise<string>;
    isSensitive(value: unknown): boolean;
    invalidate?(token: string): void;
  };
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  returnUrl?: string;
  cancelUrl?: string;
};
type OrderRow = {
  request_id: string;
  key_id: string;
  agent_id: string;
  binding_hash: string;
  policy_version: string;
  amount_value: string;
  status: 'unknown' | 'created' | 'failed';
  order_id: string | null;
  approve_url: string | null;
  audit_id: string;
  audit_hash: string;
  attempts: number;
  age_ms: number;
};
type CaptureRow = {
  execution_id: string;
  key_id: string;
  binding_hash: string;
  status: 'unknown' | 'completed' | 'failed';
  capture_id: string | null;
  audit_id: string;
  audit_hash: string;
  attempts: number;
  age_ms: number;
};
type Decision = PolicyDecision & { reason?: OrderDenyReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function httpsUrl(value: unknown, fallback: string): string {
  const text = value ?? fallback;
  if (typeof text !== 'string' || text.length > 512) throw new Error();
  const url = new URL(text);
  if (url.protocol !== 'https:' || url.href !== text) throw new Error();
  return text;
}

// Trusted server composition only. Agents receive approve links, never tokens.
export class OrderService {
  readonly #key: Buffer;
  private readonly pool: Pick<Pool, 'connect'>;
  private readonly options: OrderOptions;
  private readonly returnUrl: string;
  private readonly cancelUrl: string;
  constructor(pool: Pick<Pool, 'connect'>, options: OrderOptions) {
    try {
      if (
        typeof options.identityKey !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(options.identityKey)
      )
        throw new Error();
      this.returnUrl = httpsUrl(
        options.returnUrl,
        'https://example.com/returnUrl',
      );
      this.cancelUrl = httpsUrl(
        options.cancelUrl,
        'https://example.com/cancelUrl',
      );
    } catch {
      throw new Error('Invalid order service configuration.');
    }
    this.#key = Buffer.from(options.identityKey, 'hex');
    this.pool = pool;
    this.options = options;
  }

  private ref(domain: string, value: unknown): string {
    return createHmac('sha256', this.#key)
      .update(canonical(['spendwall/orders', 1, domain, value]))
      .digest('hex');
  }

  private get now() {
    return (this.options.now ?? Date.now)();
  }

  private async request(
    path: string,
    body: string | undefined,
    requestId: string,
  ): Promise<{ status: number; data: unknown }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.options.tokens.get();
      const response = await (this.options.fetchImpl ?? fetch)(
        `${api}${path}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            'PayPal-Request-Id': requestId,
          },
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
          body: body ?? '{}',
        },
      );
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        this.options.tokens.invalidate?.(token);
        continue;
      }
      if (![200, 201].includes(response.status)) {
        await response.body?.cancel();
        return { status: response.status, data: null };
      }
      const data: unknown = await response.json();
      if (this.options.tokens.isSensitive(data)) throw new Error();
      return { status: response.status, data };
    }
    throw new Error('PayPal authentication failed.');
  }

  private async begin(): Promise<PoolClient> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [advisoryLock],
      );
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  private async finish(client: PoolClient | undefined, committed: boolean) {
    if (!client) return;
    let discard = false;
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
    }
    client.release(discard);
  }

  private event(
    context: PolicyContext,
    resolvedCtx: unknown,
    decision: Decision,
    policy: LoadedPolicy,
    upstream?: { status: number; ref: string },
  ): AuditEvent {
    return {
      agentId: `agent:${this.ref('agent', identifier(context.agent.id))}`,
      tool: context.tool,
      args: context.args,
      resolvedCtx,
      decision: decision.decision,
      matchedRules: encodeRuleReferences(policy.rules, decision.matchedRules),
      policyVersion: policy.policyVersion,
      eventKind: 'tool_call',
      latencyMs: 0,
      ...(upstream
        ? { upstreamStatus: upstream.status, upstreamResultRef: upstream.ref }
        : {}),
    };
  }

  // Deny unsupported outcomes before any provider write; approval is PayPal's buyer page.
  private evaluate(policy: LoadedPolicy, context: PolicyContext): Decision {
    const evaluation = evaluatePolicy(policy, { ...context, agg: {} });
    if (evaluation.decision === 'require_approval')
      return {
        ...evaluation,
        decision: 'deny',
        reason: 'approval_unsupported',
      };
    return evaluation;
  }

  private deny<T>(
    policy: LoadedPolicy,
    reason: OrderDenyReason,
    decision?: PolicyDecision,
    receipt?: AuditReceipt,
  ): OrderResult<T> {
    return freeze({
      decision: 'deny',
      matchedRules: decision?.matchedRules ?? [],
      policyVersion: policy.policyVersion,
      replayed: false,
      reason,
      ...(receipt ? { receipt } : {}),
    });
  }

  // A provider rejection is not a policy match: its outcome event records no
  // matched rules, so the first attempt and every replay of it return none.
  private rejected<T>(
    policy: LoadedPolicy,
    receipt: AuditReceipt,
    replayed: boolean,
  ): OrderResult<T> {
    return freeze({
      decision: 'deny',
      matchedRules: [],
      policyVersion: policy.policyVersion,
      replayed,
      reason: 'provider_rejected',
      receipt,
    });
  }

  // Every path that answers a bound identifier from its ledger row converges
  // here. A changed binding is another request and is refused before the row
  // is read. A settled row answers as a replay, without a provider call, with
  // the stored receipt and the matched rules of the first attempt. An unknown
  // row returns nothing, so the caller resends under the same identifier.
  private replay<T>(
    policy: LoadedPolicy,
    row: Pick<
      OrderRow | CaptureRow,
      'status' | 'binding_hash' | 'audit_id' | 'audit_hash'
    >,
    binding: string,
    matchedRules: readonly string[],
    result: () => T,
  ): OrderResult<T> | undefined {
    if (row.binding_hash !== binding)
      return this.deny(policy, 'request_conflict');
    if (row.status === 'unknown') return undefined;
    const receipt = { id: row.audit_id, row_hash: row.audit_hash };
    if (row.status === 'failed') return this.rejected(policy, receipt, true);
    return freeze({
      decision: 'allow',
      matchedRules,
      policyVersion: policy.policyVersion,
      replayed: true,
      receipt,
      result: result(),
    });
  }

  private parseEnvelope(
    input: unknown,
    idField: 'requestId' | 'executionId',
  ): { id: string; args: Record<string, unknown> } {
    const submitted = object(snapshot(input));
    if (
      Object.keys(submitted).length !== 2 ||
      !Object.hasOwn(submitted, idField) ||
      !Object.hasOwn(submitted, 'args') ||
      typeof submitted[idField] !== 'string' ||
      !uuid.test(submitted[idField])
    )
      throw new Error();
    return {
      id: submitted[idField].toLowerCase(),
      args: object(submitted.args),
    };
  }

  private trusted(input: unknown) {
    const trusted = object(snapshot(input));
    if (
      Object.keys(trusted).length !== 2 ||
      !Object.hasOwn(trusted, 'agent') ||
      !Object.hasOwn(trusted, 'customer')
    )
      throw new Error();
    return { ...trusted, agg: {} };
  }

  private body(context: PolicyContext, requestId: string): string {
    const facts = createOrder(context.args);
    const money = (value: { value: string }): Money => ({
      currency_code: 'USD',
      value: value.value,
    });
    return canonical({
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: requestId,
          amount: {
            ...money(facts.total),
            breakdown: {
              item_total: money(facts.itemTotal),
              tax_total: money(facts.taxTotal),
              shipping: money(facts.shipping),
              discount: money(facts.discount),
            },
          },
          items: facts.lines.map((line) => ({
            name: line.name,
            ...(line.description === undefined
              ? {}
              : { description: line.description }),
            quantity: String(line.quantity),
            unit_amount: money(line.unit),
            tax: money(line.unitTax),
          })),
        },
      ],
      application_context: {
        user_action: 'PAY_NOW',
        return_url: this.returnUrl,
        cancel_url: this.cancelUrl,
      },
    });
  }

  private parseCreated(
    value: unknown,
    requestId: string,
    amount: Money,
  ): CreatedOrder {
    if (
      !isRecord(value) ||
      value.status !== 'CREATED' ||
      !Array.isArray(value.purchase_units) ||
      value.purchase_units.length !== 1 ||
      !Array.isArray(value.links)
    )
      throw new Error();
    const id = orderIdentifier(value.id);
    const unit = value.purchase_units[0];
    if (
      !isRecord(unit) ||
      unit.custom_id !== requestId ||
      !isRecord(unit.amount) ||
      unit.amount.currency_code !== amount.currency_code ||
      unit.amount.value !== amount.value
    )
      throw new Error();
    const approve = value.links.filter(
      (link) => isRecord(link) && link.rel === 'approve',
    );
    const href =
      approve.length === 1
        ? (approve[0] as { href?: unknown }).href
        : undefined;
    if (
      typeof href !== 'string' ||
      !href.startsWith(approveOrigin) ||
      href.length > 512 ||
      /\s/.test(href) ||
      this.options.tokens.isSensitive(href)
    )
      throw new Error();
    return freeze({ id, status: 'CREATED', amount, approveUrl: href });
  }

  private parseCaptured(
    value: unknown,
    executionId: string,
    orderId: string,
    amount: Money,
  ): CompletedCapture {
    if (
      !isRecord(value) ||
      value.id !== orderId ||
      value.status !== 'COMPLETED' ||
      !Array.isArray(value.purchase_units) ||
      value.purchase_units.length !== 1
    )
      throw new Error();
    const unit = value.purchase_units[0];
    if (!isRecord(unit) || !isRecord(unit.payments)) throw new Error();
    const captures = unit.payments.captures;
    if (!Array.isArray(captures) || captures.length !== 1) throw new Error();
    const capture = captures[0];
    if (
      !isRecord(capture) ||
      capture.status !== 'COMPLETED' ||
      !isRecord(capture.amount) ||
      capture.amount.currency_code !== amount.currency_code ||
      capture.amount.value !== amount.value
    )
      throw new Error();
    return freeze({
      executionId,
      orderId,
      id: identifier(capture.id, 15, 32),
      status: 'COMPLETED',
      amount,
    });
  }

  async create(
    policy: LoadedPolicy,
    input: unknown,
    trustedContext: unknown,
  ): Promise<OrderResult<CreatedOrder>> {
    let envelope, trusted;
    try {
      envelope = this.parseEnvelope(input, 'requestId');
      trusted = this.trusted(trustedContext);
    } catch {
      return this.deny(policy, 'invalid_arguments');
    }
    const requestId = envelope.id;
    let client: PoolClient | undefined;
    let committed = false;
    let pending:
      | {
          context: PolicyContext;
          amount: Money;
          body: string;
          retry: boolean;
          matchedRules: readonly string[];
          binding: string;
        }
      | undefined;
    try {
      client = await this.begin();
      const resolution = await this.options.resolver.resolve(
        { tool: 'create_order', args: envelope.args },
        trusted,
      );
      if (!resolution.ok) return this.deny(policy, resolution.reason);
      const context = resolution.context;
      const merchantRef = this.ref('merchant', identifier(context.merchant.id));
      const amount: Money = {
        value: context.amount.value,
        currency_code: 'USD',
      };
      if (context.amount.currency !== 'USD')
        return this.deny(policy, 'unresolved_context');
      // The server-owned URLs are part of the request body, so a changed
      // configuration must not resend a different body under the same
      // PayPal-Request-Id.
      const binding = this.ref('request', {
        requestId,
        context,
        resolvedCtx: resolution.resolvedCtx,
        policyVersion: policy.policyVersion,
        returnUrl: this.returnUrl,
        cancelUrl: this.cancelUrl,
      });
      const { rows } = await client.query<OrderRow>(
        `SELECT request_id::text, key_id, agent_id, binding_hash, policy_version, amount_value, status,
          order_id, approve_url, audit_id::text, audit_hash,
          (extract(epoch FROM clock_timestamp()-created_at)*1000)::float8 AS age_ms
        FROM orders.orders WHERE merchant_ref=$1 AND request_id=$2::uuid`,
        [merchantRef, requestId],
      );
      const previous = rows[0];
      // Evaluated before the ledger lookup so a replay or retry of a bound
      // request carries the same matched rules as its first attempt: the
      // binding hash and policy version checks below prove the inputs equal.
      const decision = this.evaluate(policy, context);
      if (previous) {
        if (previous.key_id !== this.ref('key', 'continuity'))
          throw new Error();
        if (previous.policy_version !== policy.policyVersion)
          return this.deny(policy, 'request_conflict');
        const settled = this.replay(
          policy,
          previous,
          binding,
          decision.matchedRules,
          () =>
            freeze({
              id: previous.order_id!,
              status: 'CREATED' as const,
              amount,
              approveUrl: previous.approve_url!,
            }),
        );
        if (settled) {
          await client.query('COMMIT');
          committed = true;
          return settled;
        }
        if (previous.age_ms < 0 || previous.age_ms >= replayMs)
          throw new OrderOutcomeUnknownError(
            'Order creation replay expired; reconciliation is required.',
            requestId,
          );
        // Every provider attempt is counted in the ledger so a later rejection
        // can tell a lone first attempt from a duplicate of another attempt.
        await client.query(
          `UPDATE orders.orders SET attempts=attempts+1
          WHERE merchant_ref=$1 AND request_id=$2::uuid AND status='unknown'`,
          [merchantRef, requestId],
        );
        await client.query('COMMIT');
        committed = true;
        pending = {
          context,
          amount,
          body: this.body(context, requestId),
          retry: true,
          matchedRules: decision.matchedRules,
          binding,
        };
      } else {
        const receipt = await new AuditLog(client).append(
          this.event(context, resolution.resolvedCtx, decision, policy),
        );
        if (decision.decision !== 'allow') {
          await client.query('COMMIT');
          committed = true;
          return this.deny(
            policy,
            decision.reason ?? 'unresolved_context',
            decision,
            receipt,
          );
        }
        const body = this.body(context, requestId);
        const prepared = prepareEvent(
          this.event(context, resolution.resolvedCtx, decision, policy),
        );
        await client.query(
          `INSERT INTO orders.orders(merchant_ref,request_id,key_id,agent_id,binding_hash,args_hash,policy_version,
            amount_value,amount_currency,status,attempts,audit_id,audit_hash)
          VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8,'USD','unknown',1,$9::bigint,$10)`,
          [
            merchantRef,
            requestId,
            this.ref('key', 'continuity'),
            prepared.agent_id,
            binding,
            prepared.args_hash,
            policy.policyVersion,
            amount.value,
            receipt.id,
            receipt.row_hash,
          ],
        );
        await client.query('COMMIT');
        committed = true;
        pending = {
          context,
          amount,
          body,
          retry: false,
          matchedRules: decision.matchedRules,
          binding,
        };
      }
    } catch (error) {
      if (error instanceof OrderOutcomeUnknownError) throw error;
      return this.deny(policy, 'orders_unavailable');
    } finally {
      await this.finish(client, committed);
      client = undefined;
    }
    return this.submitOrder(policy, requestId, pending);
  }

  private async submitOrder(
    policy: LoadedPolicy,
    requestId: string,
    pending: {
      context: PolicyContext;
      amount: Money;
      body: string;
      retry: boolean;
      matchedRules: readonly string[];
      binding: string;
    },
  ): Promise<OrderResult<CreatedOrder>> {
    const merchantRef = this.ref(
      'merchant',
      identifier(pending.context.merchant.id),
    );
    const unknown = (message: string) =>
      new OrderOutcomeUnknownError(message, requestId);
    let response;
    try {
      response = await this.request(
        '/v2/checkout/orders',
        pending.body,
        requestId,
      );
    } catch {
      throw unknown(
        'Order outcome unknown; reuse the same request ID for recovery.',
      );
    }
    let created: CreatedOrder | undefined;
    let definitiveFailure = false;
    if (response.status === 201 || response.status === 200) {
      try {
        created = this.parseCreated(response.data, requestId, pending.amount);
      } catch {
        throw unknown(
          'Order outcome unknown; reuse the same request ID for recovery.',
        );
      }
    } else if (
      response.status >= 400 &&
      response.status < 500 &&
      ![408, 429].includes(response.status)
    ) {
      definitiveFailure = true;
    } else {
      throw unknown(
        `Order outcome unknown (HTTP ${response.status}); reuse the same request ID for recovery.`,
      );
    }
    let client: PoolClient | undefined;
    let committed = false;
    let receipt: AuditReceipt;
    try {
      client = await this.begin();
      const { rows } = await client.query<
        Pick<
          OrderRow,
          | 'status'
          | 'order_id'
          | 'binding_hash'
          | 'audit_id'
          | 'audit_hash'
          | 'attempts'
        >
      >(
        `SELECT status, order_id, binding_hash, audit_id::text, audit_hash, attempts::int FROM orders.orders
        WHERE merchant_ref=$1 AND request_id=$2::uuid`,
        [merchantRef, requestId],
      );
      const row = rows[0];
      if (!row) throw new Error();
      if (row.status !== 'unknown') {
        // An overlapping call with the same request UUID settled first and the
        // provider replayed its idempotent response; the settled row answers
        // this call as it answers any replay.
        const agreed =
          row.status === 'created'
            ? created !== undefined && row.order_id === created.id
            : definitiveFailure;
        if (!agreed)
          throw unknown(
            'Order ledger and provider response disagree; reconciliation is required.',
          );
        const settled = this.replay(
          policy,
          row,
          pending.binding,
          pending.matchedRules,
          () => created!,
        );
        if (!settled) throw new Error();
        await client.query('COMMIT');
        committed = true;
        return settled;
      }
      // A rejection of a PayPal-Request-Id that another attempt also sent, as a
      // retry or an overlapping first attempt, says nothing about that attempt.
      if (definitiveFailure && row.attempts > 1)
        throw unknown(
          `Order attempt rejected (HTTP ${response.status}) while another attempt exists; the outcome stays unknown and reconciliation is required.`,
        );
      const decision: Decision = {
        decision: 'allow',
        matchedRules: [],
        policyVersion: policy.policyVersion,
      };
      // The append-only chain names the created order and its approve link;
      // the ledger row keyed by the request UUID is not the only record.
      receipt = await new AuditLog(client).append(
        this.event(
          pending.context,
          {
            order: definitiveFailure
              ? { amount: pending.amount }
              : {
                  amount: pending.amount,
                  status: created!.status,
                  order_id: created!.id,
                  approve_url: created!.approveUrl,
                },
          },
          decision,
          policy,
          { status: response.status, ref: requestId },
        ),
      );
      // The row's receipt follows the outcome event so a replay returns the same receipt.
      const updated = definitiveFailure
        ? await client.query(
            `UPDATE orders.orders SET status='failed', audit_id=$3::bigint, audit_hash=$4
            WHERE merchant_ref=$1 AND request_id=$2::uuid AND status='unknown'`,
            [merchantRef, requestId, receipt.id, receipt.row_hash],
          )
        : await client.query(
            `UPDATE orders.orders SET status='created', order_id=$3, approve_url=$4, audit_id=$5::bigint, audit_hash=$6
            WHERE merchant_ref=$1 AND request_id=$2::uuid AND status='unknown'`,
            [
              merchantRef,
              requestId,
              created!.id,
              created!.approveUrl,
              receipt.id,
              receipt.row_hash,
            ],
          );
      if (updated.rowCount !== 1) throw new Error();
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      if (error instanceof OrderOutcomeUnknownError) throw error;
      throw unknown(
        'Order ledger could not be saved; reuse the same request ID for recovery.',
      );
    } finally {
      await this.finish(client, committed);
    }
    if (definitiveFailure) return this.rejected(policy, receipt, pending.retry);
    return freeze({
      decision: 'allow',
      matchedRules: pending.matchedRules,
      policyVersion: policy.policyVersion,
      replayed: pending.retry,
      receipt,
      result: created!,
    });
  }

  async capture(
    policy: LoadedPolicy,
    input: unknown,
    trustedContext: unknown,
  ): Promise<OrderResult<CompletedCapture>> {
    let envelope, trusted;
    try {
      envelope = this.parseEnvelope(input, 'executionId');
      trusted = this.trusted(trustedContext);
    } catch {
      return this.deny(policy, 'invalid_arguments');
    }
    const executionId = envelope.id;
    let client: PoolClient | undefined;
    let committed = false;
    let pending:
      | {
          context: PolicyContext;
          orderId: string;
          amount: Money;
          retry: boolean;
          matchedRules: readonly string[];
          binding: string;
        }
      | undefined;
    try {
      client = await this.begin();
      const resolution = await this.options.resolver.resolve(
        { tool: 'pay_order', args: envelope.args },
        trusted,
      );
      if (!resolution.ok) return this.deny(policy, resolution.reason);
      const context = resolution.context;
      const orderId = orderIdentifier(context.args.id);
      const merchantRef = this.ref('merchant', identifier(context.merchant.id));
      const amount: Money = {
        value: context.amount.value,
        currency_code: 'USD',
      };
      if (context.amount.currency !== 'USD')
        return this.deny(policy, 'unresolved_context');
      const facts = object(object(resolution.resolvedCtx).order);
      const decision = this.evaluate(policy, context);
      const audit = new AuditLog(client);
      const denyWith = async (reason: OrderDenyReason) => {
        const receipt = await audit.append(
          this.event(
            context,
            resolution.resolvedCtx,
            { ...decision, decision: 'deny' },
            policy,
          ),
        );
        await client!.query('COMMIT');
        committed = true;
        return this.deny<CompletedCapture>(policy, reason, decision, receipt);
      };
      if (decision.decision !== 'allow')
        return await denyWith(decision.reason ?? 'unresolved_context');
      const { rows: orders } = await client.query<OrderRow>(
        `SELECT request_id::text, key_id, agent_id, binding_hash, policy_version, amount_value, status,
          order_id, approve_url, audit_id::text, audit_hash, 0::float8 AS age_ms
        FROM orders.orders WHERE merchant_ref=$1 AND order_id=$2 AND status='created'`,
        [merchantRef, orderId],
      );
      const order = orders[0];
      if (order && order.key_id !== this.ref('key', 'continuity'))
        throw new Error();
      // Binding: the ledger order, its amount and merchant must match the provider's current facts.
      if (
        !order ||
        order.amount_value !== amount.value ||
        facts.custom_id !== order.request_id
      )
        return await denyWith('order_unknown');
      const binding = this.ref('capture', {
        executionId,
        orderRequest: order.request_id,
        orderId,
        amount,
        agent: identifier(context.agent.id),
        policyVersion: policy.policyVersion,
      });
      // An execution ID is bound to one order, so its row is read on its own:
      // reused under another order, the binding differs and the call is
      // refused as a conflict instead of failing on the primary key below.
      const { rows: own } = await client.query<CaptureRow>(
        `SELECT execution_id::text, key_id, binding_hash, status, capture_id, audit_id::text, audit_hash,
          (extract(epoch FROM clock_timestamp()-created_at)*1000)::float8 AS age_ms
        FROM orders.captures WHERE merchant_ref=$1 AND execution_id=$2::uuid`,
        [merchantRef, executionId],
      );
      const previous = own[0];
      if (previous && previous.key_id !== this.ref('key', 'continuity'))
        throw new Error();
      const settled =
        previous &&
        this.replay(policy, previous, binding, decision.matchedRules, () =>
          freeze({
            executionId,
            orderId,
            id: previous.capture_id!,
            status: 'COMPLETED' as const,
            amount,
          }),
        );
      if (settled) {
        await client.query('COMMIT');
        committed = true;
        return settled;
      }
      if (previous) {
        // A bound unknown row is this order's one live capture attempt (the
        // slot index admits one row per order that is not failed), so it is
        // resent under the same identifier.
        if (previous.age_ms < 0 || previous.age_ms >= replayMs)
          throw new OrderOutcomeUnknownError(
            'Capture replay expired; reconciliation is required.',
            executionId,
          );
        await client.query(
          `UPDATE orders.captures SET attempts=attempts+1
          WHERE merchant_ref=$1 AND execution_id=$2::uuid AND status='unknown'`,
          [merchantRef, executionId],
        );
        await client.query('COMMIT');
        committed = true;
        pending = {
          context,
          orderId,
          amount,
          retry: true,
          matchedRules: decision.matchedRules,
          binding,
        };
      } else {
        // A definitive failure frees the order; a row that is not failed
        // reserves it for its own execution ID.
        const { rows: live } = await client.query<Pick<CaptureRow, 'key_id'>>(
          `SELECT key_id FROM orders.captures
          WHERE merchant_ref=$1 AND order_request=$2::uuid AND status<>'failed'`,
          [merchantRef, order.request_id],
        );
        if (live.some((row) => row.key_id !== this.ref('key', 'continuity')))
          throw new Error();
        if (live.length > 0) return await denyWith('order_capture_reserved');
        if (facts.status !== 'APPROVED')
          return await denyWith('order_not_approved');
        const receipt = await audit.append(
          this.event(context, resolution.resolvedCtx, decision, policy),
        );
        const prepared = prepareEvent(
          this.event(context, resolution.resolvedCtx, decision, policy),
        );
        await client.query(
          `INSERT INTO orders.captures(merchant_ref,execution_id,order_request,key_id,agent_id,binding_hash,policy_version,status,attempts,audit_id,audit_hash)
          VALUES($1,$2::uuid,$3::uuid,$4,$5,$6,$7,'unknown',1,$8::bigint,$9)`,
          [
            merchantRef,
            executionId,
            order.request_id,
            this.ref('key', 'continuity'),
            prepared.agent_id,
            binding,
            policy.policyVersion,
            receipt.id,
            receipt.row_hash,
          ],
        );
        await client.query('COMMIT');
        committed = true;
        pending = {
          context,
          orderId,
          amount,
          retry: false,
          matchedRules: decision.matchedRules,
          binding,
        };
      }
    } catch (error) {
      if (error instanceof OrderOutcomeUnknownError) throw error;
      return this.deny(policy, 'orders_unavailable');
    } finally {
      await this.finish(client, committed);
      client = undefined;
    }
    return this.submitCapture(policy, executionId, pending);
  }

  private async submitCapture(
    policy: LoadedPolicy,
    executionId: string,
    pending: {
      context: PolicyContext;
      orderId: string;
      amount: Money;
      retry: boolean;
      matchedRules: readonly string[];
      binding: string;
    },
  ): Promise<OrderResult<CompletedCapture>> {
    const merchantRef = this.ref(
      'merchant',
      identifier(pending.context.merchant.id),
    );
    const unknown = (message: string) =>
      new OrderOutcomeUnknownError(message, executionId);
    let response;
    try {
      response = await this.request(
        `/v2/checkout/orders/${pending.orderId}/capture`,
        undefined,
        executionId,
      );
    } catch {
      throw unknown(
        'Capture outcome unknown; reuse the same execution ID for recovery.',
      );
    }
    let completed: CompletedCapture | undefined;
    let definitiveFailure = false;
    if (response.status === 201 || response.status === 200) {
      try {
        completed = this.parseCaptured(
          response.data,
          executionId,
          pending.orderId,
          pending.amount,
        );
      } catch {
        throw unknown(
          'Capture outcome unknown; reuse the same execution ID for recovery.',
        );
      }
    } else if (
      response.status >= 400 &&
      response.status < 500 &&
      ![408, 429].includes(response.status)
    ) {
      definitiveFailure = true;
    } else {
      throw unknown(
        `Capture outcome unknown (HTTP ${response.status}); reuse the same execution ID for recovery.`,
      );
    }
    let client: PoolClient | undefined;
    let committed = false;
    let receipt: AuditReceipt;
    try {
      client = await this.begin();
      const { rows } = await client.query<
        Pick<
          CaptureRow,
          | 'status'
          | 'capture_id'
          | 'binding_hash'
          | 'audit_id'
          | 'audit_hash'
          | 'attempts'
        >
      >(
        `SELECT status, capture_id, binding_hash, audit_id::text, audit_hash, attempts::int FROM orders.captures
        WHERE merchant_ref=$1 AND execution_id=$2::uuid`,
        [merchantRef, executionId],
      );
      const row = rows[0];
      if (!row) throw new Error();
      if (row.status !== 'unknown') {
        // An overlapping call with the same execution UUID settled first and
        // the provider replayed its idempotent response; the settled row
        // answers this call as it answers any replay.
        const agreed =
          row.status === 'completed'
            ? completed !== undefined && row.capture_id === completed.id
            : definitiveFailure;
        if (!agreed)
          throw unknown(
            'Capture ledger and provider response disagree; reconciliation is required.',
          );
        const settled = this.replay(
          policy,
          row,
          pending.binding,
          pending.matchedRules,
          () => completed!,
        );
        if (!settled) throw new Error();
        await client.query('COMMIT');
        committed = true;
        return settled;
      }
      // A rejection of a PayPal-Request-Id that another attempt also sent, as a
      // retry or an overlapping first attempt, says nothing about that attempt.
      if (definitiveFailure && row.attempts > 1)
        throw unknown(
          `Capture attempt rejected (HTTP ${response.status}) while another attempt exists; the outcome stays unknown and reconciliation is required.`,
        );
      receipt = await new AuditLog(client).append(
        this.event(
          pending.context,
          {
            order: definitiveFailure
              ? { amount: pending.amount, order_id: pending.orderId }
              : {
                  amount: pending.amount,
                  order_id: pending.orderId,
                  status: 'COMPLETED',
                },
          },
          {
            decision: 'allow',
            matchedRules: [],
            policyVersion: policy.policyVersion,
          },
          policy,
          { status: response.status, ref: executionId },
        ),
      );
      // The row's receipt follows the outcome event so a replay returns the same receipt.
      const updated = definitiveFailure
        ? await client.query(
            `UPDATE orders.captures SET status='failed', audit_id=$3::bigint, audit_hash=$4
            WHERE merchant_ref=$1 AND execution_id=$2::uuid AND status='unknown'`,
            [merchantRef, executionId, receipt.id, receipt.row_hash],
          )
        : await client.query(
            `UPDATE orders.captures SET status='completed', capture_id=$3, audit_id=$4::bigint, audit_hash=$5
            WHERE merchant_ref=$1 AND execution_id=$2::uuid AND status='unknown'`,
            [
              merchantRef,
              executionId,
              completed!.id,
              receipt.id,
              receipt.row_hash,
            ],
          );
      if (updated.rowCount !== 1) throw new Error();
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      if (error instanceof OrderOutcomeUnknownError) throw error;
      throw unknown(
        'Capture ledger could not be saved; reuse the same execution ID for recovery.',
      );
    } finally {
      await this.finish(client, committed);
    }
    if (definitiveFailure) return this.rejected(policy, receipt, pending.retry);
    return freeze({
      decision: 'allow',
      matchedRules: pending.matchedRules,
      policyVersion: policy.policyVersion,
      replayed: pending.retry,
      receipt,
      result: completed!,
    });
  }
}
