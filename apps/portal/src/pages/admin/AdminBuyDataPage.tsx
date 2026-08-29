import type { PaginatedResult, ProcurementSummary, ProviderSummary } from '@uae/contracts';
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
  cx,
  formatDate,
  inputBase,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';

/**
 * What the platform has bought — §15.1.
 *
 * The console shows the most recent contracts as context for its balances;
 * this is the book itself, narrowed by provider and by when the contract was
 * signed. Registering a new one is a separate screen rather than a dialog over
 * this list, because it is a form with money in it.
 */
export function AdminBuyDataPage() {
  const navigate = useNavigate();
  const [providerId, setProviderId] = useState('');
  const [period, setPeriod] = useState<PeriodChoice>(ALL_TIME);
  const [page, setPage] = useState(1);

  const dates = periodDates(period);
  const pageSize = 50;

  // Retired providers included: a contract signed years ago belongs to whoever
  // signed it, and filtering this list by them must stay possible.
  const { data: providers } = useQuery({
    queryKey: ['asp-providers', 'picker'],
    queryFn: () =>
      api<{ items: ProviderSummary[] }>('/api/v1/admin/providers?includeInactive=true'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['admin-procurements', providerId, dates, page],
    queryFn: () =>
      api<PaginatedResult<ProcurementSummary>>(
        `/api/v1/admin/procurements${queryString({
          aspProviderId: providerId,
          from: dates.from,
          to: dates.to,
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

  const units = (data?.items ?? []).reduce((sum, row) => sum + row.totalUnits, 0);
  const spend = (data?.items ?? []).reduce((sum, row) => sum + Number(row.totalCostAed), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data purchases"
        description="Every contract the platform has bought capacity on, and what it paid."
        actions={
          <Button variant="primary" onClick={() => navigate('/admin/inventory/buy/new')}>
            New purchase
          </Button>
        }
      />

      <Card>
        <div className="flex flex-nowrap items-center gap-3 overflow-x-auto pb-1">
          <select
            className={cx(inputBase, 'w-64 shrink-0')}
            value={providerId}
            onChange={(e) => reset(setProviderId)(e.target.value)}
          >
            <option value="">All providers</option>
            {(providers?.items ?? []).map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
                {provider.isActive ? '' : ' (retired)'}
              </option>
            ))}
          </select>

          <PeriodPicker
            label="Purchased in"
            value={period}
            onChange={reset<PeriodChoice>(setPeriod)}
          />
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading purchases…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title="No purchases"
            description="Nothing was bought under these filters. The platform cannot sell units it has not bought."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="px-4 py-2 font-medium">Purchased</th>
                    <th className="px-4 py-2 font-medium">Contract</th>
                    <th className="px-4 py-2 font-medium">Provider</th>
                    <th className="px-4 py-2 text-right font-medium">Units</th>
                    <th className="px-4 py-2 text-right font-medium">Rate (AED)</th>
                    <th className="px-4 py-2 text-right font-medium">Cost (AED)</th>
                    <th className="px-4 py-2 text-right font-medium">Sold on</th>
                    <th className="px-4 py-2 text-right font-medium">Unsold</th>
                    <th className="px-4 py-2 font-medium">Expires</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">
                        {formatDate(row.purchaseDate)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-700">
                        {row.contractReference}
                      </td>
                      <td className="px-4 py-2 text-slate-800">{row.aspProviderName}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-800">
                        {row.totalUnits.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                        {Number(row.costPerUnitAed).toFixed(4)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                        {Number(row.totalCostAed).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                        {row.allocatedUnits.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                        {row.remainingUnits.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-500">
                        {row.expiryDate ? formatDate(row.expiryDate) : 'no expiry'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* This page's rows, not the whole book: a total under a
                    paginated table that counted rows you cannot see would be a
                    number with no column behind it. */}
                <tfoot className="border-t-2 border-slate-300">
                  <tr>
                    <td className="px-4 py-2 text-xs font-medium uppercase text-slate-500" colSpan={3}>
                      This page
                    </td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-900">
                      {units.toLocaleString()}
                    </td>
                    <td />
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-900">
                      {spend.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td colSpan={3} />
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
