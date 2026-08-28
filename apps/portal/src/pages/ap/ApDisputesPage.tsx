import { useQuery } from '@tanstack/react-query';
import {
  REASON_CODE_LABELS,
  RESPONSE_CODE_LABELS,
  type DocumentListItem,
} from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  EmptyState,
  PageHeader,
  Spinner,
  cx,
  formatDate,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';

/**
 * The inbound dispute desk (SRS v2.7 §12.3).
 *
 * The mirror of the outbound one, with the parties swapped: every row is a
 * supplier's bill *we* have queried or rejected and sent back. So the thing
 * that closes one is a credit note from them, not from us, and this screen
 * cannot offer a button to produce it — which is why it reports rather than
 * acts, and sends you to the verification desk to change a verdict.
 *
 * Aging is shown in days for the same reason it is on the outbound desk: a bill
 * held for two months is two months of input tax we have not reclaimed.
 */

interface DisputeListResponse {
  items: DocumentListItem[];
  total: number;
}

const STATES = ['open', 'resolved'] as const;
type DisputeState = (typeof STATES)[number];

const STATE_LABELS: Record<DisputeState, string> = {
  open: 'Open',
  resolved: 'Resolved',
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const opened = new Date(iso).getTime();
  if (Number.isNaN(opened)) return null;
  return Math.max(0, Math.floor((Date.now() - opened) / 86_400_000));
}

export function ApDisputesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('state') as DisputeState | null;
  const state: DisputeState = requested && STATES.includes(requested) ? requested : 'open';
  const setState = (next: DisputeState) => setSearchParams(next === 'open' ? {} : { state: next });

  const { data, isLoading } = useQuery({
    queryKey: ['ap-disputes', state],
    queryFn: () =>
      api<DisputeListResponse>(
        `/api/v1/ap/invoices${queryString({ disputes: state, pageSize: 200 })}`,
      ),
  });

  const items = data?.items ?? [];
  const stale = state === 'open' ? items.filter((d) => (daysSince(d.disputeOpenedAt) ?? 0) > 30) : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Supplier disputes"
        description="Purchase invoices this desk has queried or rejected and returned to the supplier."
        actions={
          <div className="flex rounded-md border border-slate-300 p-0.5">
            {STATES.map((option) => (
              <button
                key={option}
                onClick={() => setState(option)}
                className={cx(
                  'rounded px-3 py-1 text-sm transition-colors',
                  state === option ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100',
                )}
              >
                {STATE_LABELS[option]}
              </button>
            ))}
          </div>
        }
      />

      {stale.length > 0 && (
        <Alert kind="warn" title="Input tax not yet reclaimed">
          {stale.length} bill{stale.length === 1 ? ' has' : 's have'} been held for more than 30 days
          with no corrected invoice or credit note from the supplier. Chase them, or accept the bill
          if the query has been settled off-system.
        </Alert>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-6">
            <Spinner label="Loading disputes…" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={state === 'open' ? 'No open disputes' : 'No resolved disputes'}
            description={
              state === 'open'
                ? 'Every supplier bill this desk has ruled on was accepted.'
                : 'Bills queried or rejected and later accepted appear here.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Invoice</th>
                <th className="px-4 py-2 font-medium">Supplier</th>
                <th className="px-4 py-2 text-right font-medium">Amount (AED)</th>
                <th className="px-4 py-2 font-medium">Our verdict</th>
                <th className="px-4 py-2 font-medium">Reason</th>
                <th className="px-4 py-2 font-medium">{state === 'open' ? 'Held for' : 'Settled'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((dispute) => {
                const held = daysSince(dispute.disputeOpenedAt);
                return (
                  <tr key={dispute.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <Link
                        to={`/ap/documents/${dispute.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {dispute.invoiceNumber}
                      </Link>
                      {dispute.poReference && (
                        <div className="font-mono text-xs text-slate-400">
                          {dispute.poReference}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-700">{dispute.counterpartyName}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-800">
                      {formatAmount(dispute.payableAmountAed)}
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {dispute.latestResponseCode
                        ? RESPONSE_CODE_LABELS[dispute.latestResponseCode]
                        : '—'}
                    </td>
                    <td className="px-4 py-2">
                      {dispute.latestResponseReasonCode ? (
                        <>
                          <span className="font-medium text-slate-700">
                            {dispute.latestResponseReasonCode}
                          </span>{' '}
                          <span className="text-slate-500">
                            {REASON_CODE_LABELS[dispute.latestResponseReasonCode]}
                          </span>
                        </>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {state === 'resolved' ? (
                        <span className="text-slate-600">{formatDate(dispute.disputeResolvedAt)}</span>
                      ) : held !== null ? (
                        <span
                          className={cx(
                            'tabular-nums',
                            held > 30 ? 'font-medium text-warn-700' : 'text-slate-600',
                          )}
                        >
                          {held} day{held === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
