import type { PrintableDocument, PrintableParty } from '../../pdf/invoice.js';
import { config } from '../../config.js';
import { withTenant } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
import { DOCUMENT_SELECT, type DocumentRow } from '../documents/mapper.js';

/**
 * Assemble everything the printed document needs, in one round trip.
 *
 * The renderer in `pdf/invoice.ts` takes data and knows nothing about the
 * database; this is the join between them. Its one real job is deciding which
 * party is which — on an outbound sales invoice the supplier is the tenant and
 * the customer is the counterparty, and on an inbound purchase invoice it is
 * exactly the other way round. Printing a received supplier bill with our own
 * letterhead on it would be a forgery, not a formatting bug.
 *
 * Only the `_en` name columns are read. The printed document is set in the
 * standard PDF fonts, which are Latin-only; the Arabic legal name travels in
 * the UBL XML, which is the artefact the tax authority parses.
 */

interface PartyRow {
  name: string | null;
  trn: string | null;
  street_address: string | null;
  building?: string | null;
  emirate: string | null;
  postal_code: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

export async function loadPrintableDocument(
  tenantId: string,
  invoiceId: string,
): Promise<PrintableDocument> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const rows = await tx.unsafe<DocumentRow[]>(
      `SELECT ${DOCUMENT_SELECT} FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    const invoice = rows[0];
    if (!invoice) throw notFound('Invoice');

    const lines = await tx<
      {
        line_number: number;
        item_name: string;
        hs_code: string | null;
        quantity: string;
        unit_of_measure: string;
        unit_price: string;
        discount_amount: string;
        vat_category: string;
        vat_rate: string;
        vat_amount: string;
        net_amount: string;
        total_amount: string;
      }[]
    >`
      SELECT * FROM invoice_line_items WHERE invoice_id = ${invoiceId} ORDER BY line_number
    `;

    const tenants = await tx<
      { legal_name_en: string; trn: string; registered_address: unknown }[]
    >`
      SELECT legal_name_en, trn, registered_address FROM tenants WHERE id = ${tenantId}
    `;

    const customers = invoice.customer_id
      ? await tx<PartyRow[]>`
          SELECT customer_name_en AS name, trn, street_address, building, emirate,
                 postal_code, contact_email, contact_phone
          FROM customers WHERE id = ${invoice.customer_id}
        `
      : [];

    const suppliers = invoice.supplier_id
      ? await tx<PartyRow[]>`
          SELECT supplier_name_en AS name, trn, street_address, NULL AS building, emirate,
                 postal_code, contact_email, contact_phone
          FROM suppliers WHERE id = ${invoice.supplier_id}
        `
      : [];

    return { invoice, lines, tenant: tenants[0], customer: customers[0], supplier: suppliers[0] };
  });

  const { invoice, tenant } = loaded;
  const inbound = invoice.direction === 'INBOUND_PURCHASE_AP';

  const tenantParty: PrintableParty = {
    name: tenant?.legal_name_en ?? invoice.seller_name,
    trn: tenant?.trn ?? invoice.seller_trn,
    addressLines: addressLines(tenant?.registered_address),
  };

  // The invoice's own party columns are the fallback, not the directory record:
  // a document is a statement about the parties as they were when it was
  // issued, and a supplier who has since changed address does not retrospectively
  // change the bill they sent last year. The directory is consulted only for the
  // address, which the invoice table does not carry.
  const counterparty: PrintableParty = inbound
    ? {
        name: invoice.seller_name,
        trn: invoice.seller_trn || null,
        addressLines: partyAddress(loaded.supplier, invoice.buyer_emirate),
        contactEmail: loaded.supplier?.contact_email,
        contactPhone: loaded.supplier?.contact_phone,
      }
    : {
        name: invoice.buyer_name,
        trn: invoice.buyer_trn,
        addressLines: partyAddress(loaded.customer, invoice.buyer_emirate),
        contactEmail: loaded.customer?.contact_email,
        contactPhone: loaded.customer?.contact_phone,
      };

  return {
    invoiceNumber: invoice.invoice_number,
    invoiceType: invoice.invoice_type,
    direction: invoice.direction,
    status: invoice.status,
    issueDate: invoice.issue_date.toISOString().slice(0, 10),
    issueTime: invoice.issue_time,
    currencyCode: invoice.currency_code,
    exchangeRate: invoice.exchange_rate,
    seller: inbound ? counterparty : tenantParty,
    buyer: inbound ? tenantParty : counterparty,
    ftaIrn: invoice.fta_irn,
    peppolUuid: invoice.peppol_uuid,
    poReference: invoice.po_reference,
    grnReference: invoice.grn_reference,
    qrCodeData: invoice.qr_code_data,
    ublXmlSha256: invoice.ubl_xml_sha256,
    clearedAt: invoice.cleared_at?.toISOString() ?? null,

    reference: invoice.referenced_invoice_number
      ? {
          invoiceNumber: invoice.referenced_invoice_number,
          ftaIrn: invoice.referenced_fta_irn,
          reversalMode: invoice.credit_note_reversal_mode,
          reasonCode: invoice.credit_note_reason_code,
          notes: invoice.credit_note_notes,
        }
      : null,

    // A resolved dispute is history — the credit note that settled it is its own
    // document — so only a live one is printed on the face of the invoice.
    dispute:
      invoice.is_commercial_dispute && !invoice.dispute_resolved
        ? {
            responseCode: invoice.latest_response_code,
            reasonCode: invoice.latest_response_reason_code,
            comment: invoice.latest_response_comment,
            openedAt: invoice.dispute_opened_at?.toISOString() ?? null,
          }
        : null,

    lines: loaded.lines.map((line) => ({
      lineNumber: line.line_number,
      description: line.item_name,
      hsCode: line.hs_code,
      quantity: line.quantity,
      uom: line.unit_of_measure,
      unitPrice: line.unit_price,
      discount: line.discount_amount,
      vatCategory: line.vat_category,
      vatRate: line.vat_rate,
      net: line.net_amount,
      vat: line.vat_amount,
      total: line.total_amount,
    })),

    totals: {
      lineExtension: invoice.line_extension_amount,
      taxExclusive: invoice.tax_exclusive_amount,
      vatTotal: invoice.vat_total_amount,
      taxInclusive: invoice.tax_inclusive_amount,
      payable: invoice.payable_amount,
      payableAed: invoice.payable_amount_aed,
    },

    platformName: config().PLATFORM_NAME,
  };
}

function partyAddress(party: PartyRow | undefined, fallbackEmirate: string | null): string[] {
  if (!party) return fallbackEmirate ? [fallbackEmirate, 'United Arab Emirates'] : [];
  return compact([
    party.building,
    party.street_address,
    [party.emirate, party.postal_code].filter(Boolean).join(' '),
    'United Arab Emirates',
  ]);
}

/** The tenant's `registered_address` JSONB, whose keys are set in §6 onboarding. */
function addressLines(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const address = value as Record<string, unknown>;
  const text = (key: string) => (typeof address[key] === 'string' ? (address[key] as string) : '');

  return compact([
    text('building'),
    text('street'),
    [text('city') || text('emirate'), text('postalCode')].filter(Boolean).join(' '),
    text('countryCode') === 'AE' ? 'United Arab Emirates' : text('countryCode'),
  ]);
}

function compact(lines: (string | null | undefined)[]): string[] {
  return lines.map((line) => (line ?? '').trim()).filter((line) => line.length > 0);
}
