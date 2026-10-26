// cspell:words mkfifo
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readForwardTls,
  readRecordingConfig,
} from '../apps/agent-demo/src/recording-config.ts';

const config = {
  identityKey: '1'.repeat(64),
  signingKey: '2'.repeat(64),
  devices: [],
};
const unavailable = { message: 'Recording configuration unavailable.' };

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'spendwall-private-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { directory, file };
}

for (const mode of [0o600, 0o400]) {
  test(`private config mode ${mode.toString(8)} permits a current-owner regular file`, (t) => {
    const { file } = fixture(t);
    fs.chmodSync(file, mode);
    assert.deepEqual(readRecordingConfig(file), config);
    assert.equal(fs.statSync(file).mode & 0o777, mode);
  });
}

test('configuration reloads recheck mode without changing the operator file', (t) => {
  const { file } = fixture(t);
  assert.deepEqual(readRecordingConfig(file), config);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readRecordingConfig(file), unavailable);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});

test('a file owned by a different effective user is refused (simulated identity)', (t) => {
  const { file } = fixture(t);
  // No chown or privileged second user is needed. The real file UID is compared
  // with a simulated different effective UID at the process boundary.
  t.mock.method(process, 'geteuid', () => Number(fs.statSync(file).uid) + 1);
  assert.throws(() => readRecordingConfig(file), unavailable);
});

test('unavailable effective ownership information fails closed', (t) => {
  const { file } = fixture(t);
  t.mock.method(process, 'geteuid', () => NaN);
  assert.throws(() => readRecordingConfig(file), unavailable);
});

test('directories and final-component symlinks are refused', (t) => {
  const { directory, file } = fixture(t);
  const link = join(directory, 'config-link.json');
  fs.symlinkSync(file, link);
  assert.throws(() => readRecordingConfig(directory), unavailable);
  assert.throws(() => readRecordingConfig(link), unavailable);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('a FIFO is refused without waiting for a writer', (t) => {
  const { directory } = fixture(t);
  const fifo = join(directory, 'config.fifo');
  execFileSync('mkfifo', [fifo]);
  const source = `import { readRecordingConfig } from ${JSON.stringify(new URL('../apps/agent-demo/src/recording-config.ts', import.meta.url).href)}; try { readRecordingConfig(process.argv[1]); process.exitCode = 2; } catch (error) { if (error.message !== 'Recording configuration unavailable.') process.exitCode = 3; }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', source, fifo], {
    timeout: 3000,
  });
  assert.equal(fs.statSync(fifo).isFIFO(), true);
});

test('a pathname replacement after validation never substitutes another config', (t) => {
  const { directory, file } = fixture(t);
  const replacement = join(directory, 'replacement.json');
  fs.writeFileSync(
    replacement,
    JSON.stringify({ ...config, devices: [{ deviceId: 'replacement-only' }] }),
    { mode: 0o600 },
  );
  const read = fs.readFileSync;
  let readDescriptor;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    readDescriptor = target;
    // The path changes after fstat. The original descriptor must still be read,
    // and the metadata recheck must refuse the unlinked original inode.
    fs.renameSync(replacement, file);
    return read(target, ...args);
  });
  assert.throws(() => readRecordingConfig(file), unavailable);
  assert.equal(typeof readDescriptor, 'number');
  assert.throws(() => fs.fstatSync(readDescriptor), { code: 'EBADF' });
});

test('permission changes during a read fail closed and close the file', (t) => {
  const { file } = fixture(t);
  const read = fs.readFileSync;
  let descriptor;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    descriptor = target;
    const contents = read(target, ...args);
    fs.chmodSync(file, 0o644);
    return contents;
  });
  assert.throws(() => readRecordingConfig(file), unavailable);
  assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
});

test('valid reads close the verified descriptor and parsing errors reveal no source text', (t) => {
  const { file } = fixture(t);
  const fstat = fs.fstatSync;
  let descriptor;
  t.mock.method(fs, 'fstatSync', (fd, ...args) => {
    descriptor = fd;
    return fstat(fd, ...args);
  });
  assert.deepEqual(readRecordingConfig(file), config);
  assert.throws(() => fstat(descriptor), { code: 'EBADF' });
  const marker = 'synthetic-private-config-marker';
  fs.writeFileSync(file, '{' + marker);
  assert.throws(() => readRecordingConfig(file), unavailable);
  assert.throws(() => fstat(descriptor), { code: 'EBADF' });
});

const forward = {
  bind: '100.101.102.103',
  port: 8443,
  host: 'mac.example.ts.net',
  certFile: '/private/cert.pem',
  keyFile: '/private/key.pem',
};

test('an optional forward object is accepted when every key is valid', (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ ...config, forward }));
  assert.deepEqual(readRecordingConfig(file), { ...config, forward });
});

test('forward objects are validated strictly', (t) => {
  const { file } = fixture(t);
  const { keyFile: _omitted, ...missingKey } = forward;
  for (const invalid of [
    null,
    [],
    'https://mac.example.ts.net',
    missingKey,
    { ...forward, extra: true },
    { ...forward, bind: '0.0.0.0' },
    { ...forward, bind: '127.0.0.1' },
    { ...forward, bind: '192.168.1.10' },
    { ...forward, bind: '100.128.0.1' },
    { ...forward, port: 0 },
    { ...forward, port: 65536 },
    { ...forward, port: 443 },
    { ...forward, port: '8443' },
    { ...forward, host: 'mac.example.com' },
    { ...forward, host: 'Mac.example.ts.net' },
    { ...forward, host: 'mac.example.ts.net:8443' },
    { ...forward, certFile: 'cert.pem' },
    { ...forward, keyFile: './key.pem' },
    { ...forward, keyFile: 1 },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...config, forward: invalid }));
    assert.throws(() => readRecordingConfig(file), unavailable);
  }
});

function tlsFixture(t) {
  const { directory } = fixture(t);
  const keyFile = join(directory, 'key.pem'),
    certFile = join(directory, 'cert.pem');
  fs.writeFileSync(keyFile, 'synthetic-key-marker', { mode: 0o600 });
  fs.writeFileSync(certFile, 'synthetic-cert', { mode: 0o644 });
  return { directory, tls: { ...forward, keyFile, certFile } };
}
const tlsUnavailable = { message: 'Forwarder TLS files unavailable.' };

test('the forwarder key is read only from a current-owner owner-only regular file', (t) => {
  const { tls } = tlsFixture(t);
  assert.deepEqual(readForwardTls(tls), {
    key: 'synthetic-key-marker',
    cert: 'synthetic-cert',
  });
  fs.chmodSync(tls.keyFile, 0o400);
  assert.equal(readForwardTls(tls).key, 'synthetic-key-marker');
  fs.chmodSync(tls.keyFile, 0o640);
  assert.throws(() => readForwardTls(tls), tlsUnavailable);
  assert.equal(fs.statSync(tls.keyFile).mode & 0o777, 0o640);
});

test('forwarder key symlinks, directories, other owners and missing files are refused without paths', (t) => {
  const { directory, tls } = tlsFixture(t);
  const link = join(directory, 'key-link.pem');
  fs.symlinkSync(tls.keyFile, link);
  for (const keyFile of [link, directory, join(directory, 'missing.pem')])
    assert.throws(
      () => readForwardTls({ ...tls, keyFile }),
      (error) => {
        assert.equal(error.message, tlsUnavailable.message);
        assert.equal(error.message.includes(directory), false);
        return true;
      },
    );
  assert.throws(
    () => readForwardTls({ ...tls, certFile: join(directory, 'missing.pem') }),
    tlsUnavailable,
  );
  t.mock.method(
    process,
    'geteuid',
    () => Number(fs.statSync(tls.keyFile).uid) + 1,
  );
  assert.throws(() => readForwardTls(tls), tlsUnavailable);
});
