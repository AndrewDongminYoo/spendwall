import { requestSandboxToken } from '../../../scripts/check-paypal-sandbox.mjs';

export type TokenOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const MAX_DECODE_ROUNDS = 16;
// cspell:ignore bfnrt
const ESCAPE = /\\u([0-9a-fA-F]{4})|\\(["\\/bfnrt])|%([0-9a-fA-F]{2})/g;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

// One left-to-right pass that reads the text as plain text and ignores quote
// structure. Malformed sequences do not match and stay as they are.
function decodeEscapes(text: string): string {
  return text.replace(
    ESCAPE,
    (match, unicode?: string, simple?: string, percent?: string) => {
      const hex = unicode ?? percent;
      if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
      return simple === undefined ? match : (SIMPLE_ESCAPES[simple] ?? match);
    },
  );
}

export function createTokenManager(options: TokenOptions = {}) {
  const now = options.now ?? Date.now;
  let cached: { value: string; renewAt: number } | undefined;
  let refreshing: Promise<string> | undefined;
  const secrets = new Set(
    [options.env ?? process.env]
      .flatMap((env) => [env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET])
      .filter((value): value is string => Boolean(value)),
  );
  return {
    async get(): Promise<string> {
      if (cached && now() < cached.renewAt) return cached.value;
      if (refreshing) return refreshing;
      const startedAt = now();
      refreshing = (async () => {
        const token = await requestSandboxToken(options);
        const lifetime = token.expires_in * 1_000;
        const renewAt = startedAt + lifetime - Math.min(30_000, lifetime / 10);
        if (!Number.isSafeInteger(lifetime) || now() >= renewAt) {
          throw new Error('PayPal token expired before it could be used.');
        }
        cached = { value: token.access_token, renewAt };
        secrets.add(token.access_token);
        return cached.value;
      })();
      try {
        return await refreshing;
      } finally {
        refreshing = undefined;
      }
    },
    invalidate(token: string) {
      if (cached?.value === token) cached = undefined;
    },
    isSensitive(value: unknown) {
      let text = JSON.stringify(value);
      for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
        if ([...secrets].some((secret) => text.includes(secret))) return true;
        // JSON.stringify returns undefined for undefined, functions and
        // symbols; keep the earlier result for them (false with no secrets).
        if (typeof text !== 'string') return false;
        const decoded = decodeEscapes(text);
        if (decoded === text) return false;
        text = decoded;
      }
      // Still changing at the bound: deny rather than guess what remains.
      return true;
    },
  };
}
