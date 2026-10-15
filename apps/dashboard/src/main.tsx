import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Report } from './studio.tsx';
import type { Stats } from './studio.tsx';
import type { DashboardData } from '../../firewall/src/dashboard/data.ts';
import './style.css';

function App() {
  const [token, setToken] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [audit, setAudit] = useState<DashboardData['audit']>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [narrow, setNarrow] = useState(window.innerWidth < 800);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 799px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
      active.current?.abort();
    };
  }, []);
  function disconnect() {
    active.current?.abort();
    active.current = null;
    setStats(null);
    setAudit([]);
    setToken('');
    setError('');
    setBusy(false);
  }
  async function load(event?: FormEvent) {
    event?.preventDefault();
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    setBusy(true);
    setError('');
    setStats(null);
    setAudit([]);
    try {
      const responses = await Promise.all(
        ['/stats', '/audit'].map((path) =>
          fetch(path, {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
            cache: 'no-store',
          }),
        ),
      );
      if (responses.some((r) => !r.ok)) throw new Error();
      const [next, history] = await Promise.all(responses.map((r) => r.json()));
      if (active.current !== controller) return;
      setStats(next);
      setAudit(history.items);
    } catch {
      if (active.current === controller)
        setError(
          'Unable to load this merchant. Check your access token and server connection, then retry.',
        );
    } finally {
      clearTimeout(timer);
      if (active.current === controller) setBusy(false);
    }
  }
  return (
    <>
      <header className="topbar">
        <a href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          Spendwall
        </a>
        <span className="read-only">Read-only workspace</span>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <p className="eyebrow">PAYMENT OVERSIGHT</p>
            <h1>Every refund, in view.</h1>
            <p className="intro">
              See what passed, what stopped, and what needs a human.
            </p>
          </div>
          {stats && (
            <div className="actions">
              <button onClick={() => void load()} disabled={busy}>
                Refresh
              </button>
              <button className="secondary" onClick={disconnect}>
                Disconnect
              </button>
            </div>
          )}
        </div>
        {!stats && (
          <section className="connection" aria-labelledby="connection-title">
            <p className="eyebrow">MERCHANT ACCESS</p>
            <h2 id="connection-title">Connect to your firewall</h2>
            <p>
              Your dashboard token opens a read-only view. It stays in this tab
              and cannot approve a payment.
            </p>
            <form onSubmit={(e) => void load(e)}>
              <label htmlFor="token">Dashboard access token</label>
              <div className="connection-fields">
                <input
                  id="token"
                  type="password"
                  value={token}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={busy}
                />
                <button disabled={busy || !/^[a-f0-9]{64}$/i.test(token)}>
                  {busy ? 'Loading…' : 'Connect'}
                </button>
              </div>
            </form>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {busy && <p role="status">Reading the latest audit snapshot…</p>}
          </section>
        )}
        {stats && (
          <>
            <div className="freshness">
              <span className="status-dot" />
              Database snapshot ·{' '}
              <time>{new Date(stats.as_of).toLocaleString()}</time>
            </div>
            <section className="metrics" aria-label="Payment overview">
              <div>
                <span>Confirmed refunds · 24h</span>
                <strong>
                  {new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  }).format(stats.confirmed_usd)}
                </strong>
                <small>Succeeded approval executions</small>
              </div>
              <div>
                <span>Awaiting approval</span>
                <strong>{stats.pending.length}</strong>
                <small>Unexpired requests needing a decision</small>
              </div>
              <div>
                <span>Blocked attempts · 24h</span>
                <strong>
                  {stats.decisions.find((d) => d.decision === 'deny')?.count ??
                    0}
                </strong>
                <small>Original policy denials</small>
              </div>
            </section>
            <p className="coverage">
              {stats.coverage} Allowed or reserved funds are not proof of
              payment.
            </p>
            {audit.length === 0 && (
              <p className="empty" role="status">
                No tracked refunds yet. New firewall activity will appear after
                refresh.
              </p>
            )}
            <Report stats={stats} narrow={narrow} />
            <details className="audit">
              <summary>Audit history · {audit.length} tracked requests</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Agent</th>
                      <th>Decision</th>
                      <th>USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((row) => (
                      <tr key={row.id}>
                        <td>{row.at}</td>
                        <td>{row.agent}</td>
                        <td>{row.decision}</td>
                        <td>{row.usd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
        <footer>
          Spendwall · Deterministic payment controls. Human decisions stay in
          the approver.
        </footer>
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
