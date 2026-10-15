import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditRunner, queryView } from '../apps/dashboard/src/audit-runner.ts';
const result = {
  intent: 'weekly_refunds',
  as_of: '2026-10-16T00:00:00Z',
  title: 'Refund attempts',
  note: 'Tracked attempts',
  columns: [{ id: 'usd', name: 'USD', format: 'decimalFormat' }],
  rows: [{ usd: 101 }],
};
const input = {
  threadId: 'thread',
  runId: 'run',
  messages: [
    { id: '1', role: 'user', content: 'old question' },
    { id: '2', role: 'user', content: 'current question' },
  ],
  tools: [],
  state: {},
  context: [],
  forwardedProps: {},
};
test('runner sends only the current question and replaces one result widget on repeated runs', async () => {
  let view = queryView(null),
    question;
  const runner = auditRunner(
    async (q) => {
      question = q;
      return result;
    },
    (r) => {
      view = queryView(r);
    },
  );
  for (let i = 0; i < 3; i++) {
    const events = [];
    for await (const e of runner.run(input, {})) events.push(e);
    assert.equal(question, 'current question');
    assert.equal(events[0].type, 'RUN_STARTED');
    assert.equal(events.at(-1).type, 'RUN_FINISHED');
    assert.deepEqual(Object.keys(view.state.pages[0].widgets), [
      'audit-result',
    ]);
    assert.deepEqual(view.data.sources[0].data, [{ usd: 101 }]);
  }
});
test('cancelled or failed queries clear the old result and never apply a late answer', async () => {
  for (const failure of ['abort', 'error']) {
    const controller = new AbortController();
    let displayed = result;
    const runner = auditRunner(
      async () => {
        if (failure === 'error') throw new Error('private secret');
        controller.abort();
        return result;
      },
      (r) => {
        displayed = r;
      },
    );
    const events = [];
    for await (const e of runner.run(input, { signal: controller.signal }))
      events.push(e);
    assert.equal(displayed, null);
    assert.ok(!JSON.stringify(events).includes('private secret'));
    if (failure === 'error') assert.equal(events.at(-1).type, 'RUN_ERROR');
  }
});
