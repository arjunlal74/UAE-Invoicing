import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatAmount } from '@uae/domain';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button,
  EmptyState,
  PageHeader,
  Spinner,
  formatDateTime,
  invoiceTypeLabel,
} from '../../components/ui';
import { api } from '../../lib/api';

/**
 * Documents composed in the browser and not yet submitted (SRS v2.7 §7).
 *
 * A draft consumes no quota and has been filed with nobody, so it is the one
 * document state in the platform that can genuinely be deleted rather than
 * archived — which is why this screen offers a discard button and no other
 * screen does.
 */

interface DraftListItem {
  id: string;
  invoiceNumber: string;
  invoiceType: string;
  issueDate: string;
  buyerName: string;
  payableAmount: string;
  currencyCode: string;
  referencedInvoiceNumber: string | null;
  createdByName: string | null;
  updatedAt: string;
}

export function DraftsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['drafts'],
    queryFn: () => api<{ items: DraftListItem[] }>('/api/v1/ar/drafts'),
  });

  const discard = useMutation({
    mutationFn: (id: string) => api(`/api/v1/ar/drafts/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['drafts'] }),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Drafts"
        description="Invoices and credit notes composed in the builder but not yet submitted."
        actions={
          <>
            <Button onClick={() => navigate('/ar/credit-notes/new')}>New credit note</Button>
            <Button variant="primary" onClick={() => navigate('/ar/new-invoice')}>
              New invoice
            </Button>
          </>
        }
      />

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-6">
            <Spinner label="Loading drafts…" />
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            title="No drafts"
            description="Anything you save in the invoice or credit note builder appears here until it is submitted."
            action={
              <Button variant="primary" onClick={() => navigate('/ar/new-invoice')}>
                Create an invoice
              </Button>
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Number</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Buyer</th>
                <th className="px-4 py-2 font-medium">Corrects</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Last saved</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((draft) => (
                <tr key={draft.id}>
                  <td className="px-4 py-2">
                    <Link
                      to={`/ar/drafts/${draft.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {draft.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {invoiceTypeLabel(draft.invoiceType)}
                  </td>
                  <td className="px-4 py-2 text-slate-700">{draft.buyerName || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">
                    {draft.referencedInvoiceNumber ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-800">
                    {draft.currencyCode} {formatAmount(draft.payableAmount)}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{formatDateTime(draft.updatedAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" onClick={() => navigate(`/ar/drafts/${draft.id}`)}>
                        Open
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={discard.isPending}
                        onClick={() => discard.mutate(draft.id)}
                      >
                        Discard
                      </Button>
                    </div>
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
