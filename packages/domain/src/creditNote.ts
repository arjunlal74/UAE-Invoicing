import { recalcInvoice } from './calc.js';
import { AMOUNT_DP, Decimal, UNIT_PRICE_DP, toDecimal } from './money.js';
import type { StagedInvoice, StagedLine } from './types.js';

/**
 * The reversal engine behind the in-app Credit Note Builder (SRS v2.7 §8).
 *
 * A cleared invoice cannot be edited or withdrawn — under UAE VAT law it is
 * filed, and the only lawful correction is a separate Type 381 document that
 * points back at it. This module turns "the buyer disputed INV-891 on price"
 * into the staged document that says so, with amounts that reverse rather than
 * restate.
 *
 * Sign convention: credit note lines carry NEGATIVE amounts, matching the §8.1
 * wireframe ("Credit Extension Net: AED -500.00 / Reversal VAT: AED -25.00").
 * The document is emitted as a UBL Invoice with InvoiceTypeCode 381, which is
 * what the SRS's own XPaths assume — §8.2 maps the preceding-document link to
 * `/Invoice/cac:BillingReference/...`, not to a CreditNote root.
 */

/** Mirrors the `reversal_mode` enum. Duplicated here to keep @uae/domain free of contract imports. */
export type ReversalModeCode = 'FULL_CANCELLATION' | 'PARTIAL_ADJUSTMENT';

/**
 * What to do with one line of the original invoice (§8.1 "action" column).
 *
 * `CREDIT` reverses the line whole; `ADJUST` credits only the difference
 * between what was invoiced and what should have been. A line the accountant
 * leaves alone simply does not appear in the adjustments list.
 */
export interface CreditLineAdjustment {
  /** `id` of the line on the original staged invoice. */
  lineId: string;
  action: 'CREDIT' | 'ADJUST';
  /** ADJUST only: the corrected unit price. Defaults to the original. */
  newUnitPrice?: string;
  /** ADJUST only: the corrected quantity. Defaults to the original. */
  newQuantity?: string;
}

export interface BuildCreditNoteParams {
  /** The invoice being corrected, as filed. */
  original: StagedInvoice;
  mode: ReversalModeCode;
  creditNoteNumber: string;
  issueDate: string;
  issueTime: string;
  /** Required for PARTIAL_ADJUSTMENT; ignored for FULL_CANCELLATION. */
  adjustments?: CreditLineAdjustment[];
  /** Client-side id for the staged document. */
  id: string;
  /** Line ids for the produced lines, so the grid has stable keys. */
  lineIds?: string[];
}

/** Net value of a line as originally invoiced. */
function originalNet(line: StagedLine): Decimal {
  const qty = toDecimal(line.quantity) ?? new Decimal(0);
  const price = toDecimal(line.unitPrice) ?? new Decimal(0);
  const discount = toDecimal(line.lineDiscount) ?? new Decimal(0);
  return qty.times(price).minus(discount).toDecimalPlaces(AMOUNT_DP, Decimal.ROUND_HALF_UP);
}

function negate(value: string | null | undefined): string {
  const decimal = toDecimal(value);
  if (decimal === null || decimal.isZero()) return '0.00';
  return decimal.negated().toFixed(AMOUNT_DP);
}

/**
 * Mode A — full cancellation (§8.2).
 *
 * Every line comes across with its quantity and unit of measure intact and its
 * price and discount negated. Keeping the quantity real matters: the credit
 * note has to read as "these three servers, reversed", not as a bare monetary
 * adjustment, because that is what the buyer reconciles against.
 */
function fullReversalLine(line: StagedLine, id: string, lineNumber: number): StagedLine {
  const price = toDecimal(line.unitPrice);
  return {
    ...line,
    id,
    lineNumber: String(lineNumber),
    unitPrice:
      price === null || price.isZero()
        ? '0.00'
        : price.negated().toFixed(UNIT_PRICE_DP),
    lineDiscount: negate(line.lineDiscount),
    netAmount: '',
    vatAmount: '',
    lineTotal: '',
    sourceRow: null,
  };
}

/**
 * Mode B — partial adjustment (§8.2).
 *
 * The credited amount is the difference between what was invoiced and what
 * should have been, and it is expressed as a single unit at that difference
 * rather than as a restated quantity × price. That is deliberate: a rate
 * correction from 5,000 to 4,500 on a quantity of 3 credits exactly 1,500, and
 * dividing that back into a per-unit price would introduce a rounding error the
 * buyer's ledger would then have to absorb. The description carries the
 * explanation the numbers no longer do.
 */
function adjustmentLine(
  line: StagedLine,
  adjustment: CreditLineAdjustment,
  id: string,
  lineNumber: number,
): StagedLine | null {
  const before = originalNet(line);

  if (adjustment.action === 'CREDIT') {
    return {
      ...fullReversalLine(line, id, lineNumber),
      description: line.description,
    };
  }

  const newQty = toDecimal(adjustment.newQuantity ?? line.quantity);
  const newPrice = toDecimal(adjustment.newUnitPrice ?? line.unitPrice);
  const discount = toDecimal(line.lineDiscount) ?? new Decimal(0);
  if (newQty === null || newPrice === null) return null;

  const after = newQty
    .times(newPrice)
    .minus(discount)
    .toDecimalPlaces(AMOUNT_DP, Decimal.ROUND_HALF_UP);
  const delta = after.minus(before);

  // Nothing actually changed on this line; emitting a zero credit would only
  // give the validator something to complain about.
  if (delta.isZero()) return null;

  const qtyChanged = adjustment.newQuantity !== undefined && !newQty.equals(toDecimal(line.quantity) ?? newQty);
  const priceChanged = adjustment.newUnitPrice !== undefined && !newPrice.equals(toDecimal(line.unitPrice) ?? newPrice);

  const reason = qtyChanged && priceChanged
    ? `quantity ${line.quantity} → ${newQty.toString()}, rate ${line.unitPrice} → ${newPrice.toString()}`
    : qtyChanged
      ? `quantity ${line.quantity} → ${newQty.toString()}`
      : priceChanged
        ? `rate ${line.unitPrice} → ${newPrice.toString()}`
        : 'adjustment';

  return {
    ...line,
    id,
    lineNumber: String(lineNumber),
    description: `${line.description} (adjustment: ${reason})`,
    quantity: '1',
    unitPrice: delta.toFixed(UNIT_PRICE_DP),
    lineDiscount: '0.00',
    netAmount: '',
    vatAmount: '',
    lineTotal: '',
    sourceRow: null,
  };
}

/**
 * Build the staged credit note for `original`.
 *
 * Returns a fully recalculated document, so the caller can hand it straight to
 * the validator and to the XML builder without a separate arithmetic pass.
 */
export function buildCreditNote(params: BuildCreditNoteParams): StagedInvoice {
  const { original, mode, adjustments = [] } = params;
  const ids = params.lineIds ?? [];
  const nextId = (index: number) => ids[index] ?? `${params.id}-line-${index + 1}`;

  const lines: StagedLine[] = [];

  if (mode === 'FULL_CANCELLATION') {
    for (const line of original.lines) {
      lines.push(fullReversalLine(line, nextId(lines.length), lines.length + 1));
    }
  } else {
    const byId = new Map(original.lines.map((l) => [l.id, l]));
    for (const adjustment of adjustments) {
      const line = byId.get(adjustment.lineId);
      if (!line) continue;
      const produced = adjustmentLine(line, adjustment, nextId(lines.length), lines.length + 1);
      if (produced) lines.push(produced);
    }
  }

  return recalcInvoice({
    ...original,
    id: params.id,
    invoiceNumber: params.creditNoteNumber,
    invoiceType: '381',
    issueDate: params.issueDate,
    issueTime: params.issueTime,
    // §8.2 feature 2: the mandatory FTA linkage. The builder overwrites this
    // with the resolved IRN before filing, but it is set here so a document
    // that never reaches the server is still self-describing.
    precedingInvoiceId: original.invoiceNumber,
    lines,
    sourceRow: null,
  });
}

/**
 * The per-line comparison the §8.1 grid renders: what was invoiced, what the
 * accountant says it should be, and the credit that follows.
 */
export interface ReversalPreviewLine {
  lineId: string;
  description: string;
  quantity: string;
  uom: string;
  originalUnitPrice: string;
  originalNet: string;
  newNet: string;
  differenceNet: string;
  reversalTotal: string;
}

export function previewReversal(
  original: StagedInvoice,
  mode: ReversalModeCode,
  adjustments: CreditLineAdjustment[] = [],
): ReversalPreviewLine[] {
  const byId = new Map(adjustments.map((a) => [a.lineId, a]));

  return original.lines.map((line) => {
    const before = originalNet(line);
    const adjustment = byId.get(line.id);
    const credited = mode === 'FULL_CANCELLATION' || adjustment?.action === 'CREDIT';

    const newQty = toDecimal(adjustment?.newQuantity ?? line.quantity) ?? new Decimal(0);
    const newPrice = toDecimal(adjustment?.newUnitPrice ?? line.unitPrice) ?? new Decimal(0);
    const discount = toDecimal(line.lineDiscount) ?? new Decimal(0);

    const after = credited
      ? new Decimal(0)
      : adjustment
        ? newQty.times(newPrice).minus(discount).toDecimalPlaces(AMOUNT_DP, Decimal.ROUND_HALF_UP)
        : before;

    const difference = before.minus(after);
    const rate = toDecimal(line.vatRate) ?? new Decimal(0);
    const vat = difference.times(rate).dividedBy(100).toDecimalPlaces(AMOUNT_DP, Decimal.ROUND_HALF_UP);

    return {
      lineId: line.id,
      description: line.description,
      quantity: line.quantity,
      uom: line.uom,
      originalUnitPrice: line.unitPrice,
      originalNet: before.toFixed(AMOUNT_DP),
      newNet: after.toFixed(AMOUNT_DP),
      differenceNet: difference.toFixed(AMOUNT_DP),
      reversalTotal: difference.plus(vat).negated().toFixed(AMOUNT_DP),
    };
  });
}
