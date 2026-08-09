import type { InvoiceListItem, InvoiceStatus, PaginatedResult } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { formatAmount } from '@uae/domain';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  EmptyState,
  Pagination,
  Spinner,
  StatusBadge,
  formatDate,
  inputClass,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';

const STATUSES: InvoiceStatus[] = [
  'VALIDATED',
  'SUBMITTED_TO_ASP',
  'ACCEPTED_BY_FTA',
  'REJECTED_BY_FTA',
  'VALIDATION_FAILED',
  'ARCHIVED',
];

export function InvoicesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);

  // Filters live in the URL so a support conversation can be "open this link"
  // rather than "click these six things".
  const filters = {
    q: searchParams.get('q') ?? '',
    status: searchParams.get('status') ?? '',
    dateFrom: searchParams.get('dateFrom') ?? '',
    dateTo: searchParams.get('dateTo') ?? '',
    buyerTrn: searchParams.get('buyerTrn') ?? '',
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
    setPage(1);
  };

  const pageSize = 50;
  const { data, isLoading } = useQuery({
    queryKey: ['invoices', filters, page],
    queryFn: () =>
      api<PaginatedResult<InvoiceListItem>>(
        `/api/v1/invoices${queryString({ ...filters, page, pageSize })}`,
      ),
  });

  const activeFilters = Object.values(filters).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Invoices</h1>
        {activeFilters > 0 && (
          <Button size="sm" onClick={() => setSearchParams({}, { replace: true })}>
            Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
          </Button>
        )}
      </div>

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <input
            className={inputClass}
            placeholder="Invoice number, buyer, TRN, PO…"
            defaultValue={filters.q}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setFilter('q', (e.target as HTMLInputElement).value);
            }}
            onBlur={(e) => setFilter('q', e.target.value)}
          />

          <select
            className={inputClass}
            value={filters.status}
            onChange={(e) => setFilter('status', e.target.value)}
          >
            <option value="">All statuses</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>

          <input
            className={inputClass}
            type="date"
            value={filters.dateFrom}
            onChange={(e) => setFilter('dateFrom', e.target.value)}
            title="Issued on or after"
          />
          <input
            className={inputClass}
            type="date"
            value={filters.dateTo}
            onChange={(e) => setFilter('dateTo', e.target.value)}
            title="Issued on or before"
          />
          <input
            className={inputClass}
            placeholder="Buyer TRN"
            defaultValue={filters.buyerTrn}
            onBlur={(e) => setFilter('buyerTrn', e.target.value)}
          />
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Searching…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title="No invoices found"
            description={
              activeFilters > 0
                ? 'No invoices match these filters.'
                : 'Invoices appear here once a batch has been submitted.'
            }
          />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Issued</th>
                  <th className="px-4 py-2 font-medium">Buyer</th>
                  <th className="px-4 py-2 font-medium">Buyer TRN</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 text-right font-medium">AED</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((invoice) => (
                  <tr key={invoice.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <Link
                        to={`/invoices/${invoice.id}`}
                        className="font-medium text-brand-600 underline"
                      >
                        {invoice.invoiceNumber}
                      </Link>
                      <div className="text-xs text-slate-400">
                        {invoice.invoiceType.replace(/_/g, ' ').toLowerCase()}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{formatDate(invoice.issueDate)}</td>
                    <td className="max-w-xs truncate px-4 py-2">{invoice.buyerName}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">
                      {invoice.buyerTrn ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatAmount(invoice.payableAmount)}{' '}
                      <span className="text-xs text-slate-400">{invoice.currencyCode}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                      {formatAmount(invoice.payableAmountAed)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={invoice.status} />
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
