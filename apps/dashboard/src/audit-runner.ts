import type {
  AgAiAgentRunner,
  AgDataSourcesDefinition,
  AgReportState,
} from 'ag-studio';
import type { AuditResult } from '../../firewall/src/dashboard/query-contract.ts';
import { auditFields } from '../../firewall/src/dashboard/query-contract.ts';

export function queryView(result: AuditResult | null): {
  data: AgDataSourcesDefinition;
  state: AgReportState;
} {
  const state: AgReportState = {
    selectedPageId: 'audit',
    pages: [{ id: 'audit', widgets: {}, widgetLayout: {} }],
  };
  const data: AgDataSourcesDefinition = {
    sources: [
      {
        id: 'answer',
        fields: auditFields,
        data:
          result?.intent === 'support_budget'
            ? result.rows.map((row) => ({
                ...row,
                hour: String(row.hour).slice(5, 16).replace('T', ' '),
              }))
            : (result?.rows ?? []),
      },
    ],
  };
  if (!result) return { data, state };
  const format = { title: { text: result.title, enabled: true } };
  state.pages[0]!.widgets!['audit-result'] =
    result.intent === 'support_budget'
      ? {
          type: 'line-chart',
          format: {
            ...format,
            style: { theme: { common: { legend: { enabled: true } } } },
          },
          dataMapping: {
            categoryKey: [{ id: 'answer.hour' }],
            valueKey: [
              { id: 'answer.reserved_usd', aggregation: 'sum' },
              { id: 'answer.budget_usd', aggregation: 'sum' },
            ],
          },
        }
      : {
          type: 'grid',
          format,
          dataMapping: {
            cols: result.columns.map((c) => ({ id: `answer.${c.id}` })),
          },
        };
  state.pages[0]!.widgetLayout!['audit-result'] = {
    xTrack: 0,
    yTrack: 0,
    xSpan: 24,
    ySpan: 20,
  };
  return {
    data,
    state,
  };
}
export function auditRunner(
  load: (question: string, signal: AbortSignal) => Promise<AuditResult>,
  apply: (result: AuditResult | null) => void,
): AgAiAgentRunner {
  return {
    id: 'audit',
    name: 'Spendwall audit analyst',
    run: async function* (input, ctx) {
      yield {
        type: 'RUN_STARTED',
        threadId: input.threadId,
        runId: input.runId,
      };
      apply(null);
      const signal = ctx.signal ?? new AbortController().signal;
      try {
        signal.throwIfAborted();
        const message = input.messages.findLast((m) => m.role === 'user');
        if (
          !message ||
          typeof message.content !== 'string' ||
          !message.content.trim()
        )
          throw new Error();
        const result = await load(message.content, signal);
        signal.throwIfAborted();
        apply(result);
        yield {
          type: 'TEXT_MESSAGE_CHUNK',
          messageId: `answer-${input.runId}`,
          role: 'assistant',
          delta: result.note,
        };
        yield {
          type: 'RUN_FINISHED',
          threadId: input.threadId,
          runId: input.runId,
        };
      } catch {
        if (!signal.aborted)
          yield {
            type: 'RUN_ERROR',
            message:
              'Unable to answer. Use a supported complete question and check the server connection.',
          };
      }
    },
  };
}
