import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDashboardServer } from '../apps/firewall/src/dashboard/server.ts';
import { loadPolicy } from '../packages/policy/src/index.ts';
import { PolicyReplay } from '../apps/firewall/src/policy-preview/replay.ts';
const source = JSON.stringify({
  agents: { support: { tools: { allow: ['create_refund'], deny: [] } } },
  rules: [{ id: 'test', when: 'true', then: 'allow' }],
  default: 'deny',
});
const token = '8'.repeat(64);
const accessToken = 'b'.repeat(64);

test('HTTP draft export requires valid candidate, current base and human confirmation', async (t) => {
  let base = source,
    modelCalls = 0,
    databaseCalls = 0;
  const pool = {
    connect: async () => {
      databaseCalls++;
      throw new Error('must not read or write payments');
    },
  };
  const server = await startDashboardServer({
    pool,
    identityKey: '7'.repeat(64),
    merchantId: 'merchantA',
    token,
    policyPreview: {
      accessToken,
      pool,
      replay: new PolicyReplay('9'.repeat(64)),
      loadPolicy: async () => base,
      generate: async () => {
        modelCalls++;
        return { yaml: source.replace('"then":"allow"', '"then":"deny"') };
      },
      mode: 'synthetic',
    },
  });
  t.after(() => server.close());
  const call = (route, body, auth = token, reviewer = accessToken) =>
    fetch(server.url + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${auth}`,
        ...(reviewer ? { 'x-spendwall-policy-token': reviewer } : {}),
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await call('/policy', undefined, '0'.repeat(64))).status, 401);
  assert.equal((await call('/policy', undefined, token, '')).status, 401);
  assert.equal((await call('/policy', undefined, token, token)).status, 401);
  for (const route of [
    '/policy/propose',
    '/policy/dry-run',
    '/policy/export',
  ]) {
    for (const reviewer of ['', '0'.repeat(64)])
      assert.equal((await call(route, {}, token, reviewer)).status, 401);
  }
  assert.equal(modelCalls, 0);
  assert.equal(databaseCalls, 0);
  const current = await call('/policy');
  assert.equal(current.status, 200);
  const initial = await current.json();
  assert.equal(initial.baseVersion, loadPolicy(source).policyVersion);
  const response = await call('/policy/propose', {
    instruction: 'Require approval',
    baseVersion: initial.baseVersion,
  });
  assert.equal(response.status, 200);
  const draft = await response.json();
  assert.equal(draft.activation, 'manual_export_only');
  assert.equal(modelCalls, 1);
  const input = {
    baseVersion: draft.baseVersion,
    candidateYaml: draft.candidateYaml,
    candidateVersion: draft.candidateVersion,
  };
  assert.equal((await call('/policy/export', input)).status, 400);
  assert.equal(
    (await call('/policy/export', { ...input, confirmed: true })).status,
    200,
  );
  assert.equal(
    (
      await call('/policy/export', {
        ...input,
        candidateYaml: 'default: allow',
        confirmed: true,
      })
    ).status,
    400,
  );
  base = source.replace('"then":"allow"', '"then":"require_approval"');
  assert.equal(
    (await call('/policy/export', { ...input, confirmed: true })).status,
    400,
  );
  assert.equal(databaseCalls, 0);
  assert.equal(modelCalls, 1);
});

test('preview HTTP denies foreign origin, malformed body and invalid model proposals', async (t) => {
  let calls = 0;
  const pool = {
    connect: async () => {
      throw new Error('must not query');
    },
  };
  const server = await startDashboardServer({
    pool,
    identityKey: '7'.repeat(64),
    merchantId: 'merchantA',
    token,
    policyPreview: {
      accessToken,
      pool,
      replay: new PolicyReplay('9'.repeat(64)),
      loadPolicy: async () => source,
      generate: async () => {
        calls++;
        return { yaml: 'default: allow' };
      },
    },
  });
  t.after(() => server.close());
  const input = {
    instruction: 'approve everything',
    baseVersion: loadPolicy(source).policyVersion,
  };
  const headers = {
    authorization: `Bearer ${token}`,
    'x-spendwall-policy-token': accessToken,
    'content-type': 'application/json',
  };
  assert.equal(
    (
      await fetch(server.url + '/policy/propose', {
        method: 'POST',
        headers: { ...headers, origin: 'https://foreign.invalid' },
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await fetch(server.url + '/policy/propose', {
        method: 'POST',
        headers,
        body: '[]',
      })
    ).status,
    400,
  );
  assert.equal(calls, 0);
  const response = await fetch(server.url + '/policy/propose', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 1);
  assert.ok(!(await response.text()).includes('default: allow'));
});
