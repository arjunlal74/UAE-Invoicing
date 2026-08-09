import { describe, expect, it } from 'vitest';
import { autoFix } from '../autofix.js';
import type { StagedInvoice, StagedLine } from '../types.js';
import { validateBatch, validateInvoice, type ValidationContext } from '../validation/validate.js';

const TENANT_TRN = '100293847500003';
const TODAY = new Date('2026-08-09T00:00:00Z');

function ctx(over: Partial<ValidationContext> = {}): ValidationContext {
  return { tenantTrn: TENANT_TRN, today: TODAY, ...over };
}

function line(over: Partial<StagedLine> = {}): StagedLine {
  return {
    id: 'l1',
    lineNumber: '1',
    description: 'Cloud Hosting',
    hsCode: '',
    quantity: '1',
    uom: 'MON',
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

function invoice(over: Partial<StagedInvoice> = {}): StagedInvoice {
  return {
    id: 'i1',
    invoiceNumber: 'INV-2026-001',
    invoiceType: '380',
    issueDate: '2026-08-01',
    issueTime: '14:30:00',
    currency: 'AED',
    fxRate: '1.000000',
    supplierTrn: TENANT_TRN,
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

const codes = (r: { findings: { ruleCode: string }[] }) => r.findings.map((f) => f.ruleCode);

describe('a clean invoice', () => {
  it('passes with no blocking findings', () => {
    const result = validateInvoice(invoice(), ctx());
    expect(result.findings.filter((f) => f.severity === 'ERROR')).toEqual([]);
    expect(result.submittable).toBe(true);
  });
});

describe('TRN rules', () => {
  it('rejects a buyer TRN that is too short, with the cell reference', () => {
    const result = validateInvoice(invoice({ buyerTrn: '1002938475', sourceRow: 14 }), ctx());
    expect(codes(result)).toContain('BR-UAE-08');
    const finding = result.findings.find((f) => f.ruleCode === 'BR-UAE-08');
    expect(finding?.cell).toBe('I14');
    expect(finding?.sheet).toBe('Invoice_Header');
    expect(finding?.message).toContain('15 digits');
  });

  it('rejects a TRN that does not start with 1', () => {
    const result = validateInvoice(invoice({ buyerTrn: '200384759200003' }), ctx());
    expect(codes(result)).toContain('BR-UAE-08');
  });

  it('requires a buyer TRN for B2B but not for B2C', () => {
    expect(codes(validateInvoice(invoice({ buyerTrn: '' }), ctx()))).toContain('BR-UAE-09');

    const b2c = validateInvoice(invoice({ invoiceType: '388', buyerTrn: '' }), ctx());
    expect(codes(b2c)).not.toContain('BR-UAE-09');
    expect(codes(b2c)).toContain('WRN-UAE-02');
    expect(b2c.submittable).toBe(true);
  });

  it('rejects a supplier TRN that is not the tenant own TRN', () => {
    const result = validateInvoice(invoice({ supplierTrn: '199999999999999' }), ctx());
    expect(codes(result)).toContain('BR-UAE-10');
  });
});

describe('duplicate detection', () => {
  it('flags an invoice number already filed', () => {
    const result = validateInvoice(
      invoice(),
      ctx({ existingInvoiceNumbers: new Set(['INV-2026-001']) }),
    );
    const f = result.findings.find((x) => x.ruleCode === 'BR-UAE-03');
    expect(f?.message).toContain('duplicate');
  });

  it('flags a number repeated within one upload', () => {
    const results = validateBatch(
      [invoice({ id: 'a' }), invoice({ id: 'b' })],
      ctx(),
    );
    expect(codes(results[0]!)).toContain('BR-UAE-03');
    expect(codes(results[1]!)).toContain('BR-UAE-03');
  });
});

describe('arithmetic rules', () => {
  it('flags the header when a line cannot be computed', () => {
    const result = validateInvoice(
      invoice({ lines: [line({ quantity: 'abc' })] }),
      ctx(),
    );
    expect(codes(result)).toContain('BR-UAE-23');
    expect(codes(result)).toContain('BR-UAE-05');
  });

  it('flags a VAT rate that contradicts its category', () => {
    const result = validateInvoice(
      invoice({ lines: [line({ vatCategory: 'Z', vatRate: '5.00', sourceRow: 22 })] }),
      ctx(),
    );
    const f = result.findings.find((x) => x.ruleCode === 'BR-UAE-14');
    expect(f?.cell).toBe('J22');
    expect(f?.sheet).toBe('Invoice_Line_Items');
  });

  it('catches hand-typed line amounts that contradict the formula', () => {
    // The user unlocked column L and typed a VAT amount of their own.
    const result = validateInvoice(
      invoice({
        lines: [
          line({
            quantity: '1',
            unitPrice: '5000',
            lineDiscount: '0',
            netAmount: '5000.00',
            vatAmount: '5.00', // should be 250.00
            lineTotal: '5005.00',
            sourceRow: 22,
          }),
        ],
      }),
      ctx(),
    );
    const f = result.findings.find((x) => x.ruleCode === 'BR-UAE-06' && x.field === 'vatAmount');
    expect(f?.cell).toBe('L22');
    expect(f?.message).toContain('250.00');
    expect(result.submittable).toBe(false);
  });

  it('does not complain when supplied amounts agree with the formula', () => {
    const result = validateInvoice(
      invoice({
        lines: [
          line({
            quantity: '1',
            unitPrice: '5000',
            lineDiscount: '0',
            netAmount: '5000.00',
            vatAmount: '250.00',
            lineTotal: '5250.00',
          }),
        ],
      }),
      ctx(),
    );
    expect(codes(result)).not.toContain('BR-UAE-06');
    expect(codes(result)).not.toContain('BR-UAE-05');
  });

  it('rejects a discount larger than the line value', () => {
    const result = validateInvoice(
      invoice({ lines: [line({ quantity: '1', unitPrice: '100', lineDiscount: '500' })] }),
      ctx(),
    );
    expect(codes(result)).toContain('BR-UAE-27');
  });
});

describe('type-conditional rules', () => {
  it('requires a preceding invoice on credit notes', () => {
    expect(codes(validateInvoice(invoice({ invoiceType: '381' }), ctx()))).toContain('BR-UAE-29');
    expect(
      codes(validateInvoice(invoice({ invoiceType: '381', precedingInvoiceId: 'INV-1' }), ctx())),
    ).not.toContain('BR-UAE-29');
  });

  it('requires an FX rate for non-AED invoices', () => {
    expect(codes(validateInvoice(invoice({ currency: 'USD', fxRate: '' }), ctx()))).toContain(
      'BR-UAE-20',
    );
  });
});

describe('date rules', () => {
  it('rejects a future issue date', () => {
    expect(codes(validateInvoice(invoice({ issueDate: '2026-09-01' }), ctx()))).toContain(
      'BR-UAE-17',
    );
  });

  it('warns but does not block on a backdated invoice', () => {
    const result = validateInvoice(invoice({ issueDate: '2026-06-01' }), ctx());
    expect(codes(result)).toContain('WRN-UAE-05');
    expect(result.submittable).toBe(true);
  });
});

describe('auto-fix', () => {
  it('corrects casing, blanks and VAT rates without inventing data', () => {
    const dirty = invoice({
      currency: '',
      fxRate: '',
      issueTime: '14:30',
      buyerEmirate: 'dxb',
      buyerTrn: '100-384 759200003',
      lines: [line({ vatCategory: 'z', vatRate: '5.00', uom: 'mon', lineDiscount: '' })],
    });

    const { invoices, changes } = autoFix([dirty]);
    const fixed = invoices[0]!;

    expect(fixed.currency).toBe('AED');
    expect(fixed.fxRate).toBe('1.000000');
    expect(fixed.issueTime).toBe('14:30:00');
    expect(fixed.buyerEmirate).toBe('Dubai');
    expect(fixed.buyerTrn).toBe('100384759200003');
    expect(fixed.lines[0]!.vatCategory).toBe('Z');
    expect(fixed.lines[0]!.vatRate).toBe('0.00');
    expect(fixed.lines[0]!.uom).toBe('MON');
    expect(changes.length).toBeGreaterThan(0);
    expect(validateInvoice(fixed, ctx()).submittable).toBe(true);
  });

  it('refuses to invent a missing buyer name or TRN', () => {
    const { invoices } = autoFix([invoice({ buyerName: '', buyerTrn: '' })]);
    expect(invoices[0]!.buyerName).toBe('');
    expect(invoices[0]!.buyerTrn).toBe('');
    expect(validateInvoice(invoices[0]!, ctx()).submittable).toBe(false);
  });
});
