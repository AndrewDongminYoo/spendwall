import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { normalizeAmount } from '../../../../packages/policy/src/index.ts';
import type { PolicyContext } from '../context/index.ts';
import { identifier, object, snapshot, freeze } from '../context/json.ts';
import type { JsonObject } from '../context/json.ts';
import { canonical } from '../refunds.ts';

export type PreparedApproval = {
  input: { requestId: string; context: PolicyContext; resolvedCtx: JsonObject };
  binding: {
    args: JsonObject;
    agentId: string;
    customerId: string;
    merchantId: string;
    amount: { value: string; currency_code: 'USD' };
    policyVersion: string;
    adapter: string;
  };
};
export function invalid(): never {
  throw new Error('Approval unavailable.');
}
function usd(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${BigInt(whole!)}.${fraction.padEnd(2, '0')}`;
}
export function approvalId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    invalid();
  return value.toLowerCase();
}
export function prepareApproval(
  policyVersion: string,
  input: unknown,
  merchant: string,
  adapter: string,
): PreparedApproval {
  try {
    if (
      !/^[a-f0-9]{64}$/.test(policyVersion) ||
      !/^[a-f0-9]{64}$/.test(adapter)
    )
      invalid();
    const submitted = object(snapshot(input));
    if (
      Object.keys(submitted).some(
        (k) => !['requestId', 'context', 'resolvedCtx'].includes(k),
      )
    )
      invalid();
    const context = object(submitted.context),
      args = object(context.args);
    if (context.tool !== 'create_refund' || Object.keys(context).length !== 7)
      invalid();
    const agent = object(context.agent),
      customer = object(context.customer),
      owner = object(context.merchant);
    const agentId = identifier(agent.id),
      customerId = identifier(customer.id),
      merchantId = identifier(owner.id);
    if (merchantId !== merchant) invalid();
    const captureId = identifier(args.capture_id, 15, 32);
    if (
      Object.keys(args).some(
        (k) =>
          !['capture_id', 'amount', 'invoice_id', 'note_to_payer'].includes(k),
      )
    )
      invalid();
    const amount = normalizeAmount(context.amount);
    if (amount.currency !== 'USD' || Number(amount.value) <= 0) invalid();
    if (args.amount !== undefined) {
      const provided = object(args.amount);
      if (Object.keys(provided).length !== 2) invalid();
      const explicit = normalizeAmount({
        value: provided.value,
        currency: provided.currency_code,
      });
      if (
        explicit.currency !== amount.currency ||
        usd(explicit.value) !== usd(amount.value)
      )
        invalid();
    }
    if (
      args.invoice_id !== undefined &&
      (typeof args.invoice_id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,127}$/.test(args.invoice_id))
    )
      invalid();
    if (
      args.note_to_payer !== undefined &&
      (typeof args.note_to_payer !== 'string' ||
        args.note_to_payer.length > 255)
    )
      invalid();
    const money = { value: usd(amount.value), currency_code: 'USD' as const };
    const executable: JsonObject = {
      ...args,
      capture_id: captureId,
      amount: money,
    };
    const normalized: PolicyContext = {
      tool: 'create_refund',
      args: executable,
      amount: { value: money.value, currency: 'USD' },
      agent,
      customer,
      merchant: owner,
      agg: object(context.agg),
    };
    return freeze({
      input: {
        requestId: approvalId(submitted.requestId),
        context: normalized,
        resolvedCtx: object(submitted.resolvedCtx ?? {}),
      },
      binding: {
        args: executable,
        agentId,
        customerId,
        merchantId,
        amount: money,
        policyVersion,
        adapter,
      },
    });
  } catch {
    return invalid();
  }
}
export class ApprovalKeys {
  readonly #key: Buffer;
  readonly #encryption: Buffer;
  constructor(key: string) {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) invalid();
    this.#key = Buffer.from(key, 'hex');
    this.#encryption = createHmac('sha256', this.#key)
      .update('spendwall/approvals/encryption/v1')
      .digest();
  }
  reference(domain: string, value: unknown): string {
    return createHmac('sha256', this.#key)
      .update(canonical(['spendwall/approvals', 1, domain, value]))
      .digest('hex');
  }
  seal(value: unknown, aad: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.#encryption, iv);
    cipher.setAAD(Buffer.from(aad));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(snapshot(value)), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
      'base64url',
    );
  }
  open(value: string, aad: string): unknown {
    try {
      if (typeof value !== 'string' || value.length > 262144) invalid();
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.length < 29 || bytes.toString('base64url') !== value) invalid();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#encryption,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return snapshot(
        JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(28)),
            decipher.final(),
          ]).toString('utf8'),
        ),
      );
    } catch {
      return invalid();
    }
  }
}
