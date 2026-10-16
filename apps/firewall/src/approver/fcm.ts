import { GoogleAuth } from 'google-auth-library';
import { approvalId } from '../approvals/binding.ts';
import { deliveryToken } from './identity.ts';
type Options = {
  projectId: string;
  getAccessToken?: () => Promise<string | null | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};
export class FcmFailure extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds: number;
  constructor(retryable = true, retryAfterSeconds = 0) {
    super('Notification unavailable.');
    this.name = 'FcmFailure';
    this.retryable = retryable;
    this.retryAfterSeconds = Number.isFinite(retryAfterSeconds)
      ? Math.min(86400, Math.max(0, Math.ceil(retryAfterSeconds)))
      : 0;
  }
}
export class FcmSender {
  private readonly options: Options;
  private readonly accessToken: NonNullable<Options['getAccessToken']>;
  private readonly timeout: number;
  constructor(options: Options) {
    this.options = options;
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.projectId))
      throw new FcmFailure(false);
    this.timeout = options.timeoutMs ?? 5000;
    if (
      !Number.isInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 10000
    )
      throw new FcmFailure(false);
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
    this.accessToken = options.getAccessToken ?? (() => auth.getAccessToken());
  }
  async send(token: string, id: string): Promise<void> {
    const abort = new AbortController();
    let retryAfterSeconds = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      deliveryToken(token);
      approvalId(id);
      const work = async () => {
        const access = await this.accessToken();
        if (
          abort.signal.aborted ||
          typeof access !== 'string' ||
          !access.length ||
          /[\r\n]/.test(access)
        )
          throw new FcmFailure();
        const response = await (this.options.fetchImpl ?? fetch)(
          `https://fcm.googleapis.com/v1/projects/${this.options.projectId}/messages:send`,
          {
            method: 'POST',
            redirect: 'error',
            signal: abort.signal,
            headers: {
              authorization: `Bearer ${access}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token,
                data: { approval_id: id },
                notification: {
                  title: 'Approval requested',
                  body: 'Open Spendwall to review the request.',
                },
              },
            }),
          },
        );
        const after = response.headers.get('retry-after') ?? '';
        const seconds = /^\d{1,8}$/.test(after)
          ? Number(after)
          : (Date.parse(after) - Date.now()) / 1000;
        const delay = Math.max(
          response.status === 429 ? 60 : 0,
          Number.isFinite(seconds) ? seconds : 0,
        );
        retryAfterSeconds = delay;
        const reader = response.body?.getReader();
        if (!reader) throw new FcmFailure();
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 8192) throw new FcmFailure();
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (response.status !== 200) {
          const error = result?.error;
          const unregistered =
            response.status === 404 &&
            error?.status === 'NOT_FOUND' &&
            Array.isArray(error.details) &&
            error.details.some(
              (detail: unknown) =>
                detail !== null &&
                typeof detail === 'object' &&
                '@type' in detail &&
                detail['@type'] ===
                  'type.googleapis.com/google.firebase.fcm.v1.FcmError' &&
                'errorCode' in detail &&
                detail.errorCode === 'UNREGISTERED',
            );
          throw new FcmFailure(!unregistered, delay);
        }
        if (
          !result ||
          typeof result.name !== 'string' ||
          !result.name.startsWith(
            `projects/${this.options.projectId}/messages/`,
          ) ||
          result.name.length > 2048
        )
          throw new FcmFailure();
      };
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new FcmFailure());
          }, this.timeout);
        }),
      ]);
    } catch (error) {
      throw new FcmFailure(
        error instanceof FcmFailure ? error.retryable : true,
        Math.max(
          retryAfterSeconds,
          error instanceof FcmFailure ? error.retryAfterSeconds : 0,
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
    }
  }
}
