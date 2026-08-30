import { USAGE_REASONS } from '@uae/contracts';
import {
  VAT_CATEGORIES,
  participantIdFromTrn,
  type StagedInvoice,
  type VatCategoryCode,
} from '@uae/domain';
import { buildInvoiceXml, buildQrPayload } from '@uae/ubl';
import { SYSTEM_ACTOR, audit } from '../audit/audit.js';
import { jsonb, withPlatformAccess } from '../db/client.js';
import { logger } from '../logger.js';
import { queueQuotaThreshold } from '../mail/outbox.js';
import { getDriver } from '../modules/asp/driver.js';
import { loadTenantAspConfig } from '../modules/asp/service.js';
import { consumeUnits, unitsFor } from '../modules/metering/service.js';
import { buildKey, putObject } from '../storage/objectStore.js';
import type { SubmitInvoiceJob } from '../queue/queues.js';

/**
 * Generate, archive, and transmit one invoice.
 *
 * One job per invoice, never per batch: each document routes to a different
 * buyer, gets its own verdict, and must retry on its own schedule. A batch-level
 * job would let one bad invoice block 141 good ones.
 */
export class RetryableSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableSubmissionError';
  }
}

interface InvoiceRow {
  id: string;
  tenant_id: string;
  direction: 'OUTBOUND_SALES_AR' | 'INBOUND_PURCHASE_AP';
  invoice_number: string;
  invoice_type: string;
  peppol_uuid: string;
  status: string;
  raw_payload_json: StagedInvoice | null;
  seller_trn: string;
  seller_name: string;
  buyer_trn: string | null;
  currency_code: string;
  payable_amount: string;
  ubl_xml_s3_uri: string | null;
  ubl_xml_sha256: string | null;
  customer_id: string | null;
  referenced_invoice_id: string | null;
  referenced_invoice_number: string | null;
  referenced_fta_irn: string | null;
  credit_note_notes: string | null;
}

interface CustomerParty {
  street_address: string | null;
  building: string | null;
  postal_code: string | null;
  emirate: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

export async function submitInvoiceJob(job: SubmitInvoiceJob): Promise<void> {
  const { invoiceId, tenantId } = job;
  const log = logger.child({ invoiceId, tenantId });

  const context = await withPlatformAccess(async (tx) => {
    const rows = await tx<InvoiceRow[]>`SELECT * FROM invoices WHERE id = ${invoiceId}`;
    const invoice = rows[0];
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

    const tenants = await tx<{
      legal_name_en: string;
      legal_name_ar: string;
      registered_address: { street?: string; city?: string; emirate?: string; postalCode?: string };
      trn: string;
      peppol_participant_id: string | null;
    }[]>`
      SELECT legal_name_en, legal_name_ar, registered_address, trn, peppol_participant_id
      FROM tenants WHERE id = ${tenantId}
    `;

    // §6 maps the directory's address and contact fields into the buyer party
    // block. Only documents composed in the builder carry a customer link; an
    // Excel row knows the buyer by name and TRN alone.
    const customers = invoice.customer_id
      ? await tx<CustomerParty[]>`
          SELECT street_address, building, postal_code, emirate,
                 contact_name, contact_email, contact_phone
          FROM customers WHERE id = ${invoice.customer_id}
        `
      : [];

    // §8.2 feature 2: the preceding document's own issue date, which the credit
    // note has to carry alongside its number and IRN.
    const preceding = invoice.referenced_invoice_id
      ? await tx<{ issue_date: Date; fta_irn: string | null }[]>`
          SELECT issue_date, fta_irn FROM invoices WHERE id = ${invoice.referenced_invoice_id}
        `
      : [];

    return {
      invoice,
      tenant: tenants[0]!,
      customer: customers[0] ?? null,
      preceding: preceding[0] ?? null,
    };
  });

  const { invoice, tenant, customer, preceding } = context;

  // Guard against a duplicate job or a retry that raced the real thing. Filing
  // twice is a penalty for the merchant, so this check is worth its cost.
  if (invoice.status === 'ACCEPTED_BY_FTA' || invoice.status === 'SUBMITTED_TO_ASP') {
    log.info({ status: invoice.status }, 'skipping submission; invoice already in flight or cleared');
    return;
  }

  // Nothing should enqueue an unapproved invoice, but a stray job must not be
  // the thing that files one past the approver.
  if (invoice.status === 'PENDING_CFO_APPROVAL') {
    log.warn('skipping submission; invoice is still awaiting tax approver sign-off');
    return;
  }

  const staged = invoice.raw_payload_json;
  if (!staged) throw new Error(`Invoice ${invoiceId} has no staged payload to render`);

  // --- Generate and archive ------------------------------------------------
  // The XML is written to WORM storage BEFORE transmission. If the provider
  // accepts a document we failed to archive, we would have filed something we
  // cannot produce in an audit.
  let xmlUri = invoice.ubl_xml_s3_uri;
  let xmlSha = invoice.ubl_xml_sha256;
  let qrPayload: string | null = null;

  if (!xmlUri) {
    const xml = buildInvoiceXml({
      invoice: staged,
      peppolUuid: invoice.peppol_uuid,
      supplier: {
        trn: tenant.trn,
        legalNameEn: tenant.legal_name_en,
        legalNameAr: tenant.legal_name_ar,
        street: tenant.registered_address?.street ?? null,
        city: tenant.registered_address?.city ?? null,
        emirate: tenant.registered_address?.emirate ?? null,
        postalCode: tenant.registered_address?.postalCode ?? null,
        countryCode: 'AE',
      },
      buyer: customer
        ? {
            street: customer.street_address,
            building: customer.building,
            city: customer.emirate,
            postalCode: customer.postal_code,
            contactName: customer.contact_name,
            contactEmail: customer.contact_email,
            contactPhone: customer.contact_phone,
          }
        : null,
      preceding: invoice.referenced_invoice_number
        ? {
            invoiceNumber: invoice.referenced_invoice_number,
            issueDate: preceding?.issue_date.toISOString().slice(0, 10) ?? null,
            ftaIrn: invoice.referenced_fta_irn ?? preceding?.fta_irn ?? null,
          }
        : null,
      note: invoice.credit_note_notes,
    });

    qrPayload = buildQrPayload({
      invoice: staged,
      sellerName: tenant.legal_name_en,
      sellerTrn: tenant.trn,
    });

    const stored = await putObject(
      buildKey(tenantId, 'xml', `${invoice.invoice_number}-${invoice.peppol_uuid.slice(0, 8)}`, 'xml'),
      Buffer.from(xml, 'utf8'),
      'application/xml',
      { tenantId, invoiceNumber: invoice.invoice_number, peppolUuid: invoice.peppol_uuid },
    );

    xmlUri = stored.uri;
    xmlSha = stored.sha256;

    await withPlatformAccess(
      (tx) => tx`
        UPDATE invoices
        SET ubl_xml_s3_uri = ${xmlUri}, ubl_xml_sha256 = ${xmlSha}, qr_code_data = ${qrPayload}
        WHERE id = ${invoiceId}
      `,
    );
  }

  const { getObject, keyFromUri } = await import('../storage/objectStore.js');
  const xmlBuffer = await getObject(keyFromUri(xmlUri!));
  const xml = xmlBuffer.toString('utf8');

  // --- Transmit ------------------------------------------------------------
  const aspConfig = await loadTenantAspConfig(tenantId);
  const driver = getDriver(aspConfig.providerType);

  const attempt = await withPlatformAccess(async (tx) => {
    const rows = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM transmission_logs WHERE invoice_id = ${invoiceId}
    `;
    return Number(rows[0]!.count) + 1;
  });

  const started = Date.now();
  const outcome = await driver.submitInvoice(
    {
      // Stable across retries — this is what stops a timeout-then-retry from
      // filing the same invoice twice at the provider.
      idempotencyKey: `${tenantId}:${invoice.invoice_number}:${invoice.peppol_uuid}`,
      peppolUuid: invoice.peppol_uuid,
      invoiceNumber: invoice.invoice_number,
      sellerTrn: invoice.seller_trn,
      // The tenant's own address, not the one on the document: a filing goes
      // out under the account that filed it.
      sellerParticipantId:
        tenant.peppol_participant_id ?? participantIdFromTrn(invoice.seller_trn),
      buyerTrn: invoice.buyer_trn,
      payableAmount: invoice.payable_amount,
      currency: invoice.currency_code,
      ublXml: xml,
      ublSha256: xmlSha!,
    },
    aspConfig,
  );
  const latencyMs = Date.now() - started;

  await withPlatformAccess(async (tx) => {
    await tx`
      INSERT INTO transmission_logs (
        tenant_id, invoice_id, asp_provider, transmission_reference, attempt,
        http_status_code, response_payload, status, error_message, latency_ms
      ) VALUES (
        ${tenantId}, ${invoiceId}, ${aspConfig.providerType},
        ${outcome.kind === 'accepted' ? outcome.transmissionReference : null},
        ${attempt},
        ${'httpStatus' in outcome ? (outcome.httpStatus ?? null) : null},
        ${outcome.raw === undefined || outcome.raw === null ? null : jsonb(tx, outcome.raw)},
        ${
          outcome.kind === 'accepted'
            ? 'SENT'
            : outcome.kind === 'rejected'
              ? 'REJECTED'
              : 'FAILED'
        }::transmission_status,
        ${outcome.kind === 'accepted' ? null : outcome.reason},
        ${latencyMs}
      )
    `;

    if (outcome.kind === 'accepted') {
      await tx`
        UPDATE invoices
        SET status = 'SUBMITTED_TO_ASP', submitted_at = CURRENT_TIMESTAMP
        WHERE id = ${invoiceId}
      `;
    } else if (outcome.kind === 'rejected') {
      await tx`
        UPDATE invoices
        SET status = 'REJECTED_BY_FTA', fta_rejection_reason = ${outcome.reason}
        WHERE id = ${invoiceId}
      `;
      await tx`
        INSERT INTO validation_logs (tenant_id, invoice_id, rule_code, severity, error_message)
        VALUES (${tenantId}, ${invoiceId}, ${outcome.ruleCode ?? 'ASP-REJECTION'}, 'ERROR', ${outcome.reason})
      `;
    }
  });

  await audit(SYSTEM_ACTOR, {
    action: 'INVOICE_SUBMITTED',
    resourceType: 'INVOICE',
    resourceId: invoiceId,
    tenantId,
    changes: {
      outcome: outcome.kind,
      provider: aspConfig.providerType,
      attempt,
      latencyMs,
      reference: outcome.kind === 'accepted' ? outcome.transmissionReference : null,
      reason: outcome.kind === 'accepted' ? null : outcome.reason,
    },
  });

  if (outcome.kind === 'retryable') {
    // Thrown so BullMQ applies the backoff schedule. After the final attempt
    // the job lands in the failed set, which the admin transmission monitor
    // surfaces for manual retry.
    throw new RetryableSubmissionError(outcome.reason);
  }

  // §15: a unit is consumed on a successful clearance SUBMISSION, not on the
  // FTA's eventual verdict. That is the SRS's wording and it is also the honest
  // billing point — the document crossed the network and the provider charged
  // us for it whatever the tax authority goes on to say.
  if (outcome.kind === 'accepted') {
    const reason =
      invoice.invoice_type === 'CREDIT_NOTE' || invoice.invoice_type === 'DEBIT_NOTE'
        ? USAGE_REASONS.creditNoteClearance
        : USAGE_REASONS.outboundClearance;

    const usage = await consumeUnits({
      tenantId,
      invoiceId,
      direction: 'OUTBOUND_SALES_AR',
      reason,
      units: unitsFor(reason),
    });

    if (usage.thresholdCrossed) await notifyQuotaThreshold(tenantId, usage.thresholdCrossed);
  }

  log.info({ outcome: outcome.kind, attempt }, 'invoice transmission complete');
}

/** Map a VAT category code to its database enum. Kept here for the seed too. */
export function vatCategoryToDb(code: string) {
  return VAT_CATEGORIES[code as VatCategoryCode]?.dbValue ?? 'STANDARD';
}

/**
 * §15 threshold alert.
 *
 * Sent to the people who can do something about it — the company administrator
 * and the tax approver. An accountant cannot buy more capacity, so telling them
 * only adds noise to an inbox that already has a filing deadline in it.
 */
async function notifyQuotaThreshold(tenantId: string, threshold: number): Promise<void> {
  try {
    const context = await withPlatformAccess(async (tx) => {
      const tenants = await tx<{ legal_name_en: string }[]>`
        SELECT legal_name_en FROM tenants WHERE id = ${tenantId}
      `;
      const bundles = await tx<
        { purchased_units: number; consumed_units: number; allow_overage: boolean }[]
      >`
        SELECT purchased_units, consumed_units, allow_overage
        FROM data_bundles
        WHERE tenant_id = ${tenantId} AND status IN ('ACTIVE', 'EXHAUSTED')
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      const recipients = await tx<{ email: string; full_name: string }[]>`
        SELECT email, full_name FROM users
        WHERE tenant_id = ${tenantId} AND is_active
          AND role IN ('COMPANY_ADMIN', 'TAX_APPROVER_CFO')
      `;
      return { tenant: tenants[0], bundle: bundles[0], recipients };
    });

    if (!context.tenant || !context.bundle) return;

    for (const recipient of context.recipients) {
      await queueQuotaThreshold({
        to: recipient.email,
        contactName: recipient.full_name,
        companyName: context.tenant.legal_name_en,
        threshold,
        purchasedUnits: context.bundle.purchased_units,
        consumedUnits: context.bundle.consumed_units,
        remainingUnits: context.bundle.purchased_units - context.bundle.consumed_units,
        hardCap: !context.bundle.allow_overage,
        tenantId,
      });
    }
  } catch (err) {
    logger.error({ err, tenantId, threshold }, 'could not dispatch quota threshold alert');
  }
}
