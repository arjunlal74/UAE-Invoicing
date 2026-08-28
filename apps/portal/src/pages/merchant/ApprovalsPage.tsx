import type {
  ApprovalDecisionResponse,
  InvoiceListItem,
  PaginatedResult,
} from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatAmount } from '@uae/domain';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Modal,
  Spinner,
  formatDateTime,
  inputClass,
} from '../../components/ui';
import { ApiError, api, queryString } from '../../lib/api';
import { withOrigin } from '../../lib/navigation';

/**
 * The tax approver's queue (SRS v2.1 §5).
 *
 * Everything an accountant prepares lands here, and releasing it is the only
 * path to the FTA.
 *
 * Two ways to rule, for two genuinely different jobs. A single invoice somebody
 * wants to read before releasing is decided on the document itself, at the foot
 * of the page. A run of near-identical invoices is cleared from here — but
 * never in one unguarded click, because filing is the approver attesting to
 * what is on every one of them and there is no unfiling.
 */
export function ApprovalsPage() {
  const location = useLocation();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApprovalDecisionResponse | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['approvals'],
    queryFn: () =>
      api<PaginatedResult<InvoiceListItem>>(
        `/api/v1/invoices${queryString({ status: 'PENDING_CFO_APPROVAL', pageSize: 200 })}`,
      ),
  });

  const items = data?.items ?? [];
  const allSelected = items.length > 0 && selected.size === items.length;

  // No selection means the whole queue, which is the bulk clearance the SRS
  // asks for. An explicit selection narrows it. Either way the confirmation
  // below is shown the same list the server will act on.
  const affected = selected.size > 0 ? items.filter((i) => selected.has(i.id)) : items;
  const total = affected.reduce((sum, item) => sum + Number(item.payableAmountAed), 0);
  const vat = affected.reduce((sum, item) => sum + Number(item.vatTotalAmount), 0);

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api<ApprovalDecisionResponse>(`/api/v1/approvals/${decision}`, {
        method: 'POST',
        body: {
          invoiceIds: selected.size > 0 ? [...selected] : undefined,
          note: note.trim() || undefined,
        },
      }),
    onSuccess: (outcome) => {
      setError(null);
      setResult(outcome);
      setSelected(new Set());
      setNote('');
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => {
      setConfirming(null);
      setError(err instanceof ApiError ? err.message : 'That decision could not be recorded.');
    },
  });

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Approvals</h1>
        <p className="text-sm text-slate-500">
          Invoices prepared by your team, waiting to be filed with the FTA. Open one to read it and
          rule on it, or clear a run of them from here — you are the only role that can release
          them.
        </p>
      </div>

      {error && <Alert kind="danger">{error}</Alert>}

      {result && (
        <Alert kind={result.affected > 0 ? 'ok' : 'warn'}>
          {result.affected} invoice{result.affected === 1 ? '' : 's'} processed
          {result.skipped > 0 && `, ${result.skipped} skipped`}.
          {result.reasons.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-xs">
              {result.reasons.map((reason) => (
                <li key={reason.invoiceId}>{reason.reason}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      {isLoading ? (
        <Card>
          <Spinner label="Loading the approval queue…" />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing awaiting approval"
          description="Invoices your team submits for approval will appear here."
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="w-10 px-4 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select every invoice"
                        checked={allSelected}
                        onChange={() =>
                          setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))
                        }
                      />
                    </th>
                    <th className="px-4 py-2 font-medium">Prepared</th>
                    <th className="px-4 py-2 font-medium">Buyer</th>
                    <th className="px-4 py-2 font-medium">Invoice</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2 text-right font-medium">VAT</th>
                    <th className="px-4 py-2 text-right font-medium">Total (AED)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((invoice) => (
                    <tr key={invoice.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${invoice.invoiceNumber}`}
                          checked={selected.has(invoice.id)}
                          onChange={() => toggle(invoice.id)}
                        />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                        {formatDateTime(invoice.createdAt)}
                      </td>
                      <td className="px-4 py-2">
                        {invoice.buyerName}
                        <div className="font-mono text-xs text-slate-400">{invoice.buyerTrn}</div>
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          to={withOrigin(`/invoices/${invoice.id}`, location)}
                          className="font-medium text-brand-600 underline"
                        >
                          {invoice.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatAmount(invoice.taxExclusiveAmount)}{' '}
                        <span className="text-xs text-slate-400">{invoice.currencyCode}</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                        {formatAmount(invoice.vatTotalAmount)}
                      </td>
                      <td className="px-4 py-2 text-right font-medium tabular-nums">
                        {formatAmount(invoice.payableAmountAed)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <Card>
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                {selected.size > 0
                  ? `${selected.size} invoice${selected.size === 1 ? '' : 's'} selected.`
                  : `Nothing selected — this applies to all ${items.length} invoices in the queue.`}{' '}
                <span className="text-slate-500">
                  AED {formatAmount(String(total))}, including AED {formatAmount(String(vat))} of
                  VAT.
                </span>
              </p>

              <input
                className={inputClass}
                placeholder="Note (required when returning invoices to the preparer)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
              />

              <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
                <Button
                  variant="primary"
                  disabled={decide.isPending}
                  onClick={() => setConfirming('approve')}
                >
                  Approve and file with the FTA
                </Button>
                <Button
                  variant="danger"
                  disabled={decide.isPending || !note.trim()}
                  onClick={() => setConfirming('reject')}
                >
                  Return to preparer
                </Button>
                <p className="text-xs text-slate-500">
                  Returned invoices are withdrawn and their staged rows reopen for correction.
                </p>
              </div>
            </div>
          </Card>
        </>
      )}

      {confirming && (
        <ConfirmDecision
          decision={confirming}
          invoices={affected}
          total={total}
          vat={vat}
          note={note}
          pending={decide.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => decide.mutate(confirming)}
        />
      )}
    </div>
  );
}

/**
 * The step between the button and the filing.
 *
 * Approving in bulk is the one action on this screen that cannot be taken back
 * — a filed invoice is filed, and the only remedy is a credit note against it —
 * so the dialog names what is about to happen in figures and lists the
 * documents rather than a count. Returning is recoverable and gets the same
 * dialog for consistency, worded without the alarm.
 */
function ConfirmDecision({
  decision,
  invoices,
  total,
  vat,
  note,
  pending,
  onCancel,
  onConfirm,
}: {
  decision: 'approve' | 'reject';
  invoices: InvoiceListItem[];
  total: number;
  vat: number;
  note: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const approving = decision === 'approve';
  const count = `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`;

  return (
    <Modal
      title={approving ? 'File these invoices with the FTA?' : 'Return these to the preparer?'}
      onClose={onCancel}
      width="lg"
      // The figures on this dialog are the whole point of it; a stray click on
      // the backdrop must not be what files them.
      dismissOnBackdrop={false}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={approving ? 'primary' : 'danger'} disabled={pending} onClick={onConfirm}>
            {pending ? 'Working…' : approving ? `File ${count}` : `Return ${count}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {approving ? (
          <Alert kind="warn" title="This cannot be undone">
            Filing submits these invoices to the Federal Tax Authority in your company&apos;s name.
            A filed invoice cannot be withdrawn or edited — correcting one afterwards means issuing
            a credit note against it.
          </Alert>
        ) : (
          <Alert kind="info" title="The preparer can correct and resubmit">
            These are withdrawn from the queue and their staged rows reopen. Nothing is sent to the
            FTA.
          </Alert>
        )}

        <dl className="grid grid-cols-3 gap-4 rounded-lg border border-slate-200 p-3 text-sm">
          <div>
            <dt className="text-xs font-medium text-slate-500">Invoices</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{invoices.length}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-500">VAT</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">
              {formatAmount(String(vat))}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-500">Total (AED)</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">
              {formatAmount(String(total))}
            </dd>
          </div>
        </dl>

        {!approving && note.trim() && (
          <div>
            <div className="text-xs font-medium text-slate-500">Your note to the preparer</div>
            <p className="mt-1 rounded bg-slate-50 p-2 text-sm italic text-slate-700">
              “{note.trim()}”
            </p>
          </div>
        )}

        <div>
          <div className="mb-1 text-xs font-medium text-slate-500">
            {approving ? 'To be filed' : 'To be returned'}
          </div>
          <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
            {invoices.map((invoice) => (
              <li key={invoice.id} className="flex justify-between gap-4 px-3 py-1.5 text-sm">
                <span className="font-medium">{invoice.invoiceNumber}</span>
                <span className="truncate text-slate-500">{invoice.buyerName}</span>
                <span className="tabular-nums text-slate-700">
                  {formatAmount(invoice.payableAmountAed)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
