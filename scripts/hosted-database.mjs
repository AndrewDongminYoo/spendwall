import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const loopback = ['127.0.0.1', 'localhost', '[::1]'];
const configFields = [
  'identityKey',
  'merchantId',
  'token',
  'agents',
  'databaseTls',
];

/** Reads the private hosted configuration and rejects unknown fields. */
export async function hostedConfig(path) {
  if (!path || !isAbsolute(path)) throw new Error('Invalid configuration.');
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !configFields.includes(key))
  )
    throw new Error('Invalid configuration.');
  return config;
}

/**
 * Returns the `pg` TLS option for a hosted database connection.
 *
 * `verify-full` is the default. `require` encrypts without verifying the
 * certificate and is accepted only for a single-label host name, such as a
 * Render private-network host, because Render's internal certificates are
 * self-signed. `disable` is accepted only for a loopback host.
 */
export function databaseTls(value, hostname) {
  const mode = value ?? 'verify-full';
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  if (
    mode === 'require' &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(hostname) &&
    !loopback.includes(hostname)
  )
    return { rejectUnauthorized: false };
  if (mode === 'disable' && loopback.includes(hostname)) return false;
  throw new Error('Invalid database TLS mode.');
}

/** Parses a PostgreSQL URL that carries no query parameters or fragment. */
export function databaseUrl(value) {
  const url = new URL(value ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid database URL.');
  return url;
}
