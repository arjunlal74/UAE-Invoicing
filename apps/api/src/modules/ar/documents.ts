import type { InvoiceStatus, RejectionReasonCode, ReversalMode } from '@uae/contracts';
import {
  VAT_CATEGORIES,
  recalcInvoice,
  type StagedInvoice,
  type StagedLine,
  type VatCategoryCode,
} from '@uae/domain';
import { jsonb, type Tx } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { SUBMIT_JOB_OPTIONS, invoiceSubmitQueue } from '../../queue/queues.js';
import { checkFilingAllowance } from '../metering/service.js';
import { buildValidationContext, validateStagedRow } from '../staging/service.js';

/**
 * Creating and filing an outbound document, once.
 *
 * Three channels produce sales invoices — an Excel upload, the in-app builder
 * (§7) and an ERP posting over the API (§1.2 channel 1) — and the rules about
 * what a legal invoice is, who is allowed to file one and what happens to the
 * seller block do not vary between them. This module is that shared middle, so
 * that adding a channel is a new front door onto the same pipeline rather than
 * a third opinion about UAE tax law.
 *
 * The guiding rule throughout: the caller's payload is trusted for *content*
 * and never for *identity or arithmetic*. The seller block is re-read from the
 * tenant, the buyer block is re-read from the directory when a customer is
 * named, and every amount is recalculated. A client that posts a payable amount
 * of one dirham on a ten-thousand dirham invoice gets the ten thousand.
 */

/**
 * The next number in the tenant's own series (§7: "Invoice Number (Auto)").
 *
 * Derived from what has actually been issued this year rather than from a
 * counter, so a document deleted while still a draft returns its number to the
 * pool instead of leaving a permanent gap in a series a tax auditor will read.
 * The number is only a suggestion — the unique constraint is what actually
 * prevents a collision if two people compose at the same moment.
 */
export async function nextNumber(tx: Tx, tenantId: string, typeCode: string): Promise<string> {
  const prefix = typeCode === '381' ? 'CN' : typeCode === '383' ? 'DN' : 'INV';
  const year = new Date().getUTCFullYear();
  const pattern = `${prefix}-${year}-%`;

  const rows = await tx<{ highest: string | null }[]>`
    SELECT max(substring(invoice_number from '[0-9]+$')) AS highest
    FROM invoices
    WHERE tenant_id = ${tenantId}
      AND direction = 'OUTBOUND_SALES_AR'
      AND invoice_number LIKE ${pattern}
  `;

  const next = Number(rows[0]?.highest ?? 0) + 1;
  return `${prefix}-${year}-${String(next).padStart(5, '0')}`;
}

/** Copy the buyer block onto the staged document from a directory record. */
export async function applyCustomer(
  tx: Tx,
  tenantId: string,
  customerId: string,
  invoice: StagedInvoice,
): Promise<StagedInvoice> {
  const rows = await tx<
    {
      customer_name_en: string;
      customer_type: 'B2B' | 'B2C';
      trn: string | null;
      emirate: string;
      default_payment_means: string | null;
      is_active: boolean;
    }[]
  >`
    SELECT customer_name_en, customer_type, trn, emirate, default_payment_means, is_active
    FROM customers WHERE id = ${customerId} AND tenant_id = ${tenantId}
  `;

  const customer = rows[0];
  if (!customer) throw notFound('Customer');
  if (!customer.is_active) {
    throw badRequest('That customer has been deactivated. Reactivate it before invoicing them.');
  }

  return {
    ...invoice,
    buyerName: customer.customer_name_en,
    buyerTrn: customer.trn ?? '',
    buyerEmirate: customer.emirate,
    paymentMeans: invoice.paymentMeans || customer.default_payment_means || '30',
  };
}

/** Seller identity always comes from the tenant record, never from the client. */
export async function applySeller(
  tx: Tx,
  tenantId: string,
  invoice: StagedInvoice,
): Promise<StagedInvoice> {
  const rows = await tx<{ trn: string | null; legal_name_en: string }[]>`
    SELECT trn, legal_name_en FROM tenants WHERE id = ${tenantId}
  `;
  const tenant = rows[0];
  if (!tenant?.trn) {
    throw badRequest('Your company profile has no TRN, so invoices cannot be composed yet.');
  }
  return { ...invoice, supplierTrn: tenant.trn, supplierName: tenant.legal_name_en };
}

/** Replace a document's line items so the detail view matches the payload. */
export async function writeLines(
  tx: Tx,
  tenantId: string,
  invoiceId: string,
  invoice: StagedInvoice,
): Promise<void> {
  await tx`DELETE FROM invoice_line_items WHERE invoice_id = ${invoiceId}`;
  if (invoice.lines.length === 0) return;

  await tx`
    INSERT INTO invoice_line_items ${tx(
      invoice.lines.map((line: StagedLine, index: number) => ({
        tenant_id: tenantId,
        invoice_id: invoiceId,
        line_number: Number(line.lineNumber) || index + 1,
        item_name: line.description,
        hs_code: line.hsCode || null,
        quantity: line.quantity || '0',
        unit_of_measure: line.uom,
        unit_price: line.unitPrice || '0',
        discount_amount: line.lineDiscount || '0',
        vat_category: VAT_CATEGORIES[line.vatCategory as VatCategoryCode]?.dbValue ?? 'STANDARD',
        vat_rate: line.vatRate || '0',
        vat_amount: line.vatAmount || '0',
        net_amount: line.netAmount || '0',
        total_amount: line.lineTotal || '0',
      })),
    )}
  `;
}

export interface DocumentFinding {
  ruleCode: string;
  severity: string;
  message: string;
  field: string;
  lineId?: string;
}

export interface DocumentValidation {
  findings: DocumentFinding[];
  submittable: boolean;
}

export async function validateDocument(
  tx: Tx,
  tenantId: string,
  invoice: StagedInvoice,
  excludeInvoiceId: string | null,
): Promise<DocumentValidation> {
  const recalculated = recalcInvoice(invoice);
  const context = await buildValidationContext(tx, tenantId, [recalculated.invoiceNumber], {
    excludeInvoiceId: excludeInvoiceId ?? undefined,
  });
  const result = validateStagedRow(recalculated, context);

  return {
    findings: result.findings.map((finding) => ({
      ruleCode: finding.ruleCode,
      severity: finding.severity as string,
      message: finding.message,
      field: finding.field,
      lineId: finding.lineId,
    })),
    submittable: result.submittable,
  };
}

/**
 * The gate every filing passes, whichever door it arrived at.
 *
 * Three separate conditions, kept apart because each one sends the caller
 * somewhere different: an inactive tenant is waiting on onboarding, an inactive
 * provider connection is waiting on the platform, and an exhausted allowance is
 * waiting on the merchant buying more units (§15).
 */
export async function assertCanFile(tx: Tx, tenantId: string, units = 1): Promise<void> {
  const tenants = await tx<{ status: string }[]>`
    SELECT status FROM tenants WHERE id = ${tenantId}
  `;
  if (tenants[0]?.status !== 'ACTIVE') {
    throw badRequest(
      'Your account is not yet active with our network provider, so documents cannot be filed.',
    );
  }

  const configs = await tx<{ status: string }[]>`
    SELECT status FROM tenant_asp_configs WHERE tenant_id = ${tenantId} AND is_active
  `;
  if (configs[0]?.status !== 'ACTIVE') {
    throw badRequest('Your provider connection is not active. Documents cannot be filed yet.');
  }

  const allowance = await checkFilingAllowance(tenantId, units, tx);
  if (!allowance.allowed) throw badRequest(allowance.reason!);
}

export async function queueSubmission(
  invoiceId: string,
  tenantId: string,
  actorUserId: string,
  jobSuffix?: string,
): Promise<void> {
  await invoiceSubmitQueue().add(
    'submit',
    { invoiceId, tenantId, actorUserId },
    { ...SUBMIT_JOB_OPTIONS, jobId: `submit-${invoiceId}${jobSuffix ? `-${jobSuffix}` : ''}` },
  );
}

export interface InsertDocumentOptions {
  tenantId: string;
  /**
   * Exactly one of these is set. A machine is not a user, and
   * `created_by_user_id` references `users` — see migration 0007.
   */
  createdByUserId: string | null;
  createdByApiKeyId?: string | null;
  invoice: StagedInvoice;
  customerId: string | null;
  invoiceTypeDbValue: string;
  status: InvoiceStatus;
  sourceChannel: string;
  approvedByUserId?: string | null;
  referenced?: { id: string; invoice_number: string; fta_irn: string | null } | null;
  creditNote?: {
    reasonCode?: RejectionReasonCode | null;
    reversalMode?: ReversalMode | null;
    notes?: string | null;
  } | null;
  /**
   * §10.6: a document this platform composed has no ERP row to push a clearance
   * result back to, so it starts as not-applicable rather than sitting PENDING
   * forever. One that *arrived* from an ERP does have one, and starts PENDING.
   */
  erpReverseSyncStatus: 'PENDING' | 'NOT_APPLICABLE';
}

export async function insertDocument(tx: Tx, options: InsertDocumentOptions): Promise<string> {
  const { invoice, referenced, creditNote } = options;

  const rows = await tx<{ id: string }[]>`
    INSERT INTO invoices (
      tenant_id, direction, source_channel, customer_id,
      invoice_number, invoice_type, issue_date, issue_time, currency_code, exchange_rate,
      seller_trn, seller_name, buyer_trn, buyer_name, buyer_emirate,
      po_reference, preceding_invoice_id, payment_means,
      line_extension_amount, tax_exclusive_amount, tax_inclusive_amount,
      vat_total_amount, payable_amount, payable_amount_aed,
      status, created_by_user_id, approved_by_user_id, approved_at, raw_payload_json,
      referenced_invoice_id, referenced_invoice_number, referenced_fta_irn,
      credit_note_reason_code, credit_note_reversal_mode, credit_note_notes,
      erp_reverse_sync_status, created_by_api_key_id
    ) VALUES (
      ${options.tenantId}, 'OUTBOUND_SALES_AR', ${options.sourceChannel}::ingestion_source,
      ${options.customerId},
      ${invoice.invoiceNumber}, ${options.invoiceTypeDbValue}::invoice_type,
      ${invoice.issueDate || new Date().toISOString().slice(0, 10)}::date,
      ${invoice.issueTime || '00:00:00'}::time,
      ${invoice.currency || 'AED'}, ${invoice.fxRate || '1.000000'},
      ${invoice.supplierTrn}, ${invoice.supplierName},
      ${invoice.buyerTrn || null}, ${invoice.buyerName}, ${invoice.buyerEmirate},
      ${invoice.poReference || null}, ${invoice.precedingInvoiceId || null},
      ${invoice.paymentMeans || null},
      ${invoice.lineExtensionAmount}, ${invoice.taxExclusiveAmount},
      ${invoice.taxInclusiveAmount}, ${invoice.vatTotalAmount},
      ${invoice.payableAmount}, ${invoice.payableAmountAed},
      ${options.status}::invoice_status,
      ${options.createdByUserId}, ${options.approvedByUserId ?? null},
      ${options.approvedByUserId ? new Date() : null},
      ${jsonb(tx, invoice)},
      ${referenced?.id ?? null}, ${referenced?.invoice_number ?? null},
      ${referenced?.fta_irn ?? null},
      ${creditNote?.reasonCode ?? null}::rejection_reason_code,
      ${creditNote?.reversalMode ?? null}::reversal_mode,
      ${creditNote?.notes ?? null},
      ${options.erpReverseSyncStatus}::erp_sync_status,
      ${options.createdByApiKeyId ?? null}
    )
    RETURNING id
  `;

  return rows[0]!.id;
}
