import { describe, expect, it } from 'vitest';
import { recalcInvoice, recalcLine, taxSubtotals } from '../calc.js';
import { formatAmount, money, toDecimal } from '../money.js';
import type { StagedInvoice, StagedLine } from '../types.js';

function line(over: Partial<StagedLine> = {}): StagedLine {
  return {
    id: 'l1',
    lineNumber: '1',
    description: 'IT Consulting Services',
    hsCode: '',
    quantity: '10',
    uom: 'HUR',
    unitPrice: '500',
    lineDiscount: '50',
    vatCategory: 'S',
    vatRate: '5.00',
    netAmount: '',
    vatAmount: '',
    lineTotal: '',
    sourceRow: 2,
    ...over,
  };
}

function invoice(over: Partial<StagedInvoice> = {}): StagedInvoice {
  return {
    id: 'i1',
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
  };
}

describe('line arithmetic', () => {
  it('matches the template formula: (qty * price) - discount', () => {
    const out = recalcLine(line());
    expect(out.netAmount).toBe('4950.00'); // 10 * 500 - 50
    expect(out.vatAmount).toBe('247.50'); // 5%
    expect(out.lineTotal).toBe('5197.50');
  });

  it('forces the rate implied by the VAT category, ignoring a wrong supplied rate', () => {
    const out = recalcLine(line({ vatCategory: 'Z', vatRate: '5.00' }));
    expect(out.vatRate).toBe('0.00');
    expect(out.vatAmount).toBe('0.00');
  });

  it('leaves derived fields blank when the line cannot be computed', () => {
    const out = recalcLine(line({ quantity: 'ten' }));
    expect(out.netAmount).toBe('');
    expect(out.lineTotal).toBe('');
  });

  it('rounds half-up per line, as the locked Excel columns do', () => {
    // 3 * 3.335 = 10.005 -> 10.01 ; VAT 5% of 10.01 = 0.5005 -> 0.50
    const out = recalcLine(line({ quantity: '3', unitPrice: '3.335', lineDiscount: '0' }));
    expect(out.netAmount).toBe('10.01');
    expect(out.vatAmount).toBe('0.50');
  });

  it('tolerates thousands separators pasted from a spreadsheet', () => {
    const out = recalcLine(line({ quantity: '1', unitPrice: '5,000.00', lineDiscount: '0' }));
    expect(out.netAmount).toBe('5000.00');
  });
});

describe('invoice totals', () => {
  it('sums lines into header totals', () => {
    const out = recalcInvoice(
      invoice({
        lines: [
          line({ id: 'a', quantity: '1', unitPrice: '5000', lineDiscount: '0' }),
          line({ id: 'b', quantity: '2', unitPrice: '1200', lineDiscount: '0' }),
        ],
      }),
    );
    expect(out.lineExtensionAmount).toBe('7400.00');
    expect(out.vatTotalAmount).toBe('370.00');
    expect(out.payableAmount).toBe('7770.00');
  });

  it('converts the payable amount to AED using the FX rate', () => {
    const out = recalcInvoice(
      invoice({
        currency: 'USD',
        fxRate: '3.672500',
        lines: [line({ quantity: '1', unitPrice: '100', lineDiscount: '0' })],
      }),
    );
    expect(out.payableAmount).toBe('105.00');
    expect(out.payableAmountAed).toBe('385.61'); // 105 * 3.6725 = 385.6125
  });

  it('does not accumulate floating point error across many lines', () => {
    // 100 lines of 0.07 each: naive float summation drifts here.
    const lines = Array.from({ length: 100 }, (_, i) =>
      line({ id: `l${i}`, quantity: '1', unitPrice: '0.07', lineDiscount: '0', vatCategory: 'Z' }),
    );
    const out = recalcInvoice(invoice({ lines }));
    expect(out.lineExtensionAmount).toBe('7.00');
  });

  it('groups tax subtotals by category', () => {
    const out = recalcInvoice(
      invoice({
        lines: [
          line({ id: 'a', quantity: '1', unitPrice: '100', lineDiscount: '0', vatCategory: 'S' }),
          line({ id: 'b', quantity: '1', unitPrice: '200', lineDiscount: '0', vatCategory: 'S' }),
          line({ id: 'c', quantity: '1', unitPrice: '50', lineDiscount: '0', vatCategory: 'Z' }),
        ],
      }),
    );
    const subtotals = taxSubtotals(out);
    expect(subtotals).toHaveLength(2);
    const standard = subtotals.find((s) => s.category === 'S');
    expect(standard?.taxableAmount).toBe('300.00');
    expect(standard?.taxAmount).toBe('15.00');
    const zero = subtotals.find((s) => s.category === 'Z');
    expect(zero?.taxAmount).toBe('0.00');
  });
});

describe('money helpers', () => {
  it('parses blank and junk to null rather than zero', () => {
    expect(toDecimal('')).toBeNull();
    expect(toDecimal('abc')).toBeNull();
    expect(toDecimal(null)).toBeNull();
    expect(toDecimal('0')?.toString()).toBe('0');
  });

  it('rounds half-up, not to-even', () => {
    expect(money('2.345')).toBe('2.35');
    expect(money('2.355')).toBe('2.36');
  });

  it('formats with thousands separators', () => {
    expect(formatAmount('1250')).toBe('1,250.00');
    expect(formatAmount('-1234567.891')).toBe('-1,234,567.89');
  });
});
