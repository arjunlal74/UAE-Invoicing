import { recalcInvoice } from '../calc.js';
import {
  CURRENCY_CODES,
  EMIRATES,
  INVOICE_NUMBER_PATTERN,
  INVOICE_TYPES,
  ISO_DATE_PATTERN,
  ISO_TIME_PATTERN,
  isValidTrn,
  PAYMENT_MEANS,
  UOM_CODES,
  VAT_CATEGORIES,
  expectedVatRate,
  type InvoiceTypeCode,
  type VatCategoryCode,
} from '../codes.js';
import { Decimal, amountsEqual, toDecimal } from '../money.js';
import { HEADER_SHEET, LINES_SHEET, cellRef } from '../sheets.js';
import {
  isBlocking,
  type InvoiceValidationResult,
  type StagedInvoice,
  type StagedLine,
  type ValidationFinding,
} from '../types.js';
import { RULES, type RuleDefinition } from './catalog.js';

/**
 * Context the rules need but the invoice itself does not carry.
 */
export interface ValidationContext {
  /** The tenant's registered TRN — supplier TRN on every invoice must match. */
  tenantTrn: string;
  /**
   * Invoice numbers already accepted for this tenant, so a re-upload of the
   * same file is caught in the grid rather than by a unique-violation at
   * insert time (or worse, by the FTA as a duplicate filing).
   */
  existingInvoiceNumbers?: Set<string>;
  /** Invoice numbers seen elsewhere in the same batch. */
  batchInvoiceNumbers?: Map<string, number>;
  /** Today, injected so validation is deterministic and testable. */
  today?: Date;
  /** Above this AED amount a simplified invoice draws a warning. */
  simplifiedInvoiceWarnThreshold?: number;
}

function finding(
  rule: RuleDefinition,
  message: string,
  field: string,
  sheet: typeof HEADER_SHEET | typeof LINES_SHEET,
  row: number | null,
  lineId?: string,
): ValidationFinding {
  return {
    ruleCode: rule.code,
    severity: rule.severity,
    message,
    field,
    lineId,
    sheet,
    cell: cellRef(sheet, field, row),
    jsonPath: rule.xpath,
  };
}

function isBlank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === '';
}

/**
 * Validate one staged invoice.
 *
 * Runs against the recalculated invoice so that derived totals are always
 * self-consistent; the arithmetic rules then compare what the user supplied in
 * the workbook against what the formulas produce.
 */
export function validateInvoice(
  input: StagedInvoice,
  ctx: ValidationContext,
): InvoiceValidationResult {
  const invoice = recalcInvoice(input);
  const findings: ValidationFinding[] = [];
  const hRow = invoice.sourceRow;
  const push = (
    rule: RuleDefinition,
    message: string,
    field: string,
    row = hRow,
    lineId?: string,
    sheet: typeof HEADER_SHEET | typeof LINES_SHEET = HEADER_SHEET,
  ) => findings.push(finding(rule, message, field, sheet, row, lineId));

  // --- Invoice number ------------------------------------------------------
  const invNo = invoice.invoiceNumber?.trim() ?? '';
  if (isBlank(invNo)) {
    push(RULES.INVOICE_NUMBER_REQUIRED, 'Invoice number is required.', 'invoiceNumber');
  } else {
    if (!INVOICE_NUMBER_PATTERN.test(invNo)) {
      push(
        RULES.INVOICE_NUMBER_FORMAT,
        `Invoice number '${invNo}' may only contain letters, digits, hyphen and slash.`,
        'invoiceNumber',
      );
    }
    if (ctx.existingInvoiceNumbers?.has(invNo)) {
      push(
        RULES.INVOICE_NUMBER_DUPLICATE,
        `Invoice number '${invNo}' has already been submitted. Submitting it again would file a duplicate with the FTA.`,
        'invoiceNumber',
      );
    }
    if ((ctx.batchInvoiceNumbers?.get(invNo) ?? 0) > 1) {
      push(
        RULES.INVOICE_NUMBER_DUPLICATE,
        `Invoice number '${invNo}' appears more than once in this upload.`,
        'invoiceNumber',
      );
    }
  }

  // --- Type ----------------------------------------------------------------
  const typeCode = invoice.invoiceType?.trim() as InvoiceTypeCode;
  const typeSpec = INVOICE_TYPES[typeCode];
  /**
   * A credit or debit note reverses value rather than creating it, so its line
   * amounts are negative (SRS v2.7 §8.1). The sign rules below therefore have
   * to be read the other way round for these documents: a positive unit price
   * on a 381 would *increase* what the buyer owes, which is precisely the
   * mistake worth catching.
   */
  const isReversal = typeSpec?.requiresPrecedingInvoice === true;
  if (!typeSpec) {
    push(
      RULES.INVOICE_TYPE_INVALID,
      `'${invoice.invoiceType}' is not a valid invoice type. Use 380, 388, 381 or 383.`,
      'invoiceType',
    );
  }

  // --- Dates ---------------------------------------------------------------
  const issueDate = invoice.issueDate?.trim() ?? '';
  if (!ISO_DATE_PATTERN.test(issueDate) || Number.isNaN(Date.parse(issueDate))) {
    push(RULES.ISSUE_DATE_INVALID, 'Issue date must be a real date in YYYY-MM-DD format.', 'issueDate');
  } else {
    const today = ctx.today ?? new Date();
    const issued = new Date(`${issueDate}T00:00:00Z`);
    const todayUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    const dayMs = 86_400_000;
    if (issued.getTime() > todayUtc.getTime()) {
      push(RULES.ISSUE_DATE_FUTURE, `Issue date ${issueDate} is in the future.`, 'issueDate');
    } else if ((todayUtc.getTime() - issued.getTime()) / dayMs > 14) {
      push(
        RULES.BACKDATED_INVOICE,
        `Issue date ${issueDate} is more than 14 days ago. Confirm this is intentional.`,
        'issueDate',
      );
    }
  }

  if (!ISO_TIME_PATTERN.test(invoice.issueTime?.trim() ?? '')) {
    push(RULES.ISSUE_TIME_INVALID, 'Issue time must be in HH:MM:SS format.', 'issueTime');
  }

  // --- Currency and FX -----------------------------------------------------
  const currency = invoice.currency?.trim().toUpperCase() ?? '';
  if (!(CURRENCY_CODES as readonly string[]).includes(currency)) {
    push(
      RULES.CURRENCY_INVALID,
      `Currency '${invoice.currency}' is not supported. Use one of ${CURRENCY_CODES.join(', ')}.`,
      'currency',
    );
  } else if (currency !== 'AED') {
    const fx = toDecimal(invoice.fxRate);
    if (fx === null || fx.lessThanOrEqualTo(0)) {
      push(
        RULES.FX_RATE_REQUIRED,
        `An exchange rate to AED is required when the invoice currency is ${currency}.`,
        'fxRate',
      );
    }
  }

  // --- Supplier ------------------------------------------------------------
  const supplierTrn = invoice.supplierTrn?.trim() ?? '';
  if (!isValidTrn(supplierTrn)) {
    push(
      RULES.SUPPLIER_TRN_INVALID,
      `Supplier TRN '${supplierTrn}' must be exactly 15 digits starting with 1.`,
      'supplierTrn',
    );
  } else if (ctx.tenantTrn && supplierTrn !== ctx.tenantTrn) {
    push(
      RULES.SUPPLIER_TRN_MISMATCH,
      `Supplier TRN '${supplierTrn}' does not match your registered TRN '${ctx.tenantTrn}'.`,
      'supplierTrn',
    );
  }
  if (isBlank(invoice.supplierName)) {
    push(RULES.SUPPLIER_NAME_REQUIRED, 'Supplier name is required.', 'supplierName');
  }

  // --- Buyer ---------------------------------------------------------------
  const buyerTrn = invoice.buyerTrn?.trim() ?? '';
  if (typeSpec?.requiresBuyerTrn) {
    if (isBlank(buyerTrn)) {
      push(
        RULES.BUYER_TRN_REQUIRED,
        `Buyer TRN is mandatory for a ${typeSpec.label}.`,
        'buyerTrn',
      );
    } else if (!isValidTrn(buyerTrn)) {
      push(
        RULES.BUYER_TRN_INVALID,
        `Buyer TRN '${buyerTrn}' must be exactly 15 digits starting with 1.`,
        'buyerTrn',
      );
    }
  } else if (!isBlank(buyerTrn) && !isValidTrn(buyerTrn)) {
    push(
      RULES.BUYER_TRN_INVALID,
      `Buyer TRN '${buyerTrn}' must be exactly 15 digits starting with 1, or left blank for a B2C sale.`,
      'buyerTrn',
    );
  } else if (isBlank(buyerTrn)) {
    push(
      RULES.B2C_NO_BUYER_TRN,
      'No buyer TRN supplied — this will be filed as a simplified B2C invoice.',
      'buyerTrn',
    );
  }

  if (isBlank(invoice.buyerName)) {
    push(RULES.BUYER_NAME_REQUIRED, 'Buyer name is required.', 'buyerName');
  }
  if (!(EMIRATES as readonly string[]).includes(invoice.buyerEmirate?.trim() ?? '')) {
    push(
      RULES.BUYER_EMIRATE_INVALID,
      `'${invoice.buyerEmirate}' is not a UAE emirate.`,
      'buyerEmirate',
    );
  }

  // --- Payment means -------------------------------------------------------
  if (!(invoice.paymentMeans?.trim() in PAYMENT_MEANS)) {
    push(
      RULES.PAYMENT_MEANS_INVALID,
      `Payment means '${invoice.paymentMeans}' is not recognised. Use 10, 30, 42 or 48.`,
      'paymentMeans',
    );
  }

  // --- Credit / debit note references --------------------------------------
  if (typeSpec?.requiresPrecedingInvoice && isBlank(invoice.precedingInvoiceId)) {
    push(
      RULES.PRECEDING_INVOICE_REQUIRED,
      `A ${typeSpec.label} must reference the original invoice it adjusts.`,
      'precedingInvoiceId',
    );
  }

  // --- Lines ---------------------------------------------------------------
  if (invoice.lines.length === 0) {
    push(RULES.NO_LINES, 'This invoice has no line items.', 'lines');
  }

  const seenLineNumbers = new Map<string, number>();
  for (const line of invoice.lines) {
    seenLineNumbers.set(line.lineNumber, (seenLineNumbers.get(line.lineNumber) ?? 0) + 1);
  }

  for (const line of invoice.lines) {
    findings.push(...validateLine(line, input, seenLineNumbers, isReversal));
  }

  // --- Invoice-level arithmetic --------------------------------------------
  // Two distinct failures land on the header's payable amount, both so that the
  // collapsed master grid flags the invoice without the user expanding it:
  //
  //   1. A line could not be computed at all (non-numeric quantity or price).
  //      Its own cell is already flagged, but the header total is then a lie —
  //      it silently omits that line.
  //   2. The totals the workbook itself carried disagree with the recalculated
  //      ones. That means the template's locked columns were unlocked and
  //      overtyped, which is exactly the tampering the FTA arithmetic rule
  //      exists to catch.
  const uncomputable = invoice.lines.filter((l) => l.lineTotal === '');
  if (uncomputable.length > 0) {
    const numbers = uncomputable.map((l) => l.lineNumber || '?').join(', ');
    push(
      RULES.TOTALS_MISMATCH,
      `The invoice total excludes line ${numbers}, which could not be calculated. Fix the highlighted line before submitting.`,
      'payableAmount',
    );
  }

  const suppliedLineTotals = input.lines
    .map((l) => toDecimal(l.lineTotal))
    .filter((d): d is Decimal => d !== null);
  if (
    uncomputable.length === 0 &&
    suppliedLineTotals.length === input.lines.length &&
    input.lines.length > 0
  ) {
    const suppliedSum = suppliedLineTotals.reduce<Decimal>((a, d) => a.plus(d), new Decimal(0));
    if (!amountsEqual(suppliedSum, invoice.payableAmount)) {
      push(
        RULES.TOTALS_MISMATCH,
        `The line totals in your file add up to ${suppliedSum.toFixed(2)}, but recalculating them from quantity, price and VAT gives ${invoice.payableAmount}. The calculated columns appear to have been overwritten.`,
        'payableAmount',
      );
    }
  }

  const payable = toDecimal(invoice.payableAmount);
  if (payable !== null && payable.isZero() && invoice.lines.length > 0) {
    push(RULES.ZERO_VALUE_INVOICE, 'This invoice totals zero.', 'payableAmount');
  }

  const threshold = ctx.simplifiedInvoiceWarnThreshold ?? 10_000;
  if (
    typeCode === '388' &&
    payable !== null &&
    payable.greaterThan(threshold)
  ) {
    push(
      RULES.LARGE_B2C_AMOUNT,
      `Simplified invoice of ${invoice.payableAmount} ${currency} exceeds ${threshold}. Confirm a full tax invoice is not required.`,
      'payableAmount',
    );
  }

  return {
    invoiceId: invoice.id,
    findings,
    submittable: !findings.some(isBlocking),
  };
}

function validateLine(
  line: StagedLine,
  original: StagedInvoice,
  seenLineNumbers: Map<string, number>,
  isReversal: boolean,
): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const row = line.sourceRow;
  const supplied = original.lines.find((l) => l.id === line.id);
  const push = (rule: RuleDefinition, message: string, field: string) =>
    out.push(finding(rule, message, field, LINES_SHEET, row, line.id));

  if ((seenLineNumbers.get(line.lineNumber) ?? 0) > 1) {
    push(
      RULES.LINE_NUMBER_DUPLICATE,
      `Line number ${line.lineNumber} appears more than once on invoice ${original.invoiceNumber}.`,
      'lineNumber',
    );
  }

  if (isBlank(line.description)) {
    push(RULES.LINE_DESCRIPTION_REQUIRED, 'Item description is required.', 'description');
  } else if (line.description.length > 500) {
    push(
      RULES.LINE_DESCRIPTION_REQUIRED,
      `Item description is ${line.description.length} characters; the maximum is 500.`,
      'description',
    );
  }

  const qty = toDecimal(line.quantity);
  if (qty === null) {
    push(RULES.LINE_QUANTITY_INVALID, `Quantity '${line.quantity}' is not a number.`, 'quantity');
  } else if (qty.lessThanOrEqualTo(0)) {
    push(RULES.LINE_QUANTITY_INVALID, 'Quantity must be greater than zero.', 'quantity');
  }

  const price = toDecimal(line.unitPrice);
  if (price === null) {
    push(RULES.LINE_UNIT_PRICE_INVALID, `Unit price '${line.unitPrice}' is not a number.`, 'unitPrice');
  } else if (isReversal) {
    // The sign is inverted for a reversal, and zero credits nothing at all.
    if (price.greaterThan(0)) {
      push(
        RULES.LINE_UNIT_PRICE_INVALID,
        'A credit note line must carry a negative amount — it reduces what the buyer owes.',
        'unitPrice',
      );
    } else if (price.isZero()) {
      push(RULES.LINE_UNIT_PRICE_INVALID, 'This credit line reverses nothing.', 'unitPrice');
    }
  } else if (price.lessThan(0)) {
    push(RULES.LINE_UNIT_PRICE_INVALID, 'Unit price cannot be negative.', 'unitPrice');
  }

  if (!(UOM_CODES as readonly string[]).includes(line.uom?.trim() ?? '')) {
    push(
      RULES.LINE_UOM_INVALID,
      `Unit of measure '${line.uom}' is not recognised. Use ${UOM_CODES.join(', ')}.`,
      'uom',
    );
  }

  const category = line.vatCategory?.trim() as VatCategoryCode;
  if (!(category in VAT_CATEGORIES)) {
    push(
      RULES.VAT_CATEGORY_INVALID,
      `VAT category '${line.vatCategory}' is not recognised. Use S, Z, E or O.`,
      'vatCategory',
    );
  } else {
    // The rate as supplied in the workbook, before recalc overwrote it.
    const suppliedRate = toDecimal(supplied?.vatRate ?? line.vatRate);
    const required = expectedVatRate(category);
    if (suppliedRate !== null && !suppliedRate.equals(required)) {
      push(
        RULES.VAT_RATE_MISMATCH,
        `VAT category ${category} (${VAT_CATEGORIES[category].label}) requires a rate of ${required.toFixed(2)}%, but ${suppliedRate.toFixed(2)}% was supplied.`,
        'vatRate',
      );
    }
  }

  const discount = toDecimal(line.lineDiscount);
  if (discount !== null && qty !== null && price !== null) {
    // On a reversal both the line value and any discount carried over from the
    // original document are negative, so the comparison is made on magnitudes.
    const gross = isReversal ? qty.times(price).abs() : qty.times(price);
    const magnitude = isReversal ? discount.abs() : discount;
    if (magnitude.greaterThan(gross)) {
      push(
        RULES.LINE_DISCOUNT_EXCEEDS,
        `Discount ${magnitude.toFixed(2)} is greater than the line value ${gross.toFixed(2)}.`,
        'lineDiscount',
      );
    }
    if (!isReversal && discount.lessThan(0)) {
      push(RULES.LINE_DISCOUNT_EXCEEDS, 'Discount cannot be negative.', 'lineDiscount');
    }
    if (isReversal && discount.greaterThan(0)) {
      push(
        RULES.LINE_DISCOUNT_EXCEEDS,
        'A discount reversed on a credit note must itself be negative.',
        'lineDiscount',
      );
    }
  }

  // The template locks columns K, L and M precisely so these can never drift.
  // If the workbook arrives with values that disagree with the formula, the
  // lock was removed and the figures were typed by hand — report it against
  // the specific derived cell rather than silently overwriting it.
  if (line.netAmount !== '') {
    const checks: { field: 'netAmount' | 'vatAmount' | 'lineTotal'; label: string }[] = [
      { field: 'netAmount', label: 'net amount' },
      { field: 'vatAmount', label: 'VAT amount' },
      { field: 'lineTotal', label: 'line total' },
    ];
    for (const { field, label } of checks) {
      const given = toDecimal(supplied?.[field]);
      if (given !== null && !amountsEqual(given, line[field])) {
        push(
          RULES.LINE_ARITHMETIC,
          `The ${label} in your file is ${given.toFixed(2)}, but calculating it from quantity, price, discount and VAT gives ${line[field]}.`,
          field,
        );
      }
    }
  }

  return out;
}

/** Validate a whole batch, threading duplicate detection across invoices. */
export function validateBatch(
  invoices: StagedInvoice[],
  ctx: ValidationContext,
): InvoiceValidationResult[] {
  const counts = new Map<string, number>();
  for (const inv of invoices) {
    const key = inv.invoiceNumber?.trim() ?? '';
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const withCounts: ValidationContext = { ...ctx, batchInvoiceNumbers: counts };
  return invoices.map((inv) => validateInvoice(inv, withCounts));
}
