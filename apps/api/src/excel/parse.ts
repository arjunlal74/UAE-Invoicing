import { randomUUID } from 'node:crypto';
import {
  HEADER_COLUMNS,
  LINE_COLUMNS,
  normaliseHeader,
  recalcInvoice,
  type StagedInvoice,
  type StagedLine,
} from '@uae/domain';
import ExcelJS from 'exceljs';

/**
 * Workbook parsing.
 *
 * Uses the buffered reader rather than ExcelJS's streaming `WorkbookReader`.
 * Streaming would be the better fit for a 50MB upload, but that reader assumes
 * `workbook.xml` precedes the worksheet entries in the zip and throws when it
 * does not — measured here at roughly 6 failures in 8 runs against ExcelJS's
 * own output, varying run to run. A parser that non-deterministically rejects
 * valid files is not something to put in front of a tax filing.
 *
 * The memory cost is bounded instead by three things: the 50MB upload limit,
 * the row cap enforced below, and a worker concurrency of 2. Revisit if either
 * ExcelJS fixes the reader or file sizes grow.
 *
 * The parser never rejects a row for being wrong — that is validation's job,
 * and a row thrown away here could never be shown to the user in the grid for
 * correction. Everything is read as text and passed on; only structural
 * problems (missing sheet, unreadable file) fail the parse.
 */

export interface ParseResult {
  invoices: StagedInvoice[];
  /** Lines whose invoice number matches no header row. */
  orphanLines: { line: StagedLine; invoiceNumber: string }[];
  warnings: string[];
}

export class WorkbookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbookParseError';
  }
}

/**
 * Excel dates arrive as Date objects, serial numbers, or text depending on how
 * the cell was formatted. All three must land as YYYY-MM-DD or the user sees a
 * date error for a date they typed correctly.
 */
function cellToDateString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(
      value.getUTCDate(),
    ).padStart(2, '0')}`;
  }

  if (typeof value === 'number') {
    // Excel serial date: days since 1899-12-30 (its leap-year bug included).
    const ms = Math.round((value - 25_569) * 86_400_000);
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toISOString().slice(0, 10);
  }

  return cellToString(value).trim();
}

function cellToTimeString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) {
    return value.toISOString().slice(11, 19);
  }

  // A time-only cell is a fraction of a day.
  if (typeof value === 'number' && value >= 0 && value < 1) {
    const totalSeconds = Math.round(value * 86_400);
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  return cellToString(value).trim();
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    // A formula cell: take the cached result, since the formula text is useless
    // to us and the result is what the user saw on screen.
    if ('result' in value) {
      const result = (value as ExcelJS.CellFormulaValue).result;
      return result === undefined || result === null ? '' : cellToString(result as ExcelJS.CellValue);
    }
    if ('richText' in value) {
      return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    }
    if ('text' in value) return String((value as { text: unknown }).text ?? '');
    if ('error' in value) return '';
  }

  return String(value);
}

/**
 * Map the workbook's actual header row onto our expected fields.
 *
 * Column order is not assumed. Users move columns, and an upload that silently
 * read "Buyer TRN" out of the PO Reference column would be far worse than one
 * that fails.
 */
/**
 * Header fields that indicate a row was actually filled in by a user.
 *
 * Deliberately excludes supplierTrn, supplierName, currency and fxRate: the
 * generated template pre-fills those on every one of its blank rows, so
 * treating "any cell has a value" as "this row is real" would turn 200 rows of
 * template padding into 200 empty invoices.
 */
const MEANINGFUL_HEADER_FIELDS = [
  'invoiceNumber',
  'invoiceType',
  'issueDate',
  'issueTime',
  'buyerTrn',
  'buyerName',
  'buyerEmirate',
  'poReference',
  'precedingInvoiceId',
  'paymentMeans',
] as const;

function buildColumnMap(
  row: ExcelJS.Row,
  expected: typeof HEADER_COLUMNS,
): { map: Map<string, number>; missing: string[] } {
  const byNormalised = new Map<string, string>();
  for (const spec of expected) byNormalised.set(normaliseHeader(spec.header), spec.field);

  const map = new Map<string, number>();
  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const field = byNormalised.get(normaliseHeader(cellToString(cell.value)));
    if (field && !map.has(field)) map.set(field, colNumber);
  });

  const missing = expected
    .filter((spec) => spec.required !== 'derived' && !map.has(spec.field))
    .map((spec) => spec.header);

  return { map, missing };
}

function readByMap(row: ExcelJS.Row, map: Map<string, number>, field: string): ExcelJS.CellValue {
  const col = map.get(field);
  return col ? row.getCell(col).value : null;
}

export async function parseWorkbook(
  buffer: Buffer,
  options: { maxRows: number },
): Promise<ParseResult> {
  const warnings: string[] = [];
  const headerByInvoiceNumber = new Map<string, StagedInvoice>();
  const invoices: StagedInvoice[] = [];
  const orphanLines: { line: StagedLine; invoiceNumber: string }[] = [];

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (err) {
    throw new WorkbookParseError(
      `This file could not be opened as an Excel workbook (${(err as Error).message}). Make sure it is a .xlsx file and not a renamed .csv or a password-protected workbook.`,
    );
  }

  const findSheet = (wanted: string) =>
    workbook.worksheets.find((w) => normaliseHeader(w.name) === normaliseHeader(wanted));

  const headerSheet = findSheet('Invoice_Header');
  const lineSheet = findSheet('Invoice_Line_Items');

  let totalRows = 0;

  // Lines are collected first and joined afterwards, so the sheets may be in
  // any order and a forward reference still resolves.
  const pendingLines: { invoiceNumber: string; line: StagedLine }[] = [];

  if (headerSheet) {
    const built = buildColumnMap(headerSheet.getRow(1), HEADER_COLUMNS);
    if (built.missing.length > 0) {
      throw new WorkbookParseError(
        `The Invoice_Header sheet is missing these columns: ${built.missing.join(', ')}. Download a fresh template if in doubt.`,
      );
    }
    const columnMap = built.map;

    const rows: ExcelJS.Row[] = [];
    headerSheet.eachRow({ includeEmpty: false }, (row) => {
      if (row.number > 1) rows.push(row);
    });

    for (const row of rows) {
      const invoiceNumber = cellToString(readByMap(row, columnMap, 'invoiceNumber')).trim();

      const meaningful = MEANINGFUL_HEADER_FIELDS.some(
        (field) => cellToString(readByMap(row, columnMap, field)).trim() !== '',
      );
      if (!meaningful) continue;

      if (++totalRows > options.maxRows) {
        throw new WorkbookParseError(
          `This file contains more than ${options.maxRows.toLocaleString()} rows. Split it into smaller uploads.`,
        );
      }

      const invoice: StagedInvoice = {
          id: randomUUID(),
          invoiceNumber,
          invoiceType: cellToString(readByMap(row, columnMap, 'invoiceType')).trim(),
          issueDate: cellToDateString(readByMap(row, columnMap, 'issueDate')),
          issueTime: cellToTimeString(readByMap(row, columnMap, 'issueTime')),
          currency: cellToString(readByMap(row, columnMap, 'currency')).trim(),
          fxRate: cellToString(readByMap(row, columnMap, 'fxRate')).trim(),
          supplierTrn: cellToString(readByMap(row, columnMap, 'supplierTrn')).trim(),
          supplierName: cellToString(readByMap(row, columnMap, 'supplierName')).trim(),
          buyerTrn: cellToString(readByMap(row, columnMap, 'buyerTrn')).trim(),
          buyerName: cellToString(readByMap(row, columnMap, 'buyerName')).trim(),
          buyerEmirate: cellToString(readByMap(row, columnMap, 'buyerEmirate')).trim(),
          poReference: cellToString(readByMap(row, columnMap, 'poReference')).trim(),
          precedingInvoiceId: cellToString(readByMap(row, columnMap, 'precedingInvoiceId')).trim(),
          paymentMeans: cellToString(readByMap(row, columnMap, 'paymentMeans')).trim(),
          lines: [],
          lineExtensionAmount: '',
          taxExclusiveAmount: '',
          vatTotalAmount: '',
          taxInclusiveAmount: '',
          payableAmount: '',
          payableAmountAed: '',
          sourceRow: row.number,
        };

      if (invoiceNumber && headerByInvoiceNumber.has(invoiceNumber)) {
        // Kept rather than dropped: validation reports the duplicate against
        // both rows, which is what lets the user see and fix it.
        warnings.push(`Invoice number ${invoiceNumber} appears on more than one header row.`);
      } else if (invoiceNumber) {
        headerByInvoiceNumber.set(invoiceNumber, invoice);
      }

      invoices.push(invoice);
    }
  }

  if (lineSheet) {
    const built = buildColumnMap(lineSheet.getRow(1), LINE_COLUMNS);
    if (built.missing.length > 0) {
      throw new WorkbookParseError(
        `The Invoice_Line_Items sheet is missing these columns: ${built.missing.join(', ')}.`,
      );
    }
    const columnMap = built.map;

    const rows: ExcelJS.Row[] = [];
    lineSheet.eachRow({ includeEmpty: false }, (row) => {
      if (row.number > 1) rows.push(row);
    });

    for (const row of rows) {
      const invoiceNumber = cellToString(readByMap(row, columnMap, 'invoiceNumber')).trim();
      const description = cellToString(readByMap(row, columnMap, 'description')).trim();
      const quantity = cellToString(readByMap(row, columnMap, 'quantity')).trim();
      const unitPrice = cellToString(readByMap(row, columnMap, 'unitPrice')).trim();

      // The template pre-formats hundreds of blank rows; a row with none of the
      // fields a user would actually type is padding. UOM, VAT category and
      // discount are excluded because the template pre-fills them.
      if (!invoiceNumber && !description && !quantity && !unitPrice) continue;

      if (++totalRows > options.maxRows) {
        throw new WorkbookParseError(
          `This file contains more than ${options.maxRows.toLocaleString()} rows. Split it into smaller uploads.`,
        );
      }

      const line: StagedLine = {
          id: randomUUID(),
          lineNumber: cellToString(readByMap(row, columnMap, 'lineNumber')).trim(),
          description,
          hsCode: cellToString(readByMap(row, columnMap, 'hsCode')).trim(),
          quantity,
          uom: cellToString(readByMap(row, columnMap, 'uom')).trim(),
          unitPrice,
          lineDiscount: cellToString(readByMap(row, columnMap, 'lineDiscount')).trim(),
          vatCategory: cellToString(readByMap(row, columnMap, 'vatCategory')).trim(),
          vatRate: cellToString(readByMap(row, columnMap, 'vatRate')).trim(),
          // Derived values are read as supplied so validation can compare them
          // against the recalculated figures and catch an unlocked template.
          netAmount: cellToString(readByMap(row, columnMap, 'netAmount')).trim(),
          vatAmount: cellToString(readByMap(row, columnMap, 'vatAmount')).trim(),
          lineTotal: cellToString(readByMap(row, columnMap, 'lineTotal')).trim(),
        sourceRow: row.number,
      };

      pendingLines.push({ invoiceNumber, line });
    }
  }

  if (!headerSheet) {
    throw new WorkbookParseError(
      'No sheet named Invoice_Header was found. Use the template from the portal.',
    );
  }
  if (!lineSheet) {
    throw new WorkbookParseError(
      'No sheet named Invoice_Line_Items was found. Use the template from the portal.',
    );
  }

  for (const { invoiceNumber, line } of pendingLines) {
    const invoice = headerByInvoiceNumber.get(invoiceNumber);
    if (invoice) invoice.lines.push(line);
    else orphanLines.push({ line, invoiceNumber });
  }

  // Order lines as the user numbered them, falling back to sheet order so the
  // grid never reshuffles rows unpredictably.
  for (const invoice of invoices) {
    invoice.lines.sort((a, b) => {
      const na = Number(a.lineNumber);
      const nb = Number(b.lineNumber);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return (a.sourceRow ?? 0) - (b.sourceRow ?? 0);
    });
  }

  return {
    invoices: invoices.map(recalcInvoice),
    orphanLines,
    warnings,
  };
}
