import type { InventoryStatement } from '@uae/contracts';
import type { ReactNode } from 'react';
import { PeriodPicker, type PeriodChoice } from './PeriodPicker';
import { Alert, Card, EmptyState } from './ui';

export {
  DEFAULT_PERIOD,
  periodDates,
  periodQuery,
  periodReady,
  type PeriodChoice,
} from './PeriodPicker';

/**
 * The data inventory statement.
 *
 * One row per movement with a running balance, the way the business reads it:
 * every line opens at the balance the line above closed on. The same seven
 * columns at every tier — only the two middle headings change with the holder,
 * because it is the same unit changing hands down the chain.
 *
 *   Platform            Opening | Buy       | Sell      | Balance
 *   Channel partner     Opening | Buy       | Allocated | Balance
 *   Direct tenant       Opening | Buy       | Consumed  | Balance
 *   Managed sub-tenant  Opening | Allocated | Consumed  | Balance
 */
const COLUMNS: Record<InventoryStatement['holderKind'], { in: string; out: string }> = {
  PLATFORM: { in: 'Buy', out: 'Sell' },
  CHANNEL_PARTNER: { in: 'Buy', out: 'Allocated' },
  ENTERPRISE_TENANT: { in: 'Buy', out: 'Consumed' },
  MANAGED_SUB_TENANT: { in: 'Allocated', out: 'Consumed' },
};

/** "1 January 2026", the way the statement heading writes a date. */
function longDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function heading(statement: InventoryStatement): string {
  const { from, to } = statement.period;
  if (from && to) return `From ${longDate(from)} to ${longDate(to)}`;
  if (to) return `All movements to ${longDate(to)}`;
  return statement.period.label;
}

export function InventoryReportView({
  statement,
  period,
  onPeriod,
  scopePicker,
  isFetching,
}: {
  statement: InventoryStatement;
  period: PeriodChoice;
  onPeriod: (choice: PeriodChoice) => void;
  /** An account selector, where the reader may see more than one inventory. */
  scopePicker?: ReactNode;
  isFetching?: boolean;
}) {
  const columns = COLUMNS[statement.holderKind];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          {scopePicker}
          <PeriodPicker value={period} onChange={onPeriod} />
          {isFetching && <span className="text-xs text-slate-400">updating…</span>}
        </div>
      </Card>

      <Card>
        {/* The statement's own heading, as it prints: who, what, and over what
            window. Above the table rather than in the page header, because this
            block is the report and the page around it is only its frame. */}
        <div className="border-b border-slate-200 pb-3 text-center">
          <h2 className="text-base font-semibold text-slate-900">{statement.holderName}</h2>
          <p className="text-sm font-medium text-slate-700">Data Inventory Report</p>
          <p className="text-xs text-slate-500">{heading(statement)}</p>
        </div>

        {statement.omittedRows > 0 && (
          <Alert kind="info">
            {statement.omittedRows.toLocaleString()} earlier movements are folded into the opening
            balance below. Narrow the period to see them listed.
          </Alert>
        )}

        {statement.rows.length === 0 ? (
          <EmptyState
            title="No movements in this period"
            description={`The balance stood at ${statement.openingUnits.toLocaleString()} units throughout.`}
          />
        ) : (
          <div className="overflow-x-auto pt-3">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 font-medium">Reference</th>
                  <th className="pb-2 font-medium">Description</th>
                  <th className="pb-2 text-right font-medium">Opening</th>
                  <th className="pb-2 text-right font-medium">{columns.in}</th>
                  <th className="pb-2 text-right font-medium">{columns.out}</th>
                  <th className="pb-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {/* Indexed: two accounts can hold the same bundle reference, and
                    one document can move units more than once on a day. */}
                {statement.rows.map((row, index) => (
                  <tr key={index} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap py-2 text-xs text-slate-500">
                      {longDate(row.date)}
                    </td>
                    <td className="py-2 font-mono text-xs text-slate-700">{row.reference}</td>
                    <td className="py-2 text-slate-800">{row.description}</td>
                    <td className="py-2 text-right tabular-nums text-slate-500">
                      {row.openingUnits.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {row.inUnits > 0 ? row.inUnits.toLocaleString() : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {row.outUnits > 0 ? row.outUnits.toLocaleString() : '—'}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums text-slate-900">
                      {row.balanceUnits.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-slate-300">
                <tr>
                  <td className="pt-2 text-xs font-medium uppercase text-slate-500" colSpan={3}>
                    Period total
                  </td>
                  <td className="pt-2 text-right tabular-nums text-slate-700">
                    {statement.openingUnits.toLocaleString()}
                  </td>
                  <td className="pt-2 text-right font-medium tabular-nums text-slate-900">
                    {statement.totalInUnits.toLocaleString()}
                  </td>
                  <td className="pt-2 text-right font-medium tabular-nums text-slate-900">
                    {statement.totalOutUnits.toLocaleString()}
                  </td>
                  <td className="pt-2 text-right font-semibold tabular-nums text-slate-900">
                    {statement.closingUnits.toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
