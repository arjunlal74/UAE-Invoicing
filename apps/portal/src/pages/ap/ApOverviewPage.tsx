import { useQuery } from '@tanstack/react-query';
import type { ModuleDashboardResponse } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, PageHeader, Spinner, StatTile, inputClass } from '../../components/ui';
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
/**
 * The window every figure on this page is read through.
 *
 * It covers the queue counts too, which is worth stating plainly: on a short
 * period "needs review" means "issued in this window and still unreviewed", so
 * a bill older than the window drops out of the count however long it has sat
 * there. Every tile names the window for that reason, and the verification desk
 * next door lists the whole queue regardless.
 */
const PERIODS: [string, string][] = [
  ['1', 'Last month'],
  ['3', 'Last 3 months'],
  ['12', 'Last 12 months'],
  ['all', 'All time'],
];

export function ApOverviewPage() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState('12');

  const { data, isLoading } = useQuery({
    queryKey: ['module-dashboard', 'ap', period],
    queryFn: () =>
      api<ModuleDashboardResponse>(
        `/api/v1/dashboard/module${queryString({ direction: 'INBOUND_PURCHASE_AP', period })}`,
      ),
    // Changing the window re-labels the two money tiles rather than emptying
    // the page under the reader.
    placeholderData: (previous) => previous,
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
        actions={
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <span>Period</span>
            <select
              className={`${inputClass} w-auto`}
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              title="Every figure on this page is read through this window"
            >
              {PERIODS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        }
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
          hint={`${data.period.label} · nobody has ruled on these yet`}
          tone={data.needsAction > 0 ? 'warn' : 'ok'}
          onClick={() => navigate('/ap/inbox')}
        />
        <StatTile
          label="Accepted &amp; posted"
          value={posted}
          hint={`${data.period.label} · approved and pushed to your ledger`}
          tone="ok"
        />
        <StatTile
          label="Under query"
          value={queried}
          hint={`${data.period.label} · the supplier owes you an answer`}
          tone={queried > 0 ? 'warn' : 'neutral'}
          onClick={() => navigate('/ap/inbox?status=UNDER_QUERY')}
        />
        <StatTile
          label="Rejected"
          value={rejected}
          hint={`${data.period.label} · a supplier credit note closes one`}
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
          hint={`${data.period.label} · queried or rejected, awaiting the supplier`}
          tone={data.openDisputes > 0 ? 'danger' : 'ok'}
          onClick={() => navigate('/ap/disputes')}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Purchase invoices received"
          value={data.totalDocuments}
          hint={`${data.period.label} · every bill a supplier sent`}
        />
        <StatTile
          label="Input VAT received"
          value={`AED ${formatAmount(data.vatTotalAed)}`}
          hint={`${data.period.label} · claimable once the invoice is accepted`}
          tone="ok"
        />
        <StatTile
          label="Total purchase value"
          value={`AED ${formatAmount(data.amountTotalAed)}`}
          hint={`${data.period.label} · payable to your suppliers`}
        />
      </div>
    </div>
  );
}
