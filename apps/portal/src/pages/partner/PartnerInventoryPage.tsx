import type { InventoryStatement, PaginatedResult, SubTenantSummary } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  DEFAULT_PERIOD,
  InventoryReportView,
  periodQuery,
  periodReady,
  type PeriodChoice,
} from '../../components/InventoryReportView';
import { PdfActions } from '../../components/PdfActions';
import { PageHeader, Spinner, cx, inputClass } from '../../components/ui';
import { api } from '../../lib/api';

/**
 * A channel partner's data inventory statement, and its clients'.
 *
 * The same statement the platform reads about this partner, rendered by the
 * same component — so what "allocated" means here and what it means on the
 * host's copy cannot drift apart. A partner may also read one of its own
 * sub-tenants', which is its book of business; the API enforces the parent
 * check, this picker only offers what it already knows about.
 */
export function PartnerInventoryPage() {
  const [period, setPeriod] = useState<PeriodChoice>(DEFAULT_PERIOD);
  const [tenantId, setTenantId] = useState('');

  const { data: subTenants } = useQuery({
    queryKey: ['partner-sub-tenants', ''],
    queryFn: () => api<PaginatedResult<SubTenantSummary>>('/api/v1/partner/sub-tenants'),
  });

  const query = periodQuery(period);
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['partner-inventory-report', tenantId || 'self', query],
    queryFn: () =>
      api<InventoryStatement>(
        `/api/v1/partner/inventory/report?${query}${tenantId ? `&tenantId=${tenantId}` : ''}`,
      ),
    enabled: periodReady(period),
    placeholderData: (previous) => previous,
  });

  const scopePicker = (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      Inventory of
      <select
        className={cx(inputClass, 'w-auto max-w-xs')}
        value={tenantId}
        onChange={(event) => setTenantId(event.target.value)}
      >
        <option value="">My own pools</option>
        {(subTenants?.items ?? []).map((sub) => (
          <option key={sub.id} value={sub.id}>
            {sub.legalNameEn}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data inventory"
        description="What you bought from the platform, what you allocated to your clients, and the balance each movement left behind."
        actions={
          <PdfActions
            path={`/api/v1/partner/inventory/report.pdf?${query}${tenantId ? `&tenantId=${tenantId}` : ''}`}
            xlsxPath={`/api/v1/partner/inventory/report.xlsx?${query}${tenantId ? `&tenantId=${tenantId}` : ''}`}
            disabled={!data?.rows.length}
            label="PDF"
          />
        }
      />

      {isLoading || !data ? (
        <Spinner label="Loading statement…" />
      ) : (
        <InventoryReportView
          statement={data}
          period={period}
          onPeriod={setPeriod}
          scopePicker={scopePicker}
          isFetching={isFetching}
        />
      )}
    </div>
  );
}
