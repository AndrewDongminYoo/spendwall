import type { IncomingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';
import type { TokenOptions } from '../token.ts';
import { createTokenManager } from '../token.ts';
import { identifier, object, snapshot } from '../context/json.ts';

export type VerifiedRefund = {
  eventId: string;
  refundId: string;
  captureId: string;
  usdCents: number;
  payload: unknown;
};
export type WebhookOptions = TokenOptions & {
  webhookId: string;
  merchantId: string;
  timeoutMs?: number;
};
export class WebhookError extends Error {
  readonly code: number;
  constructor(code: number) {
    super('Webhook unavailable.');
    this.code = code;
  }
}
export function usdCents(value: unknown): number {
  const money = object(value);
  if (
    money.currency_code !== 'USD' ||
    typeof money.value !== 'string' ||
    !/^\d{1,9}(?:\.\d{1,2})?$/.test(money.value)
  )
    throw new WebhookError(422);
  const [whole, fraction = ''] = money.value.split('.');
  const cents = Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')));
  if (cents <= 0 || cents > 1_000_000_000) throw new WebhookError(422);
  return cents;
}
const api = 'https://api-m.sandbox.paypal.com';
const origins = [api, 'https://api.sandbox.paypal.com'];
function headers(input: IncomingHttpHeaders) {
  const read = (key: string, maximum: number) => {
    const value = input[`paypal-${key.replaceAll('_', '-')}`];
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > maximum ||
      /[\s,]/.test(value)
    )
      throw new WebhookError(400);
    return value;
  };
  const result = {
    auth_algo: read('auth_algo', 100),
    cert_url: read('cert_url', 500),
    transmission_id: read('transmission_id', 50),
    transmission_sig: read('transmission_sig', 500),
    transmission_time: read('transmission_time', 100),
  };
  if (
    result.auth_algo !== 'SHA256withRSA' ||
    !/^[A-Za-z0-9_-]+$/.test(result.transmission_id) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(result.transmission_sig) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      result.transmission_time,
    ) ||
    !Number.isFinite(Date.parse(result.transmission_time)) ||
    !origins.some(
      (origin) =>
        result.cert_url.startsWith(`${origin}/v1/notifications/certs/`) &&
        /^[A-Za-z0-9_-]+$/.test(
          result.cert_url.slice(`${origin}/v1/notifications/certs/`.length),
        ),
    )
  )
    throw new WebhookError(400);
  return result;
}
export class PayPalWebhookVerifier {
  readonly adapterRef: string;
  private readonly options: WebhookOptions;
  private readonly tokens: ReturnType<typeof createTokenManager>;
  constructor(options: WebhookOptions) {
    const env = options.env ?? process.env;
    if (
      !env.PAYPAL_CLIENT_ID?.trim() ||
      !env.PAYPAL_CLIENT_SECRET?.trim() ||
      !/^[A-Za-z0-9]{1,50}$/.test(options.webhookId) ||
      (options.timeoutMs !== undefined &&
        (!Number.isInteger(options.timeoutMs) ||
          options.timeoutMs < 1 ||
          options.timeoutMs > 15000))
    )
      throw new Error('Invalid webhook configuration.');
    identifier(options.merchantId);
    this.options = { ...options, env: { ...env } };
    this.adapterRef = createHash('sha256')
      .update(env.PAYPAL_CLIENT_ID)
      .digest('hex');
    this.tokens = createTokenManager(this.options);
  }
  private async request(path: string, body?: string): Promise<unknown> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await this.tokens.get();
        const response = await (this.options.fetchImpl ?? fetch)(
          `${api}${path}`,
          {
            method: body === undefined ? 'GET' : 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            ...(body === undefined ? {} : { body }),
          },
        );
        if (response.status === 401 && attempt === 0) {
          await response.body?.cancel();
          this.tokens.invalidate(token);
          continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error();
        }
        return await response.json();
      }
    } catch {
      throw new WebhookError(503);
    }
    throw new WebhookError(503);
  }
  async verify(
    inputHeaders: IncomingHttpHeaders,
    input: string,
  ): Promise<VerifiedRefund | null> {
    const transmission = headers(inputHeaders);
    let event;
    try {
      if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 65536)
        throw new Error();
      event = object(snapshot(JSON.parse(input)));
      identifier(event.id, 1, 255);
      if (
        typeof event.event_type !== 'string' ||
        !/^[A-Z][A-Z0-9_.]{1,99}$/.test(event.event_type)
      )
        throw new Error();
    } catch {
      throw new WebhookError(400);
    }
    const metadata = JSON.stringify({
      ...transmission,
      webhook_id: this.options.webhookId,
    });
    // The validated event must keep its signed representation, including whitespace.
    const verified = await this.request(
      '/v1/notifications/verify-webhook-signature',
      `${metadata.slice(0, -1)},"webhook_event":${input}}`,
    );
    const verification = object(verified);
    if (verification.verification_status === 'FAILURE')
      throw new WebhookError(401);
    if (verification.verification_status !== 'SUCCESS')
      throw new WebhookError(503);
    if (event.event_type !== 'PAYMENT.CAPTURE.REFUNDED') return null;
    let refundId: string, captureId: string, cents: number;
    try {
      const resource = object(event.resource);
      if (
        event.resource_type !== 'refund' ||
        event.resource_version !== '2.0' ||
        resource.status !== 'COMPLETED'
      )
        throw new Error();
      refundId = identifier(resource.id, 15, 32);
      cents = usdCents(resource.amount);
      if (!Array.isArray(resource.links)) throw new Error();
      const up = resource.links.map(object).filter((link) => link.rel === 'up');
      if (
        up.length !== 1 ||
        up[0]!.method !== 'GET' ||
        typeof up[0]!.href !== 'string'
      )
        throw new Error();
      const href = up[0]!.href;
      const origin = origins.find((value) =>
        href.startsWith(`${value}/v2/payments/captures/`),
      );
      if (!origin) throw new Error();
      captureId = identifier(
        href.slice(`${origin}/v2/payments/captures/`.length),
        15,
        32,
      );
    } catch {
      throw new WebhookError(422);
    }
    const capture = await this.request(`/v2/payments/captures/${captureId}`);
    try {
      const value = object(capture);
      if (
        value.id !== captureId ||
        object(value.payee).merchant_id !== this.options.merchantId ||
        !['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(
          String(value.status),
        ) ||
        usdCents(value.amount) < cents
      )
        throw new Error();
    } catch {
      throw new WebhookError(422);
    }
    return {
      eventId: String(event.id),
      refundId,
      captureId,
      usdCents: cents,
      payload: event,
    };
  }
}
