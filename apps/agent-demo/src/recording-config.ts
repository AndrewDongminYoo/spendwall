import fs from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DeviceGrant } from '../../firewall/src/approver/identity.ts';
import {
  isTailnetAddress,
  isTailnetHost,
} from '../../firewall/src/approver/forwarder.ts';

type ForwardConfig = {
  bind: string;
  port: number;
  host: string;
  certFile: string;
  keyFile: string;
};

type RecordingConfig = {
  identityKey: string;
  signingKey: string;
  devices: DeviceGrant[];
  port?: number;
  forward?: ForwardConfig;
};

// Reads a regular file owned by the effective user with no group/other mode
// bits. Throws without detail; callers replace the error with a generic one.
function readPrivateFile(file: string): string {
  const uid = process.geteuid?.();
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (
    uid === undefined ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !Number.isInteger(O_NOFOLLOW) ||
    !Number.isInteger(O_NONBLOCK)
  )
    throw new Error();
  // These flags reject a final-component symlink atomically and prevent a
  // FIFO from blocking before fstat can reject it as non-regular.
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(uid) ||
      (before.mode & 0o77n) !== 0n
    )
      throw new Error();
    const source = fs.readFileSync(fd, 'utf8');
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      !after.isFile() ||
      after.uid !== before.uid ||
      after.mode !== before.mode ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error();
    return source;
  } finally {
    fs.closeSync(fd);
  }
}

function isForwardConfig(value: unknown): value is ForwardConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const forward = value as Record<string, unknown>;
  const keys = ['bind', 'port', 'host', 'certFile', 'keyFile'];
  return (
    Object.keys(forward).length === keys.length &&
    Object.keys(forward).every((key) => keys.includes(key)) &&
    isTailnetAddress(forward.bind) &&
    typeof forward.port === 'number' &&
    Number.isInteger(forward.port) &&
    forward.port >= 1 &&
    forward.port <= 65535 &&
    // Port 443 would drop out of Host; the forwarder refuses it as well.
    forward.port !== 443 &&
    isTailnetHost(forward.host) &&
    [forward.certFile, forward.keyFile].every(
      (path) =>
        typeof path === 'string' && isAbsolute(path) && !path.includes('\0'),
    )
  );
}

// Every invocation, including devices reloads, validates and reads the same
// opened file. Never repair an operator's ownership or permissions implicitly.
export function readRecordingConfig(file: string): RecordingConfig {
  try {
    const config = JSON.parse(readPrivateFile(file));
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      Object.keys(config).some(
        (key) =>
          !['identityKey', 'signingKey', 'devices', 'port', 'forward'].includes(
            key,
          ),
      ) ||
      typeof config.identityKey !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(config.identityKey) ||
      typeof config.signingKey !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(config.signingKey) ||
      !Array.isArray(config.devices) ||
      (config.port !== undefined &&
        (!Number.isInteger(config.port) ||
          config.port < 0 ||
          config.port > 65535)) ||
      (config.forward !== undefined && !isForwardConfig(config.forward))
    )
      throw new Error();
    return config as RecordingConfig;
  } catch {
    // Parser and filesystem errors can contain source text or private paths.
    throw new Error('Recording configuration unavailable.');
  }
}

// The private key gets the same owner-only, no-symlink, regular-file checks as
// the configuration. The certificate is public material.
export function readForwardTls(forward: ForwardConfig): {
  cert: string;
  key: string;
} {
  try {
    return {
      key: readPrivateFile(forward.keyFile),
      cert: fs.readFileSync(forward.certFile, 'utf8'),
    };
  } catch {
    // Filesystem errors contain private paths.
    throw new Error('Forwarder TLS files unavailable.');
  }
}
