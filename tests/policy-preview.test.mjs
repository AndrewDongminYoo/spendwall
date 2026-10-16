import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPolicy } from '../packages/policy/src/index.ts';
import { validateProposal } from '../apps/firewall/src/policy-preview/proposal.ts';

export const source = (then = 'allow', when = 'amount.usd <= 100') =>
  JSON.stringify({
    agents: { support: { tools: { allow: ['create_refund'], deny: [] } } },
    rules: [{ id: 'limit', when, then }],
    default: 'deny',
  });

test('proposal validates candidate with the existing loader and binds both versions', () => {
  const base = source(),
    candidate = source('require_approval');
  const result = validateProposal(
    base,
    candidate,
    loadPolicy(base).policyVersion,
  );
  assert.equal(result.baseVersion, loadPolicy(base).policyVersion);
  assert.equal(result.candidateVersion, loadPolicy(candidate).policyVersion);
  assert.equal(result.candidateYaml, candidate);
  assert.equal(result.baseYaml, base);
  assert.equal(result.activation, 'manual_export_only');
});

test('invalid or stale proposals cannot become reviewed drafts', () => {
  const base = source(),
    version = loadPolicy(base).policyVersion;
  for (const candidate of [
    null,
    {},
    'default: allow',
    source('allow', 'amount.usd <'),
    source().replace('"default":"deny"', '"default":"allow"'),
    'a'.repeat(65537),
    source() + '\n'.repeat(2000),
  ]) {
    assert.throws(
      () => validateProposal(base, candidate, version),
      /Proposal unavailable/,
    );
  }
  assert.throws(
    () => validateProposal(base, source(), 'a'.repeat(64)),
    /Proposal unavailable/,
  );
});

test('Claude adapter sends only explicit policy/instruction and rejects incomplete output', async () => {
  const { claudePolicy } =
    await import('../apps/firewall/src/policy-preview/claude.ts');
  let sent;
  const generate = claudePolicy({
    apiKey: 'synthetic-only',
    model: 'synthetic-model',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.redirect, 'error');
      sent = JSON.parse(options.body);
      return Response.json({
        type: 'message',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ yaml: source() }) }],
      });
    },
  });
  assert.deepEqual(
    await generate(
      { instruction: 'Require approval', baseYaml: source() },
      new AbortController().signal,
    ),
    { yaml: source() },
  );
  assert.deepEqual(JSON.parse(sent.messages[0].content), {
    instruction: 'Require approval',
    baseYaml: source(),
  });
  assert.equal(sent.tools, undefined);
  for (const value of [
    { type: 'message', stop_reason: 'max_tokens', content: [] },
    {
      type: 'message',
      stop_reason: 'end_turn',
      content: [{ type: 'tool_use' }],
    },
  ]) {
    const invalid = claudePolicy({
      apiKey: 'synthetic-only',
      model: 'synthetic-model',
      fetchImpl: async () => Response.json(value),
    });
    await assert.rejects(() =>
      invalid(
        { instruction: 'x', baseYaml: source() },
        new AbortController().signal,
      ),
    );
  }
});

test('aborted generation retains its slot until the original provider settles', async () => {
  const { PolicyPreview } =
    await import('../apps/firewall/src/policy-preview/service.ts');
  let resolve, started;
  const entered = new Promise((r) => {
    started = r;
  });
  let calls = 0;
  const preview = new PolicyPreview({
    loadPolicy: async () => source(),
    generate: async () => {
      calls++;
      started();
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  const input = {
    instruction: 'Change policy',
    baseVersion: loadPolicy(source()).policyVersion,
  };
  const controller = new AbortController();
  const pending = preview.run('/policy/propose', input, {}, controller.signal);
  await entered;
  controller.abort();
  await assert.rejects(pending);
  await assert.rejects(() =>
    preview.run('/policy/propose', input, {}, new AbortController().signal),
  );
  assert.equal(calls, 1);
  resolve({ yaml: source('deny') });
  await new Promise((r) => setImmediate(r));
});
