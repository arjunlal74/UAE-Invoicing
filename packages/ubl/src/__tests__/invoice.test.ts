import type { StagedInvoice, StagedLine } from '@uae/domain';
import { describe, expect, it } from 'vitest';
import { buildInvoiceXml, type SupplierParty } from '../invoice.js';
import { QR_TAGS, buildQrPayload, decodeQrPayload } from '../qr.js';

const supplier: SupplierParty = {
  trn: '100293847500003',
  legalNameEn: 'Al-Bahar Enterprises LLC',
  legalNameAr: 'شركة البحار للمقاولات ذ.م.م',
  city: 'Dubai',
  emirate: 'Dubai',
  countryCode: 'AE',
};

function line(over: Partial<StagedLine> = {}): StagedLine {
  return {
    id: 'l1',
    lineNumber: '1',
    description: 'IT Consulting Services',
    hsCode: '8471.30.00',
    quantity: '10',
    uom: 'HUR',
    unitPrice: '500',
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
    invoiceNumber: 'INV-2026-00891',
    invoiceType: '380',
    issueDate: '2026-08-09',
    issueTime: '14:30:00',
    currency: 'AED',
    fxRate: '1.000000',
    supplierTrn: supplier.trn,
    supplierName: supplier.legalNameEn,
    buyerTrn: '100384759200003',
    buyerName: 'Emirates Trading Co',
    buyerEmirate: 'Abu Dhabi',
    poReference: 'PO-992211',
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

const build = (over: Partial<StagedInvoice> = {}) =>
  buildInvoiceXml({ invoice: invoice(over), supplier, peppolUuid: 'c3098f98-e705-4b08-8e6f-705d9dfd7003' });

describe('UBL invoice generation', () => {
  it('emits a well-formed PINT-AE invoice with the expected identifiers', () => {
    const xml = build();
    expect(xml).toContain('<cbc:CustomizationID>urn:peppol:pint:billing-1@ae-1</cbc:CustomizationID>');
    expect(xml).toContain('<cbc:ID>INV-2026-00891</cbc:ID>');
    expect(xml).toContain('<cbc:UUID>c3098f98-e705-4b08-8e6f-705d9dfd7003</cbc:UUID>');
    expect(xml).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:IssueTime>14:30:00</cbc:IssueTime>');
  });

  it('carries the recalculated totals, not whatever the upload claimed', () => {
    const xml = build({ payableAmount: '999999.00', vatTotalAmount: '1.00' });
    expect(xml).toContain('<cbc:PayableAmount currencyID="AED">5250.00</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="AED">250.00</cbc:TaxAmount>');
    expect(xml).not.toContain('999999.00');
  });

  it('includes both parties with their TRNs under the UAE scheme', () => {
    const xml = build();
    expect(xml).toContain('<cbc:EndpointID schemeID="0201">100293847500003</cbc:EndpointID>');
    expect(xml).toContain('<cbc:EndpointID schemeID="0201">100384759200003</cbc:EndpointID>');
    expect(xml).toContain('<cbc:RegistrationName>Emirates Trading Co</cbc:RegistrationName>');
  });

  it('omits the buyer endpoint and tax scheme entirely on a B2C invoice', () => {
    const xml = build({ invoiceType: '388', buyerTrn: '', buyerName: 'Individual Customer' });
    // Only the supplier endpoint should remain.
    expect(xml.match(/<cbc:EndpointID/g)).toHaveLength(1);
    expect(xml.match(/<cac:PartyTaxScheme>/g)).toHaveLength(1);
    expect(xml).toContain('<cbc:RegistrationName>Individual Customer</cbc:RegistrationName>');
  });

  it('references the preceding invoice on a credit note', () => {
    const xml = build({ invoiceType: '381', precedingInvoiceId: 'INV-2026-00500' });
    expect(xml).toContain('<cac:BillingReference>');
    expect(xml).toContain('<cbc:ID>INV-2026-00500</cbc:ID>');
  });

  it('emits an exchange rate block only for non-AED invoices', () => {
    expect(build()).not.toContain('<cac:TaxExchangeRate>');
    const usd = build({ currency: 'USD', fxRate: '3.672500' });
    expect(usd).toContain('<cbc:CalculationRate>3.672500</cbc:CalculationRate>');
    expect(usd).toContain('<cbc:TargetCurrencyCode>AED</cbc:TargetCurrencyCode>');
  });

  it('produces one tax subtotal per category in use', () => {
    const xml = build({
      lines: [
        line({ id: 'a', vatCategory: 'S', quantity: '1', unitPrice: '100' }),
        line({ id: 'b', lineNumber: '2', vatCategory: 'E', quantity: '1', unitPrice: '50' }),
      ],
    });
    expect(xml.match(/<cac:TaxSubtotal>/g)).toHaveLength(2);
    expect(xml).toContain('<cbc:TaxExemptionReason>Exempt supply under UAE VAT law</cbc:TaxExemptionReason>');
  });

  it('represents a line discount as a negative allowance charge', () => {
    const xml = build({ lines: [line({ lineDiscount: '50' })] });
    expect(xml).toContain('<cbc:ChargeIndicator>false</cbc:ChargeIndicator>');
    // Normalised to 2dp regardless of how the cell was typed.
    expect(xml).toContain('<cbc:Amount currencyID="AED">50.00</cbc:Amount>');
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="AED">4950.00</cbc:LineExtensionAmount>');
  });

  it('omits the allowance block when there is no discount', () => {
    expect(build({ lines: [line({ lineDiscount: '0' })] })).not.toContain('<cac:AllowanceCharge>');
    expect(build({ lines: [line({ lineDiscount: '' })] })).not.toContain('<cac:AllowanceCharge>');
  });

  it('escapes XML metacharacters in free-text fields', () => {
    const xml = build({ buyerName: 'Smith & Sons <Trading> Co' });
    expect(xml).toContain('Smith &amp; Sons &lt;Trading&gt; Co');
    expect(xml).not.toContain('<Trading>');
  });

  it('preserves Arabic text intact', () => {
    const xml = buildInvoiceXml({
      invoice: invoice({ buyerName: 'شركة الإمارات للتجارة' }),
      supplier,
      peppolUuid: 'c3098f98-e705-4b08-8e6f-705d9dfd7003',
    });
    expect(xml).toContain('شركة الإمارات للتجارة');
  });
});

describe('QR payload', () => {
  it('round-trips the five mandated fields', () => {
    const payload = buildQrPayload({
      invoice: invoice(),
      sellerName: supplier.legalNameEn,
      sellerTrn: supplier.trn,
    });
    const decoded = decodeQrPayload(payload);
    expect(decoded[QR_TAGS.SELLER_NAME]).toBe('Al-Bahar Enterprises LLC');
    expect(decoded[QR_TAGS.SELLER_TRN]).toBe('100293847500003');
    expect(decoded[QR_TAGS.TIMESTAMP]).toBe('2026-08-09T14:30:00Z');
    expect(decoded[QR_TAGS.INVOICE_TOTAL]).toBe('5250.00');
    expect(decoded[QR_TAGS.VAT_TOTAL]).toBe('250.00');
  });

  it('round-trips multi-byte seller names', () => {
    const payload = buildQrPayload({
      invoice: invoice(),
      sellerName: 'شركة البحار للمقاولات ذ.م.م',
      sellerTrn: supplier.trn,
    });
    expect(decodeQrPayload(payload)[QR_TAGS.SELLER_NAME]).toBe('شركة البحار للمقاولات ذ.م.م');
  });

  it('truncates an over-long name on a character boundary, not mid-codepoint', () => {
    const payload = buildQrPayload({
      invoice: invoice(),
      sellerName: 'ش'.repeat(200), // 400 bytes in UTF-8
      sellerTrn: supplier.trn,
    });
    const name = decodeQrPayload(payload)[QR_TAGS.SELLER_NAME]!;
    expect(name).toMatch(/^ش+$/);
    expect(Buffer.from(name, 'utf8').length).toBeLessThanOrEqual(255);
    // The other tags must still decode, which only holds if the truncated
    // value's declared length matched its real byte length.
    expect(decodeQrPayload(payload)[QR_TAGS.VAT_TOTAL]).toBe('250.00');
  });
});
