import { recalcInvoice, type StagedInvoice, type StagedLine } from '@uae/domain';
import { describe, expect, it } from 'vitest';
import {
  buildApplicationResponseXml,
  parseApplicationResponse,
} from '../applicationResponse.js';
import { buildInvoiceXml } from '../invoice.js';
import { InboundParseError, parseInboundInvoiceXml } from '../parseInvoice.js';

/**
 * The two documents SRS v2.7 adds to the wire: the ApplicationResponse that
 * carries a commercial verdict (§11, §12.3) and the inbound purchase invoice
 * the AP module receives (§12.1).
 */

function line(over: Partial<StagedLine> = {}): StagedLine {
  return {
    id: 'l1',
    lineNumber: '1',
    description: 'Server Maintenance',
    hsCode: '8471.30',
    quantity: '3',
    uom: 'HUR',
    unitPrice: '5000',
    lineDiscount: '0',
    vatCategory: 'S',
    vatRate: '5.00',
    netAmount: '',
    vatAmount: '',
    lineTotal: '',
    sourceRow: null,
    ...over,
  };
}

function invoice(over: Partial<StagedInvoice> = {}): StagedInvoice {
  return recalcInvoice({
    id: 'i1',
    invoiceNumber: 'SUP-2026-881',
    invoiceType: '380',
    issueDate: '2026-08-20',
    issueTime: '11:05:00',
    currency: 'AED',
    fxRate: '1.000000',
    supplierTrn: '100293847500003',
    supplierName: 'Gulf Tech LLC',
    buyerTrn: '100384759200003',
    buyerName: 'Al-Bahar Enterprises LLC',
    buyerEmirate: 'Dubai',
    poReference: 'PO-44012',
    precedingInvoiceId: '',
    paymentMeans: '30',
    lines: [line()],
    lineExtensionAmount: '',
    taxExclusiveAmount: '',
    vatTotalAmount: '',
    taxInclusiveAmount: '',
    payableAmount: '',
    payableAmountAed: '',
    sourceRow: null,
    ...over,
  });
}

const supplier = {
  trn: '100293847500003',
  legalNameEn: 'Gulf Tech LLC',
  legalNameAr: 'جلف تك ذ.م.م',
  street: 'Sheikh Zayed Road',
  city: 'Dubai',
  emirate: 'Dubai',
  postalCode: '00000',
};

// ===========================================================================
// §12.1 receiving a purchase invoice
// ===========================================================================

describe('inbound purchase invoice parsing', () => {
  /**
   * The strongest available check on the AP reader: generate a document with
   * our own PINT builder and read it back. Anything the two disagree about is a
   * genuine defect in one of them rather than a quarrel with a fixture.
   */
  const xml = buildInvoiceXml({ invoice: invoice(), supplier, peppolUuid: 'a'.repeat(8) + '-1111-2222-3333-444444444444' });
  const parsed = parseInboundInvoiceXml(xml, { id: 'p1', lineId: (i) => `pl-${i}` });

  it('recovers the header the supplier sent', () => {
    expect(parsed.invoice.invoiceNumber).toBe('SUP-2026-881');
    expect(parsed.invoice.invoiceType).toBe('380');
    expect(parsed.invoice.issueDate).toBe('2026-08-20');
    expect(parsed.invoice.currency).toBe('AED');
    expect(parsed.invoice.poReference).toBe('PO-44012');
  });

  it('identifies both parties by TRN', () => {
    expect(parsed.invoice.supplierTrn).toBe('100293847500003');
    expect(parsed.invoice.supplierName).toBe('Gulf Tech LLC');
    expect(parsed.invoice.buyerTrn).toBe('100384759200003');
  });

  it('recovers the line items', () => {
    expect(parsed.invoice.lines).toHaveLength(1);
    const [first] = parsed.invoice.lines;
    expect(first!.description).toBe('Server Maintenance');
    expect(first!.quantity).toBe('3');
    expect(first!.uom).toBe('HUR');
    expect(first!.hsCode).toBe('8471.30');
    expect(first!.vatCategory).toBe('S');
    expect(first!.netAmount).toBe('15000.00');
  });

  it('preserves the totals exactly as stated rather than recomputing them', () => {
    expect(parsed.invoice.lineExtensionAmount).toBe('15000.00');
    expect(parsed.invoice.vatTotalAmount).toBe('750.00');
    expect(parsed.invoice.payableAmount).toBe('15750.00');
    expect(parsed.arithmeticWarnings).toEqual([]);
  });

  it('reports arithmetic the supplier got wrong instead of silently fixing it', () => {
    // The AP desk's entire purpose is catching this, so it must survive parsing.
    const tampered = xml.replace(
      '<cbc:PayableAmount currencyID="AED">15750.00</cbc:PayableAmount>',
      '<cbc:PayableAmount currencyID="AED">17750.00</cbc:PayableAmount>',
    );
    const result = parseInboundInvoiceXml(tampered, { id: 'p2', lineId: (i) => `pl-${i}` });

    expect(result.invoice.payableAmount).toBe('17750.00');
    expect(result.arithmeticWarnings.join(' ')).toContain('17750.00');
  });

  it('reads a line discount back as a discount, not as a charge', () => {
    const discounted = buildInvoiceXml({
      invoice: invoice({ lines: [line({ lineDiscount: '500' })] }),
      supplier,
      peppolUuid: 'b'.repeat(8) + '-1111-2222-3333-444444444444',
    });
    const result = parseInboundInvoiceXml(discounted, { id: 'p3', lineId: (i) => `pl-${i}` });

    expect(result.invoice.lines[0]!.lineDiscount).toBe('500.00');
    expect(result.invoice.lines[0]!.netAmount).toBe('14500.00');
  });

  it('refuses a document that is not a UBL invoice at all', () => {
    expect(() => parseInboundInvoiceXml('<html><body>oops</body></html>', { id: 'x', lineId: () => 'l' }))
      .toThrow(InboundParseError);
  });
});

// ===========================================================================
// §11 / §12.3 the ApplicationResponse
// ===========================================================================

const responseOptions = {
  responseUuid: 'c'.repeat(8) + '-1111-2222-3333-444444444444',
  responseId: 'RSP-SUP-2026-881',
  issueDate: '2026-08-24',
  issueTime: '10:15:00',
  sender: { trn: '100384759200003', name: 'Al-Bahar Enterprises LLC' },
  recipient: { trn: '100293847500003', name: 'Gulf Tech LLC' },
  document: {
    invoiceNumber: 'SUP-2026-881',
    issueDate: '2026-08-20',
    peppolUuid: 'a'.repeat(8) + '-1111-2222-3333-444444444444',
  },
};

describe('application response', () => {
  it('carries a rejection with its reason code', () => {
    const xml = buildApplicationResponseXml({
      ...responseOptions,
      responseCode: 'RE',
      reasonCode: 'PRI',
      description: 'Unit price should be AED 4,500 as per contract MSA-2026-Rev1.',
    });

    expect(xml).toContain('<cbc:ResponseCode>RE</cbc:ResponseCode>');
    expect(xml).toContain('PRI</cbc:StatusReasonCode>');
    expect(xml).toContain('urn:fdc:peppol.eu:poacc:trns:invoice_response:3');
  });

  it('names the invoice it responds to, not itself', () => {
    const xml = buildApplicationResponseXml({ ...responseOptions, responseCode: 'AP' });
    const reference = /<cac:DocumentReference>[\s\S]*?<\/cac:DocumentReference>/.exec(xml)![0];

    expect(reference).toContain('<cbc:ID>SUP-2026-881</cbc:ID>');
    expect(reference).toContain('<cbc:IssueDate>2026-08-20</cbc:IssueDate>');
  });

  it('omits the status block when there is no reason to report', () => {
    const xml = buildApplicationResponseXml({ ...responseOptions, responseCode: 'AP' });
    expect(xml).not.toContain('cbc:StatusReasonCode');
  });

  /**
   * The round trip that matters: what our AP desk sends is exactly what our AR
   * dispute engine has to be able to read when a buyer sends us the same thing.
   */
  it('round-trips through the reader', () => {
    const xml = buildApplicationResponseXml({
      ...responseOptions,
      responseCode: 'UQ',
      reasonCode: 'QTY',
      description: 'Only 2 units were received against 3 invoiced.',
    });

    const parsed = parseApplicationResponse(xml);
    expect(parsed.responseCode).toBe('UQ');
    expect(parsed.reasonCode).toBe('QTY');
    expect(parsed.invoiceNumber).toBe('SUP-2026-881');
    expect(parsed.invoicePeppolUuid).toBe(responseOptions.document.peppolUuid);
    expect(parsed.description).toBe('Only 2 units were received against 3 invoiced.');
    expect(parsed.senderTrn).toBe('100384759200003');
  });

  it('returns nulls rather than throwing on a response it cannot understand', () => {
    const parsed = parseApplicationResponse('<ApplicationResponse></ApplicationResponse>');
    expect(parsed.responseCode).toBeNull();
    expect(parsed.invoiceNumber).toBeNull();
  });
});

// ===========================================================================
// §8.2 the credit note's legal linkage
// ===========================================================================

describe('credit note XML', () => {
  it('embeds the preceding invoice number, date and clearance IRN', () => {
    const xml = buildInvoiceXml({
      invoice: invoice({
        invoiceNumber: 'CN-2026-00042',
        invoiceType: '381',
        precedingInvoiceId: 'INV-2026-00891',
      }),
      supplier,
      peppolUuid: 'd'.repeat(8) + '-1111-2222-3333-444444444444',
      preceding: {
        invoiceNumber: 'INV-2026-00891',
        issueDate: '2026-08-09',
        ftaIrn: 'irn_uae_993827101829',
      },
      note: 'Adjusted rate from AED 5,000 to AED 4,500 as per MSA-2026-Rev1.',
    });

    const reference = /<cac:BillingReference>[\s\S]*?<\/cac:BillingReference>/.exec(xml)![0];
    expect(reference).toContain('<cbc:ID>INV-2026-00891</cbc:ID>');
    expect(reference).toContain('<cbc:IssueDate>2026-08-09</cbc:IssueDate>');
    expect(reference).toContain('<cbc:UUID>irn_uae_993827101829</cbc:UUID>');
    expect(xml).toContain('Adjusted rate from AED 5,000');
  });

  it('emits no billing reference on an ordinary invoice', () => {
    const xml = buildInvoiceXml({
      invoice: invoice(),
      supplier,
      peppolUuid: 'e'.repeat(8) + '-1111-2222-3333-444444444444',
    });
    expect(xml).not.toContain('cac:BillingReference');
  });

  it('fills the buyer party block from the customer directory when there is one', () => {
    const xml = buildInvoiceXml({
      invoice: invoice(),
      supplier,
      peppolUuid: 'f'.repeat(8) + '-1111-2222-3333-444444444444',
      buyer: {
        street: 'Al-Maktoum Street',
        building: 'Deira Tower',
        city: 'Dubai',
        postalCode: '12345',
        contactName: 'Accounts Payable',
        contactEmail: 'accounts@albahar.ae',
        contactPhone: '+97140000000',
      },
    });

    const buyerBlock = /<cac:AccountingCustomerParty>[\s\S]*?<\/cac:AccountingCustomerParty>/.exec(xml)![0];
    expect(buyerBlock).toContain('<cbc:StreetName>Al-Maktoum Street</cbc:StreetName>');
    expect(buyerBlock).toContain('<cbc:PostalZone>12345</cbc:PostalZone>');
    expect(buyerBlock).toContain('<cbc:ElectronicMail>accounts@albahar.ae</cbc:ElectronicMail>');
  });

  it('omits the contact element entirely when the directory has no contact', () => {
    const xml = buildInvoiceXml({
      invoice: invoice(),
      supplier,
      peppolUuid: '0'.repeat(8) + '-1111-2222-3333-444444444444',
      buyer: { street: 'Al-Maktoum Street' },
    });
    expect(xml).not.toContain('cac:Contact');
  });
});
