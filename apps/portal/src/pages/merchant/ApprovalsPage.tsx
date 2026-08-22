import type {
  ApprovalDecisionResponse,
  InvoiceListItem,
  PaginatedResult,
} from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Spinner,
  formatDateTime,
  inputClass,
} from '../../components/ui';
import { ApiError, api, queryString } from '../../lib/api';

/**
 * The tax approver's queue (SRS v2.1 §5).
 *
 * Everything an accountant prepares lands here, and releasing it is the only
 * path to the FTA. Approving is deliberately the heavier of the two buttons:
 * rejection is recoverable, filing is not.
 */
export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
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

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api<ApprovalDecisionResponse>(`/api/v1/approvals/${decision}`, {
        method: 'POST',
        body: {
          // No selection means the whole queue, which is the bulk clearance the
          // SRS asks for. An explicit selection narrows it.
          invoiceIds: selected.size > 0 ? [...selected] : undefined,
          note: note.trim() || undefined,
        },
      }),
    onSuccess: (outcome) => {
      setError(null);
      setResult(outcome);
      setSelected(new Set());
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That decision could not be recorded.'),
  });

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const total = items.reduce((sum, item) => sum + Number(item.payableAmountAed), 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Approvals</h1>
        <p className="text-sm text-slate-500">
          Invoices prepared by your team, waiting to be filed with the FTA. You are the only role
          that can release them.
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
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Buyer</th>
                  <th className="px-4 py-2 font-medium">Prepared by</th>
                  <th className="px-4 py-2 text-right font-medium">Amount (AED)</th>
                  <th className="px-4 py-2 font-medium">Prepared</th>
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
                    <td className="px-4 py-2">
                      <Link
                        to={`/invoices/${invoice.id}`}
                        className="font-medium text-brand-600 underline"
                      >
                        {invoice.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      {invoice.buyerName}
                      <div className="font-mono text-xs text-slate-400">{invoice.buyerTrn}</div>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{invoice.createdByName ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {invoice.payableAmountAed}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{formatDateTime(invoice.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Card>
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                {selected.size > 0
                  ? `${selected.size} invoice${selected.size === 1 ? '' : 's'} selected.`
                  : `Nothing selected — this applies to all ${items.length} invoices in the queue, totalling AED ${total.toFixed(2)}.`}
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
                  onClick={() => decide.mutate('approve')}
                >
                  {decide.isPending ? 'Working…' : 'Approve and file with the FTA'}
                </Button>
                <Button
                  variant="danger"
                  disabled={decide.isPending || !note.trim()}
                  onClick={() => decide.mutate('reject')}
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
    </div>
  );
}
