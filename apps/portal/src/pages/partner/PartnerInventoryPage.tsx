import type { InventoryReport } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { InventoryReportView } from '../../components/InventoryReportView';
import { PageHeader, Spinner } from '../../components/ui';
import { api } from '../../lib/api';

/**
 * A channel partner's own data inventory report.
 *
 * The same report the platform reads about this partner, served to the partner
 * itself and rendered by the same component — so what "sold" means here and
 * what it means on the host's copy cannot drift apart.
 */
export function PartnerInventoryPage() {
  const [period, setPeriod] = useState('12');

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['partner-inventory-report', period],
    queryFn: () => api<InventoryReport>(`/api/v1/partner/inventory/report?period=${period}`),
    placeholderData: (previous) => previous,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data inventory"
        description="What you bought from the platform, what you allocated to your sub-tenants, and what is left in your pools to allocate."
      />

      {isLoading || !data ? (
        <Spinner label="Loading report…" />
      ) : (
        <InventoryReportView
          report={data}
          period={period}
          onPeriod={setPeriod}
          isFetching={isFetching}
        />
      )}
    </div>
  );
}
