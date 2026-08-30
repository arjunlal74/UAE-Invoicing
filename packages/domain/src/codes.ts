/**
 * UAE PINT-AE code lists.
 *
 * These mirror the `Ref_Lookups` sheet of the FTA Excel template exactly. The
 * template's dropdowns are generated from this file, the parser validates
 * against it, and the portal's pickers render from it — so there is one
 * definition of "which codes are legal" rather than three that can drift.
 */

/** UBL InvoiceTypeCode (/Invoice/cbc:InvoiceTypeCode). */
export const INVOICE_TYPE_CODES = ['380', '388', '381', '383'] as const;
export type InvoiceTypeCode = (typeof INVOICE_TYPE_CODES)[number];

export const INVOICE_TYPES: Record<
  InvoiceTypeCode,
  { label: string; dbValue: InvoiceTypeDb; requiresBuyerTrn: boolean; requiresPrecedingInvoice: boolean }
> = {
  '380': {
    label: 'Commercial Tax Invoice (B2B)',
    dbValue: 'TAX_INVOICE',
    requiresBuyerTrn: true,
    requiresPrecedingInvoice: false,
  },
  '388': {
    label: 'Simplified Tax Invoice (B2C)',
    dbValue: 'SIMPLIFIED_TAX_INVOICE',
    requiresBuyerTrn: false,
    requiresPrecedingInvoice: false,
  },
  '381': {
    label: 'Credit Note',
    dbValue: 'CREDIT_NOTE',
    requiresBuyerTrn: true,
    requiresPrecedingInvoice: true,
  },
  '383': {
    label: 'Debit Note',
    dbValue: 'DEBIT_NOTE',
    requiresBuyerTrn: true,
    requiresPrecedingInvoice: true,
  },
};

export type InvoiceTypeDb =
  | 'TAX_INVOICE'
  | 'SIMPLIFIED_TAX_INVOICE'
  | 'CREDIT_NOTE'
  | 'DEBIT_NOTE';

/** UBL ClassifiedTaxCategory/cbc:ID. */
export const VAT_CATEGORY_CODES = ['S', 'Z', 'E', 'O'] as const;
export type VatCategoryCode = (typeof VAT_CATEGORY_CODES)[number];

export type VatCategoryDb = 'STANDARD' | 'ZERO_RATED' | 'EXEMPT' | 'OUT_OF_SCOPE';

export const VAT_CATEGORIES: Record<
  VatCategoryCode,
  { label: string; rate: number; dbValue: VatCategoryDb; taxExemptionReason?: string }
> = {
  S: { label: 'Standard Rate (5%)', rate: 5, dbValue: 'STANDARD' },
  Z: { label: 'Zero Rated (0%)', rate: 0, dbValue: 'ZERO_RATED' },
  E: {
    label: 'Exempt',
    rate: 0,
    dbValue: 'EXEMPT',
    taxExemptionReason: 'Exempt supply under UAE VAT law',
  },
  O: {
    label: 'Out of Scope',
    rate: 0,
    dbValue: 'OUT_OF_SCOPE',
    taxExemptionReason: 'Outside the scope of UAE VAT',
  },
};

/** The rate a category must carry. Used by both validation and the grid's live recalc. */
export function expectedVatRate(category: VatCategoryCode): number {
  return VAT_CATEGORIES[category].rate;
}

/** UBL PaymentMeansCode. */
export const PAYMENT_MEANS_CODES = ['10', '30', '42', '48'] as const;
export type PaymentMeansCode = (typeof PAYMENT_MEANS_CODES)[number];

export const PAYMENT_MEANS: Record<PaymentMeansCode, string> = {
  '10': 'Cash',
  '30': 'Credit Transfer / Bank',
  '42': 'Bank Cheque',
  '48': 'Payment Card',
};

export const EMIRATES = [
  'Dubai',
  'Abu Dhabi',
  'Sharjah',
  'Ajman',
  'Ras Al Khaimah',
  'Fujairah',
  'Umm Al Quwain',
] as const;
export type Emirate = (typeof EMIRATES)[number];

export const UOM_CODES = ['PCE', 'HUR', 'KGM', 'DAY', 'MON'] as const;
export type UomCode = (typeof UOM_CODES)[number];

export const UOMS: Record<UomCode, string> = {
  PCE: 'Piece',
  HUR: 'Hours',
  KGM: 'Kilograms',
  DAY: 'Days',
  MON: 'Months',
};

export const CURRENCY_CODES = ['AED', 'USD', 'EUR', 'GBP', 'SAR'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const BASE_CURRENCY = 'AED';

/**
 * A UAE Tax Registration Number: exactly 15 digits beginning with 1.
 * Deliberately not a loose /^\d{15}$/ — the leading digit is part of the rule
 * the FTA enforces, and catching it at upload is the entire value of the
 * staging grid.
 */
export const TRN_PATTERN = /^1\d{14}$/;

/**
 * The UAE Peppol scheme code. Joined to the TIN, it is a business's address on
 * the network.
 */
export const PEPPOL_SCHEME_AE = '0235';

/**
 * A tenant's participant identifier, derived from its TRN.
 *
 * The TIN is the first ten digits of the fifteen-digit TRN, and the identifier
 * is the scheme code joined to it — `0235:1002938475`. Not a copy of the TRN,
 * and not something to be guessed at a call site: getting the length wrong
 * addresses a document to a business that does not exist.
 *
 * Null for anything that is not a valid TRN. A channel partner has none because
 * it never files, and half a TRN is not half an address.
 */
export function participantIdFromTrn(trn: string | null | undefined): string | null {
  if (!trn || !TRN_PATTERN.test(trn.trim())) return null;
  return `${PEPPOL_SCHEME_AE}:${trn.trim().slice(0, 10)}`;
}

export function isValidTrn(value: string | null | undefined): boolean {
  return typeof value === 'string' && TRN_PATTERN.test(value.trim());
}

/** Invoice numbers per the template: alphanumerics, dash and slash only. */
export const INVOICE_NUMBER_PATTERN = /^[A-Za-z0-9\-/]+$/;

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
