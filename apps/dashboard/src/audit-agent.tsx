import { useEffect, useMemo, useRef, useState } from 'react';
import { AgStudio } from 'ag-studio-react';
import {
  AgStudioAiModule,
  AgStudioModuleRegistry,
  createAiHarness,
} from 'ag-studio';
import type {
  AgAiChatSession,
  AgAiHarness,
  AgAiHarnessSetupParams,
} from 'ag-studio';
import { auditPrompts } from '../../firewall/src/dashboard/query-contract.ts';
import type { AuditResult } from '../../firewall/src/dashboard/query-contract.ts';
import { auditRunner, queryView } from './audit-runner.ts';
import { theme } from './studio.tsx';

AgStudioModuleRegistry.registerModules([AgStudioAiModule]);
const empty = queryView(null);

export function AuditAgent({
  token,
  mode,
}: {
  token: string;
  mode: 'claude' | 'synthetic' | 'disabled';
}) {
  const [question, setQuestion] = useState('');
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null),
    [error, setError] = useState('');
  const harness = useRef<AgAiHarness | null>(null),
    session = useRef<AgAiChatSession | null>(null);
  const mounted = useRef(true),
    running = useRef(false);
  useEffect(
    () => () => {
      mounted.current = false;
      session.current?.cancel();
      harness.current?.dispose?.();
    },
    [],
  );
  const setup = useMemo<(params: AgAiHarnessSetupParams) => AgAiHarness>(
    () =>
      ({ api }) => {
        if (harness.current) return harness.current;
        const agent = auditRunner(
          async (text, signal) => {
            const response = await fetch('/query', {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ question: text }),
              signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
              cache: 'no-store',
            });
            if (!response.ok) throw new Error();
            return (await response.json()) as AuditResult;
          },
          (next) => {
            if (!mounted.current) return;
            const view = queryView(next);
            api.setProperty('data', view.data);
            api.setState(view.state);
            api.clearHistory();
            setResult(next);
          },
        );
        const value = createAiHarness(api, () => ({
          agents: [agent],
          primary: 'audit',
        }));
        harness.current = value;
        return value;
      },
    [token],
  );
  async function ask(text: string) {
    if (running.current || !harness.current || !text.trim()) return;
    running.current = true;
    setBusy(true);
    setError('');
    setQuestion(text);
    try {
      if (session.current)
        await harness.current.deleteThread(session.current.threadId);
      const next = await harness.current.createThread({ agentId: 'audit' });
      if (!mounted.current) {
        next.close();
        return;
      }
      session.current = next;
      let started = false;
      const changed = () => {
        if (!mounted.current || session.current !== next) {
          next.removeEventListener('changed', changed);
          return;
        }
        if (next.status === 'running') {
          started = true;
          return;
        }
        // Studio notifies the user message while still idle, before beginRun.
        if (!started) return;
        if (next.status === 'error')
          setError(
            'Unable to answer. Try one of the three supported questions, or check the Claude configuration and server connection.',
          );
        running.current = false;
        setBusy(false);
        next.removeEventListener('changed', changed);
      };
      next.addEventListener('changed', changed);
      next.sendMessage(text);
    } catch {
      if (mounted.current) {
        setError('Audit agent unavailable. Refresh and retry.');
        setBusy(false);
        running.current = false;
      }
    }
  }
  return (
    <section className="audit-agent" aria-labelledby="audit-agent-title">
      <div className="agent-heading">
        <div>
          <p className="eyebrow">AUDIT ASSISTANT</p>
          <h2 id="audit-agent-title">Ask about your refunds</h2>
        </div>
        <span className="read-only">
          {mode === 'synthetic'
            ? 'Synthetic preview · no model calls'
            : mode === 'disabled'
              ? 'Claude not configured'
              : 'Claude · read-only'}
        </span>
      </div>
      <p>
        Three supported views. Each question replaces the result below. Week
        boundaries use UTC; rule groups and reservation trends cover 24 hours.
      </p>
      <div className="prompt-list">
        {auditPrompts.map((entry) => (
          <button
            className="secondary"
            key={entry.intent}
            disabled={!ready || busy || mode === 'disabled'}
            onClick={() => void ask(entry.prompt)}
          >
            {entry.prompt}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
      >
        <label htmlFor="audit-question">Complete audit question</label>
        <div className="connection-fields">
          <input
            id="audit-question"
            value={question}
            maxLength={2000}
            disabled={busy || mode === 'disabled'}
            onChange={(event) => setQuestion(event.target.value)}
            autoComplete="off"
          />
          <button
            disabled={!ready || busy || !question.trim() || mode === 'disabled'}
          >
            {busy ? 'Reading…' : 'Ask'}
          </button>
        </div>
      </form>
      {mode === 'claude' && (
        <p className="widget-note">
          Your question is sent to Claude. Do not include credentials or
          customer details. Audit records stay on the server.
        </p>
      )}
      {busy && (
        <p role="status">
          Reading a fresh audit snapshot…{' '}
          <button
            className="secondary"
            onClick={() => {
              session.current?.cancel();
              running.current = false;
              setBusy(false);
              setError('Query cancelled.');
            }}
          >
            Cancel
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result && (
        <div className="query-caption" role="status">
          <strong>
            {result.rows.length === 0
              ? 'No matching records.'
              : `${result.rows.length} ${result.intent === 'support_budget' ? 'hourly samples' : result.rows.length === 1 ? 'row' : 'rows'}.`}
          </strong>
          <p>{result.note}</p>
          <small>Query snapshot · {result.as_of}</small>
        </div>
      )}
      <div style={{ display: result ? 'block' : 'none' }}>
        <AgStudio
          data={empty.data}
          initialState={empty.state}
          ai={setup}
          theme={theme}
          panels={{ view: { left: [], right: [] } }}
          mode="view"
          onStudioReady={(event) => {
            setup(event);
            setReady(true);
          }}
          style={{ width: '100%', height: 440 }}
        />
      </div>
    </section>
  );
}
