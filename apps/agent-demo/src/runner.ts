import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Demo, Scenario } from './firewall.ts';

export async function connectRecorded(demo: Demo) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await demo.server.instance.connect(serverTransport);
  const client = new Client({
    name: 'recorded-support-agent',
    version: '1.0.0',
  });
  await client.connect(clientTransport);
  return client;
}

export async function replay(demo: Demo, signal?: AbortSignal) {
  const client = await connectRecorded(demo);
  try {
    for (const args of demo.ticket.recordedCalls) {
      signal?.throwIfAborted();
      await client.callTool({ name: 'create_refund', arguments: args });
    }
    for (const id of demo.pendingIds()) {
      signal?.throwIfAborted();
      const before = await client.callTool({
        name: 'check_approval',
        arguments: { approval_id: id },
      });
      if (
        (before.structuredContent as Record<string, unknown> | undefined)
          ?.status !== 'pending' ||
        demo.payments.length !== 0
      )
        throw new Error('Approval failed to hold payment execution.');
      await demo.humanDecision(id, 'approve');
      const after = await client.callTool({
        name: 'check_approval',
        arguments: { approval_id: id },
      });
      if (
        (after.structuredContent as Record<string, unknown> | undefined)
          ?.execution_state !== 'succeeded'
      )
        throw new Error('Approved payment did not complete.');
    }
    assertScenario(demo.ticket.id, demo);
  } finally {
    await client.close();
  }
}

export function assertScenario(name: Scenario, demo: Demo) {
  const expected = {
    small: ['allow'],
    approval: ['pending_approval', 'approved'],
    injection: ['deny', 'deny'],
    velocity: ['allow', 'allow', 'deny'],
  };
  const counts = { small: 1, approval: 1, injection: 0, velocity: 2 };
  if (
    JSON.stringify(demo.events.map((event) => event.decision)) !==
      JSON.stringify(expected[name]) ||
    demo.payments.length !== counts[name]
  )
    throw new Error(`Unexpected ${name} scenario outcome.`);
}
