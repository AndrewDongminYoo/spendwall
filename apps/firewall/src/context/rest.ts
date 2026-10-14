import { fail, freeze } from './json.ts';

const origin = 'https://api-m.sandbox.paypal.com';
export type RestOptions = {
  tokens: { get(): Promise<string>; isSensitive(value: unknown): boolean };
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
};
type Entry = { value: unknown; started: number; expires: number };
type Pending = { promise: Promise<unknown>; invalidated: boolean };

export class ContextRest {
  private readonly options: RestOptions;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Pending>();
  constructor(options: RestOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.ttl = options.ttlMs ?? 2000;
    this.timeout = options.timeoutMs ?? 5000;
    if (
      !Number.isInteger(this.ttl) ||
      this.ttl < 1 ||
      this.ttl > 5000 ||
      !Number.isInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 10_000
    )
      throw new Error('Invalid context resolver timing configuration.');
  }

  invalidate(key: string) {
    this.cache.delete(key);
    const active = this.pending.get(key);
    if (active) {
      active.invalidated = true;
      this.pending.delete(key);
    }
  }

  async facts<T>(
    key: string,
    load: (get: (path: string) => Promise<unknown>) => Promise<T>,
  ): Promise<T> {
    const clock = this.now();
    if (!Number.isSafeInteger(clock) || clock < 0) fail('stale_context');
    const cached = this.cache.get(key);
    if (cached && clock >= cached.started && clock < cached.expires)
      return cached.value as T;
    this.cache.delete(key);
    const active = this.pending.get(key);
    if (active) return active.promise as Promise<T>;
    if (this.pending.size >= 128) fail();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error('Context lookup deadline.'));
      }, this.timeout);
    });
    const slot: Pending = { invalidated: false, promise: Promise.resolve() };
    const get = async (path: string): Promise<unknown> => {
      if (
        !/^\/v2\/(?:payments\/captures|checkout\/orders|invoicing\/invoices)\/[A-Za-z0-9_-]{1,128}$/.test(
          path,
        )
      )
        fail();
      const token = await this.options.tokens.get();
      abort.signal.throwIfAborted();
      if (typeof token !== 'string' || !token) fail();
      const url = origin + path;
      const response = await (this.options.fetchImpl ?? fetch)(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Prefer: 'return=representation',
        },
        redirect: 'error',
        signal: abort.signal,
      });
      if (
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== url) ||
        !response.headers
          .get('content-type')
          ?.toLowerCase()
          .startsWith('application/json')
      ) {
        await response.body?.cancel();
        fail();
      }
      const reader = response.body?.getReader();
      if (!reader) fail();
      let size = 0;
      const parts: Uint8Array[] = [];
      try {
        for (;;) {
          abort.signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 131_072) {
            await reader.cancel();
            fail();
          }
          parts.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      abort.signal.throwIfAborted();
      const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (this.options.tokens.isSensitive(parsed)) fail();
      return parsed;
    };
    const operation = (async () => {
      const value = await load(get);
      abort.signal.throwIfAborted();
      const completed = this.now();
      if (
        slot.invalidated ||
        !Number.isSafeInteger(completed) ||
        completed < clock ||
        completed >= clock + this.ttl
      )
        fail('stale_context');
      if (this.cache.size >= 128)
        this.cache.delete(this.cache.keys().next().value!);
      const safe = freeze(value);
      this.cache.set(key, {
        value: safe,
        started: clock,
        expires: clock + this.ttl,
      });
      return safe;
    })();
    slot.promise = Promise.race([operation, expired]);
    this.pending.set(key, slot);
    try {
      return (await slot.promise) as T;
    } finally {
      clearTimeout(timer!);
      if (this.pending.get(key) === slot) this.pending.delete(key);
    }
  }
}
