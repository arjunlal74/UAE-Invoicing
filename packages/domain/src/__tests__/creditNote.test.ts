import { describe, expect, it } from 'vitest';
import { recalcInvoice } from '../calc.js';
import { buildCreditNote, previewReversal } from '../creditNote.js';
import type { StagedInvoice, StagedLine } from '../types.js';
import { validateInvoice } from '../validation/validate.js';

/**
 * The reversal engine of SRS v2.7 §8.
 *
 * The worked example throughout is the one in the §8.1 wireframe: INV-2026-00891
 * for a single line of IT consulting at AED 5,000, disputed on price because the
 * contract rate was 4,500.
 */

function line(over: Partial<StagedLine> = {}): StagedLine {
  return {
    id: 'line-1',
    lineNumber: '1',
    description: 'IT Consulting Services',
    hsCode: '',
    quantity: '1',
    uom: 'HUR',
    unitPrice: '5000',
    lineDiscount: '0',
    vatCategory: 'S',
    vatRate: '5.00',
    netAmount: '',
    vatAmount: '',
    lineTotal: '',
    sourceRow: 2,
    ...over,
  };
}

function original(over: Partial<StagedInvoice> = {}): StagedInvoice {
  return recalcInvoice({
    id: 'inv-1',
    invoiceNumber: 'INV-2026-00891',
    invoiceType: '380',
    issueDate: '2026-08-09',
    issueTime: '14:30:00',
    currency: 'AED',
    fxRate: '1.000000',
    supplierTrn: '100293847500003',
    supplierName: 'Al-Bahar Enterprises LLC',
    buyerTrn: '100384759200003',
    buyerName: 'Emirates Trading Co',
    buyerEmirate: 'Dubai',
    poReference: '',
    precedingInvoiceId: '',
    paymentMeans: '30',
    lines: [line()],
    lineExtensionAmount: '',
    taxExclusiveAmount: '',
    vatTotalAmount: '',
    taxInclusiveAmount: '',
    payableAmount: '',
    payableAmountAed: '',
    sourceRow: 2,
    ...over,
  });
}

const params = {
  creditNoteNumber: 'CN-2026-00042',
  issueDate: '2026-08-24',
  issueTime: '09:00:00',
  id: 'cn-1',
};

describe('full cancellation (§8.2 mode A)', () => {
  it('reverses the entire invoice, sign for sign', () => {
    const invoice = original();
    const note = buildCreditNote({ ...params, original: invoice, mode: 'FULL_CANCELLATION' });

    expect(invoice.payableAmount).toBe('5250.00');
    expect(note.lineExtensionAmount).toBe('-5000.00');
    expect(note.vatTotalAmount).toBe('-250.00');
    expect(note.payableAmount).toBe('-5250.00');
  });

  it('carries every line across with its quantity and unit intact', () => {
    const invoice = original({
      lines: [line(), line({ id: 'line-2', lineNumber: '2', quantity: '2', unitPrice: '1500' })],
    });
    const note = buildCreditNote({ ...params, original: invoice, mode: 'FULL_CANCELLATION' });

    expect(note.lines).toHaveLength(2);
    expect(note.lines[1]!.quantity).toBe('2');
    expect(note.lines[1]!.uom).toBe('HUR');
    expect(note.lines[1]!.netAmount).toBe('-3000.00');
  });

  it('reverses a discount along with the line it was applied to', () => {
    // Net was 10 × 500 − 50 = 4,950. The reversal must credit exactly that, not
    // the undiscounted 5,000.
    const invoice = original({
      lines: [line({ quantity: '10', unitPrice: '500', lineDiscount: '50' })],
    });
    const note = buildCreditNote({ ...params, original: invoice, mode: 'FULL_CANCELLATION' });

    expect(invoice.lineExtensionAmount).toBe('4950.00');
    expect(note.lineExtensionAmount).toBe('-4950.00');
  });

  it('names the invoice it reverses and becomes a 381', () => {
    const note = buildCreditNote({
      ...params,
      original: original(),
      mode: 'FULL_CANCELLATION',
    });

    expect(note.invoiceType).toBe('381');
    expect(note.invoiceNumber).toBe('CN-2026-00042');
    expect(note.precedingInvoiceId).toBe('INV-2026-00891');
    expect(note.issueDate).toBe('2026-08-24');
  });
});

describe('partial adjustment (§8.2 mode B)', () => {
  it('credits only the difference, matching the §8.1 worked example', () => {
    const note = buildCreditNote({
      ...params,
      original: original(),
      mode: 'PARTIAL_ADJUSTMENT',
      adjustments: [{ lineId: 'line-1', action: 'ADJUST', newUnitPrice: '4500' }],
    });

    // The wireframe's figures: difference 500.00 net, reversal −525.00 gross.
    expect(note.lineExtensionAmount).toBe('-500.00');
    expect(note.vatTotalAmount).toBe('-25.00');
    expect(note.payableAmount).toBe('-525.00');
  });

  it('handles a quantity reduction without a per-unit rounding error', () => {
    // Three units at 1,000 reduced to two credits exactly 1,000 — expressing
    // that as a restated quantity × price is where thirds go wrong.
    const invoice = original({
      lines: [line({ quantity: '3', unitPrice: '1000' })],
    });
    const note = buildCreditNote({
      ...params,
      original: invoice,
      mode: 'PARTIAL_ADJUSTMENT',
      adjustments: [{ lineId: 'line-1', action: 'ADJUST', newQuantity: '2' }],
    });

    expect(note.lineExtensionAmount).toBe('-1000.00');
    expect(note.vatTotalAmount).toBe('-50.00');
  });

  it('leaves untouched lines out of the credit note entirely', () => {
    const invoice = original({
      lines: [line(), line({ id: 'line-2', lineNumber: '2', unitPrice: '1500' })],
    });
    const note = buildCreditNote({
      ...params,
      original: invoice,
      mode: 'PARTIAL_ADJUSTMENT',
      adjustments: [{ lineId: 'line-2', action: 'CREDIT' }],
    });

    expect(note.lines).toHaveLength(1);
    expect(note.payableAmount).toBe('-1575.00');
  });

  it('drops an adjustment that changes nothing', () => {
    const note = buildCreditNote({
      ...params,
      original: original(),
      mode: 'PARTIAL_ADJUSTMENT',
      adjustments: [{ lineId: 'line-1', action: 'ADJUST', newUnitPrice: '5000' }],
    });

    expect(note.lines).toHaveLength(0);
  });
});

describe('validation of a reversal', () => {
  const context = { tenantTrn: '100293847500003' };

  it('accepts a well-formed credit note despite its negative amounts', () => {
    const note = buildCreditNote({
      ...params,
      original: original(),
      mode: 'FULL_CANCELLATION',
    });

    const result = validateInvoice(note, context);
    const blocking = result.findings.filter(
      (f) => f.severity === 'ERROR' || f.severity === 'FATAL',
    );
    expect(blocking).toEqual([]);
    expect(result.submittable).toBe(true);
  });

  it('rejects a credit note whose lines would increase what the buyer owes', () => {
    const note = buildCreditNote({
      ...params,
      original: original(),
      mode: 'FULL_CANCELLATION',
    });
    // Flip the sign back: a positive line on a 381 is the mistake worth catching.
    const wrong = recalcInvoice({
      ...note,
      lines: note.lines.map((l) => ({ ...l, unitPrice: '5000' })),
    });

    const result = validateInvoice(wrong, context);
    expect(result.findings.some((f) => f.field === 'unitPrice')).toBe(true);
    expect(result.submittable).toBe(false);
  });

  it('still requires a preceding invoice reference', () => {
    const note = buildCreditNote({
      ...params,
      original: original(),
      mode: 'FULL_CANCELLATION',
    });

    const result = validateInvoice({ ...note, precedingInvoiceId: '' }, context);
    expect(result.findings.some((f) => f.field === 'precedingInvoiceId')).toBe(true);
    expect(result.submittable).toBe(false);
  });
});

describe('the §8.1 comparison grid', () => {
  it('shows original, new, difference and reversal per line', () => {
    const preview = previewReversal(original(), 'PARTIAL_ADJUSTMENT', [
      { lineId: 'line-1', action: 'ADJUST', newUnitPrice: '4500' },
    ]);

    expect(preview).toEqual([
      {
        lineId: 'line-1',
        description: 'IT Consulting Services',
        quantity: '1',
        uom: 'HUR',
        originalUnitPrice: '5000',
        originalNet: '5000.00',
        newNet: '4500.00',
        differenceNet: '500.00',
        reversalTotal: '-525.00',
      },
    ]);
  });

  it('shows a full reversal as crediting the whole line', () => {
    const preview = previewReversal(original(), 'FULL_CANCELLATION');
    expect(preview[0]!.newNet).toBe('0.00');
    expect(preview[0]!.reversalTotal).toBe('-5250.00');
  });
});
