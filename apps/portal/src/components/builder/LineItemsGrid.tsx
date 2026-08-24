import {
  UOMS,
  VAT_CATEGORIES,
  formatAmount,
  type StagedLine,
  type VatCategoryCode,
} from '@uae/domain';
import { Button, cx } from '../ui';

/**
 * The line itemisation grid from the §7 and §8.1 wireframes.
 *
 * Every derived column (net, VAT, total) is read-only and comes from
 * `recalcInvoice` in @uae/domain — the same function the worker uses to produce
 * the figures that go into the XML. A grid that computed its own totals would
 * eventually show the user a number the FTA never received.
 */

export interface LineFindings {
  /** Field names with a blocking finding, keyed by line id. */
  byLine: Map<string, Set<string>>;
}

export function LineItemsGrid({
  lines,
  onChange,
  onAdd,
  onRemove,
  readOnly,
  findings,
  /** A credit note's amounts are negative, so its columns read differently. */
  reversal,
}: {
  lines: StagedLine[];
  onChange: (id: string, patch: Partial<StagedLine>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  readOnly?: boolean;
  findings?: LineFindings;
  reversal?: boolean;
}) {
  const cell = 'px-2 py-1.5 align-top';
  const input =
    'w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50 disabled:text-slate-500';

  const invalid = (lineId: string, field: string) =>
    findings?.byLine.get(lineId)?.has(field) ? 'border-danger-500 bg-danger-50' : '';

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-10 px-2 py-2 font-medium">#</th>
              <th className="px-2 py-2 font-medium">Description</th>
              <th className="w-24 px-2 py-2 font-medium">HS code</th>
              <th className="w-20 px-2 py-2 font-medium">Qty</th>
              <th className="w-24 px-2 py-2 font-medium">UOM</th>
              <th className="w-28 px-2 py-2 font-medium">
                {reversal ? 'Credit / unit' : 'Unit price'}
              </th>
              <th className="w-24 px-2 py-2 font-medium">Discount</th>
              <th className="w-28 px-2 py-2 font-medium">VAT</th>
              <th className="w-28 px-2 py-2 text-right font-medium">Net</th>
              <th className="w-24 px-2 py-2 text-right font-medium">VAT amt</th>
              <th className="w-28 px-2 py-2 text-right font-medium">Total</th>
              {!readOnly && <th className="w-10 px-2 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {lines.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-6 text-center text-sm text-slate-500">
                  {reversal
                    ? 'No lines are being credited yet.'
                    : 'No line items yet. Add the first one below.'}
                </td>
              </tr>
            )}

            {lines.map((line, index) => (
              <tr key={line.id}>
                <td className={cx(cell, 'text-slate-500')}>{index + 1}</td>
                <td className={cell}>
                  <input
                    className={cx(input, invalid(line.id, 'description'))}
                    value={line.description}
                    disabled={readOnly}
                    onChange={(e) => onChange(line.id, { description: e.target.value })}
                  />
                </td>
                <td className={cell}>
                  <input
                    className={input}
                    value={line.hsCode}
                    disabled={readOnly}
                    onChange={(e) => onChange(line.id, { hsCode: e.target.value })}
                  />
                </td>
                <td className={cell}>
                  <input
                    className={cx(input, 'text-right tabular-nums', invalid(line.id, 'quantity'))}
                    value={line.quantity}
                    disabled={readOnly}
                    inputMode="decimal"
                    onChange={(e) => onChange(line.id, { quantity: e.target.value })}
                  />
                </td>
                <td className={cell}>
                  <select
                    className={input}
                    value={line.uom}
                    disabled={readOnly}
                    onChange={(e) => onChange(line.id, { uom: e.target.value })}
                  >
                    {Object.entries(UOMS).map(([code, label]) => (
                      <option key={code} value={code}>
                        {code} — {label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={cell}>
                  <input
                    className={cx(input, 'text-right tabular-nums', invalid(line.id, 'unitPrice'))}
                    value={line.unitPrice}
                    disabled={readOnly}
                    inputMode="decimal"
                    onChange={(e) => onChange(line.id, { unitPrice: e.target.value })}
                  />
                </td>
                <td className={cell}>
                  <input
                    className={cx(input, 'text-right tabular-nums')}
                    value={line.lineDiscount}
                    disabled={readOnly}
                    inputMode="decimal"
                    onChange={(e) => onChange(line.id, { lineDiscount: e.target.value })}
                  />
                </td>
                <td className={cell}>
                  <select
                    className={input}
                    value={line.vatCategory}
                    disabled={readOnly}
                    onChange={(e) =>
                      onChange(line.id, {
                        vatCategory: e.target.value,
                        // The category dictates the rate; leaving the old one
                        // behind is exactly the BR-UAE-14 mismatch the
                        // validator would raise a moment later.
                        vatRate: String(
                          VAT_CATEGORIES[e.target.value as VatCategoryCode]?.rate ?? 0,
                        ),
                      })
                    }
                  >
                    {Object.entries(VAT_CATEGORIES).map(([code, spec]) => (
                      <option key={code} value={code}>
                        {code} — {spec.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={cx(cell, 'text-right tabular-nums text-slate-700')}>
                  {line.netAmount ? formatAmount(line.netAmount) : '—'}
                </td>
                <td className={cx(cell, 'text-right tabular-nums text-slate-600')}>
                  {line.vatAmount ? formatAmount(line.vatAmount) : '—'}
                </td>
                <td className={cx(cell, 'text-right font-medium tabular-nums text-slate-900')}>
                  {line.lineTotal ? formatAmount(line.lineTotal) : '—'}
                </td>
                {!readOnly && (
                  <td className={cx(cell, 'text-right')}>
                    <button
                      onClick={() => onRemove(line.id)}
                      aria-label={`Remove line ${index + 1}`}
                      className="rounded px-2 py-0.5 text-slate-400 hover:bg-danger-50 hover:text-danger-700"
                    >
                      ×
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!readOnly && (
        <Button size="sm" onClick={onAdd}>
          + Add line item
        </Button>
      )}
    </div>
  );
}

/** The totals strip beneath the grid (§7 and §8.1 "REVERSAL TOTALS"). */
export function TotalsStrip({
  currency,
  net,
  vat,
  total,
  reversal,
}: {
  currency: string;
  net: string;
  vat: string;
  total: string;
  reversal?: boolean;
}) {
  const tone = reversal ? 'text-danger-700' : 'text-slate-900';

  return (
    <div className="flex flex-wrap items-center justify-end gap-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
      <div>
        <span className="text-slate-500">{reversal ? 'Credit extension net' : 'Net total'}: </span>
        <span className="font-medium tabular-nums">
          {currency} {formatAmount(net || '0')}
        </span>
      </div>
      <div>
        <span className="text-slate-500">{reversal ? 'Reversal VAT' : 'Total VAT'}: </span>
        <span className="font-medium tabular-nums">
          {currency} {formatAmount(vat || '0')}
        </span>
      </div>
      <div className="text-base">
        <span className="text-slate-500">{reversal ? 'Total credit' : 'Payable total'}: </span>
        <span className={cx('font-semibold tabular-nums', tone)}>
          {currency} {formatAmount(total || '0')}
        </span>
      </div>
    </div>
  );
}
