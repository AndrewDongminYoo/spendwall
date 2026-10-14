import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { object, snapshot, identifier } from '../context/json.ts';
import { approvalId, invalid } from './binding.ts';
import type { ApprovalService } from './index.ts';

export const approvalTool: Tool = {
  name: 'check_approval',
  description:
    'Read the authenticated owner’s approval and execution result. This never executes a payment.',
  inputSchema: {
    type: 'object',
    properties: { approval_id: { type: 'string', format: 'uuid' } },
    required: ['approval_id'],
    additionalProperties: false,
  },
};
export async function checkApproval(
  service: Pick<ApprovalService, 'check'>,
  principal: { agentId: string },
  args: unknown,
): Promise<CallToolResult> {
  try {
    const value = object(snapshot(args));
    if (Object.keys(value).length !== 1) invalid();
    const view = await service.check({
      agentId: identifier(principal.agentId),
      approvalId: approvalId(value.approval_id),
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(view) }],
      structuredContent: { ...view },
    };
  } catch {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Approval status unavailable.' }],
    };
  }
}
// Compatible with PR #39's authenticated approvalLookup boundary.
export function approvalLookup(service: Pick<ApprovalService, 'check'>) {
  return async (input: { agentId: string; approvalId: string }) => {
    const view = await service.check(input);
    return {
      agentId: input.agentId,
      approvalId: view.approval_id,
      status: view.status,
      executionState: view.execution_state,
      result: view.result,
    };
  };
}
