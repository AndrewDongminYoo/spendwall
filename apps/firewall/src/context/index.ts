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
import { normalizedAmount, policyAmount } from './money.ts';
import { readRefund, refundAmount } from './refund.ts';
import { ContextRest } from './rest.ts';
import type { RestOptions } from './rest.ts';

export const resolverRegistry = Object.freeze({
  create_refund: 'money-out',
  create_invoice: 'money-in',
  send_invoice: 'money-in',
  get_invoice: 'read',
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
  private readonly merchant: JsonObject;
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

  async resolve(input: unknown, serverContext: unknown): Promise<Resolution> {
    try {
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
        !['agent', 'customer', 'agg'].every((key) =>
          Object.hasOwn(trusted, key),
        )
      )
        fail();
      const agent = object(trusted.agent);
      const customer = object(trusted.customer);
      const agg = object(trusted.agg);
      identifier(agent.id);
      identifier(customer.id);
      customer.email = email(customer.email);
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
