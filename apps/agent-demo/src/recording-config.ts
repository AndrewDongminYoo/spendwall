import fs from 'node:fs';
import type { DeviceGrant } from '../../firewall/src/approver/identity.ts';

type RecordingConfig = {
  identityKey: string;
  signingKey: string;
  devices: DeviceGrant[];
  port?: number;
};

// Every invocation, including devices reloads, validates and reads the same
// opened file. Never repair an operator's ownership or permissions implicitly.
export function readRecordingConfig(file: string): RecordingConfig {
  try {
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
    let source: string;
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (
        !before.isFile() ||
        before.uid !== BigInt(uid) ||
        (before.mode & 0o77n) !== 0n
      )
        throw new Error();
      source = fs.readFileSync(fd, 'utf8');
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
    } finally {
      fs.closeSync(fd);
    }
    const config = JSON.parse(source);
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      Object.keys(config).some(
        (key) =>
          !['identityKey', 'signingKey', 'devices', 'port'].includes(key),
      ) ||
      typeof config.identityKey !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(config.identityKey) ||
      typeof config.signingKey !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(config.signingKey) ||
      !Array.isArray(config.devices) ||
      (config.port !== undefined &&
        (!Number.isInteger(config.port) ||
          config.port < 0 ||
          config.port > 65535))
    )
      throw new Error();
    return config as RecordingConfig;
  } catch {
    // Parser and filesystem errors can contain source text or private paths.
    throw new Error('Recording configuration unavailable.');
  }
}
