import type { InventoryStatement } from '@uae/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { renderReportXlsx } from '../../excel/report.js';
import { sendXlsx } from '../../excel/reply.js';
import { renderReportPdf } from '../../pdf/report.js';
import { sendPdf } from '../../pdf/reply.js';

/**
 * A statement flattened to columns and rows, so it can be typeset or written to
 * a workbook by the same code every other report uses.
 *
 * The two middle columns are named for the holder — the platform sells what a
 * partner allocates and a tenant consumes — exactly as the on-screen table
 * names them. A printed statement whose columns disagreed with the screen it
 * was printed from would be worse than no printout at all.
 */

const MOVEMENT_LABELS: Record<
  InventoryStatement['holderKind'],
  { in: string; out: string; holder: string }
> = {
  PLATFORM: { in: 'Buy', out: 'Sell', holder: 'Platform' },
  CHANNEL_PARTNER: { in: 'Buy', out: 'Allocated', holder: 'Channel partner' },
  ENTERPRISE_TENANT: { in: 'Buy', out: 'Consumed', holder: 'Enterprise tenant' },
  MANAGED_SUB_TENANT: { in: 'Allocated', out: 'Consumed', holder: 'Managed sub-tenant' },
};

export interface FlatStatement {
  columns: string[];
  /** Numbers stay numbers: a workbook column that cannot be summed is a picture. */
  rows: (string | number)[][];
  holderLabel: string;
  notes: string[];
}

export function flattenStatement(statement: InventoryStatement): FlatStatement {
  const labels = MOVEMENT_LABELS[statement.holderKind];

  const columns = ['Date', 'Reference', 'Description', 'Opening', labels.in, labels.out, 'Balance'];

  const rows: (string | number)[][] = statement.rows.map((row) => [
    row.date,
    row.reference,
    row.description,
    row.openingUnits,
    row.inUnits,
    row.outUnits,
    row.balanceUnits,
  ]);

  // The total is a row rather than a note: it is the line the reader is
  // checking, and in a spreadsheet it wants to sit under the column it foots.
  rows.push([
    'Period total',
    '',
    '',
    statement.openingUnits,
    statement.totalInUnits,
    statement.totalOutUnits,
    statement.closingUnits,
  ]);

  const notes: string[] = [];
  if (statement.omittedRows > 0) {
    notes.push(
      `${statement.omittedRows.toLocaleString()} earlier movements are folded into the opening balance. The balances are complete; the earliest lines are not listed.`,
    );
  }

  return { columns, rows, holderLabel: labels.holder, notes };
}

/** "1 Jan 2026 to 31 Mar 2026", or an honest description of an open end. */
export function statementPeriodLabel(statement: InventoryStatement): string {
  const { from, to, label } = statement.period;
  if (from && to) return `From ${from} to ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Up to ${to}`;
  return label || 'All dates';
}

/**
 * A statement on paper or in a workbook.
 *
 * Both dispositions come off the same loaded statement and the same flattening,
 * so the printed copy, the spreadsheet and the screen cannot disagree about
 * what a balance was — which is the only reason a printout is worth anything
 * once it has left the machine it was run on.
 */
export async function sendStatement(
  request: FastifyRequest,
  reply: FastifyReply,
  statement: InventoryStatement,
  format: 'pdf' | 'xlsx',
): Promise<FastifyReply> {
  const flat = flattenStatement(statement);
  const period = statementPeriodLabel(statement);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `data-inventory-${statement.holderName}-${stamp}`;

  if (format === 'xlsx') {
    return sendXlsx(
      reply,
      await renderReportXlsx({
        sheetName: 'Data inventory',
        title: 'Data Inventory Report',
        subtitle: flat.holderLabel,
        periodLabel: period,
        holderName: statement.holderName,
        columns: flat.columns,
        rows: flat.rows,
        notes: flat.notes,
      }),
      filename,
    );
  }

  const pdf = await renderReportPdf({
    // Not one of the §13.2 library reports; the key only names the file and
    // picks a tint, and inventory belongs to neither AR nor AP.
    key: 'ap-inbound-log',
    name: 'Data Inventory Report',
    module: 'BOTH',
    description: flat.holderLabel,
    columns: flat.columns,
    rows: flat.rows.map((row) => row.map((cell) => (typeof cell === 'number' ? cell.toLocaleString() : cell))),
    dateFrom: statement.period.from,
    dateTo: statement.period.to,
    tenantName: statement.holderName,
    platformName: config().PLATFORM_NAME,
    truncated: statement.omittedRows > 0,
  });

  return sendPdf(request, reply, pdf, filename);
}
