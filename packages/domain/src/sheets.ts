import type { SheetName } from './types.js';

/**
 * Workbook layout — the single source of truth for the .xlsx template.
 *
 * The template generator writes these headers, the parser reads by these
 * columns, and validation findings resolve back to these letters so the error
 * sidebar can say "Sheet: Invoice_Line_Items | Cell: I14" and have it match
 * what the user sees when they open their own file.
 */

export interface ColumnSpec {
  /** Excel column letter. */
  col: string;
  /** Header text written into row 1. */
  header: string;
  /** Corresponding field on the staged model. */
  field: string;
  required: 'yes' | 'no' | 'conditional' | 'derived';
  width: number;
  /** Shown in the template's header comment and the portal's field help. */
  hint: string;
}

export const HEADER_SHEET: SheetName = 'Invoice_Header';
export const LINES_SHEET: SheetName = 'Invoice_Line_Items';
export const LOOKUPS_SHEET = 'Ref_Lookups';

export const HEADER_COLUMNS: ColumnSpec[] = [
  { col: 'A', header: 'Invoice Number', field: 'invoiceNumber', required: 'yes', width: 22, hint: 'Unique per tenant. Letters, digits, - and / only.' },
  { col: 'B', header: 'Invoice Type', field: 'invoiceType', required: 'yes', width: 14, hint: '380 Tax, 388 Simplified, 381 Credit, 383 Debit' },
  { col: 'C', header: 'Issue Date', field: 'issueDate', required: 'yes', width: 14, hint: 'YYYY-MM-DD' },
  { col: 'D', header: 'Issue Time', field: 'issueTime', required: 'yes', width: 12, hint: 'HH:MM:SS' },
  { col: 'E', header: 'Document Currency', field: 'currency', required: 'yes', width: 18, hint: 'Defaults to AED' },
  { col: 'F', header: 'FX Rate to AED', field: 'fxRate', required: 'conditional', width: 16, hint: 'Required when currency is not AED' },
  { col: 'G', header: 'Supplier TRN', field: 'supplierTrn', required: 'yes', width: 20, hint: '15 digits starting with 1' },
  { col: 'H', header: 'Supplier Name', field: 'supplierName', required: 'yes', width: 30, hint: 'Max 255 characters' },
  { col: 'I', header: 'Buyer TRN', field: 'buyerTrn', required: 'conditional', width: 20, hint: 'Required for B2B (380/381/383)' },
  { col: 'J', header: 'Buyer Name', field: 'buyerName', required: 'yes', width: 30, hint: 'Max 255 characters' },
  { col: 'K', header: 'Buyer Emirate', field: 'buyerEmirate', required: 'yes', width: 18, hint: 'One of the seven emirates' },
  { col: 'L', header: 'PO Reference', field: 'poReference', required: 'no', width: 18, hint: 'Free text' },
  { col: 'M', header: 'Preceding Invoice ID', field: 'precedingInvoiceId', required: 'conditional', width: 22, hint: 'Required for credit (381) and debit (383) notes' },
  { col: 'N', header: 'Payment Means', field: 'paymentMeans', required: 'yes', width: 16, hint: '10 Cash, 30 Transfer, 42 Cheque, 48 Card' },
];

export const LINE_COLUMNS: ColumnSpec[] = [
  { col: 'A', header: 'Invoice Number', field: 'invoiceNumber', required: 'yes', width: 22, hint: 'Must match a row in Invoice_Header' },
  { col: 'B', header: 'Line Number', field: 'lineNumber', required: 'yes', width: 12, hint: 'Sequential per invoice: 1, 2, 3...' },
  { col: 'C', header: 'Item Description', field: 'description', required: 'yes', width: 36, hint: 'Max 500 characters' },
  { col: 'D', header: 'HS Code', field: 'hsCode', required: 'no', width: 14, hint: 'Harmonized System customs code' },
  { col: 'E', header: 'Quantity', field: 'quantity', required: 'yes', width: 12, hint: 'Greater than zero, up to 4 decimals' },
  { col: 'F', header: 'UOM', field: 'uom', required: 'yes', width: 10, hint: 'PCE, HUR, KGM, DAY, MON' },
  { col: 'G', header: 'Unit Price (Net)', field: 'unitPrice', required: 'yes', width: 16, hint: 'Excluding VAT' },
  { col: 'H', header: 'Line Discount', field: 'lineDiscount', required: 'no', width: 14, hint: 'Defaults to 0.00' },
  { col: 'I', header: 'VAT Category', field: 'vatCategory', required: 'yes', width: 14, hint: 'S Standard, Z Zero, E Exempt, O Out of scope' },
  { col: 'J', header: 'VAT Rate (%)', field: 'vatRate', required: 'yes', width: 14, hint: 'Derived from the VAT category' },
  { col: 'K', header: 'Line Net Amount', field: 'netAmount', required: 'derived', width: 18, hint: '(Quantity x Unit Price) - Discount' },
  { col: 'L', header: 'Line VAT Amount', field: 'vatAmount', required: 'derived', width: 18, hint: 'Net x VAT rate' },
  { col: 'M', header: 'Line Grand Total', field: 'lineTotal', required: 'derived', width: 18, hint: 'Net + VAT' },
];

const headerFieldToCol = new Map(HEADER_COLUMNS.map((c) => [c.field, c.col]));
const lineFieldToCol = new Map(LINE_COLUMNS.map((c) => [c.field, c.col]));

/**
 * Resolve a staged-model field to its Excel cell reference.
 * Returns null when the row is unknown (e.g. a line added by hand in the grid
 * that never existed in the uploaded workbook) — the sidebar then shows the
 * field name instead of a fake coordinate.
 */
export function cellRef(sheet: SheetName, field: string, row: number | null): string | null {
  if (row === null || row < 1) return null;
  const col = sheet === HEADER_SHEET ? headerFieldToCol.get(field) : lineFieldToCol.get(field);
  return col ? `${col}${row}` : null;
}

export function headerColumnIndex(field: string): number {
  const idx = HEADER_COLUMNS.findIndex((c) => c.field === field);
  return idx === -1 ? -1 : idx + 1;
}

export function lineColumnIndex(field: string): number {
  const idx = LINE_COLUMNS.findIndex((c) => c.field === field);
  return idx === -1 ? -1 : idx + 1;
}

/** Normalise a spreadsheet header cell for tolerant matching. */
export function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}
