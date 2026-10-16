import { useEffect, useRef, useState } from 'react';
import type { Proposal } from '../../firewall/src/policy-preview/proposal.ts';

type Coverage = {
  total: number;
  replayed: number;
  changed: number;
  unchanged: number;
  unavailable: number;
  coverage: 'complete' | 'partial';
  as_of: string;
};
export function PolicyPreviewPanel({
  token,
  mode,
}: {
  token: string;
  mode: 'claude' | 'synthetic' | 'disabled';
}) {
  const [instruction, setInstruction] = useState(
    'Require approval when a customer has already requested two refunds in seven days.',
  );
  const [base, setBase] = useState<{
    baseYaml: string;
    baseVersion: string;
  } | null>(null);
  const [draft, setDraft] = useState<Proposal | null>(null),
    [coverage, setCoverage] = useState<Coverage | null>(null);
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [token],
  );
  async function perform(action: 'load' | 'propose' | 'dry-run' | 'export') {
    if (busy) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    if (action === 'load' || action === 'propose') {
      setDraft(null);
      setCoverage(null);
      setConfirmed(false);
    }
    const input =
      action === 'propose'
        ? { instruction, baseVersion: base?.baseVersion }
        : draft
          ? {
              baseVersion: draft.baseVersion,
              candidateYaml: draft.candidateYaml,
              candidateVersion: draft.candidateVersion,
              ...(action === 'export' ? { confirmed } : {}),
            }
          : {};
    try {
      const response = await fetch(
        action === 'load' ? '/policy' : `/policy/${action}`,
        {
          method: action === 'load' ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          ...(action === 'load' ? {} : { body: JSON.stringify(input) }),
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20000),
          ]),
        },
      );
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (active.current !== controller) return;
      if (action === 'load') setBase(result);
      if (action === 'propose') setDraft(result);
      if (action === 'dry-run') setCoverage(result);
      if (action === 'export') {
        const url = URL.createObjectURL(
          new Blob([result.candidateYaml], { type: 'application/yaml' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = `spendwall-draft-${result.candidateVersion.slice(0, 12)}.yaml`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('Draft downloaded. The running policy has not changed.');
      }
    } catch {
      if (active.current === controller) {
        setError(
          'This draft could not be verified. Reload the current policy and try again.',
        );
        setDraft(null);
        setCoverage(null);
        setConfirmed(false);
        setBase(null);
      }
    } finally {
      if (active.current === controller) setBusy(false);
    }
  }
  if (mode === 'disabled') return null;
  const lines = (yaml: string, other: string, kind: 'removed' | 'added') => {
    const current = yaml.split('\n'),
      previous = other.split('\n');
    let prefix = 0,
      suffix = 0;
    while (
      prefix < Math.min(current.length, previous.length) &&
      current[prefix] === previous[prefix]
    )
      prefix++;
    while (
      suffix < Math.min(current.length, previous.length) - prefix &&
      current[current.length - 1 - suffix] ===
        previous[previous.length - 1 - suffix]
    )
      suffix++;
    return current.map((line, index) => {
      const changed = index >= prefix && index < current.length - suffix;
      return (
        <span key={index} className={changed ? kind : ''}>
          <i aria-hidden="true">
            {changed ? (kind === 'removed' ? '−' : '+') : ' '}
          </i>
          {line || ' '}
        </span>
      );
    });
  };
  return (
    <section className="policy-preview" aria-labelledby="policy-preview-title">
      <div className="policy-heading">
        <div>
          <p className="eyebrow">POLICY WORKSHOP</p>
          <h2 id="policy-preview-title">Review a change before it matters.</h2>
        </div>
        <span className="read-only">
          {mode === 'synthetic' ? 'Synthetic preview' : 'Drafts only'}
        </span>
      </div>
      <p className="policy-intro">
        Describe a change, compare the draft, and check recorded decisions.
        Downloading a draft does not change your running policy.
      </p>
      {mode === 'claude' && (
        <p className="widget-note">
          Your instruction and current policy are sent to Claude. Payment
          history stays on your server.
        </p>
      )}
      <div className="policy-step">
        <span className="policy-number">01</span>
        <div>
          <h3>Describe the change</h3>
          {!base ? (
            <button onClick={() => void perform('load')} disabled={busy}>
              Load current policy
            </button>
          ) : (
            <>
              <p className="widget-note">
                Current version <code>{base.baseVersion.slice(0, 12)}</code> ·{' '}
                <button
                  className="policy-link"
                  onClick={() => void perform('load')}
                  disabled={busy}
                >
                  Reload policy
                </button>
              </p>
              <label htmlFor="policy-instruction">What should change?</label>
              <textarea
                id="policy-instruction"
                value={instruction}
                maxLength={2000}
                onChange={(e) => {
                  setInstruction(e.target.value);
                  setConfirmed(false);
                }}
                disabled={busy}
              />
              <button
                onClick={() => void perform('propose')}
                disabled={busy || !instruction.trim()}
              >
                Generate draft
              </button>
            </>
          )}
        </div>
      </div>
      {draft && (
        <>
          <div className="policy-step">
            <span className="policy-number">02</span>
            <div>
              <h3>Compare the policies</h3>
              <p className="widget-note">
                The draft passed format and expression checks. Review whether it
                matches your intent.
              </p>
              <div className="policy-diff">
                <div>
                  <h4>
                    Current <span>− removed or replaced</span>
                  </h4>
                  <pre aria-label="Current policy">
                    {lines(draft.baseYaml, draft.candidateYaml, 'removed')}
                  </pre>
                </div>
                <div>
                  <h4>
                    Proposed <span>+ added or replaced</span>
                  </h4>
                  <pre aria-label="Proposed policy">
                    {lines(draft.candidateYaml, draft.baseYaml, 'added')}
                  </pre>
                </div>
              </div>
              <button
                className="secondary"
                onClick={() => void perform('dry-run')}
                disabled={busy}
              >
                Reevaluate last 7 days
              </button>
              {coverage && (
                <div className="policy-coverage" role="status">
                  <div className="policy-counts">
                    <div>
                      <strong>{coverage.changed}</strong>
                      <span>Changed decisions</span>
                    </div>
                    <div>
                      <strong>{coverage.unchanged}</strong>
                      <span>Unchanged</span>
                    </div>
                    <div>
                      <strong>{coverage.unavailable}</strong>
                      <span>Unable to reevaluate</span>
                    </div>
                  </div>
                  <p>
                    {coverage.total === 0
                      ? 'No recorded calls in this seven-day window.'
                      : `${coverage.replayed} of ${coverage.total} calls reevaluated.`}{' '}
                    {coverage.coverage === 'partial'
                      ? 'Coverage is partial. Missing inputs are not counted as unchanged.'
                      : ''}
                  </p>
                  <small>
                    Uses the inputs and totals recorded at each decision. This
                    does not simulate future payments.
                  </small>
                </div>
              )}
            </div>
          </div>
          <div className="policy-step">
            <span className="policy-number">03</span>
            <div>
              <h3>Keep the decision with you</h3>
              <label className="policy-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  disabled={busy}
                />
                I reviewed this exact draft and understand that it is not
                applied automatically.
              </label>
              <button
                onClick={() => void perform('export')}
                disabled={busy || !confirmed}
              >
                Download reviewed draft
              </button>
            </div>
          </div>
        </>
      )}
      {busy && <p role="status">Checking the policy…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
