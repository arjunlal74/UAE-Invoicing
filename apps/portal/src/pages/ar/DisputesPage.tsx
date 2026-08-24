import { useQuery } from '@tanstack/react-query';
import { REASON_CODE_LABELS, RESPONSE_CODE_LABELS, type RejectionReasonCode } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  EmptyState,
  PageHeader,
  Spinner,
  cx,
  formatDate,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';
import { can, useAuthStore } from '../../stores/auth';

/**
 * The outbound dispute desk (SRS v2.7 §11).
 *
 * Every row is a cleared invoice a buyer is refusing to pay, and the only thing
 * that closes one is a corrective credit note. So the primary action on each
 * row is the credit note builder, pre-loaded — the same one-click path the
 * Template E email offers, for the people who work from a queue rather than
 * from their inbox.
 *
 * Aging is shown in days rather than as a date because "opened 62 days ago" is
 * the fact that matters: past 30 days the invoice appears on the §13.2 FTA
 * non-compliance report as unreversed output tax.
 */

interface DisputeItem {
  id: string;
  invoiceNumber: string;
  buyerName: string;
  amountAed: string;
  ftaIrn: string | null;
  responseCode: string | null;
  reasonCode: RejectionReasonCode | null;
  comment: string | null;
  openedAt: string | null;
  resolvedAt: string | null;
  daysOpen: number;
  creditNoteId: string | null;
  creditNoteNumber: string | null;
}

export function DisputesPage() {
  const [state, setState] = useState<'open' | 'resolved'>('open');
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const canCredit = can(user, 'invoice.edit');

  const { data, isLoading } = useQuery({
    queryKey: ['disputes', state],
    queryFn: () => api<{ items: DisputeItem[] }>(`/api/v1/ar/disputes${queryString({ state })}`),
  });

  const overdue = (data?.items ?? []).filter((d) => state === 'open' && d.daysOpen > 30);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customer disputes"
        description="Cleared sales invoices a buyer has queried or rejected over the Peppol network."
        actions={
          <div className="flex rounded-md border border-slate-300 p-0.5">
            {(['open', 'resolved'] as const).map((option) => (
              <button
                key={option}
                onClick={() => setState(option)}
                className={cx(
                  'rounded px-3 py-1 text-sm capitalize transition-colors',
                  state === option
                    ? 'bg-brand-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100',
                )}
              >
                {option}
              </button>
            ))}
          </div>
        }
      />

      {overdue.length > 0 && (
        <Alert kind="danger" title="Unreversed output tax">
          {overdue.length} disputed invoice{overdue.length === 1 ? ' has' : 's have'} been open for
          more than 30 days with no corrective credit note. These appear on the FTA audit
          non-compliance report.
        </Alert>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-6">
            <Spinner label="Loading disputes…" />
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            title={state === 'open' ? 'No open disputes' : 'No resolved disputes'}
            description={
              state === 'open'
                ? 'Buyers have not queried or rejected any of your cleared invoices.'
                : 'Disputes closed by a corrective credit note appear here.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Invoice</th>
                <th className="px-4 py-2 font-medium">Buyer</th>
                <th className="px-4 py-2 text-right font-medium">Amount (AED)</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Reason</th>
                <th className="px-4 py-2 font-medium">
                  {state === 'open' ? 'Open for' : 'Resolved'}
                </th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((dispute) => (
                <tr key={dispute.id}>
                  <td className="px-4 py-2">
                    <Link
                      to={`/invoices/${dispute.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {dispute.invoiceNumber}
                    </Link>
                    {dispute.ftaIrn && (
                      <div className="font-mono text-xs text-slate-400">{dispute.ftaIrn}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-700">{dispute.buyerName}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-800">
                    {formatAmount(dispute.amountAed)}
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {dispute.responseCode
                      ? RESPONSE_CODE_LABELS[
                          dispute.responseCode as keyof typeof RESPONSE_CODE_LABELS
                        ] ?? dispute.responseCode
                      : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {dispute.reasonCode ? (
                      <div>
                        <span className="font-medium text-slate-700">{dispute.reasonCode}</span>{' '}
                        <span className="text-slate-500">
                          {REASON_CODE_LABELS[dispute.reasonCode]}
                        </span>
                        {dispute.comment && (
                          <div className="mt-0.5 max-w-md truncate text-xs italic text-slate-500">
                            “{dispute.comment}”
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {state === 'open' ? (
                      <span
                        className={cx(
                          'tabular-nums',
                          dispute.daysOpen > 30 ? 'font-medium text-danger-700' : 'text-slate-600',
                        )}
                      >
                        {dispute.daysOpen} day{dispute.daysOpen === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-slate-600">{formatDate(dispute.resolvedAt)}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {dispute.creditNoteId ? (
                      <Link
                        to={`/invoices/${dispute.creditNoteId}`}
                        className="text-sm text-brand-700 hover:underline"
                      >
                        {dispute.creditNoteNumber ?? 'Credit note'}
                      </Link>
                    ) : (
                      canCredit && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            navigate(`/ar/credit-notes/new?invoiceId=${dispute.id}`)
                          }
                        >
                          Generate credit note
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
