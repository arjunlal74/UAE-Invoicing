import { useQuery } from '@tanstack/react-query';
import { RESPONSE_CODE_LABELS, type DocumentListItem, type InvoiceStatus } from '@uae/contracts';
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
  invoiceTypeLabel,
  statusLabel,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';

/**
 * Every bill a supplier has sent us (SRS v2.7 §12).
 *
 * The inbound counterpart of Sales documents, and deliberately not the
 * verification desk next door. The desk is a queue — unreviewed first, one bill
 * open at a time, three verdicts at the bottom of the pane — and that is the
 * wrong shape for "what did we pay Emirates Trading in March?". This screen
 * answers that one: everything received, searchable, verdict included, and no
 * work to clear.
 */

interface PurchaseListResponse {
  items: DocumentListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** The lifecycle an inbound bill actually travels. */
const STATUSES: InvoiceStatus[] = [
  'INGESTED',
  'ACCEPTED_BY_BUYER',
  'UNDER_QUERY',
  'REJECTED_COMMERCIAL',
  'REJECTED_TECHNICAL',
  'ARCHIVED',
];

export function PurchaseDocumentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);

  const filters = {
    q: searchParams.get('q') ?? '',
    status: searchParams.get('status') ?? '',
    match: searchParams.get('match') ?? '',
    dateFrom: searchParams.get('dateFrom') ?? '',
    dateTo: searchParams.get('dateTo') ?? '',
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
    setPage(1);
  };

  const activeFilters = Object.values(filters).filter(Boolean).length;
  const pageSize = 25;

  const { data, isLoading } = useQuery({
    queryKey: ['ap-documents', filters, page],
    queryFn: () =>
      api<PurchaseListResponse>(
        `/api/v1/ap/invoices${queryString({ ...filters, page, pageSize })}`,
      ),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Purchase documents</h1>
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
            placeholder="Invoice number, supplier, TRN, PO…"
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
                {statusLabel(status)}
              </option>
            ))}
          </select>

          <select
            className={inputClass}
            value={filters.match}
            onChange={(e) => setFilter('match', e.target.value)}
          >
            <option value="">Matched and unmatched</option>
            <option value="matched">Has a purchase order</option>
            <option value="unmatched">No purchase order</option>
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
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading documents…" />
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            title="No purchase documents"
            description={
              activeFilters > 0
                ? 'Nothing matches those filters.'
                : 'Bills your suppliers send over the network arrive here.'
            }
          />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Document</th>
                  <th className="px-4 py-2 font-medium">Supplier</th>
                  <th className="px-4 py-2 font-medium">Issued</th>
                  <th className="px-4 py-2 text-right font-medium">Amount (AED)</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Our verdict</th>
                  <th className="px-4 py-2 font-medium">PO</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((document) => (
                  <tr key={document.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <Link
                        to={`/ap/documents/${document.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {document.invoiceNumber}
                      </Link>
                      <div className="text-xs text-slate-400">
                        {invoiceTypeLabel(document.invoiceType)}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-slate-700">
                      {document.counterpartyName}
                      {document.supplierIsProvisional && (
                        <span className="ml-1 text-xs text-warn-700">· provisional</span>
                      )}
                      <div className="font-mono text-xs text-slate-400">
                        {document.counterpartyTrn ?? '—'}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{formatDate(document.issueDate)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-800">
                      {formatAmount(document.payableAmountAed)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={document.status} />
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {document.latestResponseCode
                        ? RESPONSE_CODE_LABELS[document.latestResponseCode]
                        : 'Not reviewed'}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">
                      {document.poReference || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-slate-200 px-4 py-2">
              <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
