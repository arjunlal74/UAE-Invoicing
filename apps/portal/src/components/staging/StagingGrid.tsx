import type { StagedRow, ValidationFindingDto } from '@uae/contracts';
import {
  CURRENCY_CODES,
  EMIRATES,
  INVOICE_TYPES,
  PAYMENT_MEANS,
  UOM_CODES,
  VAT_CATEGORIES,
  formatAmount,
} from '@uae/domain';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef, useState } from 'react';
import { StatusBadge, cx } from '../ui';
import { EditableCell } from './EditableCell';

/**
 * Virtualised master/detail grid.
 *
 * Virtualised because a batch can hold 10,000 invoices and rendering them all
 * would lock the tab. Master/detail because an invoice's errors can be on the
 * header or on a line, and the user needs to reach either without leaving the
 * page.
 *
 * Only expanded rows render their line items, so the common case — scanning a
 * long list for red cells — stays cheap.
 */

interface Props {
  rows: StagedRow[];
  editable: boolean;
  saving: boolean;
  focusedCell: { rowId: string; field: string } | null;
  onEditInvoice: (rowId: string, field: string, value: string) => void;
  onEditLine: (rowId: string, lineId: string, field: string, value: string) => void;
}

const HEADER_COLUMNS = [
  { field: 'invoiceNumber', label: 'Invoice number', width: 'w-40', type: 'text' as const },
  { field: 'invoiceType', label: 'Type', width: 'w-32', type: 'select' as const },
  { field: 'issueDate', label: 'Issue date', width: 'w-32', type: 'date' as const },
  { field: 'buyerName', label: 'Buyer', width: 'w-48', type: 'text' as const },
  { field: 'buyerTrn', label: 'Buyer TRN', width: 'w-44', type: 'text' as const },
  { field: 'buyerEmirate', label: 'Emirate', width: 'w-36', type: 'select' as const },
  { field: 'currency', label: 'Currency', width: 'w-24', type: 'select' as const },
  { field: 'payableAmount', label: 'Total', width: 'w-32', type: 'derived' as const },
];

const INVOICE_TYPE_OPTIONS = Object.entries(INVOICE_TYPES).map(([code, spec]) => ({
  value: code,
  label: `${code} — ${spec.label}`,
}));

const EMIRATE_OPTIONS = EMIRATES.map((e) => ({ value: e, label: e }));
const CURRENCY_OPTIONS = CURRENCY_CODES.map((c) => ({ value: c, label: c }));
const UOM_OPTIONS = UOM_CODES.map((u) => ({ value: u, label: u }));
const VAT_OPTIONS = Object.entries(VAT_CATEGORIES).map(([code, spec]) => ({
  value: code,
  label: `${code} — ${spec.label}`,
}));
const PAYMENT_OPTIONS = Object.entries(PAYMENT_MEANS).map(([code, label]) => ({
  value: code,
  label: `${code} — ${label}`,
}));

function optionsFor(field: string) {
  switch (field) {
    case 'invoiceType':
      return INVOICE_TYPE_OPTIONS;
    case 'buyerEmirate':
      return EMIRATE_OPTIONS;
    case 'currency':
      return CURRENCY_OPTIONS;
    case 'paymentMeans':
      return PAYMENT_OPTIONS;
    case 'uom':
      return UOM_OPTIONS;
    case 'vatCategory':
      return VAT_OPTIONS;
    default:
      return undefined;
  }
}

/** Index findings by the cell they belong to, so lookup during render is O(1). */
function indexFindings(row: StagedRow) {
  const byField = new Map<string, ValidationFindingDto[]>();
  for (const finding of row.findings) {
    const key = finding.lineId ? `${finding.lineId}:${finding.field}` : finding.field;
    const list = byField.get(key) ?? [];
    list.push(finding);
    byField.set(key, list);
  }
  return byField;
}

export function StagingGrid({
  rows,
  editable,
  saving,
  focusedCell,
  onEditInvoice,
  onEditLine,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = useCallback((rowId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }, []);

  const findingIndex = useMemo(() => {
    const map = new Map<string, Map<string, ValidationFindingDto[]>>();
    for (const row of rows) map.set(row.id, indexFindings(row));
    return map;
  }, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // An expanded row is taller by roughly its line count; a rough estimate is
    // fine because measureElement corrects it after the first paint.
    estimateSize: (index) => {
      const row = rows[index];
      if (!row) return 44;
      return expanded.has(row.id) ? 44 + 40 + row.invoice.lines.length * 36 : 44;
    },
    overscan: 8,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white py-16 text-center text-sm text-slate-500">
        No invoices to show.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      {/* Column headers, outside the scroll container so they stay put. */}
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
        <span className="w-6" />
        <span className="w-10 text-right">#</span>
        {HEADER_COLUMNS.map((column) => (
          <span key={column.field} className={cx(column.width, 'shrink-0')}>
            {column.label}
          </span>
        ))}
        <span className="w-28 shrink-0">Status</span>
      </div>

      <div ref={scrollRef} className="max-h-[62vh] overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;

            const isExpanded = expanded.has(row.id);
            const fields =
              findingIndex.get(row.id) ?? new Map<string, ValidationFindingDto[]>();
            const locked = !editable || !!row.invoiceId;

            return (
              <div
                key={row.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div
                  className={cx(
                    'flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-sm',
                    !row.submittable && 'bg-danger-50/30',
                    row.invoiceId && 'bg-slate-50',
                  )}
                >
                  <button
                    onClick={() => toggle(row.id)}
                    className="w-6 shrink-0 text-slate-400 hover:text-slate-700"
                    title={isExpanded ? 'Collapse line items' : 'Expand line items'}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? '▾' : '▸'}
                  </button>

                  <span className="w-10 shrink-0 text-right text-xs text-slate-400 tabular-nums">
                    {virtualRow.index + 1}
                  </span>

                  {HEADER_COLUMNS.map((column) => {
                    const value = String(
                      (row.invoice as unknown as Record<string, unknown>)[column.field] ?? '',
                    );
                    const cellFindings = fields.get(column.field) ?? [];

                    if (column.type === 'derived') {
                      return (
                        <span
                          key={column.field}
                          data-cell={`${row.id}:${column.field}`}
                          tabIndex={-1}
                          className={cx(
                            column.width,
                            'shrink-0 px-2 py-1 text-right font-medium tabular-nums',
                            cellFindings.length > 0 && 'cell-error rounded',
                          )}
                          title={cellFindings.map((f) => f.message).join('\n')}
                        >
                          {value ? formatAmount(value) : '—'}
                        </span>
                      );
                    }

                    return (
                      <EditableCell
                        key={column.field}
                        rowId={row.id}
                        field={column.field}
                        value={value}
                        type={column.type}
                        options={optionsFor(column.field)}
                        findings={cellFindings}
                        disabled={locked}
                        saving={saving}
                        focused={
                          focusedCell?.rowId === row.id && focusedCell.field === column.field
                        }
                        className={column.width}
                        onCommit={(next) => onEditInvoice(row.id, column.field, next)}
                      />
                    );
                  })}

                  <span className="w-28 shrink-0">
                    {row.invoiceId ? (
                      <StatusBadge status="SUBMITTED_TO_ASP" />
                    ) : row.submittable ? (
                      <StatusBadge status="VALIDATED" />
                    ) : (
                      <StatusBadge status="VALIDATION_FAILED" />
                    )}
                  </span>
                </div>

                {isExpanded && (
                  <LineItems
                    row={row}
                    fields={fields}
                    locked={locked}
                    saving={saving}
                    focusedCell={focusedCell}
                    onEditLine={onEditLine}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const LINE_COLUMNS = [
  { field: 'description', label: 'Description', width: 'w-56', type: 'text' as const },
  { field: 'quantity', label: 'Qty', width: 'w-20', type: 'number' as const },
  { field: 'uom', label: 'UOM', width: 'w-24', type: 'select' as const },
  { field: 'unitPrice', label: 'Unit price', width: 'w-28', type: 'number' as const },
  { field: 'lineDiscount', label: 'Discount', width: 'w-24', type: 'number' as const },
  { field: 'vatCategory', label: 'VAT category', width: 'w-40', type: 'select' as const },
  { field: 'vatRate', label: 'Rate %', width: 'w-20', type: 'derived' as const },
  { field: 'netAmount', label: 'Net', width: 'w-28', type: 'derived' as const },
  { field: 'vatAmount', label: 'VAT', width: 'w-24', type: 'derived' as const },
  { field: 'lineTotal', label: 'Line total', width: 'w-28', type: 'derived' as const },
];

function LineItems({
  row,
  fields,
  locked,
  saving,
  focusedCell,
  onEditLine,
}: {
  row: StagedRow;
  fields: Map<string, ValidationFindingDto[]>;
  locked: boolean;
  saving: boolean;
  focusedCell: { rowId: string; field: string } | null;
  onEditLine: (rowId: string, lineId: string, field: string, value: string) => void;
}) {
  return (
    <div className="border-b border-slate-200 bg-slate-50/70 px-3 py-2 pl-11">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span className="w-10">Line</span>
        {LINE_COLUMNS.map((column) => (
          <span key={column.field} className={cx(column.width, 'shrink-0')}>
            {column.label}
          </span>
        ))}
      </div>

      {row.invoice.lines.length === 0 && (
        <p className="py-2 text-sm text-danger-700">
          This invoice has no line items. Add them to the Invoice_Line_Items sheet and re-upload.
        </p>
      )}

      {row.invoice.lines.map((line) => (
        <div key={line.id} className="flex items-center gap-2 py-0.5 text-sm">
          <span className="w-10 shrink-0 text-xs text-slate-400 tabular-nums">
            {line.lineNumber}
          </span>

          {LINE_COLUMNS.map((column) => {
            const value = String((line as unknown as Record<string, unknown>)[column.field] ?? '');
            const cellFindings = fields.get(`${line.id}:${column.field}`) ?? [];

            if (column.type === 'derived') {
              return (
                <span
                  key={column.field}
                  data-cell={`${row.id}:${line.id}:${column.field}`}
                  className={cx(
                    column.width,
                    'shrink-0 px-2 py-1 text-right tabular-nums text-slate-600',
                    cellFindings.length > 0 && 'cell-error rounded',
                  )}
                  title={cellFindings.map((f) => f.message).join('\n')}
                >
                  {value ? (column.field === 'vatRate' ? value : formatAmount(value)) : '—'}
                </span>
              );
            }

            return (
              <EditableCell
                key={column.field}
                rowId={row.id}
                lineId={line.id}
                field={column.field}
                value={value}
                type={column.type}
                options={optionsFor(column.field)}
                findings={cellFindings}
                disabled={locked}
                saving={saving}
                focused={
                  focusedCell?.rowId === row.id && focusedCell.field === `${line.id}:${column.field}`
                }
                className={column.width}
                onCommit={(next) => onEditLine(row.id, line.id, column.field, next)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
