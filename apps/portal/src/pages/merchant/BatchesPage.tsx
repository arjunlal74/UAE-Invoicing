import type { BatchSummary, PaginatedResult } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  EmptyState,
  Pagination,
  Spinner,
  StatusBadge,
  cx,
  formatDateTime,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';

export function BatchesPage() {
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { data, isLoading } = useQuery({
    queryKey: ['batches', page],
    queryFn: () =>
      api<PaginatedResult<BatchSummary>>(`/api/v1/batches${queryString({ page, pageSize })}`),
    // Keep the list live while anything is still being read.
    refetchInterval: (query) =>
      query.state.data?.items.some((b) => b.status === 'UPLOADED' || b.status === 'PARSING')
        ? 2_000
        : false,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Batches</h1>
        <Link to="/upload">
          <Button variant="primary">Upload invoices</Button>
        </Link>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title="No uploads yet"
            description="Download the template, fill it in, and upload it to get started."
            action={
              <Link to="/upload">
                <Button variant="primary">Upload invoices</Button>
              </Link>
            }
          />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Reference</th>
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 text-right font-medium">Invoices</th>
                  <th className="px-4 py-2 text-right font-medium">Valid</th>
                  <th className="px-4 py-2 text-right font-medium">Errors</th>
                  <th className="px-4 py-2 text-right font-medium">Submitted</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Uploaded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((batch) => (
                  <tr key={batch.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <Link
                        to={`/batches/${batch.id}`}
                        className="font-medium text-brand-600 underline"
                      >
                        {batch.reference}
                      </Link>
                    </td>
                    <td className="max-w-xs truncate px-4 py-2 text-slate-600">
                      {batch.fileName}
                      {batch.parseError && (
                        <span className="block text-xs text-danger-700">{batch.parseError}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{batch.totalRecords}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ok-700">
                      {batch.validRecords}
                    </td>
                    <td
                      className={cx(
                        'px-4 py-2 text-right tabular-nums',
                        batch.invalidRecords > 0
                          ? 'font-medium text-danger-700'
                          : 'text-slate-400',
                      )}
                    >
                      {batch.invalidRecords}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                      {batch.submittedRecords}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={batch.status} />
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {formatDateTime(batch.createdAt)}
                      {batch.uploadedByName && (
                        <span className="block text-xs text-slate-400">
                          {batch.uploadedByName}
                        </span>
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
