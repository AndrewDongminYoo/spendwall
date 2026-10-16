import type { ReconciliationData } from '../../firewall/src/webhooks/reconciliation.ts';

const labels = {
  pending: 'Waiting for a match',
  matched: 'Matched',
  unmediated: 'Unmediated · review needed',
  mismatch: 'Details do not match',
};
const explanations = {
  pending:
    'The execution record may still be arriving. Refresh after five minutes.',
  matched: 'This refund matches a recorded firewall execution.',
  unmediated:
    'No matching firewall completion was found. Check the refund in PayPal and your execution records.',
  mismatch:
    'The refund and execution evidence differ. Check the amount, capture and audit record.',
};
export function ReconciliationPanel({
  data,
}: {
  data: ReconciliationData | null;
}) {
  const review =
    data?.items.filter((item) =>
      ['unmediated', 'mismatch'].includes(item.state),
    ).length ?? 0;
  return (
    <section className="reconciliation" aria-labelledby="reconciliation-title">
      <div className="reconciliation-heading">
        <div>
          <p className="eyebrow">REFUND RECONCILIATION</p>
          <h2 id="reconciliation-title">
            Compare refunds with firewall activity
          </h2>
        </div>
        {data && (
          <span className={review ? 'reconciliation-attention' : 'read-only'}>
            {review
              ? `${review} observations need review`
              : 'No observations need review'}
          </span>
        )}
      </div>
      {!data ? (
        <p>
          Reconciliation is not enabled for this workspace. Refunds received
          outside the firewall are not shown here.
        </p>
      ) : (
        <>
          <p className="coverage">{data.coverage}</p>
          {data.items.length === 0 ? (
            <p className="empty">
              No verified refund events received yet. New observations will
              appear after refresh.
            </p>
          ) : (
            <ul className="reconciliation-list">
              {data.items.map((item) => (
                <li
                  key={item.reference}
                  className={`reconciliation-item reconciliation-${item.state}`}
                >
                  <div className="reconciliation-row">
                    <strong>{labels[item.state]}</strong>
                    <strong>
                      {new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                      }).format(item.usd)}
                    </strong>
                  </div>
                  <p>{explanations[item.state]}</p>
                  <div className="reconciliation-meta">
                    <time dateTime={item.received_at}>
                      Received {new Date(item.received_at).toLocaleString()}
                    </time>
                    <span>
                      Observation {item.reference.slice(0, 12)}
                      {item.audit_id ? ` · Audit #${item.audit_id}` : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
