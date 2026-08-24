import { useQuery } from '@tanstack/react-query';
import { REASON_CODE_LABELS, type DisputeAnalytics } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { Link } from 'react-router-dom';
import {
  Alert,
  Card,
  EmptyState,
  PageHeader,
  Spinner,
  StatTile,
  cx,
} from '../../components/ui';
import { api } from '../../lib/api';

/**
 * The dispute KPI dashboard (SRS v2.7 §13.1).
 *
 * Both modules on one page, deliberately: the four headline ratios only mean
 * something next to each other. A 12% sales dispute rate is alarming on its own
 * and unremarkable beside a 14% purchase dispute rate, which would suggest the
 * problem is the industry rather than the billing.
 */
export function AnalyticsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dispute-analytics'],
    queryFn: () => api<DisputeAnalytics>('/api/v1/reports/analytics'),
  });

  if (isLoading || !data) return <Spinner label="Computing analytics…" />;

  const { kpis } = data;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dispute analytics"
        description="Outbound sales disputes and inbound purchase rejections across both modules."
      />

      {kpis.unresolvedOver30Days > 0 && (
        <Alert kind="danger" title="FTA audit exposure">
          {kpis.unresolvedOver30Days} disputed document
          {kpis.unresolvedOver30Days === 1 ? ' has' : 's have'} been open for more than 30 days with
          no corrective credit note. Until one is issued the output tax stands unreversed on your
          return.
        </Alert>
      )}

      {/* --- §13.1 KPI tiles ------------------------------------------------ */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Sales dispute rate"
          value={`${kpis.salesDisputeRatePct}%`}
          hint={`${kpis.outboundDisputed.toLocaleString()} of ${kpis.outboundTotal.toLocaleString()} outbound`}
          tone={kpis.salesDisputeRatePct > 5 ? 'danger' : 'neutral'}
        />
        <StatTile
          label="Purchase dispute rate"
          value={`${kpis.purchaseDisputeRatePct}%`}
          hint={`${kpis.inboundRejected.toLocaleString()} of ${kpis.inboundTotal.toLocaleString()} inbound`}
          tone={kpis.purchaseDisputeRatePct > 5 ? 'warn' : 'neutral'}
        />
        <StatTile
          label="Input VAT claimable"
          value={`AED ${formatAmount(kpis.inputVatClaimableAed)}`}
          hint="On accepted purchase invoices"
          tone="ok"
        />
        <StatTile
          label="Input VAT blocked"
          value={`AED ${formatAmount(kpis.inputVatBlockedAed)}`}
          hint="Held behind a query or rejection"
          tone={Number(kpis.inputVatBlockedAed) > 0 ? 'danger' : 'neutral'}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Open disputes"
          value={kpis.openDisputes}
          tone={kpis.openDisputes > 0 ? 'warn' : 'ok'}
        />
        <StatTile
          label="Average resolution"
          value={kpis.averageResolutionDays === null ? '—' : `${kpis.averageResolutionDays} days`}
          hint="Dispute logged to credit note received"
        />
        <StatTile
          label="Open beyond 30 days"
          value={kpis.unresolvedOver30Days}
          tone={kpis.unresolvedOver30Days > 0 ? 'danger' : 'ok'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- §13.2 report 4 ---------------------------------------------- */}
        <Card title="Outbound dispute aging">
          {data.aging.every((bucket) => bucket.count === 0) ? (
            <EmptyState title="No open sales disputes" />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1.5 font-medium">Bucket</th>
                  <th className="py-1.5 text-right font-medium">Invoices</th>
                  <th className="py-1.5 text-right font-medium">Value (AED)</th>
                  <th className="w-1/3 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.aging.map((bucket) => {
                  const max = Math.max(1, ...data.aging.map((b) => b.count));
                  return (
                    <tr key={bucket.bucket}>
                      <td className="py-1.5 text-slate-700">{bucket.bucket}</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-800">
                        {bucket.count}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-800">
                        {formatAmount(bucket.amountAed)}
                      </td>
                      <td className="py-1.5 pl-3">
                        <div className="h-2 rounded bg-slate-100">
                          <div
                            className={cx(
                              'h-2 rounded',
                              bucket.bucket === '60+ days' ? 'bg-danger-500' : 'bg-warn-500',
                            )}
                            style={{ width: `${(bucket.count / max) * 100}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* --- §13.2 report 5 ---------------------------------------------- */}
        <Card title="Rejection Pareto by reason code">
          {data.pareto.length === 0 ? (
            <EmptyState title="No rejections recorded" />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1.5 font-medium">Reason</th>
                  <th className="py-1.5 text-right font-medium">AR</th>
                  <th className="py-1.5 text-right font-medium">AP</th>
                  <th className="py-1.5 text-right font-medium">Total</th>
                  <th className="py-1.5 text-right font-medium">Cumulative</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.pareto.map((row) => (
                  <tr key={row.reasonCode}>
                    <td className="py-1.5">
                      <span className="font-medium text-slate-700">{row.reasonCode}</span>{' '}
                      <span className="text-slate-500">{REASON_CODE_LABELS[row.reasonCode]}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-700">
                      {row.outbound}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-700">{row.inbound}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums text-slate-900">
                      {row.total}
                    </td>
                    <td
                      className={cx(
                        'py-1.5 text-right tabular-nums',
                        // The 80% line is the whole point of a Pareto: past it,
                        // the remaining causes are not worth chasing first.
                        row.cumulativePct <= 80 ? 'font-medium text-slate-800' : 'text-slate-400',
                      )}
                    >
                      {row.cumulativePct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* --- §13.2 report 2 ------------------------------------------------ */}
      <Card title="Supplier dispute scorecard">
        {data.supplierScorecard.length === 0 ? (
          <EmptyState title="No purchase invoices received yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1.5 font-medium">Supplier</th>
                  <th className="py-1.5 font-medium">TRN</th>
                  <th className="py-1.5 text-right font-medium">Received</th>
                  <th className="py-1.5 text-right font-medium">Queried</th>
                  <th className="py-1.5 text-right font-medium">Rejected</th>
                  <th className="py-1.5 text-right font-medium">Rejection rate</th>
                  <th className="py-1.5 font-medium">Most common reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.supplierScorecard.map((row, index) => (
                  <tr key={row.supplierId ?? index}>
                    <td className="py-1.5 text-slate-800">{row.supplierName}</td>
                    <td className="py-1.5 font-mono text-xs text-slate-500">{row.trn ?? '—'}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-700">
                      {row.received}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-700">{row.queried}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-700">
                      {row.rejected}
                    </td>
                    <td
                      className={cx(
                        'py-1.5 text-right tabular-nums',
                        row.rejectionRatePct > 10 ? 'font-medium text-danger-700' : 'text-slate-700',
                      )}
                    >
                      {row.rejectionRatePct}%
                    </td>
                    <td className="py-1.5 text-slate-600">
                      {row.topReason
                        ? `${row.topReason} — ${REASON_CODE_LABELS[row.topReason]}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* --- §13.2 report 6 ------------------------------------------------ */}
      <Card title="FTA audit non-compliance log">
        {data.nonCompliance.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description="Every disputed document either has a corrective credit note or was raised within the last 30 days."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-1.5 font-medium">Document</th>
                <th className="py-1.5 font-medium">Counterparty</th>
                <th className="py-1.5 font-medium">Reason</th>
                <th className="py-1.5 text-right font-medium">Days open</th>
                <th className="py-1.5 text-right font-medium">Amount (AED)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.nonCompliance.map((row) => (
                <tr key={row.invoiceId}>
                  <td className="py-1.5">
                    <Link
                      to={`/invoices/${row.invoiceId}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {row.invoiceNumber}
                    </Link>
                  </td>
                  <td className="py-1.5 text-slate-700">{row.counterpartyName}</td>
                  <td className="py-1.5 text-slate-600">
                    {row.reasonCode
                      ? `${row.reasonCode} — ${REASON_CODE_LABELS[row.reasonCode]}`
                      : '—'}
                  </td>
                  <td className="py-1.5 text-right font-medium tabular-nums text-danger-700">
                    {row.daysOpen}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-slate-800">
                    {formatAmount(row.amountAed)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
