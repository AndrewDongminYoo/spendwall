import { summarySchema } from './summary.ts';
import type { SummaryPrompt } from './summary.ts';

type Options = { apiKey: string; model: string; fetchImpl?: typeof fetch };

// Explicit opt-in: no environment lookup, tools, redirects, or retry loop.
export function claudeSummary(options: Options) {
  if (
    !options.apiKey ||
    /[\r\n]/.test(options.apiKey) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(options.model)
  )
    throw new Error('Summary configuration unavailable.');
  return async (
    prompt: SummaryPrompt,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const response = await (options.fetchImpl ?? fetch)(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: 600,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          output_config: {
            format: { type: 'json_schema', schema: summarySchema },
          },
        }),
      },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Summary unavailable.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (response.status !== 200) throw new Error('Summary unavailable.');
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16384) throw new Error('Summary unavailable.');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      result?.type !== 'message' ||
      result.stop_reason !== 'end_turn' ||
      !Array.isArray(result.content) ||
      result.content.length !== 1 ||
      result.content[0]?.type !== 'text' ||
      typeof result.content[0].text !== 'string'
    )
      throw new Error('Summary unavailable.');
    return JSON.parse(result.content[0].text);
  };
}
