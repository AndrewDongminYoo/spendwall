import { readFileSync } from 'node:fs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js';
import type { NormalizedAmount } from '../../../../packages/policy/src/index.ts';
import {
  email,
  fail,
  freeze,
  identifier,
  object,
  ResolutionError,
  snapshot,
} from './json.ts';
import type { DenyReason, JsonObject } from './json.ts';
import { createInvoice, readInvoice } from './invoice.ts';
import { disputeIdentifier, readDispute } from './dispute.ts';
import { normalizedAmount, policyAmount } from './money.ts';
import { createOrder, readOrder } from './order.ts';
import { readRefund, refundAmount } from './refund.ts';
import { ContextRest } from './rest.ts';
import type { RestOptions } from './rest.ts';

export const resolverRegistry = Object.freeze({
  create_refund: 'money-out',
  create_invoice: 'money-in',
  send_invoice: 'money-in',
  get_invoice: 'read',
  accept_dispute_claim: 'money-out',
  get_dispute: 'read',
  create_order: 'money-in',
  pay_order: 'money-in',
});
type ToolName = keyof typeof resolverRegistry;
export type PolicyContext = {
  tool: string;
  args: JsonObject;
  amount: { value: string; currency: NormalizedAmount['currency'] };
  agent: JsonObject;
  customer: JsonObject;
  merchant: JsonObject;
  agg: JsonObject;
};
export type Resolution =
  | { ok: false; decision: 'deny'; reason: DenyReason }
  | {
      ok: true;
      context: PolicyContext;
      amount: NormalizedAmount;
      resolvedCtx: JsonObject;
    };

export function orderIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9]{17,32}$/.test(value)) fail();
  return value;
}

const validator = new AjvJsonSchemaValidator();
const catalog: { tools: { name: string; inputSchema: JsonSchemaType }[] } =
  JSON.parse(
    readFileSync(
      new URL('../../../../docs/paypal-mcp-tools.json', import.meta.url),
      'utf8',
    ),
  );
const validators = new Map(
  (Object.keys(resolverRegistry) as ToolName[]).map((name) => {
    const schema = catalog.tools.find(
      (tool) => tool.name === name,
    )?.inputSchema;
    if (!schema) throw new Error('Resolver tool schema is unavailable.');
    return [name, validator.getValidator(schema)] as const;
  }),
);

export class ContextResolver {
  private readonly rest: ContextRest;
  readonly merchant: JsonObject;
  constructor(
    options: RestOptions & { merchant: { id: string; email: string } },
  ) {
    this.merchant = object(snapshot(options.merchant));
    identifier(this.merchant.id);
    this.merchant.email = email(this.merchant.email);
    freeze(this.merchant);
    this.rest = new ContextRest(options);
  }

  invalidateCapture(id: string) {
    this.rest.invalidate(`capture:${identifier(id, 15, 32)}`);
  }
  invalidateInvoice(id: string) {
    this.rest.invalidate(`invoice:${identifier(id, 1, 127)}`);
  }
  invalidateDispute(id: string) {
    this.rest.invalidate(`dispute:${disputeIdentifier(id)}`);
  }
  invalidateOrder(id: string) {
    this.rest.invalidate(`order:${orderIdentifier(id)}`);
  }

  private inputs(input: unknown, serverContext: unknown) {
    const request = object(snapshot(input));
    if (
      Object.keys(request).length !== 2 ||
      typeof request.tool !== 'string' ||
      !Object.hasOwn(request, 'args')
    )
      fail('invalid_arguments');
    if (!Object.hasOwn(resolverRegistry, request.tool))
      fail('unsupported_tool');
    const tool = request.tool as ToolName;
    const args = object(request.args);
    if (!validators.get(tool)!(args).valid) fail('invalid_arguments');
    const trusted = object(snapshot(serverContext));
    if (
      Object.keys(trusted).length !== 3 ||
      !['agent', 'customer', 'agg'].every((key) => Object.hasOwn(trusted, key))
    )
      fail();
    const agent = object(trusted.agent);
    const customer = object(trusted.customer);
    const agg = object(trusted.agg);
    identifier(agent.id);
    identifier(customer.id);
    customer.email = email(customer.email);
    return { tool, args, agent, customer, agg };
  }

  // The policy context of a call whose amount the caller already holds from a
  // ledger row that was bound equal to the provider's facts when it was
  // written: the same inputs as resolve() builds, without a provider read or a
  // cache lease. Inputs that resolve() would deny throw a ResolutionError.
  bound(
    input: unknown,
    serverContext: unknown,
    amount: PolicyContext['amount'],
  ): PolicyContext {
    const context: PolicyContext = {
      ...this.inputs(input, serverContext),
      amount,
      merchant: this.merchant,
    };
    snapshot(context);
    return freeze(context);
  }

  async resolve(input: unknown, serverContext: unknown): Promise<Resolution> {
    try {
      const { tool, args, agent, customer, agg } = this.inputs(
        input,
        serverContext,
      );
      let assertCurrent = () => {};
      let amount;
      let resolvedCtx: JsonObject;
      if (tool === 'create_refund') {
        const id = identifier(args.capture_id, 15, 32);
        const lease = await this.rest.facts(`capture:${id}`, (get) =>
          readRefund(get, id, String(this.merchant.id)),
        );
        const facts = lease.value;
        assertCurrent = lease.assertCurrent;
        amount = refundAmount(args, facts, String(customer.id));
        resolvedCtx = {
          capture: {
            amount: policyAmount(facts.original),
            amount_minor: Number(facts.original.minor),
            refunded_minor: Number(facts.refunded.minor),
            remaining_minor: Number(facts.remaining.minor),
            status: facts.status,
          },
        };
      } else if (tool === 'accept_dispute_claim' || tool === 'get_dispute') {
        const id = disputeIdentifier(args.dispute_id);
        const lease = await this.rest.facts(`dispute:${id}`, (get) =>
          readDispute(
            get,
            id,
            String(this.merchant.id),
            String(this.merchant.email),
          ),
        );
        const facts = lease.value;
        assertCurrent = lease.assertCurrent;
        if (
          customer.seller_transaction_id !== facts.transactionId ||
          (tool === 'accept_dispute_claim' && !facts.canAccept)
        )
          fail();
        amount = facts.amount;
        resolvedCtx = {
          dispute: {
            dispute_id: facts.id,
            seller_transaction_id: facts.transactionId,
            amount: policyAmount(facts.amount),
            amount_minor: Number(facts.amount.minor),
            gross_amount: policyAmount(facts.gross),
            transaction_status: facts.transactionStatus,
            status: facts.status,
            life_cycle_stage: facts.stage,
            can_accept: facts.canAccept,
            ...(facts.dueAt === undefined
              ? {}
              : { seller_response_due_date: facts.dueAt }),
          },
        };
      } else if (tool === 'create_order') {
        const facts = createOrder(args);
        amount = facts.total;
        resolvedCtx = {
          order: {
            amount: policyAmount(facts.total),
            amount_minor: Number(facts.total.minor),
            quantity: facts.lines.length,
          },
        };
      } else if (tool === 'pay_order') {
        const id = orderIdentifier(args.id);
        const lease = await this.rest.facts(`order:${id}`, (get) =>
          readOrder(get, id, String(this.merchant.id)),
        );
        const facts = lease.value;
        assertCurrent = lease.assertCurrent;
        amount = facts.total;
        resolvedCtx = {
          order: {
            order_id: facts.id,
            amount: policyAmount(facts.total),
            amount_minor: Number(facts.total.minor),
            status: facts.status,
            ...(facts.customId === null ? {} : { custom_id: facts.customId }),
            ...(facts.captureId === null
              ? {}
              : { capture_id: facts.captureId }),
          },
        };
      } else {
        let facts;
        if (tool === 'create_invoice') {
          facts = createInvoice(args, String(this.merchant.email));
        } else {
          const lease = await this.rest.facts(
            `invoice:${identifier(args.invoice_id, 1, 127)}`,
            (get) =>
              readInvoice(
                get,
                String(args.invoice_id),
                String(this.merchant.email),
              ),
          );
          facts = lease.value;
          assertCurrent = lease.assertCurrent;
        }
        if (
          facts.recipient !== customer.email ||
          (tool === 'send_invoice' &&
            (facts.status !== 'DRAFT' ||
              facts.additionalRecipients !== 0 ||
              args.send_to_recipient === false ||
              (Array.isArray(args.additional_recipients) &&
                args.additional_recipients.length > 0)))
        )
          fail();
        amount = facts.total;
        resolvedCtx = {
          invoice: {
            amount: policyAmount(facts.total),
            amount_minor: Number(facts.total.minor),
            status: facts.status,
            quantity: Array.isArray(args.items) ? args.items.length : 0,
          },
        };
      }
      const context: PolicyContext = {
        tool,
        args,
        amount: policyAmount(amount),
        agent,
        customer,
        merchant: this.merchant,
        agg,
      };
      snapshot(context);
      assertCurrent();
      return freeze({
        ok: true,
        context,
        amount: normalizedAmount(amount),
        resolvedCtx,
      });
    } catch (error) {
      return freeze({
        ok: false,
        decision: 'deny',
        reason:
          error instanceof ResolutionError
            ? error.reason
            : 'unresolved_context',
      });
    }
  }
}
