import type { StagedRow, ValidationFindingDto } from '@uae/contracts';
import { useMemo, useState } from 'react';
import { cx } from '../ui';

/**
 * The error audit sidebar.
 *
 * Its whole job is to turn "8 invalid" into eight specific places to click.
 * Each entry names the rule, explains the problem in plain language, and gives
 * the coordinate in the user's own spreadsheet so they can also fix it at
 * source if they prefer.
 */
export function ErrorSidebar({
  findings,
  onFocus,
  focusedCell,
}: {
  findings: { row: StagedRow; finding: ValidationFindingDto }[];
  onFocus: (rowId: string, field: string) => void;
  focusedCell: { rowId: string; field: string } | null;
}) {
  const [showWarnings, setShowWarnings] = useState(true);

  const errors = findings.filter(
    (f) => f.finding.severity === 'ERROR' || f.finding.severity === 'FATAL',
  );
  const warnings = findings.filter(
    (f) => f.finding.severity === 'WARNING' || f.finding.severity === 'INFO',
  );

  const visible = showWarnings ? [...errors, ...warnings] : errors;

  // Grouping by rule turns "the same mistake 40 times" into one line the user
  // can act on, instead of 40 identical entries to scroll past.
  const byRule = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { finding } of findings) {
      counts.set(finding.ruleCode, (counts.get(finding.ruleCode) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [findings]);

  return (
    <aside className="w-80 shrink-0">
      <div className="sticky top-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-800">
            {errors.length > 0
              ? `${errors.length} error${errors.length === 1 ? '' : 's'} to fix`
              : 'No blocking errors'}
          </h3>
          {warnings.length > 0 && (
            <label className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={showWarnings}
                onChange={(e) => setShowWarnings(e.target.checked)}
                className="rounded border-slate-300"
              />
              Show {warnings.length} warning{warnings.length === 1 ? '' : 's'} (these do not block
              submission)
            </label>
          )}
        </header>

        {byRule.length > 1 && (
          <div className="flex flex-wrap gap-1 border-b border-slate-200 bg-slate-50 px-3 py-2">
            {byRule.map(([code, count]) => (
              <span
                key={code}
                className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-600 ring-1 ring-slate-200"
                title={`${count} occurrence${count === 1 ? '' : 's'} of ${code}`}
              >
                {code} ×{count}
              </span>
            ))}
          </div>
        )}

        <div className="max-h-[58vh] overflow-auto">
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">
              Everything checks out. You can submit this batch.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {visible.map(({ row, finding }, index) => {
                const target = finding.lineId
                  ? `${finding.lineId}:${finding.field}`
                  : finding.field;
                const isFocused =
                  focusedCell?.rowId === row.id && focusedCell.field === target;
                const blocking =
                  finding.severity === 'ERROR' || finding.severity === 'FATAL';

                return (
                  <li key={`${row.id}-${finding.ruleCode}-${target}-${index}`}>
                    <button
                      onClick={() => onFocus(row.id, target)}
                      className={cx(
                        'w-full px-4 py-3 text-left transition-colors hover:bg-slate-50',
                        isFocused && 'bg-brand-50',
                      )}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <span
                          className={cx(
                            'inline-block h-2 w-2 shrink-0 rounded-full',
                            blocking ? 'bg-danger-500' : 'bg-warn-500',
                          )}
                        />
                        <span className="font-mono text-[11px] font-medium text-slate-500">
                          {finding.ruleCode}
                        </span>
                        <span className="truncate text-xs text-slate-400">
                          {row.invoice.invoiceNumber || '(no number)'}
                        </span>
                      </div>

                      <p className="text-sm leading-snug text-slate-700">{finding.message}</p>

                      {finding.cell && (
                        <p className="mt-1 font-mono text-[11px] text-slate-400">
                          {finding.sheet} · cell {finding.cell}
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
