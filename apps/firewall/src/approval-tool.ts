import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentPrincipal } from './auth.ts';

export type ApprovalLookup = (input: {
  agentId: string;
  approvalId: string;
}) => Promise<unknown>;
export const approvalTool: Tool = {
  name: 'check_approval',
  description:
    'Check an approval owned by this authenticated agent; this does not execute or grant permission.',
  inputSchema: {
    type: 'object',
    properties: {
      approval_id: {
        type: 'string',
        pattern:
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
      },
    },
    required: ['approval_id'],
    additionalProperties: false,
  },
};

export async function checkApproval(
  id: string,
  agent: AgentPrincipal,
  lookup?: ApprovalLookup,
) {
  const denied = () => ({
    isError: true,
    content: [{ type: 'text' as const, text: 'Approval status unavailable.' }],
  });
  if (!lookup) return denied();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const approvalId = id.toLowerCase();
    const result = await Promise.race([
      lookup({ agentId: agent.agentId, approvalId }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error()), 5000);
      }),
    ]);
    if (!result || typeof result !== 'object' || Array.isArray(result))
      return denied();
    const fields = ['agentId', 'approvalId', 'status'].map((name) =>
      Object.getOwnPropertyDescriptor(result, name),
    );
    if (fields.some((field) => !field || !('value' in field))) return denied();
    const [owner, storedId, status] = fields.map(
      (field) => field!.value as unknown,
    );
    if (
      owner !== agent.agentId ||
      storedId !== approvalId ||
      typeof status !== 'string' ||
      !['pending', 'approved', 'denied', 'expired'].includes(status)
    )
      return denied();
    const safe = { approval_id: approvalId, status };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(safe) }],
      structuredContent: safe,
    };
  } catch {
    return denied();
  } finally {
    clearTimeout(timer);
  }
}
