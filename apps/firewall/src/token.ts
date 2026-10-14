import { requestSandboxToken } from '../../../scripts/check-paypal-sandbox.mjs';

const credentialFields =
  '(?:(?:access|refresh|id)[_-]?token|client[_-]?secret|api[_-]?key|password|secret|token|(?:proxy[_-]?)?authorization)';
const credentialField = new RegExp(`^${credentialFields}$`, 'i');
const credentialFieldText = new RegExp(
  `\\b${credentialFields}\\b[\\s\\p{White_Space}]*(?::|["'][\\s\\p{White_Space}]*:)`,
  'iu',
);

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
      const seen = new Set<object>();
      let nodes = 0;
      let bytes = 0;
      const credentialText = (text: string) => {
        for (const match of text.matchAll(
          /\b(Bearer|Basic)[\s\p{White_Space}]+([A-Za-z0-9+/_~.-]+={0,2})/giu,
        )) {
          const scheme = match[1]!.toLowerCase();
          const value = match[2]!;
          if (scheme === 'basic') {
            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) continue;
            const decoded = Buffer.from(value, 'base64');
            if (
              decoded.toString('base64').replace(/=+$/, '') ===
                value.replace(/=+$/, '') &&
              decoded.includes(58)
            )
              return true;
          } else if (scheme === 'bearer') return true;
        }
        return false;
      };
      const sensitiveText = (text: string) => {
        bytes += Buffer.byteLength(text);
        return (
          bytes > 1_048_576 ||
          credentialFieldText.test(text) ||
          credentialText(text) ||
          [...secrets].some(
            (secret) =>
              text.includes(secret) ||
              text.includes(JSON.stringify(secret).slice(1, -1)),
          )
        );
      };
      const inspect = (entry: unknown, depth = 0): boolean => {
        if (++nodes > 4096 || depth > 32) return true;
        if (typeof entry === 'string') {
          if (sensitiveText(entry)) return true;
          // Inspect original literals before whole-text parsing can fail or drop duplicates.
          for (const literal of entry.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
            const text: unknown = JSON.parse(literal[0]);
            if (
              (typeof text === 'string' &&
                credentialField.test(text) &&
                /^[\s\p{White_Space}]*:/u.test(
                  entry.slice(literal.index + literal[0].length),
                )) ||
              inspect(text, depth + 1)
            )
              return true;
          }
          if (!/^[\s\p{White_Space}]*[{\["]/u.test(entry)) return false;
          let decoded: unknown;
          try {
            decoded = JSON.parse(entry);
          } catch {
            return true;
          }
          return inspect(decoded, depth + 1);
        }
        if (entry === null || typeof entry === 'boolean') return false;
        if (typeof entry === 'number') return !Number.isFinite(entry);
        if (typeof entry !== 'object' || seen.has(entry)) return true;
        seen.add(entry);
        for (const key of Reflect.ownKeys(entry)) {
          if (
            typeof key !== 'string' ||
            sensitiveText(key) ||
            credentialField.test(key)
          )
            return true;
          if (Array.isArray(entry) && key === 'length') continue;
          const field = Object.getOwnPropertyDescriptor(entry, key);
          if (
            !field ||
            !field.enumerable ||
            !('value' in field) ||
            inspect(field.value, depth + 1)
          )
            return true;
        }
        seen.delete(entry);
        return false;
      };
      try {
        return inspect(value);
      } catch {
        return true;
      }
    },
  };
}
