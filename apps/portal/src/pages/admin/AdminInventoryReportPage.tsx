import type { InventoryReport, PaginatedResult, TenantSummary } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { InventoryReportView } from '../../components/InventoryReportView';
import { Alert, PageHeader, Spinner, cx, inputClass } from '../../components/ui';
import { api } from '../../lib/api';

/**
 * The data inventory report, host side.
 *
 * The same page reads the platform's own ledger and any one channel partner's,
 * because a partner is the platform one level down: it buys the bundles the
 * host sells and sells slices to its own sub-tenants. Which is on screen is a
 * route — `/admin/inventory/report` for the platform, `/report/:tenantId` for a
 * partner — so a partner's report can be linked to and sent to them.
 */
export function AdminInventoryReportPage() {
  const { tenantId } = useParams<{ tenantId?: string }>();
  const navigate = useNavigate();
  const [period, setPeriod] = useState('12');

  const { data: partners } = useQuery({
    queryKey: ['admin-channel-partners'],
    queryFn: () =>
      api<PaginatedResult<TenantSummary>>(
        '/api/v1/admin/tenants?tenantType=CHANNEL_PARTNER&pageSize=200',
      ),
  });

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-inventory-report', tenantId ?? 'platform', period],
    queryFn: () =>
      api<InventoryReport>(
        tenantId
          ? `/api/v1/admin/inventory/report/${tenantId}?period=${period}`
          : `/api/v1/admin/inventory/report?period=${period}`,
      ),
    // The window changes far more often than the scope, and blanking the whole
    // report to re-render the same tables reads as a fault rather than a load.
    placeholderData: (previous) => previous,
  });

  const scopePicker = (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      Inventory of
      <select
        className={cx(inputClass, 'w-auto')}
        value={tenantId ?? ''}
        onChange={(event) =>
          navigate(
            event.target.value
              ? `/admin/inventory/report/${event.target.value}`
              : '/admin/inventory/report',
          )
        }
      >
        <option value="">This platform</option>
        {(partners?.items ?? []).map((partner) => (
          <option key={partner.id} value={partner.id}>
            {partner.legalNameEn}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data inventory report"
        description="Units in and units out over a window: what was bought, what was sold on, and what the movement leaves on the shelf."
      />

      {error ? (
        <Alert kind="danger" title="That report could not be read">
          The account may not be a channel partner, or may no longer exist.
        </Alert>
      ) : isLoading || !data ? (
        <Spinner label="Loading report…" />
      ) : (
        <>
          {data.scope === 'PARTNER' && (
            <Alert kind="info">
              <strong>{data.holderName}</strong> — bundles this partner bought from the platform,
              and the slices it sold on to its own sub-tenants.
            </Alert>
          )}
          <InventoryReportView
            report={data}
            period={period}
            onPeriod={setPeriod}
            scopePicker={scopePicker}
            isFetching={isFetching}
          />
        </>
      )}
    </div>
  );
}
