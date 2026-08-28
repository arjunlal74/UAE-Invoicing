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
  StatePill,
  documentStates,
  statusLabel,
  formatDate,
  inputClass,
  invoiceTypeLabel,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';

/**
 * Three filters over three questions, matching the three columns.
 *
 * The old single "All statuses" list asked all three at once and could answer
 * only the one written last, so "show me everything the FTA cleared" quietly
 * omitted every invoice a customer had since replied to.
 */
const DOCUMENT_STATES: [string, string][] = [
  ['draft', 'Draft'],
  ['approval', 'Awaiting approval'],
  ['ready', 'Ready to submit'],
  ['failed', 'Failed checks'],
  ['filed', 'Filed'],
  ['archived', 'Archived'],
];

const FTA_STATES: [string, string][] = [
  ['unsubmitted', 'Not submitted'],
  ['awaiting', 'Awaiting'],
  ['cleared', 'Cleared'],
  ['rejected', 'Rejected'],
];

const BUYER_STATES: [string, string][] = [
  ['none', 'No reply'],
  ['AB', 'Acknowledged'],
  ['IP', 'In process'],
  ['UQ', 'Under query'],
  ['AP', 'Accepted'],
  ['CA', 'Accepted with conditions'],
  ['RE', 'Rejected'],
];

/**
 * The three verdicts, one per column.
 *
 * A single status column had to pick one of them, and the one it picked was
 * whichever arrived last — which is how an invoice the FTA cleared and the
 * buyer then accepted stopped showing that it had ever cleared.
 */
function StateCells({ invoice }: { invoice: InvoiceListItem }) {
  const states = documentStates(invoice);
  return (
    <>
      <td className="px-4 py-2">
        <StatePill state={states.document} />
      </td>
      <td className="px-4 py-2">
        <StatePill state={states.fta} />
      </td>
      <td className="px-4 py-2">
        <StatePill state={states.buyer} />
      </td>
    </>
  );
}

export function InvoicesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);

  // Filters live in the URL so a support conversation can be "open this link"
  // rather than "click these six things".
  const filters = {
    q: searchParams.get('q') ?? '',
    documentState: searchParams.get('documentState') ?? '',
    ftaState: searchParams.get('ftaState') ?? '',
    buyerState: searchParams.get('buyerState') ?? '',
    dateFrom: searchParams.get('dateFrom') ?? '',
    dateTo: searchParams.get('dateTo') ?? '',
    // No control of its own any more, but still honoured: the dashboard tiles
    // and any link a colleague has already sent point here with a raw status,
    // and dropping the parameter would have turned those into an unfiltered
    // list that looks like it worked. Shown as a chip so it is not invisible.
    status: searchParams.get('status') ?? '',
  };

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
    setPage(1);
  };

  const pageSize = 50;
  const { data, isLoading, isFetching, refetch } = useQuery({
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
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={activeFilters === 0}
            onClick={() => {
              setSearchParams({}, { replace: true });
              setPage(1);
            }}
          >
            {activeFilters > 0
              ? `Clear ${activeFilters} filter${activeFilters === 1 ? '' : 's'}`
              : 'Clear filters'}
          </Button>
          {/* A clearance verdict can land seconds after the page did, so the
              list needs a way to ask again without losing the filters. */}
          <Button size="sm" disabled={isFetching} onClick={() => void refetch()}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Pinned under the navigation: on a list this long the filters are
          how you narrow it, and scrolling back up to change one was a tax on
          every second look. */}
      <div className="sticky top-28 z-30 -mx-4 bg-slate-50 px-4 pb-3 pt-1">
        <Card>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
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
              value={filters.documentState}
              onChange={(e) => setFilter('documentState', e.target.value)}
              title="Where the document sits in your own workflow"
            >
              <option value="">Any document state</option>
              {DOCUMENT_STATES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <select
              className={inputClass}
              value={filters.ftaState}
              onChange={(e) => setFilter('ftaState', e.target.value)}
              title="What the Federal Tax Authority ruled"
            >
              <option value="">Any FTA state</option>
              {FTA_STATES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <select
              className={inputClass}
              value={filters.buyerState}
              onChange={(e) => setFilter('buyerState', e.target.value)}
              title="What the customer said about it"
            >
              <option value="">Any buyer state</option>
              {BUYER_STATES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
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
          </div>
        </Card>
      </div>

      {filters.status && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">Filtered to</span>
          <button
            onClick={() => setFilter('status', '')}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-600 hover:bg-brand-100"
          >
            {statusLabel(filters.status as InvoiceStatus)}
            <span aria-hidden>×</span>
            <span className="sr-only">Remove this filter</span>
          </button>
        </div>
      )}

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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Issued</th>
                  <th className="px-4 py-2 font-medium">Buyer</th>
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Buyer TRN</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 text-right font-medium">AED</th>
                  <th className="px-4 py-2 font-medium">Document</th>
                  <th className="px-4 py-2 font-medium">FTA</th>
                  <th className="px-4 py-2 font-medium">Buyer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((invoice) => (
                  <tr key={invoice.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {formatDate(invoice.issueDate)}
                    </td>
                    <td className="max-w-xs truncate px-4 py-2">{invoice.buyerName}</td>
                    <td className="px-4 py-2">
                      <Link
                        to={`/invoices/${invoice.id}`}
                        className="font-medium text-brand-600 underline"
                      >
                        {invoice.invoiceNumber}
                      </Link>
                      <div className="text-xs text-slate-400">
                        {invoiceTypeLabel(invoice.invoiceType)}
                      </div>
                    </td>
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
                    <StateCells invoice={invoice} />
                  </tr>
                ))}
              </tbody>
              </table>
            </div>

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
