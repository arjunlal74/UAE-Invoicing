import { useQuery } from '@tanstack/react-query';
import { REPORT_CATALOG, type ReportKey } from '@uae/contracts';
import { useState } from 'react';
import { PdfActions } from '../../components/PdfActions';
import {
  Button,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Spinner,
  cx,
  inputClass,
} from '../../components/ui';
import { api, downloadBlob, queryString } from '../../lib/api';

/**
 * The §13.2 report library.
 *
 * Reports come back as columns and rows, and the CSV is produced in the browser
 * from exactly the data on screen — the export and the table cannot disagree
 * because they are the same array. The PDF is rendered server-side, where the
 * pagination and column fitting a printed table needs actually live, but from
 * the same query behind the same date filters, so it cannot drift either.
 */

interface ReportResult {
  key: ReportKey;
  name: string;
  module: 'AR' | 'AP' | 'BOTH';
  columns: string[];
  rows: string[][];
  /** The query hit its row cap and there may be more. */
  truncated: boolean;
}

const MODULE_STYLES: Record<string, string> = {
  AR: 'bg-brand-50 text-brand-700',
  AP: 'bg-ok-50 text-ok-700',
  BOTH: 'bg-slate-100 text-slate-600',
};

export function ReportLibraryPage() {
  const [selected, setSelected] = useState<ReportKey>('ap-inbound-log');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const { data, isFetching } = useQuery({
    queryKey: ['report', selected, dateFrom, dateTo],
    queryFn: () =>
      api<ReportResult>(`/api/v1/reports/${selected}${queryString({ dateFrom, dateTo })}`),
  });

  const exportCsv = () => {
    if (!data) return;
    const escape = (value: string) =>
      /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    const csv = [data.columns, ...data.rows]
      .map((row) => row.map((cell) => escape(String(cell ?? ''))).join(','))
      .join('\r\n');
    // A BOM, because these files are opened in Excel and Arabic supplier names
    // arrive as mojibake without one.
    downloadBlob(
      new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }),
      `${data.key}-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Report library"
        description="Standard AR and AP reports, filtered by issue date and exportable to CSV or PDF."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PdfActions
              path={`/api/v1/reports/${selected}/pdf${queryString({ dateFrom, dateTo })}`}
              disabled={!data?.rows.length}
              label="Export PDF"
            />
            <Button variant="primary" onClick={exportCsv} disabled={!data?.rows.length}>
              Export CSV
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[280px,1fr]">
        <Card title="Reports">
          <ul className="space-y-1">
            {REPORT_CATALOG.map((report) => (
              <li key={report.key}>
                <button
                  onClick={() => setSelected(report.key)}
                  className={cx(
                    'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                    report.key === selected
                      ? 'bg-brand-50 text-brand-800'
                      : 'text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{report.name}</span>
                    <span
                      className={cx(
                        'rounded-full px-1.5 text-xs font-medium',
                        MODULE_STYLES[report.module],
                      )}
                    >
                      {report.module}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">{report.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-4">
          <Card>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Issued on or after">
                <input
                  className={inputClass}
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </Field>
              <Field label="Issued on or before">
                <input
                  className={inputClass}
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </Field>
              {(dateFrom || dateTo) && (
                <div className="flex items-end">
                  <Button
                    onClick={() => {
                      setDateFrom('');
                      setDateTo('');
                    }}
                  >
                    Clear dates
                  </Button>
                </div>
              )}
            </div>
          </Card>

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            {isFetching ? (
              <div className="p-6">
                <Spinner label="Running report…" />
              </div>
            ) : !data?.rows.length ? (
              <EmptyState
                title="No rows"
                description="Nothing matched this report for the selected period."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      {data.columns.map((column) => (
                        <th key={column} className="whitespace-nowrap px-3 py-2 font-medium">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.rows.map((row, index) => (
                      <tr key={index}>
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className={cx(
                              'whitespace-nowrap px-3 py-1.5 text-slate-700',
                              // Numeric-looking cells right-align and get
                              // tabular figures so columns of money line up.
                              /^-?[\d,.]+$/.test(cell) && 'text-right tabular-nums',
                            )}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {data && data.rows.length > 0 && (
              <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
                {data.rows.length.toLocaleString()} row
                {data.rows.length === 1 ? '' : 's'}
                {data.truncated &&
                  ' — capped at the query limit. Narrow the date range to see the rest.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
