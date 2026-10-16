import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { loadPolicy } from '../../../../packages/policy/src/index.ts';
import { validateProposal } from './proposal.ts';
import type { ProposalGenerator } from './proposal.ts';
import type { PolicyReplay } from './replay.ts';

export type PreviewOptions = {
  accessToken: string;
  pool: Pick<Pool, 'connect'>;
  replay: PolicyReplay;
  loadPolicy: () => Promise<string>;
  generate?: ProposalGenerator;
  mode?: 'claude' | 'synthetic';
};
export async function readPreviewBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') ||
    req.headers['content-encoding'] !== undefined
  )
    throw new Error();
  const timer = setTimeout(() => req.destroy(), 5000);
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const part of req.iterator({ destroyOnReturn: false })) {
      const chunk = Buffer.from(part);
      bytes += chunk.length;
      if (bytes > 262144) {
        req.resume();
        throw new Error();
      }
      chunks.push(chunk);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error();
    return input as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}
function fields(input: Record<string, unknown>, names: string[]) {
  if (
    Object.keys(input).length !== names.length ||
    names.some((k) => !Object.hasOwn(input, k))
  )
    throw new Error();
}
export class PolicyPreview {
  readonly options: PreviewOptions;
  private generating = false;
  constructor(options: PreviewOptions) {
    this.options = options;
  }
  async run(
    action: string,
    input: Record<string, unknown>,
    scope: { merchantRef: string; keyId: string },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const base = await this.options.loadPolicy(),
      version = loadPolicy(base).policyVersion;
    if (action === '/policy')
      return {
        baseYaml: base,
        baseVersion: version,
        mode: this.options.generate
          ? (this.options.mode ?? 'claude')
          : 'disabled',
      };
    if (input.baseVersion !== version) throw new Error();
    if (action === '/policy/propose') {
      fields(input, ['instruction', 'baseVersion']);
      if (
        typeof input.instruction !== 'string' ||
        !input.instruction.trim() ||
        input.instruction.length > 2000 ||
        !this.options.generate ||
        this.generating
      )
        throw new Error();
      this.generating = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 10000);
      let removeAbort = () => {},
        operationStarted = false;
      try {
        signal.throwIfAborted();
        const stopped = new Promise<never>((_, reject) => {
          const cancel = () => reject(new Error());
          controller.signal.addEventListener('abort', cancel, { once: true });
          removeAbort = () =>
            controller.signal.removeEventListener('abort', cancel);
        });
        // Keep the slot occupied until the actual provider settles, even after timeout.
        operationStarted = true;
        const operation = Promise.resolve()
          .then(() =>
            this.options.generate!(
              {
                instruction: (input.instruction as string).trim(),
                baseYaml: base,
              },
              controller.signal,
            ),
          )
          .finally(() => {
            this.generating = false;
          });
        const output = await Promise.race([operation, stopped]);
        controller.signal.throwIfAborted();
        if (
          !output ||
          typeof output !== 'object' ||
          Array.isArray(output) ||
          Object.keys(output).length !== 1 ||
          !('yaml' in output)
        )
          throw new Error();
        return validateProposal(
          await this.options.loadPolicy(),
          output.yaml,
          version,
        );
      } finally {
        if (!operationStarted) this.generating = false;
        clearTimeout(timer);
        removeAbort();
        signal.removeEventListener('abort', abort);
        controller.abort();
      }
    }
    fields(
      input,
      action === '/policy/export'
        ? ['baseVersion', 'candidateYaml', 'candidateVersion', 'confirmed']
        : ['baseVersion', 'candidateYaml', 'candidateVersion'],
    );
    const proposal = validateProposal(base, input.candidateYaml, version);
    if (input.candidateVersion !== proposal.candidateVersion) throw new Error();
    if (action === '/policy/export') {
      if (input.confirmed !== true) throw new Error();
      signal.throwIfAborted();
      return proposal;
    }
    if (action !== '/policy/dry-run') throw new Error();
    const result = await this.options.replay.preview(
      this.options.pool,
      scope,
      loadPolicy(proposal.candidateYaml),
    );
    signal.throwIfAborted();
    validateProposal(
      await this.options.loadPolicy(),
      proposal.candidateYaml,
      version,
    );
    return {
      ...result,
      baseVersion: version,
      candidateVersion: proposal.candidateVersion,
    };
  }
}
