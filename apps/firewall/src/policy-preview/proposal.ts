import { loadPolicy } from '../../../../packages/policy/src/index.ts';

export function validateProposal(
  base: string,
  candidate: unknown,
  version: string,
) {
  try {
    if (
      typeof candidate !== 'string' ||
      candidate.split('\n').length > 2000 ||
      base.split('\n').length > 2000
    )
      throw new Error();
    const original = loadPolicy(base),
      next = loadPolicy(candidate);
    if (original.policyVersion !== version) throw new Error();
    return Object.freeze({
      baseYaml: base,
      candidateYaml: candidate,
      baseVersion: original.policyVersion,
      candidateVersion: next.policyVersion,
      activation: 'manual_export_only' as const,
    });
  } catch {
    throw new Error('Proposal unavailable.');
  }
}
export type Proposal = ReturnType<typeof validateProposal>;
export type ProposalGenerator = (
  input: { instruction: string; baseYaml: string },
  signal: AbortSignal,
) => Promise<unknown>;
