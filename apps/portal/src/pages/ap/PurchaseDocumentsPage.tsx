import { useQuery } from '@tanstack/react-query';
import type { DocumentListItem } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  EmptyState,
  Pagination,
  Spinner,
  StatePill,
  formatDate,
  inputClass,
  invoiceTypeLabel,
  purchaseStates,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';
import { withOrigin } from '../../lib/navigation';

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

/**
 * Three filters over three questions, matching the three columns.
 *
 * A single status list could only ever answer the last of them, which made the
 * question this desk asks most — "which cleared bills has nobody reviewed?" —
 * impossible to put to it.
 */
const POSTING_STATES: [string, string][] = [
  ['NOT_POSTED', 'Not posted'],
  ['POSTED', 'Posted'],
  ['ON_HOLD', 'On hold'],
  ['BLOCKED', 'Blocked'],
];

const FTA_STATES: [string, string][] = [
  ['cleared', 'Cleared'],
  ['uncleared', 'No IRN'],
];

const VERDICT_STATES: [string, string][] = [
  ['none', 'Not reviewed'],
  ['AB', 'Acknowledged'],
  ['IP', 'In process'],
  ['UQ', 'Under query'],
  ['AP', 'Accepted'],
  ['CA', 'Accepted with conditions'],
  ['RE', 'Rejected'],
];

/** The three verdicts, one per column. */
function StateCells({ document }: { document: DocumentListItem }) {
  const states = purchaseStates(document);
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

export function PurchaseDocumentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [page, setPage] = useState(1);

  const filters = {
    q: searchParams.get('q') ?? '',
    postingState: searchParams.get('postingState') ?? '',
    ftaState: searchParams.get('ftaState') ?? '',
    verdict: searchParams.get('verdict') ?? '',
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

  const { data, isLoading, isFetching, refetch } = useQuery({
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
          {/* A supplier bill can arrive seconds after the page did, so the list
              needs a way to ask again without losing the filters. */}
          <Button size="sm" disabled={isFetching} onClick={() => void refetch()}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Pinned under the navigation, as on the sales list: the filters are
          how you narrow a long list, and scrolling back up to change one was a
          tax on every second look. */}
      <div className="sticky top-28 z-30 -mx-4 bg-slate-50 px-4 pb-3 pt-1">
        <Card>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
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
              value={filters.postingState}
              onChange={(e) => setFilter('postingState', e.target.value)}
              title="Whether the bill has reached your ledger"
            >
              <option value="">Any posting state</option>
              {POSTING_STATES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <select
              className={inputClass}
              value={filters.ftaState}
              onChange={(e) => setFilter('ftaState', e.target.value)}
              title="Whether the supplier filed it with the Federal Tax Authority"
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
              value={filters.verdict}
              onChange={(e) => setFilter('verdict', e.target.value)}
              title="What this desk ruled"
            >
              <option value="">Any verdict</option>
              {VERDICT_STATES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
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

            <div className="grid grid-cols-2 gap-2">
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
          </div>
        </Card>
      </div>

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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Issued</th>
                  <th className="px-4 py-2 font-medium">Supplier</th>
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Supplier TRN</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 text-right font-medium">AED</th>
                  <th className="px-4 py-2 font-medium">PO</th>
                  <th className="px-4 py-2 font-medium">Posting</th>
                  <th className="px-4 py-2 font-medium">FTA</th>
                  <th className="px-4 py-2 font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((document) => (
                  <tr key={document.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {formatDate(document.issueDate)}
                    </td>
                    <td className="max-w-xs truncate px-4 py-2 text-slate-700">
                      {document.counterpartyName}
                      {document.supplierIsProvisional && (
                        <span className="ml-1 text-xs text-warn-700">· provisional</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        to={withOrigin(`/ap/documents/${document.id}`, location)}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {document.invoiceNumber}
                      </Link>
                      <div className="text-xs text-slate-400">
                        {invoiceTypeLabel(document.invoiceType)}
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">
                      {document.counterpartyTrn ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatAmount(document.payableAmount)}{' '}
                      <span className="text-xs text-slate-400">{document.currencyCode}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                      {formatAmount(document.payableAmountAed)}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">
                      {document.poReference || '—'}
                    </td>
                    <StateCells document={document} />
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
            <div className="border-t border-slate-200 px-4 py-2">
              <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
