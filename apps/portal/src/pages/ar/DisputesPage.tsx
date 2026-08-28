import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { REASON_CODE_LABELS, RESPONSE_CODE_LABELS, type RejectionReasonCode } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  EmptyState,
  Modal,
  PageHeader,
  Spinner,
  cx,
  formatDate,
  inputClass,
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
  conditionMet: boolean;
  conditionMetAt: string | null;
  conditionMetNote: string | null;
}

const STATES = ['open', 'resolved', 'conditions'] as const;
type DisputeState = (typeof STATES)[number];

const STATE_LABELS: Record<DisputeState, string> = {
  open: 'Open',
  resolved: 'Resolved',
  conditions: 'Conditions',
};

export function DisputesPage() {
  // In the URL rather than in component state: the dashboard tiles link
  // straight to a list, and a link that lands on the wrong one is how the
  // conditional-acceptance tile came to point at a page it was filtered out of.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('state') as DisputeState | null;
  const state: DisputeState = requested && STATES.includes(requested) ? requested : 'open';
  const setState = (next: DisputeState) => setSearchParams(next === 'open' ? {} : { state: next });

  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const canCredit = can(user, 'invoice.edit');
  const [signingOff, setSigningOff] = useState<DisputeItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['disputes', state],
    queryFn: () => api<{ items: DisputeItem[] }>(`/api/v1/ar/disputes${queryString({ state })}`),
  });

  const overdue = (data?.items ?? []).filter((d) => state === 'open' && d.daysOpen > 30);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customer responses"
        description={
          state === 'conditions'
            ? 'Invoices a buyer accepted subject to a condition. The invoice is settled; the condition is not.'
            : 'Cleared sales invoices a buyer has queried or rejected over the Peppol network.'
        }
        actions={
          <div className="flex rounded-md border border-slate-300 p-0.5">
            {STATES.map((option) => (
              <button
                key={option}
                onClick={() => setState(option)}
                className={cx(
                  'rounded px-3 py-1 text-sm transition-colors',
                  state === option
                    ? 'bg-brand-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100',
                )}
              >
                {STATE_LABELS[option]}
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
            title={
              state === 'open'
                ? 'No open disputes'
                : state === 'resolved'
                  ? 'No resolved disputes'
                  : 'No outstanding conditions'
            }
            description={
              state === 'open'
                ? 'Buyers have not queried or rejected any of your cleared invoices.'
                : state === 'resolved'
                  ? 'Disputes closed by a corrective credit note appear here.'
                  : 'Every conditional acceptance has been signed off.'
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
                  {state === 'open' ? 'Open for' : state === 'resolved' ? 'Resolved' : 'Outstanding'}
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
                    {state === 'resolved' ? (
                      <span className="text-slate-600">{formatDate(dispute.resolvedAt)}</span>
                    ) : (
                      <span
                        className={cx(
                          'tabular-nums',
                          dispute.daysOpen > 30 ? 'font-medium text-danger-700' : 'text-slate-600',
                        )}
                      >
                        {dispute.daysOpen} day{dispute.daysOpen === 1 ? '' : 's'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {state === 'conditions' ? (
                      canCredit && (
                        <Button size="sm" variant="primary" onClick={() => setSigningOff(dispute)}>
                          Mark condition met
                        </Button>
                      )
                    ) : dispute.creditNoteId ? (
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

      {signingOff && (
        <SignOffModal
          dispute={signingOff}
          onClose={() => setSigningOff(null)}
        />
      )}
    </div>
  );
}

/**
 * Signing off a conditional acceptance.
 *
 * The note is optional but pressed for: six months on, "why was this condition
 * closed?" is answerable only from what somebody typed here — the buyer's half
 * of the exchange is on the invoice, ours is nowhere else.
 */
function SignOffModal({ dispute, onClose }: { dispute: DisputeItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const signOff = useMutation({
    mutationFn: () =>
      api(`/api/v1/ar/disputes/${dispute.id}/condition-met`, {
        method: 'POST',
        body: { note: note.trim() || undefined },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['disputes'] });
      // The dashboard tile counts the same rows; leaving it stale would show a
      // number the desk has just worked off.
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
  });

  return (
    <Modal
      title={`Condition on ${dispute.invoiceNumber}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => signOff.mutate()} disabled={signOff.isPending}>
            {signOff.isPending ? 'Saving…' : 'Mark condition met'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">The buyer asked for</div>
          <p className="mt-1 rounded bg-slate-50 p-3 text-sm italic text-slate-700">
            {dispute.comment ? `“${dispute.comment}”` : 'No condition was recorded with the acceptance.'}
          </p>
        </div>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">What was done</span>
          <textarea
            className={`${inputClass} mt-1 h-24`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Replacement delivered 12 Aug, GRN 44821."
          />
          <span className="mt-1 block text-xs text-slate-500">
            Optional, but it is the only record of how the condition was settled.
          </span>
        </label>

        {signOff.isError && (
          <Alert kind="danger">That condition could not be signed off. Refresh and try again.</Alert>
        )}
      </div>
    </Modal>
  );
}
