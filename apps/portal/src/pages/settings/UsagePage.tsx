import { useQuery } from '@tanstack/react-query';
import {
  DIRECTION_SHORT,
  type BalanceResponse,
  type PaginatedResult,
  type UsageLedgerItem,
} from '@uae/contracts';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  Spinner,
  StatTile,
  StatusBadge,
  cx,
  formatDate,
  formatDateTime,
} from '../../components/ui';
import { api, queryString } from '../../lib/api';

/**
 * Prepaid data bundles and consumption (SRS v2.7 §15).
 *
 * The number that matters is "how many documents can I still file", so it leads.
 * Everything below is the evidence for it: which bundle it came out of, and the
 * per-document ledger a tenant will reach for when they disagree with an
 * invoice from us.
 */
export function UsagePage() {
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { data: balance, isLoading } = useQuery({
    queryKey: ['billing-balance'],
    queryFn: () => api<BalanceResponse>('/api/v1/billing/balance'),
  });

  const { data: ledger } = useQuery({
    queryKey: ['billing-usage', page],
    queryFn: () =>
      api<PaginatedResult<UsageLedgerItem>>(
        `/api/v1/billing/usage${queryString({ page, pageSize })}`,
      ),
  });

  if (isLoading || !balance) return <Spinner label="Loading your balance…" />;

  const critical = balance.usedPct >= 90;
  const warning = balance.usedPct >= 80 && !critical;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Usage and balance"
        description="Prepaid document capacity and what has been consumed against it."
      />

      {balance.message && (
        <Alert kind={balance.canFile ? 'info' : 'danger'}>{balance.message}</Alert>
      )}

      {(critical || warning) && balance.canFile && (
        <Alert kind={critical ? 'danger' : 'warn'} title={`${balance.usedPct}% consumed`}>
          Order additional capacity before your bundle runs out. Filing stops when a bundle with a
          hard cap is exhausted.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Documents remaining"
          value={balance.totalRemaining}
          tone={critical ? 'danger' : warning ? 'warn' : 'ok'}
        />
        <StatTile label="Purchased" value={balance.totalPurchased} />
        <StatTile
          label="Consumed"
          value={balance.totalConsumed}
          hint={`${balance.usedPct}% of capacity`}
        />
      </div>

      {balance.parentPool && (
        <Card title="Channel partner master pool">
          <p className="mb-3 text-sm text-slate-600">
            Your allocation is carved out of a bundle held by {balance.parentPool.tenantName}.
            Documents you file draw down both your own slice and their pool.
          </p>
          <BundleBar bundle={balance.parentPool} />
        </Card>
      )}

      <Card title="Your bundles">
        {balance.bundles.length === 0 ? (
          <EmptyState
            title="No bundle loaded"
            description="Documents are still recorded, but nothing is being metered. Contact your account manager to load capacity."
          />
        ) : (
          <div className="space-y-4">
            {balance.bundles.map((bundle) => (
              <div key={bundle.id}>
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-800">{bundle.reference}</span>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    {bundle.allowOverage && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5">Overage allowed</span>
                    )}
                    {bundle.expiresAt && <span>Expires {formatDate(bundle.expiresAt)}</span>}
                    <StatusBadge status={bundle.status} />
                  </div>
                </div>
                <BundleBar bundle={bundle} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">Consumption ledger</h2>
        </header>

        {!ledger?.items.length ? (
          <EmptyState
            title="Nothing consumed yet"
            description="Every metered document appears here, including the ones that cost nothing."
          />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Document</th>
                  <th className="px-4 py-2 font-medium">Module</th>
                  <th className="px-4 py-2 font-medium">Reason</th>
                  <th className="px-4 py-2 text-right font-medium">Units</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ledger.items.map((entry) => (
                  <tr key={entry.id} className={entry.isParentMirror ? 'bg-slate-50/60' : ''}>
                    <td className="px-4 py-2 text-slate-500">{formatDateTime(entry.createdAt)}</td>
                    <td className="px-4 py-2">
                      {entry.invoiceId ? (
                        <Link
                          to={`/invoices/${entry.invoiceId}`}
                          className="text-brand-700 hover:underline"
                        >
                          {entry.invoiceNumber ?? 'Document'}
                        </Link>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                      {entry.isParentMirror && (
                        <span className="ml-2 text-xs text-slate-400">
                          (sub-tenant consumption)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {DIRECTION_SHORT[entry.direction]}
                    </td>
                    <td className="px-4 py-2 text-slate-600">{entry.reason}</td>
                    <td
                      className={cx(
                        'px-4 py-2 text-right tabular-nums',
                        entry.units === 0 ? 'text-slate-400' : 'text-slate-800',
                      )}
                    >
                      {entry.units}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} pageSize={pageSize} total={ledger.total} onPage={setPage} />
          </>
        )}
      </div>
    </div>
  );
}

function BundleBar({ bundle }: { bundle: BalanceResponse['bundles'][number] }) {
  const pct = Math.min(100, bundle.usedPct);
  const tone = pct >= 90 ? 'bg-danger-500' : pct >= 80 ? 'bg-warn-500' : 'bg-brand-500';

  return (
    <div>
      <div className="h-2 overflow-hidden rounded bg-slate-100">
        <div className={cx('h-2 rounded', tone)} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-xs text-slate-500">
        <span>
          {bundle.consumedUnits.toLocaleString()} of {bundle.purchasedUnits.toLocaleString()} used
        </span>
        <span className="tabular-nums">
          {Math.max(0, bundle.remainingUnits).toLocaleString()} remaining
        </span>
      </div>
    </div>
  );
}
