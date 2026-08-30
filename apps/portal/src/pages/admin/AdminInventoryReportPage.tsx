import { TENANT_TYPE_LABELS } from '@uae/contracts';
import type { InventoryStatement, PaginatedResult, TenantSummary, TenantType } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DEFAULT_PERIOD,
  InventoryReportView,
  periodQuery,
  periodReady,
  type PeriodChoice,
} from '../../components/InventoryReportView';
import { PdfActions } from '../../components/PdfActions';
import { Alert, PageHeader, Spinner, cx, inputClass } from '../../components/ui';
import { api } from '../../lib/api';

/**
 * The data inventory statement, host side.
 *
 * The same page reads the platform's own movements and any one account's,
 * because every tier of the hierarchy keeps the same statement: the platform
 * buys and sells, a partner buys and allocates, a tenant buys or is allocated
 * and then consumes. Which is on screen is a route — `/admin/inventory/report`
 * for the platform, `/report/:tenantId` for an account — so any of them can be
 * linked to and sent to the account it describes.
 */

/** The order accounts are grouped in, following the hierarchy down. */
const TIERS: TenantType[] = ['CHANNEL_PARTNER', 'ENTERPRISE_TENANT', 'MANAGED_SUB_TENANT', 'HOST'];

export function AdminInventoryReportPage() {
  const { tenantId } = useParams<{ tenantId?: string }>();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<PeriodChoice>(DEFAULT_PERIOD);

  const { data: tenants } = useQuery({
    queryKey: ['admin-tenants-for-report'],
    queryFn: () => api<PaginatedResult<TenantSummary>>('/api/v1/admin/tenants?pageSize=500'),
  });

  const query = periodQuery(period);
  const reportPath = tenantId
    ? `/api/v1/admin/inventory/report/${tenantId}`
    : '/api/v1/admin/inventory/report';

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-inventory-report', tenantId ?? 'platform', query],
    queryFn: () =>
      api<InventoryStatement>(`${reportPath}?${query}`),
    enabled: periodReady(period),
    // The window changes far more often than the account, and blanking a
    // statement to redraw the same one reads as a fault rather than a load.
    placeholderData: (previous) => previous,
  });

  const accounts = tenants?.items ?? [];

  const scopePicker = (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      Inventory of
      <select
        className={cx(inputClass, 'w-auto max-w-xs')}
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
        {TIERS.map((tier) => {
          const inTier = accounts.filter((account) => account.tenantType === tier);
          if (inTier.length === 0) return null;
          return (
            <optgroup key={tier} label={TENANT_TYPE_LABELS[tier]}>
              {inTier.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.legalNameEn}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data inventory report"
        description="Every movement of units over a window, with the balance each one leaves behind — for this platform or for any account on it."
        actions={
          <PdfActions
            // The exports carry the same window the table is showing, so the
            // file and the screen are the same statement rather than two runs
            // of the same report a few keystrokes apart.
            path={`${reportPath}.pdf?${query}`}
            xlsxPath={`${reportPath}.xlsx?${query}`}
            disabled={!data?.rows.length}
            label="PDF"
          />
        }
      />

      {error ? (
        <Alert kind="danger" title="That statement could not be read">
          The account may no longer exist.
        </Alert>
      ) : isLoading || !data ? (
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
