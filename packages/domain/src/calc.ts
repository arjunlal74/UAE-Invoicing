import { expectedVatRate, VAT_CATEGORIES, type VatCategoryCode } from './codes.js';
import { AMOUNT_DP, Decimal, money, toDecimal } from './money.js';
import type { StagedInvoice, StagedLine } from './types.js';

/**
 * Invoice arithmetic.
 *
 * This module is imported by the browser (so the staging grid updates totals as
 * the user types) and by the worker (so the XML carries authoritative figures).
 * It must therefore be free of any Node or DOM dependency, and it must be the
 * ONLY place these formulas exist. A second implementation is a second answer.
 *
 * The formulas match the Excel template's locked columns exactly:
 *   Net   = ROUND((Qty * UnitPrice) - Discount, 2)
 *   VAT   = ROUND(Net * (Rate / 100), 2)
 *   Total = Net + VAT
 *
 * Note VAT is rounded per line, not once at the invoice level. That choice has
 * to match the template, because the user can see both numbers and the FTA
 * arithmetic rule compares them.
 */

export function recalcLine(line: StagedLine): StagedLine {
  const qty = toDecimal(line.quantity);
  const price = toDecimal(line.unitPrice);
  const discount = toDecimal(line.lineDiscount) ?? new Decimal(0);

  // A category always dictates its rate. If the uploaded sheet disagrees,
  // validation raises BR-UAE-14 against the original value — but the maths
  // below uses the correct rate so downstream totals stay coherent.
  const category = line.vatCategory as VatCategoryCode;
  const rate =
    category in VAT_CATEGORIES ? new Decimal(expectedVatRate(category)) : toDecimal(line.vatRate) ?? new Decimal(0);

  if (qty === null || price === null) {
    // Not computable yet — leave derived fields blank rather than showing 0.00,
    // which would read as "this line is free" instead of "this line is broken".
    return { ...line, netAmount: '', vatAmount: '', lineTotal: '' };
  }

  const net = qty.times(price).minus(discount).toDecimalPlaces(AMOUNT_DP, Decimal.ROUND_HALF_UP);
  const vat = net.times(rate).dividedBy(100).toDecimalPlaces(AMOUNT_DP, Decimal.ROUND_HALF_UP);
  const total = net.plus(vat);

  return {
    ...line,
    vatRate: rate.toFixed(2),
    netAmount: net.toFixed(AMOUNT_DP),
    vatAmount: vat.toFixed(AMOUNT_DP),
    lineTotal: total.toFixed(AMOUNT_DP),
  };
}

export function recalcInvoice(invoice: StagedInvoice): StagedInvoice {
  const lines = invoice.lines.map(recalcLine);

  const lineExtension = lines.reduce<Decimal>(
    (acc, l) => acc.plus(toDecimal(l.netAmount) ?? 0),
    new Decimal(0),
  );
  const vatTotal = lines.reduce<Decimal>(
    (acc, l) => acc.plus(toDecimal(l.vatAmount) ?? 0),
    new Decimal(0),
  );
  const taxInclusive = lineExtension.plus(vatTotal);

  // Allowances and charges at document level are not in the v1 template, so
  // tax-exclusive equals the sum of line nets. Kept as its own field because
  // UBL requires both and they diverge the moment document-level discounts
  // are added.
  const taxExclusive = lineExtension;

  const fx = toDecimal(invoice.fxRate) ?? new Decimal(1);
  const payable = taxInclusive;
  const payableAed = payable.times(fx.isZero() ? 1 : fx);

  return {
    ...invoice,
    lines,
    lineExtensionAmount: lineExtension.toFixed(AMOUNT_DP),
    taxExclusiveAmount: taxExclusive.toFixed(AMOUNT_DP),
    vatTotalAmount: vatTotal.toFixed(AMOUNT_DP),
    taxInclusiveAmount: taxInclusive.toFixed(AMOUNT_DP),
    payableAmount: payable.toFixed(AMOUNT_DP),
    payableAmountAed: payableAed.toDecimalPlaces(AMOUNT_DP, Decimal.ROUND_HALF_UP).toFixed(AMOUNT_DP),
  };
}

/**
 * VAT broken down by category, for the UBL TaxTotal/TaxSubtotal blocks.
 * PINT requires one subtotal per (category, rate) pair actually used.
 */
export interface TaxSubtotal {
  category: VatCategoryCode;
  rate: string;
  taxableAmount: string;
  taxAmount: string;
  exemptionReason?: string;
}

export function taxSubtotals(invoice: StagedInvoice): TaxSubtotal[] {
  const buckets = new Map<string, { taxable: Decimal; tax: Decimal; rate: Decimal }>();

  for (const line of invoice.lines) {
    const category = line.vatCategory as VatCategoryCode;
    if (!(category in VAT_CATEGORIES)) continue;

    const rate = new Decimal(expectedVatRate(category));
    const key = `${category}:${rate.toFixed(2)}`;
    const bucket = buckets.get(key) ?? { taxable: new Decimal(0), tax: new Decimal(0), rate };

    bucket.taxable = bucket.taxable.plus(toDecimal(line.netAmount) ?? 0);
    bucket.tax = bucket.tax.plus(toDecimal(line.vatAmount) ?? 0);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()].map(([key, b]) => {
    const category = key.split(':')[0] as VatCategoryCode;
    return {
      category,
      rate: b.rate.toFixed(2),
      taxableAmount: money(b.taxable),
      taxAmount: money(b.tax),
      exemptionReason: VAT_CATEGORIES[category].taxExemptionReason,
    };
  });
}

/** Blank line with the shape the grid expects, for "add row". */
export function emptyLine(id: string, lineNumber: number): StagedLine {
  return {
    id,
    lineNumber: String(lineNumber),
    description: '',
    hsCode: '',
    quantity: '',
    uom: 'PCE',
    unitPrice: '',
    lineDiscount: '0.00',
    vatCategory: 'S',
    vatRate: '5.00',
    netAmount: '',
    vatAmount: '',
    lineTotal: '',
    sourceRow: null,
  };
}
