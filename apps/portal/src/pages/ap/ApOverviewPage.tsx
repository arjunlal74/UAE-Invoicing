import { useQuery } from '@tanstack/react-query';
import type { ModuleDashboardResponse } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { useNavigate } from 'react-router-dom';
import { Alert, Card, PageHeader, Spinner, StatTile } from '../../components/ui';
import { TrendChart } from '../../components/TrendChart';
import { api, queryString } from '../../lib/api';

/**
 * The Inbound (AP) module's landing page (SRS v2.7 §1.2, §13.1).
 *
 * The AR overview asks "did my invoices clear?". This one asks a different
 * question — "what have suppliers sent me that nobody has looked at, and how
 * much input tax is stuck behind it?" — because that is the number an AP
 * manager is measured on and the one that decides whether a VAT return can be
 * filed on time.
 */
export function ApOverviewPage() {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['module-dashboard', 'ap'],
    queryFn: () =>
      api<ModuleDashboardResponse>(
        `/api/v1/dashboard/module${queryString({ direction: 'INBOUND_PURCHASE_AP' })}`,
      ),
  });

  if (isLoading || !data) return <Spinner label="Loading the AP overview…" />;

  const posted = data.counts.ACCEPTED_BY_BUYER ?? 0;
  const queried = data.counts.UNDER_QUERY ?? 0;
  const rejected =
    (data.counts.REJECTED_COMMERCIAL ?? 0) + (data.counts.REJECTED_TECHNICAL ?? 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inbound purchases"
        description="Supplier e-invoices received through the FTA Peppol network."
      />

      {data.needsAction > 0 && (
        <Alert kind="warn" title="Invoices awaiting verification">
          {data.needsAction} supplier invoice{data.needsAction === 1 ? '' : 's'} have not been
          reviewed. Input tax on them cannot be claimed until they are accepted.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Needs review"
          value={data.needsAction}
          tone={data.needsAction > 0 ? 'warn' : 'ok'}
          onClick={() => navigate('/ap/inbox')}
        />
        <StatTile label="Accepted &amp; posted" value={posted} tone="ok" />
        <StatTile
          label="Under query"
          value={queried}
          tone={queried > 0 ? 'warn' : 'neutral'}
          onClick={() => navigate('/ap/inbox?status=UNDER_QUERY')}
        />
        <StatTile
          label="Rejected"
          value={rejected}
          tone={rejected > 0 ? 'danger' : 'neutral'}
          onClick={() => navigate('/ap/inbox?status=REJECTED_COMMERCIAL')}
        />
        {/* The two tiles above count verdicts; this counts arguments still
            running. They overlap on purpose — a bill can be under query for a
            week without anyone thinking of it as a dispute, and it is the one
            figure on this page that maps to a desk you can work. */}
        <StatTile
          label="Open supplier disputes"
          value={data.openDisputes}
          hint="Queried or rejected, awaiting the supplier"
          tone={data.openDisputes > 0 ? 'danger' : 'ok'}
          onClick={() => navigate('/ap/disputes')}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Purchase invoices received"
          value={data.totalDocuments}
          hint="All time"
        />
        <StatTile
          label="Input VAT received"
          value={`AED ${formatAmount(data.vatTotalAed)}`}
          hint="Claimable once the invoice is accepted"
        />
        <StatTile
          label="Total purchase value"
          value={`AED ${formatAmount(data.amountTotalAed)}`}
        />
      </div>

      <Card title="Received over the last 30 days">
        <TrendChart
          series={data.last30Days.map((day) => ({
            date: day.date,
            primary: day.created,
            secondary: day.cleared,
            tertiary: day.disputed,
          }))}
          labels={{ primary: 'Received', secondary: 'Accepted', tertiary: 'Disputed' }}
        />
      </Card>
    </div>
  );
}
