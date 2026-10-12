import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const syntheticToken = ['ghp_', 'Q7r9W2e4T6y8U1i3O5p7A9s2D4f6G8h1J3k5'].join(
  '',
);

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'spendwall-hook-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('GIT_') &&
      !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)
    )
      delete env[key];
  }
  const git = (...args) =>
    spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Hook Test'],
    ['config', 'user.email', 'test@example.invalid'],
  ]) {
    const result = git(...args);
    assert.equal(result.status, 0, result.stderr);
  }
  mkdirSync(join(cwd, 'scripts'));
  mkdirSync(join(cwd, '.trunk'));
  cpSync(join(root, '.trunk/trunk.yaml'), join(cwd, '.trunk/trunk.yaml'));
  cpSync(
    join(root, 'scripts/check-secrets.mjs'),
    join(cwd, 'scripts/check-secrets.mjs'),
  );
  const sync = spawnSync('trunk', ['git-hooks', 'sync'], {
    cwd,
    env,
    encoding: 'utf8',
  });
  assert.equal(sync.status, 0, sync.stderr + sync.stdout);
  const stage = (name, content) => {
    writeFileSync(join(cwd, name), content);
    assert.equal(git('add', '--', name).status, 0);
  };
  return { cwd, env, git, stage };
}

test('a staged credential blocks a real initial commit and is redacted', (t) => {
  const { git, stage } = fixture(t);
  stage('credentials.txt', `github_token=${syntheticToken}\n`);
  const result = git('commit', '-m', 'test: reject credential');
  assert.notEqual(result.status, 0, 'a secret-bearing commit must be rejected');
  assert.match(result.stderr + result.stdout, /leaks found/i);
  assert.ok(!(result.stderr + result.stdout).includes(syntheticToken));
  assert.notEqual(git('rev-parse', '--verify', 'HEAD').status, 0);
});

test('a clean working copy cannot hide a staged credential', (t) => {
  const { cwd, git, stage } = fixture(t);
  stage('credentials.txt', `github_token=${syntheticToken}\n`);
  writeFileSync(join(cwd, 'credentials.txt'), 'github_token=\n');
  const result = git('commit', '-m', 'test: reject staged secret');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /leaks found/i);
});

test('a clean file can be committed', (t) => {
  const { git, stage } = fixture(t);
  stage('safe.txt', 'A safe example.\n');
  const result = git('commit', '-m', 'test: allow safe content');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git('rev-parse', '--verify', 'HEAD').status, 0);
});

test('a missing scanner fails closed', (t) => {
  const { cwd, env, stage } = fixture(t);
  stage('safe.txt', 'safe\n');
  const result = spawnSync(
    process.execPath,
    [join(cwd, 'scripts/check-secrets.mjs')],
    {
      cwd,
      env: { ...env, PATH: '' },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
});
