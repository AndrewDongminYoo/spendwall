import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTokenManager } from '../apps/firewall/src/token.ts';

const tokens = createTokenManager({
  env: { PAYPAL_CLIENT_SECRET: 'synthetic-managed-secret' },
});

test('decoded response strings and object keys reject literal backslashes before parsing', async (t) => {
  for (const value of [
    String.raw`Result: "synthetic\u002dmanaged-secret`,
    String.raw`Result: "BEA\u0052ER unfamiliar-token`,
    String.raw`prefix "unfinished\q`,
    String.raw`prefix {"data":"ordinary` + '\\',
    String.raw`C:\ordinary\invoice.txt`,
    String.raw`first\nsecond`,
    '\\',
    'ordinary\\',
    JSON.stringify({ note: 'first\nsecond' }),
    JSON.stringify(JSON.stringify({ note: 'ordinary' })),
    { nested: { [String.raw`ordinary\key`]: 'ordinary' } },
    { nested: { note: String.raw`ordinary\value` } },
    { [String.raw`access\u005ftoken`]: 'unfamiliar-token' },
  ]) {
    await t.test('denies the whole value', () => {
      assert.equal(tokens.isSensitive(value), true);
    });
  }
});

test('actual newline characters remain distinct from literal backslash+n', () => {
  assert.equal(tokens.isSensitive('first\nsecond'), false);
  assert.equal(tokens.isSensitive({ ['line\nkey']: 'first\nsecond' }), false);
  assert.equal(tokens.isSensitive(String.raw`first\nsecond`), true);
  assert.equal(
    tokens.isSensitive({ [String.raw`line\nkey`]: 'ordinary' }),
    true,
  );
});

test('credential recognizers and resource limits still deny without backslashes', () => {
  for (const value of [
    'synthetic-managed-secret',
    { access_token: 'unfamiliar-token' },
    { Authorization: 'unfamiliar-token' },
    'bEaReR\tunknown-token',
    'Basic dXNlcjpwYXNzd29yZA==',
    'x'.repeat(1_048_577),
    Array.from({ length: 4097 }, () => false),
  ])
    assert.equal(tokens.isSensitive(value), true);
  const deep = {};
  let node = deep;
  for (let depth = 0; depth < 35; depth++) node = node.next = {};
  assert.equal(tokens.isSensitive(deep), true);
  const cycle = {};
  cycle.next = cycle;
  assert.equal(tokens.isSensitive(cycle), true);
});
