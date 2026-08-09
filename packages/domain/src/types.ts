import type {
  CurrencyCode,
  Emirate,
  InvoiceTypeCode,
  PaymentMeansCode,
  UomCode,
  VatCategoryCode,
} from './codes.js';

/**
 * The canonical staged invoice.
 *
 * Everything is a string, including amounts, because this shape is what comes
 * out of a spreadsheet cell and what goes into a grid input box. Coercion to
 * Decimal happens inside calc/validation, never at the boundary — that way an
 * unparseable cell survives long enough to be reported as a validation error
 * against its original Excel coordinate, instead of becoming NaN somewhere
 * downstream with no idea where it came from.
 */

export interface StagedLine {
  /** Stable id for grid editing; assigned at parse time. */
  id: string;
  lineNumber: string;
  description: string;
  hsCode: string;
  quantity: string;
  uom: UomCode | string;
  unitPrice: string;
  lineDiscount: string;
  vatCategory: VatCategoryCode | string;
  vatRate: string;
  /** Derived. Recomputed on every edit; never trusted from the upload. */
  netAmount: string;
  vatAmount: string;
  lineTotal: string;
  /** 1-based row in the Invoice_Line_Items sheet, for error mapping. */
  sourceRow: number | null;
}

export interface StagedInvoice {
  id: string;
  invoiceNumber: string;
  invoiceType: InvoiceTypeCode | string;
  issueDate: string;
  issueTime: string;
  currency: CurrencyCode | string;
  fxRate: string;
  supplierTrn: string;
  supplierName: string;
  buyerTrn: string;
  buyerName: string;
  buyerEmirate: Emirate | string;
  poReference: string;
  precedingInvoiceId: string;
  paymentMeans: PaymentMeansCode | string;
  lines: StagedLine[];
  /** Derived totals. */
  lineExtensionAmount: string;
  taxExclusiveAmount: string;
  vatTotalAmount: string;
  taxInclusiveAmount: string;
  payableAmount: string;
  payableAmountAed: string;
  /** 1-based row in the Invoice_Header sheet. */
  sourceRow: number | null;
}

export type ValidationSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'FATAL';

export type SheetName = 'Invoice_Header' | 'Invoice_Line_Items';

/**
 * A single validation finding, carrying enough location information to
 * highlight the exact cell in the grid AND to tell the user where it lives in
 * the workbook they uploaded.
 */
export interface ValidationFinding {
  ruleCode: string;
  severity: ValidationSeverity;
  message: string;
  /** Field on StagedInvoice, or `lines[i].field` for a line-level finding. */
  field: string;
  /** Id of the staged line, when the finding belongs to a line. */
  lineId?: string;
  sheet: SheetName;
  /** e.g. "I14" — sheet column letter + 1-based row. Null if unmappable. */
  cell: string | null;
  /** XPath into the generated UBL document, for parity with ASP error reports. */
  jsonPath?: string;
}

export interface InvoiceValidationResult {
  invoiceId: string;
  findings: ValidationFinding[];
  /** True when nothing above WARNING remains — i.e. this invoice may be sent. */
  submittable: boolean;
}

export const FATAL_SEVERITIES: ValidationSeverity[] = ['ERROR', 'FATAL'];

export function isBlocking(finding: ValidationFinding): boolean {
  return FATAL_SEVERITIES.includes(finding.severity);
}
