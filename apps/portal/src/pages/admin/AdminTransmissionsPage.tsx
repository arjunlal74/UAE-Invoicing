import type { PaginatedResult, TransmissionMonitorItem } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatAmount } from '@uae/domain';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Pagination,
  Spinner,
  StatusBadge,
  formatDateTime,
} from '../../components/ui';
import { ApiError, api, queryString } from '../../lib/api';

/**
 * The support desk.
 *
 * When a merchant calls to say an invoice never went through, this screen
 * answers why and offers the one action that helps: retry. It defaults to
 * showing only problems, because a list of everything that worked is noise.
 */
export function AdminTransmissionsPage() {
  const queryClient = useQueryClient();
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);

  const pageSize = 50;

  const { data, isLoading } = useQuery({
    queryKey: ['admin-transmissions', onlyProblems, page],
    queryFn: () =>
      api<PaginatedResult<TransmissionMonitorItem>>(
        `/api/v1/admin/transmissions${queryString({ onlyProblems, page, pageSize })}`,
      ),
    refetchInterval: 20_000,
  });

  const retry = useMutation({
    mutationFn: (invoiceId: string) =>
      api(`/api/v1/admin/transmissions/${invoiceId}/retry`, { method: 'POST' }),
    onSuccess: () => {
      setMessage({ kind: 'ok', text: 'Queued for resubmission.' });
      queryClient.invalidateQueries({ queryKey: ['admin-transmissions'] });
    },
    onError: (err) =>
      setMessage({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'That retry could not be queued.',
      }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Transmissions</h1>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => {
              setOnlyProblems(e.target.checked);
              setPage(1);
            }}
            className="rounded border-slate-300"
          />
          Only show problems
        </label>
      </div>

      {message && <Alert kind={message.kind === 'ok' ? 'ok' : 'danger'}>{message.text}</Alert>}

      <Card>
        <p className="text-sm text-slate-600">
          &ldquo;Problems&rdquo; means invoices rejected by the FTA, invoices that failed our own
          checks, and invoices handed to a provider more than an hour ago with no verdict since.
          The last group is the one that would otherwise go unnoticed until a filing deadline.
        </p>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title={onlyProblems ? 'Nothing needs attention' : 'No transmissions yet'}
            description={
              onlyProblems ? 'Every invoice has either cleared or is still within its window.' : undefined
            }
          />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Tenant</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 text-right font-medium">Attempts</th>
                  <th className="px-4 py-2 text-right font-medium">AED</th>
                  <th className="px-4 py-2 font-medium">Last attempt</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((item) => (
                  <tr key={item.invoiceId} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium">{item.invoiceNumber}</td>
                    <td className="px-4 py-2 text-slate-600">{item.tenantName}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-2 text-slate-500">{item.aspProvider ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{item.attempts}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatAmount(item.payableAmountAed)}
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {formatDateTime(item.lastAttemptAt)}
                      {item.lastError && (
                        <p className="max-w-xs truncate text-xs text-danger-700" title={item.lastError}>
                          {item.lastError}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {item.status !== 'ACCEPTED_BY_FTA' && (
                        <Button
                          size="sm"
                          onClick={() => retry.mutate(item.invoiceId)}
                          disabled={retry.isPending}
                        >
                          Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={setPage}
            />
          </>
        )}
      </div>
    </div>
  );
}
