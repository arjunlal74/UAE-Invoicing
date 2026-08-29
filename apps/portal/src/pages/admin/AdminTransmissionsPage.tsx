import { DIRECTION_SHORT, InvoiceStatus } from '@uae/contracts';
import type {
  InvoiceDirection,
  PaginatedResult,
  TenantSummary,
  TransmissionMonitorItem,
} from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { formatAmount } from '@uae/domain';
import { useState } from 'react';
import {
  ALL_TIME,
  PeriodPicker,
  periodDates,
  periodReady,
  type PeriodChoice,
} from '../../components/PeriodPicker';
import {
  Card,
  EmptyState,
  Pagination,
  Spinner,
  StatusBadge,
  cx,
  formatDate,
  formatDateTime,
  inputBase,
  statusLabel,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';

/**
 * The transmission monitor.
 *
 * A window onto what every account has filed and what came back of it, in both
 * directions — outbound sales handed to a provider for clearance, and inbound
 * purchase documents received. Read-only by design: when a merchant calls, the
 * platform's job here is to say what happened, not to reach into their filing
 * and act on their behalf.
 */
/**
 * Where the filters start once the reader takes the wheel: the question asked
 * most often, which is what our own tenants sent out and had refused recently.
 */
const DEFAULTS = {
  tenantId: '',
  direction: 'OUTBOUND_SALES_AR',
  status: 'REJECTED_BY_FTA',
  period: { preset: '3', from: '', to: '' } as PeriodChoice,
};

/** Every filter wide open, which is what "only show problems" runs against. */
const UNFILTERED = { tenantId: '', direction: '', status: '', period: ALL_TIME };

export function AdminTransmissionsPage() {
  // Problems first, and while that switch is on the filters are held open and
  // disabled: the point of it is "show me everything that went wrong", and a
  // filter left over from a previous question would quietly hide some of it.
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [tenantId, setTenantId] = useState(UNFILTERED.tenantId);
  const [status, setStatus] = useState(UNFILTERED.status);
  const [direction, setDirection] = useState(UNFILTERED.direction);
  const [period, setPeriod] = useState<PeriodChoice>(UNFILTERED.period);
  const [page, setPage] = useState(1);

  const pageSize = 50;
  const dates = periodDates(period);

  const { data: tenants } = useQuery({
    queryKey: ['admin-tenants-for-transmissions'],
    queryFn: () => api<PaginatedResult<TenantSummary>>('/api/v1/admin/tenants?pageSize=500'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['admin-transmissions', onlyProblems, tenantId, status, direction, dates, page],
    queryFn: () =>
      api<PaginatedResult<TransmissionMonitorItem>>(
        `/api/v1/admin/transmissions${queryString({
          onlyProblems,
          tenantId,
          status,
          direction,
          dateFrom: dates.from,
          dateTo: dates.to,
          page,
          pageSize,
        })}`,
      ),
    enabled: periodReady(period),
    refetchInterval: 20_000,
  });

  /** Any filter change invalidates the page number that was read under the old one. */
  const reset = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };

  /** The switch owns the filters: on, it opens them; off, it hands them back. */
  const toggleProblems = (checked: boolean) => {
    const next = checked ? UNFILTERED : DEFAULTS;
    setOnlyProblems(checked);
    setTenantId(next.tenantId);
    setDirection(next.direction);
    setStatus(next.status);
    setPeriod(next.period);
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Transmissions</h1>

      <Card>
        <div className="space-y-3">
          {/* One row, and it stays one row: the controls are sized rather than
              left to their content, and a narrow window scrolls this strip
              sideways instead of stacking it into a wall of selects. */}
          <div className="flex flex-nowrap items-center gap-3 overflow-x-auto pb-1">
            <select
              className={cx(inputBase, 'w-52 shrink-0')}
              value={tenantId}
              disabled={onlyProblems}
              onChange={(e) => reset(setTenantId)(e.target.value)}
            >
              <option value="">All accounts</option>
              {/* A channel partner resells capacity and files nothing itself,
                  so it would only ever be an empty answer in this list. */}
              {(tenants?.items ?? [])
                .filter((tenant) => tenant.tenantType !== 'CHANNEL_PARTNER')
                .map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.legalNameEn}
                  </option>
                ))}
            </select>

            <select
              className={cx(inputBase, 'w-44 shrink-0')}
              value={direction}
              disabled={onlyProblems}
              onChange={(e) => reset(setDirection)(e.target.value)}
            >
              <option value="">Both directions</option>
              <option value="OUTBOUND_SALES_AR">Outbound sales (AR)</option>
              <option value="INBOUND_PURCHASE_AP">Inbound purchases (AP)</option>
            </select>

            <select
              className={cx(inputBase, 'w-44 shrink-0')}
              value={status}
              disabled={onlyProblems}
              onChange={(e) => reset(setStatus)(e.target.value)}
            >
              <option value="">Any status</option>
              {InvoiceStatus.options.map((option) => (
                <option key={option} value={option}>
                  {statusLabel(option)}
                </option>
              ))}
            </select>

            <PeriodPicker
              label="Issued in"
              value={period}
              disabled={onlyProblems}
              onChange={reset<PeriodChoice>(setPeriod)}
            />

            <label className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-sm text-slate-600">
              <input
                type="checkbox"
                checked={onlyProblems}
                onChange={(e) => toggleProblems(e.target.checked)}
                className="rounded border-slate-300"
              />
              Only show problems
            </label>
          </div>

          <p className="text-sm text-slate-600">
            &ldquo;Problems&rdquo; means every refusal — by the FTA, by the network, by the buyer —
            invoices that failed our own checks, and invoices handed to a provider more than an
            hour ago with no verdict since. The last group is the one that would otherwise go
            unnoticed until a filing deadline. The filters are held open while it is ticked, so
            nothing that went wrong is left out; untick it to ask a narrower question.
          </p>
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title={onlyProblems ? 'Nothing needs attention' : 'No transmissions match'}
            description={
              onlyProblems
                ? 'Every invoice has either cleared or is still within its window.'
                : 'No document on this platform answers to those filters.'
            }
          />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Direction</th>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Issued</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 text-right font-medium">Attempts</th>
                  <th className="px-4 py-2 text-right font-medium">AED</th>
                  <th className="px-4 py-2 font-medium">Last attempt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((item) => (
                  <tr key={item.invoiceId} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium">{item.invoiceNumber}</td>
                    <td className="px-4 py-2">
                      <span
                        className={cx(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          item.direction === 'OUTBOUND_SALES_AR'
                            ? 'bg-brand-50 text-brand-700'
                            : 'bg-slate-100 text-slate-600',
                        )}
                      >
                        {DIRECTION_SHORT[item.direction as InvoiceDirection]}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{item.tenantName}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs text-slate-500">
                      {formatDate(item.issueDate)}
                    </td>
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
                        <p
                          className="max-w-xs truncate text-xs text-danger-700"
                          title={item.lastError}
                        >
                          {item.lastError}
                        </p>
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
