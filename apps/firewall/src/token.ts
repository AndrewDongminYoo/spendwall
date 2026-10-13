import { requestSandboxToken } from '../../../scripts/check-paypal-sandbox.mjs';

export type TokenOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

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
      const text = JSON.stringify(value);
      return [...secrets].some((secret) => text.includes(secret));
    },
  };
}
