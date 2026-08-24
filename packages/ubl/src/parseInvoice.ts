import { emptyLine, recalcInvoice, type StagedInvoice, type StagedLine } from '@uae/domain';

/**
 * Reading an inbound purchase invoice (SRS v2.7 §12.1).
 *
 * Module 2 receives cleared UBL 2.1 documents that a supplier's ASP pushed at
 * us. They have to become the same `StagedInvoice` shape everything else in the
 * platform speaks, so that one grid renders them, one calculator checks their
 * arithmetic and one detail screen shows them.
 *
 * Two things this parser deliberately does NOT do:
 *
 *   1. It does not recalculate the supplier's figures over the top of what they
 *      sent. Those amounts are the supplier's legal assertion and the buyer's
 *      input-tax claim rests on them; silently "correcting" a rounding
 *      difference would hide exactly the discrepancy the AP desk exists to
 *      catch. The recalculated view is produced separately for comparison.
 *   2. It does not reject documents it only partly understands. A supplier
 *      whose XML carries an element we have never seen is still owed a review,
 *      not a bounce.
 */

export interface ParsedInboundInvoice {
  /** The document as sent, amounts exactly as the supplier stated them. */
  invoice: StagedInvoice;
  /** Header fields that have no home on StagedInvoice. */
  peppolUuid: string | null;
  customizationId: string | null;
  supplierStreet: string | null;
  supplierCity: string | null;
  supplierEmirate: string | null;
  supplierPostalCode: string | null;
  supplierContactEmail: string | null;
  /** Present when the supplier's ASP embedded the clearance identifier. */
  ftaIrn: string | null;
  /** Discrepancies between the stated totals and the recalculated ones. */
  arithmeticWarnings: string[];
}

export class InboundParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundParseError';
  }
}

export function parseInboundInvoiceXml(
  xml: string,
  options: { id: string; lineId: (index: number) => string },
): ParsedInboundInvoice {
  if (!/<(\w+:)?Invoice[\s>]/.test(xml)) {
    throw new InboundParseError(
      'That file is not a UBL Invoice document. Expected an <Invoice> root element.',
    );
  }

  const invoiceNumber = tag(xml, 'cbc:ID', { scope: headerScope(xml) });
  if (!invoiceNumber) {
    throw new InboundParseError('The document carries no invoice number (cbc:ID).');
  }

  const supplierBlock = block(xml, 'cac:AccountingSupplierParty') ?? '';
  const customerBlock = block(xml, 'cac:AccountingCustomerParty') ?? '';

  const lines = parseLines(xml, options.lineId);

  const stated: StagedInvoice = {
    id: options.id,
    invoiceNumber,
    invoiceType: tag(xml, 'cbc:InvoiceTypeCode', { scope: headerScope(xml) }) ?? '380',
    issueDate: tag(xml, 'cbc:IssueDate', { scope: headerScope(xml) }) ?? '',
    issueTime: tag(xml, 'cbc:IssueTime', { scope: headerScope(xml) }) ?? '00:00:00',
    currency: tag(xml, 'cbc:DocumentCurrencyCode', { scope: headerScope(xml) }) ?? 'AED',
    fxRate: tag(xml, 'cbc:CalculationRate') ?? '1.000000',
    supplierTrn: partyTrn(supplierBlock) ?? '',
    supplierName: partyName(supplierBlock) ?? 'Unknown supplier',
    buyerTrn: partyTrn(customerBlock) ?? '',
    buyerName: partyName(customerBlock) ?? '',
    buyerEmirate: tag(customerBlock, 'cbc:CountrySubentity') ?? tag(customerBlock, 'cbc:CityName') ?? '',
    poReference: tag(block(xml, 'cac:OrderReference') ?? '', 'cbc:ID') ?? '',
    precedingInvoiceId:
      tag(block(xml, 'cac:InvoiceDocumentReference') ?? '', 'cbc:ID') ?? '',
    paymentMeans: tag(xml, 'cbc:PaymentMeansCode') ?? '',
    lines,
    lineExtensionAmount: amount(xml, 'cac:LegalMonetaryTotal', 'cbc:LineExtensionAmount'),
    taxExclusiveAmount: amount(xml, 'cac:LegalMonetaryTotal', 'cbc:TaxExclusiveAmount'),
    vatTotalAmount: taxTotal(xml),
    taxInclusiveAmount: amount(xml, 'cac:LegalMonetaryTotal', 'cbc:TaxInclusiveAmount'),
    payableAmount: amount(xml, 'cac:LegalMonetaryTotal', 'cbc:PayableAmount'),
    payableAmountAed: '',
    sourceRow: null,
  };

  // AED conversion is ours to do, not the supplier's. If the document is in AED
  // the two are the same number; otherwise the stated FX rate applies.
  const recalculated = recalcInvoice(stated);
  stated.payableAmountAed =
    stated.currency === 'AED' ? stated.payableAmount : recalculated.payableAmountAed;

  const warnings: string[] = [];
  const compare = (label: string, statedValue: string, ours: string) => {
    if (statedValue && statedValue !== ours) {
      warnings.push(
        `The supplier states a ${label} of ${statedValue}, but recalculating their own line items gives ${ours}.`,
      );
    }
  };
  compare('net total', stated.lineExtensionAmount, recalculated.lineExtensionAmount);
  compare('VAT total', stated.vatTotalAmount, recalculated.vatTotalAmount);
  compare('payable amount', stated.payableAmount, recalculated.payableAmount);

  return {
    invoice: stated,
    peppolUuid: tag(xml, 'cbc:UUID', { scope: headerScope(xml) }),
    customizationId: tag(xml, 'cbc:CustomizationID'),
    supplierStreet: tag(supplierBlock, 'cbc:StreetName'),
    supplierCity: tag(supplierBlock, 'cbc:CityName'),
    supplierEmirate: tag(supplierBlock, 'cbc:CountrySubentity'),
    supplierPostalCode: tag(supplierBlock, 'cbc:PostalZone'),
    supplierContactEmail: tag(supplierBlock, 'cbc:ElectronicMail'),
    // Some ASPs stamp the clearance identifier into an AdditionalDocument-
    // Reference rather than anywhere standard, so both spellings are tried.
    ftaIrn:
      tagWithAttribute(xml, 'cbc:ID', 'schemeID', 'FTA-IRN') ??
      additionalReference(xml, 'IRN') ??
      null,
    arithmeticWarnings: warnings,
  };
}

// ---------------------------------------------------------------------------
// Extraction helpers
//
// Regex rather than a DOM parser, and for one reason: this package is imported
// by the browser bundle as well as the worker, and pulling a full XML DOM in
// for six field lookups would cost far more than it returns. The inputs are
// machine-generated UBL, not arbitrary markup.
// ---------------------------------------------------------------------------

/**
 * The document header — everything before the first party block.
 *
 * Necessary because `cbc:ID` appears a dozen times in a UBL invoice (parties,
 * lines, tax categories) and only the first one is the invoice number.
 */
function headerScope(xml: string): string {
  const index = xml.indexOf('<cac:AccountingSupplierParty');
  return index === -1 ? xml : xml.slice(0, index);
}

function tag(source: string, name: string, options?: { scope?: string }): string | null {
  const target = options?.scope ?? source;
  const pattern = new RegExp(`<${escapeName(name)}[^>]*>([\\s\\S]*?)</${escapeName(name)}>`);
  const match = pattern.exec(target);
  return match?.[1] !== undefined ? decodeEntities(match[1].trim()) || null : null;
}

function tagWithAttribute(
  source: string,
  name: string,
  attribute: string,
  value: string,
): string | null {
  const pattern = new RegExp(
    `<${escapeName(name)}[^>]*${attribute}="${value}"[^>]*>([\\s\\S]*?)</${escapeName(name)}>`,
  );
  const match = pattern.exec(source);
  return match?.[1] ? decodeEntities(match[1].trim()) : null;
}

function additionalReference(xml: string, idPrefix: string): string | null {
  const blocks = xml.match(
    /<cac:AdditionalDocumentReference>[\s\S]*?<\/cac:AdditionalDocumentReference>/g,
  );
  for (const candidate of blocks ?? []) {
    const id = tag(candidate, 'cbc:ID');
    if (id && id.toUpperCase().includes(idPrefix)) {
      return tag(candidate, 'cbc:DocumentDescription') ?? id;
    }
  }
  return null;
}

function block(xml: string, name: string): string | null {
  const pattern = new RegExp(`<${escapeName(name)}[^>]*>([\\s\\S]*?)</${escapeName(name)}>`);
  return pattern.exec(xml)?.[1] ?? null;
}

function amount(xml: string, container: string, name: string): string {
  const scope = block(xml, container);
  return (scope ? tag(scope, name) : null) ?? '';
}

/** The document-level TaxTotal, not the per-line ones that follow it. */
function taxTotal(xml: string): string {
  const beforeLines = xml.slice(0, indexOrEnd(xml, '<cac:InvoiceLine'));
  const scope = block(beforeLines, 'cac:TaxTotal');
  return (scope ? tag(scope, 'cbc:TaxAmount') : null) ?? '';
}

function indexOrEnd(source: string, needle: string): number {
  const index = source.indexOf(needle);
  return index === -1 ? source.length : index;
}

function partyTrn(partyBlock: string): string | null {
  return (
    tag(block(partyBlock, 'cac:PartyTaxScheme') ?? '', 'cbc:CompanyID') ??
    tag(partyBlock, 'cbc:EndpointID')
  );
}

function partyName(partyBlock: string): string | null {
  return (
    tag(block(partyBlock, 'cac:PartyLegalEntity') ?? '', 'cbc:RegistrationName') ??
    tag(block(partyBlock, 'cac:PartyName') ?? '', 'cbc:Name')
  );
}

function parseLines(xml: string, lineId: (index: number) => string): StagedLine[] {
  const blocks = xml.match(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/g) ?? [];

  return blocks.map((source, index) => {
    const item = block(source, 'cac:Item') ?? '';
    const category = block(item, 'cac:ClassifiedTaxCategory') ?? '';
    const quantityMatch = /<cbc:InvoicedQuantity[^>]*unitCode="([^"]+)"[^>]*>([\s\S]*?)</.exec(source);

    const base = emptyLine(lineId(index), index + 1);
    return {
      ...base,
      lineNumber: tag(source, 'cbc:ID') ?? String(index + 1),
      description: tag(item, 'cbc:Name') ?? '',
      hsCode: tagWithAttribute(item, 'cbc:ItemClassificationCode', 'listID', 'HS') ?? '',
      quantity: quantityMatch?.[2]?.trim() ?? '',
      uom: quantityMatch?.[1] ?? 'PCE',
      unitPrice: tag(block(source, 'cac:Price') ?? '', 'cbc:PriceAmount') ?? '',
      lineDiscount: allowanceAmount(source),
      vatCategory: tag(category, 'cbc:ID') ?? 'S',
      vatRate: tag(category, 'cbc:Percent') ?? '5.00',
      netAmount: tag(source, 'cbc:LineExtensionAmount') ?? '',
      vatAmount: tag(block(source, 'cac:TaxTotal') ?? '', 'cbc:TaxAmount') ?? '',
      lineTotal: '',
      sourceRow: null,
    } satisfies StagedLine;
  });
}

/** A line-level allowance (ChargeIndicator false) is a discount. A charge is not. */
function allowanceAmount(lineXml: string): string {
  const blocks = lineXml.match(/<cac:AllowanceCharge>[\s\S]*?<\/cac:AllowanceCharge>/g) ?? [];
  for (const candidate of blocks) {
    if (tag(candidate, 'cbc:ChargeIndicator') === 'false') {
      return tag(candidate, 'cbc:Amount') ?? '0.00';
    }
  }
  return '0.00';
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
