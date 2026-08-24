import type { StagedInvoice } from '@uae/domain';
import { VAT_CATEGORIES, type VatCategoryCode } from '@uae/domain';
import { InboundParseError, parseInboundInvoiceXml } from '@uae/ubl';
import { randomUUID } from 'node:crypto';
import { SYSTEM_ACTOR, audit, type AuditActor } from '../../audit/audit.js';
import { jsonb, withPlatformAccess, type Tx } from '../../db/client.js';
import { badRequest } from '../../lib/errors.js';
import { logger } from '../../logger.js';
import { queueInboundPurchaseInvoice } from '../../mail/outbox.js';
import { buildKey, putObject } from '../../storage/objectStore.js';
import { resolveOrCreateSupplier } from '../directories/routes.js';

/**
 * Inbound reception for Module 2 (SRS v2.7 §12.1).
 *
 * A supplier's ASP pushes us a cleared UBL 2.1 invoice. By the time it arrives
 * the FTA has already accepted it — the clearance question is settled and the
 * only open question is commercial, which is why the document lands at
 * ACCEPTED_BY_FTA with `ap_posting_status = NOT_POSTED` rather than at the
 * start of the outbound lifecycle.
 *
 * The one rule this path never breaks: a bill that reaches us is received. A
 * supplier we have never heard of, an unmatched purchase order, arithmetic that
 * does not add up — all of those are things for the verification desk to
 * decide, not reasons to drop a document the supplier has already filed with
 * the tax authority and will expect to be paid for.
 */

export interface ReceiveResult {
  invoiceId: string;
  invoiceNumber: string;
  duplicate: boolean;
  supplierCreated: boolean;
  warnings: string[];
}

export interface ReceiveParams {
  tenantId: string;
  ublXml: string;
  ftaIrn?: string | null;
  source: 'webhook' | 'manual';
  actor?: AuditActor;
  actorUserId?: string | null;
}

export async function receivePurchaseInvoice(params: ReceiveParams): Promise<ReceiveResult> {
  let parsed;
  try {
    parsed = parseInboundInvoiceXml(params.ublXml, {
      id: randomUUID(),
      lineId: () => randomUUID(),
    });
  } catch (err) {
    if (err instanceof InboundParseError) throw badRequest(err.message);
    throw err;
  }

  const warnings = [...parsed.arithmeticWarnings];

  // The original document goes to WORM storage before any of it is believed.
  // §19 requires the received XML to be retained for 5–15 years, and it is the
  // evidence for an input-tax claim the buyer will make on the strength of it.
  const archived = await archive(params.tenantId, params.ublXml, parsed.invoice.invoiceNumber);

  const outcome = await withPlatformAccess(async (tx) => {
    const tenants = await tx<{ trn: string | null; legal_name_en: string }[]>`
      SELECT trn, legal_name_en FROM tenants WHERE id = ${params.tenantId}
    `;
    const tenant = tenants[0];

    // A document addressed to somebody else's TRN is still stored — it is
    // evidence of a routing fault at the ASP — but the desk is told, because
    // claiming input tax on it would be a false return.
    if (tenant?.trn && parsed.invoice.buyerTrn && parsed.invoice.buyerTrn !== tenant.trn) {
      warnings.push(
        `This invoice is addressed to TRN ${parsed.invoice.buyerTrn}, which is not your registered TRN ${tenant.trn}.`,
      );
    }

    // §10.5 idempotency. A provider that retries a delivery must not create a
    // second copy of a bill the AP clerk would then pay twice.
    const existing = await tx<{ id: string; invoice_number: string }[]>`
      SELECT id, invoice_number FROM invoices
      WHERE tenant_id = ${params.tenantId}
        AND direction = 'INBOUND_PURCHASE_AP'
        AND invoice_number = ${parsed.invoice.invoiceNumber}
        AND seller_trn = ${parsed.invoice.supplierTrn}
    `;
    if (existing[0]) {
      return {
        invoiceId: existing[0].id,
        invoiceNumber: existing[0].invoice_number,
        duplicate: true,
        supplierCreated: false,
        supplierName: parsed.invoice.supplierName,
        supplierTrn: parsed.invoice.supplierTrn || null,
      };
    }

    const supplier = await resolveOrCreateSupplier(tx, params.tenantId, {
      trn: parsed.invoice.supplierTrn || null,
      nameEn: parsed.invoice.supplierName,
      emirate: parsed.supplierEmirate,
      street: parsed.supplierStreet,
      postalCode: parsed.supplierPostalCode,
      contactEmail: parsed.supplierContactEmail,
    });

    const invoice = parsed.invoice;
    const typeDbValue =
      invoice.invoiceType === '381'
        ? 'CREDIT_NOTE'
        : invoice.invoiceType === '383'
          ? 'DEBIT_NOTE'
          : invoice.invoiceType === '388'
            ? 'SIMPLIFIED_TAX_INVOICE'
            : 'TAX_INVOICE';

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO invoices (
        tenant_id, direction, source_channel, supplier_id,
        peppol_uuid,
        invoice_number, invoice_type, issue_date, issue_time, currency_code, exchange_rate,
        seller_trn, seller_name, buyer_trn, buyer_name, buyer_emirate,
        po_reference, preceding_invoice_id, payment_means,
        line_extension_amount, tax_exclusive_amount, tax_inclusive_amount,
        vat_total_amount, payable_amount, payable_amount_aed,
        -- Cleared before it reached us: the FTA verdict is not ours to make.
        status, ap_posting_status,
        fta_irn, ubl_xml_s3_uri, ubl_xml_sha256, raw_payload_json,
        erp_reverse_sync_status
      ) VALUES (
        ${params.tenantId}, 'INBOUND_PURCHASE_AP', 'INBOUND_PEPPOL_AS4', ${supplier.id},
        ${parsed.peppolUuid ?? randomUUID()}::uuid,
        ${invoice.invoiceNumber}, ${typeDbValue}::invoice_type,
        ${invoice.issueDate || new Date().toISOString().slice(0, 10)}::date,
        ${invoice.issueTime || '00:00:00'}::time,
        ${invoice.currency || 'AED'}, ${invoice.fxRate || '1.000000'},
        ${invoice.supplierTrn || ''}, ${invoice.supplierName},
        ${invoice.buyerTrn || null}, ${invoice.buyerName || (tenant?.legal_name_en ?? '')},
        ${invoice.buyerEmirate || null},
        ${invoice.poReference || null}, ${invoice.precedingInvoiceId || null},
        ${invoice.paymentMeans || null},
        ${orZero(invoice.lineExtensionAmount)}, ${orZero(invoice.taxExclusiveAmount)},
        ${orZero(invoice.taxInclusiveAmount)}, ${orZero(invoice.vatTotalAmount)},
        ${orZero(invoice.payableAmount)}, ${orZero(invoice.payableAmountAed)},
        'ACCEPTED_BY_FTA', 'NOT_POSTED',
        ${params.ftaIrn ?? parsed.ftaIrn ?? null},
        ${archived?.uri ?? null}, ${archived?.sha256 ?? null},
        ${jsonb(tx, invoice)},
        'NOT_APPLICABLE'
      )
      RETURNING id
    `;

    const invoiceId = inserted[0]!.id;
    await writeLines(tx, params.tenantId, invoiceId, invoice);

    // The desk needs to see what we could not reconcile, and it needs to see it
    // next to the document rather than in a log file.
    for (const warning of warnings) {
      await tx`
        INSERT INTO validation_logs (tenant_id, invoice_id, rule_code, severity, error_message)
        VALUES (${params.tenantId}, ${invoiceId}, 'AP-RECEPTION', 'WARNING', ${warning})
      `;
    }

    return {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      duplicate: false,
      supplierCreated: supplier.created,
      supplierName: invoice.supplierName,
      supplierTrn: invoice.supplierTrn || null,
    };
  });

  if (outcome.duplicate) {
    logger.info(
      { tenantId: params.tenantId, invoiceNumber: outcome.invoiceNumber },
      'inbound purchase invoice already received; ignoring duplicate delivery',
    );
    return { ...outcome, warnings };
  }

  await audit(params.actor ?? SYSTEM_ACTOR, {
    action: 'PURCHASE_INVOICE_RECEIVED',
    resourceType: 'INVOICE',
    resourceId: outcome.invoiceId,
    tenantId: params.tenantId,
    changes: {
      invoiceNumber: outcome.invoiceNumber,
      supplier: outcome.supplierName,
      supplierTrn: outcome.supplierTrn,
      source: params.source,
      newSupplier: outcome.supplierCreated,
      warnings,
    },
  });

  await notifyApTeam(params.tenantId, {
    invoiceId: outcome.invoiceId,
    invoiceNumber: outcome.invoiceNumber,
    supplierName: outcome.supplierName,
    supplierTrn: outcome.supplierTrn,
    ftaIrn: params.ftaIrn ?? parsed.ftaIrn ?? null,
    totalAmount: orZero(parsed.invoice.payableAmount),
    vatAmount: orZero(parsed.invoice.vatTotalAmount),
    currency: parsed.invoice.currency || 'AED',
    isNewSupplier: outcome.supplierCreated,
  });

  return { ...outcome, warnings };
}

/**
 * §12.2 "Auto-Match with POs".
 *
 * The match is by purchase-order reference, which is the only key both sides
 * genuinely share — the supplier put it on their invoice because we put it on
 * our order. Amount- or date-based matching would guess, and a guessed match on
 * a payable is worse than no match at all.
 */
export async function autoMatchPurchaseOrders(
  tx: Tx,
  tenantId: string,
): Promise<{ matched: number }> {
  // Where a PO reference is present the bill is treated as matched; where it is
  // absent the desk sees the warning triangle from §12.2's grid. There is no
  // purchase-order table in the platform (orders live in the tenant's ERP), so
  // this records the presence of the linkage rather than verifying it against
  // an order we do not hold.
  const rows = await tx<{ id: string }[]>`
    UPDATE invoices SET ap_posting_status = 'ON_HOLD'
    WHERE tenant_id = ${tenantId}
      AND direction = 'INBOUND_PURCHASE_AP'
      AND ap_posting_status = 'NOT_POSTED'
      AND (po_reference IS NULL OR po_reference = '')
      AND latest_response_code IS NULL
    RETURNING id
  `;
  return { matched: rows.length };
}

async function writeLines(
  tx: Tx,
  tenantId: string,
  invoiceId: string,
  invoice: StagedInvoice,
): Promise<void> {
  if (invoice.lines.length === 0) return;

  await tx`
    INSERT INTO invoice_line_items ${tx(
      invoice.lines.map((line, index) => ({
        tenant_id: tenantId,
        invoice_id: invoiceId,
        line_number: Number(line.lineNumber) || index + 1,
        item_name: line.description || `Line ${index + 1}`,
        hs_code: line.hsCode || null,
        quantity: orZero(line.quantity),
        unit_of_measure: line.uom || 'PCE',
        unit_price: orZero(line.unitPrice),
        discount_amount: orZero(line.lineDiscount),
        vat_category: VAT_CATEGORIES[line.vatCategory as VatCategoryCode]?.dbValue ?? 'STANDARD',
        vat_rate: orZero(line.vatRate),
        vat_amount: orZero(line.vatAmount),
        net_amount: orZero(line.netAmount),
        // The supplier's own line total, recomputed only when they omitted it.
        total_amount: line.lineTotal
          ? line.lineTotal
          : String(Number(orZero(line.netAmount)) + Number(orZero(line.vatAmount))),
      })),
    )}
  `;
}

/** A missing numeric from a supplier's XML is zero, not a failed INSERT. */
function orZero(value: string | null | undefined): string {
  return value && value.trim() !== '' ? value : '0';
}

async function archive(tenantId: string, xml: string, invoiceNumber: string) {
  try {
    return await putObject(
      buildKey(tenantId, 'inbound', invoiceNumber, 'xml'),
      Buffer.from(xml, 'utf8'),
      'application/xml',
      { tenantId, kind: 'inbound-purchase-invoice', invoiceNumber },
    );
  } catch (err) {
    logger.error({ err, tenantId, invoiceNumber }, 'failed to archive inbound purchase invoice');
    return null;
  }
}

async function notifyApTeam(
  tenantId: string,
  invoice: {
    invoiceId: string;
    invoiceNumber: string;
    supplierName: string;
    supplierTrn: string | null;
    ftaIrn: string | null;
    totalAmount: string;
    vatAmount: string;
    currency: string;
    isNewSupplier: boolean;
  },
): Promise<void> {
  const recipients = await withPlatformAccess(
    (tx) => tx<{ email: string }[]>`
      SELECT email FROM users
      WHERE tenant_id = ${tenantId}
        AND is_active
        AND role IN ('COMPANY_ADMIN', 'ACCOUNTANT', 'TAX_APPROVER_CFO')
    `,
  );

  for (const recipient of recipients) {
    await queueInboundPurchaseInvoice({ to: recipient.email, tenantId, ...invoice });
  }
}
