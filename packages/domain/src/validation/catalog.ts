import type { ValidationSeverity } from '../types.js';

/**
 * The UAE business-rule catalogue.
 *
 * The FTA publishes its rules as Schematron. Until those files are in hand
 * (and running through a compiled XSLT stage), these are hand-implemented in
 * `rules.ts` against the same rule-code vocabulary, so that:
 *
 *   - error messages the user sees now match the codes an ASP will return later
 *   - swapping in real Schematron changes where findings come from, not how
 *     they are stored, displayed, or mapped back to spreadsheet cells
 *
 * Anything sourced from official Schematron will keep its published code; the
 * WRN-* codes are ours and are advisory only.
 */

export interface RuleDefinition {
  code: string;
  severity: ValidationSeverity;
  /** Short label for the admin rule catalogue screen. */
  title: string;
  /** UBL location the rule concerns, quoted back in ASP-style error reports. */
  xpath?: string;
}

export const RULES = {
  // --- Document identity ---------------------------------------------------
  INVOICE_NUMBER_REQUIRED: { code: 'BR-UAE-01', severity: 'ERROR', title: 'Invoice number is required', xpath: '/Invoice/cbc:ID' },
  INVOICE_NUMBER_FORMAT: { code: 'BR-UAE-02', severity: 'ERROR', title: 'Invoice number contains illegal characters', xpath: '/Invoice/cbc:ID' },
  INVOICE_NUMBER_DUPLICATE: { code: 'BR-UAE-03', severity: 'ERROR', title: 'Invoice number already used', xpath: '/Invoice/cbc:ID' },
  INVOICE_TYPE_INVALID: { code: 'BR-UAE-04', severity: 'ERROR', title: 'Invoice type code is not recognised', xpath: '/Invoice/cbc:InvoiceTypeCode' },

  // --- Arithmetic ----------------------------------------------------------
  TOTALS_MISMATCH: { code: 'BR-UAE-05', severity: 'ERROR', title: 'Line totals do not sum to the invoice total', xpath: '/Invoice/cac:LegalMonetaryTotal/cbc:PayableAmount' },
  LINE_ARITHMETIC: { code: 'BR-UAE-06', severity: 'ERROR', title: 'Line amount does not match quantity x price', xpath: '/Invoice/cac:InvoiceLine/cbc:LineExtensionAmount' },

  // --- Parties -------------------------------------------------------------
  SUPPLIER_TRN_INVALID: { code: 'BR-UAE-07', severity: 'ERROR', title: 'Supplier TRN is not a valid 15-digit TRN', xpath: '/Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID' },
  BUYER_TRN_INVALID: { code: 'BR-UAE-08', severity: 'ERROR', title: 'Buyer TRN is not a valid 15-digit TRN', xpath: '/Invoice/cac:AccountingCustomerParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID' },
  BUYER_TRN_REQUIRED: { code: 'BR-UAE-09', severity: 'ERROR', title: 'Buyer TRN is mandatory for this invoice type', xpath: '/Invoice/cac:AccountingCustomerParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID' },
  SUPPLIER_TRN_MISMATCH: { code: 'BR-UAE-10', severity: 'ERROR', title: 'Supplier TRN does not match the registered tenant TRN', xpath: '/Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID' },
  SUPPLIER_NAME_REQUIRED: { code: 'BR-UAE-11', severity: 'ERROR', title: 'Supplier name is required', xpath: '/Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName' },
  BUYER_NAME_REQUIRED: { code: 'BR-UAE-12', severity: 'ERROR', title: 'Buyer name is required', xpath: '/Invoice/cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName' },
  BUYER_EMIRATE_INVALID: { code: 'BR-UAE-13', severity: 'ERROR', title: 'Buyer emirate is not one of the seven emirates', xpath: '/Invoice/cac:AccountingCustomerParty/cac:Party/cac:PostalAddress/cbc:CityName' },

  // --- VAT -----------------------------------------------------------------
  VAT_RATE_MISMATCH: { code: 'BR-UAE-14', severity: 'ERROR', title: 'VAT rate does not match the VAT category', xpath: '/Invoice/cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory/cbc:Percent' },
  VAT_CATEGORY_INVALID: { code: 'BR-UAE-15', severity: 'ERROR', title: 'VAT category is not recognised', xpath: '/Invoice/cac:InvoiceLine/cac:Item/cac:ClassifiedTaxCategory/cbc:ID' },

  // --- Dates & currency ----------------------------------------------------
  ISSUE_DATE_INVALID: { code: 'BR-UAE-16', severity: 'ERROR', title: 'Issue date is missing or not YYYY-MM-DD', xpath: '/Invoice/cbc:IssueDate' },
  ISSUE_DATE_FUTURE: { code: 'BR-UAE-17', severity: 'ERROR', title: 'Issue date is in the future', xpath: '/Invoice/cbc:IssueDate' },
  ISSUE_TIME_INVALID: { code: 'BR-UAE-18', severity: 'ERROR', title: 'Issue time is missing or not HH:MM:SS', xpath: '/Invoice/cbc:IssueTime' },
  CURRENCY_INVALID: { code: 'BR-UAE-19', severity: 'ERROR', title: 'Currency code is not supported', xpath: '/Invoice/cbc:DocumentCurrencyCode' },
  FX_RATE_REQUIRED: { code: 'BR-UAE-20', severity: 'ERROR', title: 'FX rate to AED is required for non-AED invoices', xpath: '/Invoice/cac:TaxExchangeRate/cbc:CalculationRate' },

  // --- Lines ---------------------------------------------------------------
  NO_LINES: { code: 'BR-UAE-21', severity: 'ERROR', title: 'Invoice has no line items', xpath: '/Invoice/cac:InvoiceLine' },
  LINE_DESCRIPTION_REQUIRED: { code: 'BR-UAE-22', severity: 'ERROR', title: 'Line description is required', xpath: '/Invoice/cac:InvoiceLine/cac:Item/cbc:Name' },
  LINE_QUANTITY_INVALID: { code: 'BR-UAE-23', severity: 'ERROR', title: 'Quantity must be greater than zero', xpath: '/Invoice/cac:InvoiceLine/cbc:InvoicedQuantity' },
  LINE_UNIT_PRICE_INVALID: { code: 'BR-UAE-24', severity: 'ERROR', title: 'Unit price is missing or negative', xpath: '/Invoice/cac:InvoiceLine/cac:Price/cbc:PriceAmount' },
  LINE_UOM_INVALID: { code: 'BR-UAE-25', severity: 'ERROR', title: 'Unit of measure is not recognised', xpath: '/Invoice/cac:InvoiceLine/cbc:InvoicedQuantity/@unitCode' },
  LINE_NUMBER_DUPLICATE: { code: 'BR-UAE-26', severity: 'ERROR', title: 'Duplicate line number within an invoice', xpath: '/Invoice/cac:InvoiceLine/cbc:ID' },
  LINE_DISCOUNT_EXCEEDS: { code: 'BR-UAE-27', severity: 'ERROR', title: 'Discount exceeds the line value', xpath: '/Invoice/cac:InvoiceLine/cac:AllowanceCharge/cbc:Amount' },
  ORPHAN_LINE: { code: 'BR-UAE-28', severity: 'ERROR', title: 'Line references an invoice number that is not in the header sheet', xpath: '/Invoice/cac:InvoiceLine' },

  // --- References ----------------------------------------------------------
  PRECEDING_INVOICE_REQUIRED: { code: 'BR-UAE-29', severity: 'ERROR', title: 'Credit and debit notes must reference the original invoice', xpath: '/Invoice/cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID' },
  PAYMENT_MEANS_INVALID: { code: 'BR-UAE-30', severity: 'ERROR', title: 'Payment means code is not recognised', xpath: '/Invoice/cac:PaymentMeans/cbc:PaymentMeansCode' },

  // --- Advisory (ours, non-blocking) ---------------------------------------
  B2C_NO_BUYER_TRN: { code: 'WRN-UAE-02', severity: 'WARNING', title: 'No buyer TRN — will be filed as a simplified B2C invoice' },
  LARGE_B2C_AMOUNT: { code: 'WRN-UAE-03', severity: 'WARNING', title: 'High-value simplified invoice — confirm a full tax invoice is not required' },
  ZERO_VALUE_INVOICE: { code: 'WRN-UAE-04', severity: 'WARNING', title: 'Invoice total is zero' },
  BACKDATED_INVOICE: { code: 'WRN-UAE-05', severity: 'WARNING', title: 'Invoice is backdated by more than 14 days' },
} as const satisfies Record<string, RuleDefinition>;

export type RuleKey = keyof typeof RULES;

export const ALL_RULES: RuleDefinition[] = Object.values(RULES);

export const RULES_BY_CODE = new Map<string, RuleDefinition>(
  ALL_RULES.map((r) => [r.code, r]),
);
