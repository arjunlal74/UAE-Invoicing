import { TENANT_TYPE_LABELS, type InventoryLedgerRow, type InventoryReport } from '@uae/contracts';
import type { ReactNode } from 'react';
import { Card, EmptyState, StatTile, cx, formatDate, inputClass } from './ui';

/**
 * The data inventory report — units in, units out, over a window.
 *
 * One view for both holders. The platform buys from an accredited provider and
 * sells bundles on; a channel partner buys those bundles and sells slices to
 * its own sub-tenants. Same ledger, one level down — so the host's view of a
 * partner, the partner's own view, and the platform's own report are one
 * component and cannot drift into disagreeing about what "sold" means.
 *
 * Not a consumption report: what a tenant files draws down a bundle and is
 * counted on the console. This is the stock behind it.
 */
export const REPORT_PERIODS = [
  { value: '1', label: 'Last month' },
  { value: '3', label: 'Last 3 months' },
  { value: '6', label: 'Last 6 months' },
  { value: '12', label: 'Last 12 months' },
  { value: '24', label: 'Last 24 months' },
  { value: 'all', label: 'All time' },
];

export function InventoryReportView({
  report,
  period,
  onPeriod,
  scopePicker,
  isFetching,
}: {
  report: InventoryReport;
  period: string;
  onPeriod: (value: string) => void;
  /** The admin console's partner selector. Absent in the partner's own portal. */
  scopePicker?: ReactNode;
  isFetching?: boolean;
}) {
  const partner = report.scope === 'PARTNER';

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          {scopePicker}
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Movements over
            <select
              className={cx(inputClass, 'w-auto')}
              value={period}
              onChange={(event) => onPeriod(event.target.value)}
            >
              {REPORT_PERIODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          {isFetching && <span className="text-xs text-slate-400">updating…</span>}
          <span className="ml-auto text-xs text-slate-500">{report.period.label}</span>
        </div>
      </Card>

      {/* The four figures in the order the sentence runs: what was on the shelf,
          what arrived, what left, what remains. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Opening stock"
          value={report.openingUnits.toLocaleString()}
          hint="Unsold when the window opened"
        />
        <StatTile
          label={partner ? 'Bought from the platform' : 'Bought from providers'}
          value={report.purchasedUnits.toLocaleString()}
          hint={
            report.purchasedCostAed
              ? `AED ${Number(report.purchasedCostAed).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}`
              : `${report.purchases.length} contract${report.purchases.length === 1 ? '' : 's'}`
          }
          tone={report.purchasedUnits > 0 ? 'ok' : 'neutral'}
        />
        <StatTile
          label={partner ? 'Sold to sub-tenants' : 'Sold to accounts'}
          value={report.soldUnits.toLocaleString()}
          hint={`${report.sales.length} bundle${report.sales.length === 1 ? '' : 's'} issued`}
        />
        <StatTile
          label="Closing stock"
          value={report.closingUnits.toLocaleString()}
          hint="Opening + bought − sold"
          tone={report.closingUnits <= 0 ? 'danger' : 'neutral'}
        />
      </div>

      <LedgerTable
        title={partner ? 'Bought from the platform' : 'Bought from providers'}
        rows={report.purchases}
        counterpartyHeader={partner ? 'Seller' : 'Provider'}
        detailHeader={partner ? 'Out of contract' : 'Accreditation'}
        emptyTitle="Nothing bought in this window"
        emptyDescription={
          partner
            ? 'No bundle was issued to this partner over the period shown.'
            : 'No provider contract was registered over the period shown.'
        }
        // Only the host's own contracts carry a price. Nothing records what a
        // partner paid, so the columns are dropped rather than filled with
        // dashes down a report nobody can act on.
        money={report.purchases.some((row) => row.totalCostAed !== null)}
      />

      <LedgerTable
        title={partner ? 'Sold to sub-tenants' : 'Sold to tenants and partners'}
        rows={report.sales}
        counterpartyHeader="Buyer"
        detailHeader={partner ? 'From pool' : 'Tier'}
        emptyTitle="Nothing sold in this window"
        emptyDescription="No bundle was issued out of this stock over the period shown."
      />
    </div>
  );
}

function LedgerTable({
  title,
  rows,
  counterpartyHeader,
  detailHeader,
  emptyTitle,
  emptyDescription,
  money,
}: {
  title: string;
  rows: InventoryLedgerRow[];
  counterpartyHeader: string;
  detailHeader: string;
  emptyTitle: string;
  emptyDescription: string;
  /** The buy side of the host's own ledger is the only one that carries money. */
  money?: boolean;
}) {
  const total = rows.reduce((sum, row) => sum + row.units, 0);

  return (
    <Card title={`${title} (${rows.length})`}>
      {rows.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Date</th>
                <th className="pb-2 font-medium">Reference</th>
                <th className="pb-2 font-medium">{counterpartyHeader}</th>
                <th className="pb-2 font-medium">{detailHeader}</th>
                <th className="pb-2 text-right font-medium">Units</th>
                {money && <th className="pb-2 text-right font-medium">Rate (AED)</th>}
                {money && <th className="pb-2 text-right font-medium">Cost (AED)</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {/* Indexed: a bundle reference is unique per tenant, so two
                  accounts can hold the same one and a reference key would
                  collide across a platform-wide ledger. */}
              {rows.map((row, index) => (
                <tr key={index}>
                  <td className="py-2 text-xs text-slate-500">{formatDate(row.date)}</td>
                  <td className="py-2 font-mono text-xs text-slate-700">{row.reference}</td>
                  <td className="py-2 text-slate-800">{row.counterparty}</td>
                  <td className="py-2 text-xs text-slate-500">{detailLabel(row)}</td>
                  <td className="py-2 text-right tabular-nums text-slate-800">
                    {row.units.toLocaleString()}
                  </td>
                  {money && (
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {row.costPerUnitAed ? Number(row.costPerUnitAed).toFixed(4) : '—'}
                    </td>
                  )}
                  {money && (
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {row.totalCostAed ? Number(row.totalCostAed).toLocaleString() : '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-200">
              <tr>
                <td className="pt-2 text-xs font-medium text-slate-500" colSpan={4}>
                  Total
                </td>
                <td className="pt-2 text-right font-medium tabular-nums text-slate-900">
                  {total.toLocaleString()}
                </td>
                {money && <td />}
                {money && (
                  <td className="pt-2 text-right font-medium tabular-nums text-slate-900">
                    {rows.some((row) => row.totalCostAed)
                      ? rows
                          .reduce((sum, row) => sum + Number(row.totalCostAed ?? 0), 0)
                          .toLocaleString(undefined, { minimumFractionDigits: 2 })
                      : '—'}
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

/** The detail column carries a tenant tier on one report and a reference on another. */
function detailLabel(row: InventoryLedgerRow): string {
  if (!row.counterpartyDetail) return '—';
  const tier = TENANT_TYPE_LABELS[row.counterpartyDetail as keyof typeof TENANT_TYPE_LABELS];
  return tier ?? row.counterpartyDetail;
}
