import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('agent launchers reject invalid configuration and redact database failure details', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spendwall-agent-cli-'));
  try {
    const config = join(dir, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        databaseUrl:
          'postgresql://synthetic:private-fixture-marker@127.0.0.1:9/unavailable',
        merchantId: 'merchantA',
        agentId: 'support',
        tools: ['get_order'],
        ledgerPath: join(dir, 'ledger.json'),
      }),
      { mode: 0o600 },
    );
    for (const [script, args] of [
      ['agent-proxy.mjs', ['--config', config]],
      [
        'agent-keys.mjs',
        ['issue', '--config', config, '--output', join(dir, 'key.json')],
      ],
      ['agent-proxy.mjs', []],
      ['agent-keys.mjs', ['bad-command']],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['scripts/' + script, ...args],
        { encoding: 'utf8', timeout: 5000 },
      );
      assert.ok([1, 2].includes(result.status));
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /private-fixture-marker|postgresql:|ECONNREFUSED/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
