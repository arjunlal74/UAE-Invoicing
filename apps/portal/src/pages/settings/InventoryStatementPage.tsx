import type { InventoryStatement } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  DEFAULT_PERIOD,
  InventoryReportView,
  periodQuery,
  periodReady,
  type PeriodChoice,
} from '../../components/InventoryReportView';
import { PageHeader, Spinner } from '../../components/ui';
import { api } from '../../lib/api';

/**
 * An account's own data inventory statement.
 *
 * The same statement the platform reads about this account, and the same one a
 * channel partner reads about its clients — one component and one endpoint, so
 * a tenant disputing a balance and the host answering the dispute are looking
 * at the same rows.
 *
 * A direct tenant buys its units; a managed sub-tenant is allocated them by its
 * partner. Both then consume by filing, which is what the outgoing column
 * counts, one document at a time.
 */
export function InventoryStatementPage() {
  const [period, setPeriod] = useState<PeriodChoice>(DEFAULT_PERIOD);

  const query = periodQuery(period);
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['tenant-inventory-report', query],
    queryFn: () => api<InventoryStatement>(`/api/v1/billing/inventory/report?${query}`),
    enabled: periodReady(period),
    placeholderData: (previous) => previous,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data inventory"
        description="Every movement of units on your account — what arrived, what each filing took, and the balance it left."
      />

      {isLoading || !data ? (
        <Spinner label="Loading statement…" />
      ) : (
        <InventoryReportView
          statement={data}
          period={period}
          onPeriod={setPeriod}
          isFetching={isFetching}
        />
      )}
    </div>
  );
}
