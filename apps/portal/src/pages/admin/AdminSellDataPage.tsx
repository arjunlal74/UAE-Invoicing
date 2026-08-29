import { TENANT_TYPE_LABELS } from '@uae/contracts';
import type { BundleSummary, PaginatedResult, TenantSummary } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ALL_TIME,
  PeriodPicker,
  periodDates,
  periodReady,
  type PeriodChoice,
} from '../../components/PeriodPicker';
import {
  Button,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  Spinner,
  StatusBadge,
  cx,
  formatDate,
  inputBase,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';

/**
 * What the platform has sold — §15.2.
 *
 * The host's own sales only. A channel partner's slice is carved out of a
 * master pool the host already sold to the partner, so listing both would
 * count the same units twice and read as double the business.
 */
export function AdminSellDataPage() {
  const navigate = useNavigate();
  const [tenantId, setTenantId] = useState('');
  const [period, setPeriod] = useState<PeriodChoice>(ALL_TIME);
  const [page, setPage] = useState(1);

  const dates = periodDates(period);
  const pageSize = 50;

  const { data: tenants } = useQuery({
    queryKey: ['admin-tenants-for-sales'],
    queryFn: () => api<PaginatedResult<TenantSummary>>('/api/v1/admin/tenants?pageSize=500'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['admin-bundles', tenantId, dates, page],
    queryFn: () =>
      api<PaginatedResult<BundleSummary>>(
        `/api/v1/admin/bundles${queryString({
          tenantId,
          from: dates.from,
          to: dates.to,
          hostSalesOnly: true,
          page,
          pageSize,
        })}`,
      ),
    enabled: periodReady(period),
  });

  const reset = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };

  // Only the tiers the host sells to directly. A managed sub-tenant buys from
  // its partner, so it can never appear in this list.
  const buyers = (tenants?.items ?? []).filter(
    (tenant) => tenant.tenantType === 'ENTERPRISE_TENANT' || tenant.tenantType === 'CHANNEL_PARTNER',
  );
  const units = (data?.items ?? []).reduce((sum, row) => sum + row.purchasedUnits, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data sales"
        description="Every bundle the platform has issued to a tenant or a channel partner."
        actions={
          <Button variant="primary" onClick={() => navigate('/admin/inventory/sell/new')}>
            New sale
          </Button>
        }
      />

      <Card>
        <div className="flex flex-nowrap items-center gap-3 overflow-x-auto pb-1">
          <select
            className={cx(inputBase, 'w-64 shrink-0')}
            value={tenantId}
            onChange={(e) => reset(setTenantId)(e.target.value)}
          >
            <option value="">All buyers</option>
            {buyers.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.legalNameEn} · {TENANT_TYPE_LABELS[tenant.tenantType]}
              </option>
            ))}
          </select>

          <PeriodPicker label="Sold in" value={period} onChange={reset<PeriodChoice>(setPeriod)} />
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading sales…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title="No sales"
            description="No bundle was issued under these filters."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="px-4 py-2 font-medium">Sold</th>
                    <th className="px-4 py-2 font-medium">Reference</th>
                    <th className="px-4 py-2 font-medium">Buyer</th>
                    <th className="px-4 py-2 text-right font-medium">Units</th>
                    <th className="px-4 py-2 text-right font-medium">Consumed</th>
                    <th className="px-4 py-2 text-right font-medium">Remaining</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Expires</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">
                        {formatDate(row.validFrom)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-700">
                        {row.reference}
                      </td>
                      <td className="px-4 py-2 text-slate-800">
                        {row.tenantName ?? '—'}
                        {/* A partner's pool is the one bundle that gets carved
                            up again, so what it has left to allocate is a
                            different number from what it has left to file. */}
                        {row.allocatedUnits > 0 && (
                          <p className="text-xs text-slate-500">
                            {row.allocatedUnits.toLocaleString()} allocated onward,{' '}
                            {row.unallocatedUnits.toLocaleString()} unallocated
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-800">
                        {row.purchasedUnits.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                        {row.consumedUnits.toLocaleString()}
                      </td>
                      <td
                        className={cx(
                          'px-4 py-2 text-right font-medium tabular-nums',
                          row.belowBuffer ? 'text-danger-700' : 'text-slate-900',
                        )}
                      >
                        {row.remainingUnits.toLocaleString()}
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-500">
                        {row.expiresAt ? formatDate(row.expiresAt) : 'no expiry'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-300">
                  <tr>
                    <td className="px-4 py-2 text-xs font-medium uppercase text-slate-500" colSpan={3}>
                      This page
                    </td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-900">
                      {units.toLocaleString()}
                    </td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
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
