import {
  INVOICE_TYPES,
  PAYMENT_MEANS,
  UNIT_PRICE_DP,
  VAT_CATEGORIES,
  money,
  recalcInvoice,
  round,
  taxSubtotals,
  toDecimal,
  type InvoiceTypeCode,
  type PaymentMeansCode,
  type StagedInvoice,
  type VatCategoryCode,
} from '@uae/domain';
import { create } from 'xmlbuilder2';

/**
 * UAE PINT-AE / UBL 2.1 invoice document builder.
 *
 * Element order is significant in UBL — the XSD uses xs:sequence, so a document
 * with correct content in the wrong order fails schema validation. The order
 * below follows UBL 2.1 Invoice-2.
 */

const NS = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
} as const;

/**
 * PINT AE customisation and profile identifiers.
 *
 * These are the two values an ASP checks first to decide which rule set to run.
 * They are configurable because the FTA revises the customisation ID between
 * PINT releases and we must be able to change it without a code deploy.
 */
export const DEFAULT_CUSTOMIZATION_ID =
  'urn:peppol:pint:billing-1@ae-1';
export const DEFAULT_PROFILE_ID = 'urn:peppol:bis:billing';

/** Peppol/ISO 6523 scheme for UAE tax registration numbers. */
export const UAE_TRN_SCHEME_ID = '0201';

export interface SupplierParty {
  trn: string;
  legalNameEn: string;
  legalNameAr?: string | null;
  street?: string | null;
  city?: string | null;
  emirate?: string | null;
  postalCode?: string | null;
  countryCode?: string;
}

/**
 * Buyer detail beyond what the staged row carries.
 *
 * The spreadsheet channel only ever knew the buyer's name, TRN and emirate. A
 * document composed in the in-app builder is drawn from the Customer Master
 * Directory (SRS v2.7 §6) and can therefore fill the whole party block, which
 * is what PINT wants and what a buyer's own AP desk reconciles against.
 */
export interface BuyerParty {
  street?: string | null;
  building?: string | null;
  city?: string | null;
  postalCode?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

/** The document a credit or debit note corrects (SRS v2.7 §8.2 feature 2). */
export interface PrecedingDocument {
  invoiceNumber: string;
  issueDate?: string | null;
  /** The FTA clearance IRN of the original, embedded for legal auditability. */
  ftaIrn?: string | null;
}

export interface BuildInvoiceOptions {
  invoice: StagedInvoice;
  supplier: SupplierParty;
  buyer?: BuyerParty | null;
  /** Stable document UUID, persisted on the invoice row. */
  peppolUuid: string;
  /**
   * Set on a 381/383. Overrides the free-text `precedingInvoiceId` the
   * spreadsheet channel carries, because only this form has the IRN.
   */
  preceding?: PrecedingDocument | null;
  /** Free-text explanation, emitted as cbc:Note. §8.1's "Credit Note Notes". */
  note?: string | null;
  customizationId?: string;
  profileId?: string;
  /** Injected so generation is deterministic and reproducible in tests. */
  generatedAt?: Date;
}

/**
 * Every UBL amount element carries a currencyID attribute. Returning just the
 * attribute map keeps the call sites as `.ele(name, attrs).txt(value)`, which
 * is the only form xmlbuilder2 accepts — passing the text alongside the
 * attributes silently produces an invalid attribute name.
 */
function amountAttrs(currency: string) {
  return { currencyID: currency };
}

export function buildInvoiceXml(options: BuildInvoiceOptions): string {
  const invoice = recalcInvoice(options.invoice);
  const { supplier, peppolUuid } = options;
  const currency = invoice.currency || 'AED';
  const typeCode = invoice.invoiceType as InvoiceTypeCode;
  const typeSpec = INVOICE_TYPES[typeCode];

  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('Invoice', {
    xmlns: NS.invoice,
    'xmlns:cac': NS.cac,
    'xmlns:cbc': NS.cbc,
    'xmlns:ext': NS.ext,
  });

  doc.ele('cbc:CustomizationID').txt(options.customizationId ?? DEFAULT_CUSTOMIZATION_ID);
  doc.ele('cbc:ProfileID').txt(options.profileId ?? DEFAULT_PROFILE_ID);
  doc.ele('cbc:ID').txt(invoice.invoiceNumber);
  doc.ele('cbc:UUID').txt(peppolUuid);
  doc.ele('cbc:IssueDate').txt(invoice.issueDate);
  doc.ele('cbc:IssueTime').txt(invoice.issueTime);
  doc.ele('cbc:InvoiceTypeCode').txt(invoice.invoiceType);

  // cbc:Note sits between InvoiceTypeCode and DocumentCurrencyCode in the UBL
  // 2.1 sequence. Placing it anywhere else fails XSD validation even though the
  // content is correct.
  if (options.note?.trim()) {
    doc.ele('cbc:Note').txt(options.note.trim());
  }

  doc.ele('cbc:DocumentCurrencyCode').txt(currency);
  doc.ele('cbc:TaxCurrencyCode').txt('AED');

  if (invoice.poReference?.trim()) {
    doc.ele('cac:OrderReference').ele('cbc:ID').txt(invoice.poReference).up();
  }

  // Credit and debit notes must point at the document they adjust. §8.2 makes
  // this the legal linkage: without cac:BillingReference the note is not a
  // correction of anything, and a UAE VAT audit has no way to tie the reversed
  // output tax back to the supply it reverses.
  const precedingNumber =
    options.preceding?.invoiceNumber?.trim() || invoice.precedingInvoiceId?.trim();
  if (typeSpec?.requiresPrecedingInvoice && precedingNumber) {
    const reference = doc.ele('cac:BillingReference').ele('cac:InvoiceDocumentReference');
    reference.ele('cbc:ID').txt(precedingNumber).up();
    if (options.preceding?.issueDate) {
      reference.ele('cbc:IssueDate').txt(options.preceding.issueDate).up();
    }
    // The clearance IRN of the original, carried as the referenced document's
    // UUID — the identifier the FTA itself issued and the one an auditor will
    // search on.
    if (options.preceding?.ftaIrn) {
      reference.ele('cbc:UUID').txt(options.preceding.ftaIrn).up();
    }
    reference.up().up();
  }

  // --- Supplier ------------------------------------------------------------
  const supplierParty = doc.ele('cac:AccountingSupplierParty').ele('cac:Party');
  supplierParty
    .ele('cbc:EndpointID', { schemeID: UAE_TRN_SCHEME_ID })
    .txt(supplier.trn)
    .up();

  const supplierAddress = supplierParty.ele('cac:PostalAddress');
  if (supplier.street) supplierAddress.ele('cbc:StreetName').txt(supplier.street).up();
  supplierAddress.ele('cbc:CityName').txt(supplier.city ?? supplier.emirate ?? '').up();
  if (supplier.postalCode) supplierAddress.ele('cbc:PostalZone').txt(supplier.postalCode).up();
  if (supplier.emirate) supplierAddress.ele('cbc:CountrySubentity').txt(supplier.emirate).up();
  supplierAddress
    .ele('cac:Country')
    .ele('cbc:IdentificationCode')
    .txt(supplier.countryCode ?? 'AE')
    .up()
    .up();
  supplierAddress.up();

  supplierParty
    .ele('cac:PartyTaxScheme')
    .ele('cbc:CompanyID')
    .txt(supplier.trn)
    .up()
    .ele('cac:TaxScheme')
    .ele('cbc:ID')
    .txt('VAT')
    .up()
    .up()
    .up();

  const supplierLegal = supplierParty.ele('cac:PartyLegalEntity');
  supplierLegal.ele('cbc:RegistrationName').txt(supplier.legalNameEn).up();
  supplierLegal.ele('cbc:CompanyID').txt(supplier.trn).up();
  supplierLegal.up();
  supplierParty.up().up();

  // --- Buyer ---------------------------------------------------------------
  const buyerParty = doc.ele('cac:AccountingCustomerParty').ele('cac:Party');
  // A B2C simplified invoice legitimately has no buyer TRN, so the endpoint
  // identifier is omitted entirely rather than emitted empty — an empty
  // schemeID-bearing element fails PINT validation.
  if (invoice.buyerTrn?.trim()) {
    buyerParty.ele('cbc:EndpointID', { schemeID: UAE_TRN_SCHEME_ID }).txt(invoice.buyerTrn).up();
  }

  const buyer = options.buyer;
  const buyerAddress = buyerParty.ele('cac:PostalAddress');
  if (buyer?.street) buyerAddress.ele('cbc:StreetName').txt(buyer.street).up();
  if (buyer?.building) {
    buyerAddress.ele('cbc:AdditionalStreetName').txt(buyer.building).up();
  }
  buyerAddress.ele('cbc:CityName').txt(buyer?.city || invoice.buyerEmirate || '').up();
  if (buyer?.postalCode) buyerAddress.ele('cbc:PostalZone').txt(buyer.postalCode).up();
  buyerAddress.ele('cbc:CountrySubentity').txt(invoice.buyerEmirate ?? '').up();
  buyerAddress.ele('cac:Country').ele('cbc:IdentificationCode').txt('AE').up().up();
  buyerAddress.up();

  if (invoice.buyerTrn?.trim()) {
    buyerParty
      .ele('cac:PartyTaxScheme')
      .ele('cbc:CompanyID')
      .txt(invoice.buyerTrn)
      .up()
      .ele('cac:TaxScheme')
      .ele('cbc:ID')
      .txt('VAT')
      .up()
      .up()
      .up();
  }

  buyerParty
    .ele('cac:PartyLegalEntity')
    .ele('cbc:RegistrationName')
    .txt(invoice.buyerName)
    .up()
    .up();

  // §6 maps the directory's contact fields to cac:Contact. Emitted only when
  // there is something to put in it — an empty Contact element is a PINT error.
  if (buyer?.contactName || buyer?.contactEmail || buyer?.contactPhone) {
    const contact = buyerParty.ele('cac:Contact');
    if (buyer.contactName) contact.ele('cbc:Name').txt(buyer.contactName).up();
    if (buyer.contactPhone) contact.ele('cbc:Telephone').txt(buyer.contactPhone).up();
    if (buyer.contactEmail) contact.ele('cbc:ElectronicMail').txt(buyer.contactEmail).up();
    contact.up();
  }

  buyerParty.up().up();

  // --- Payment means -------------------------------------------------------
  const means = invoice.paymentMeans as PaymentMeansCode;
  if (means in PAYMENT_MEANS) {
    doc
      .ele('cac:PaymentMeans')
      .ele('cbc:PaymentMeansCode')
      .txt(means)
      .up()
      .up();
  }

  // --- Exchange rate -------------------------------------------------------
  // Only meaningful when the document currency is not the tax currency.
  if (currency !== 'AED') {
    doc
      .ele('cac:TaxExchangeRate')
      .ele('cbc:SourceCurrencyCode')
      .txt(currency)
      .up()
      .ele('cbc:TargetCurrencyCode')
      .txt('AED')
      .up()
      .ele('cbc:CalculationRate')
      .txt(invoice.fxRate || '1.000000')
      .up()
      .up();
  }

  // --- Tax total -----------------------------------------------------------
  const taxTotal = doc.ele('cac:TaxTotal');
  taxTotal.ele('cbc:TaxAmount', amountAttrs(currency)).txt(invoice.vatTotalAmount).up();

  for (const subtotal of taxSubtotals(invoice)) {
    const sub = taxTotal.ele('cac:TaxSubtotal');
    sub.ele('cbc:TaxableAmount', amountAttrs(currency)).txt(subtotal.taxableAmount).up();
    sub.ele('cbc:TaxAmount', amountAttrs(currency)).txt(subtotal.taxAmount).up();

    const cat = sub.ele('cac:TaxCategory');
    cat.ele('cbc:ID').txt(subtotal.category).up();
    cat.ele('cbc:Percent').txt(subtotal.rate).up();
    if (subtotal.exemptionReason) {
      cat.ele('cbc:TaxExemptionReason').txt(subtotal.exemptionReason).up();
    }
    cat.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT').up().up();
    cat.up();
    sub.up();
  }
  taxTotal.up();

  // --- Monetary totals -----------------------------------------------------
  const totals = doc.ele('cac:LegalMonetaryTotal');
  totals.ele('cbc:LineExtensionAmount', amountAttrs(currency)).txt(invoice.lineExtensionAmount).up();
  totals.ele('cbc:TaxExclusiveAmount', amountAttrs(currency)).txt(invoice.taxExclusiveAmount).up();
  totals.ele('cbc:TaxInclusiveAmount', amountAttrs(currency)).txt(invoice.taxInclusiveAmount).up();
  totals.ele('cbc:PayableAmount', amountAttrs(currency)).txt(invoice.payableAmount).up();
  totals.up();

  // --- Lines ---------------------------------------------------------------
  for (const line of invoice.lines) {
    const category = line.vatCategory as VatCategoryCode;
    const categorySpec = VAT_CATEGORIES[category];

    const node = doc.ele('cac:InvoiceLine');
    node.ele('cbc:ID').txt(line.lineNumber).up();
    node
      .ele('cbc:InvoicedQuantity', { unitCode: line.uom || 'PCE' })
      .txt(line.quantity)
      .up();
    node.ele('cbc:LineExtensionAmount', amountAttrs(currency)).txt(line.netAmount).up();

    // Line-level discounts ride as an AllowanceCharge with ChargeIndicator false.
    const discount = toDecimal(line.lineDiscount);
    if (discount !== null && discount.greaterThan(0)) {
      node
        .ele('cac:AllowanceCharge')
        .ele('cbc:ChargeIndicator')
        .txt('false')
        .up()
        .ele('cbc:AllowanceChargeReason')
        .txt('Discount')
        .up()
        .ele('cbc:Amount', amountAttrs(currency))
        .txt(money(line.lineDiscount))
        .up()
        .up();
    }

    const lineTax = node.ele('cac:TaxTotal');
    lineTax.ele('cbc:TaxAmount', amountAttrs(currency)).txt(line.vatAmount).up();
    lineTax.up();

    const item = node.ele('cac:Item');
    item.ele('cbc:Name').txt(line.description).up();
    if (line.hsCode?.trim()) {
      item
        .ele('cac:CommodityClassification')
        .ele('cbc:ItemClassificationCode', { listID: 'HS' })
        .txt(line.hsCode)
        .up()
        .up();
    }
    const classified = item.ele('cac:ClassifiedTaxCategory');
    classified.ele('cbc:ID').txt(category).up();
    classified.ele('cbc:Percent').txt(line.vatRate).up();
    if (categorySpec?.taxExemptionReason) {
      classified.ele('cbc:TaxExemptionReason').txt(categorySpec.taxExemptionReason).up();
    }
    classified.ele('cac:TaxScheme').ele('cbc:ID').txt('VAT').up().up();
    classified.up();
    item.up();

    node
      .ele('cac:Price')
      .ele('cbc:PriceAmount', amountAttrs(currency))
      .txt(round(line.unitPrice, UNIT_PRICE_DP))
      .up()
      .up();
    node.up();
  }

  return doc.end({ prettyPrint: true, indent: '  ' });
}
