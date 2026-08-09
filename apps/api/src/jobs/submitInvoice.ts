import { VAT_CATEGORIES, type StagedInvoice, type VatCategoryCode } from '@uae/domain';
import { buildInvoiceXml, buildQrPayload } from '@uae/ubl';
import { SYSTEM_ACTOR, audit } from '../audit/audit.js';
import { jsonb, withPlatformAccess } from '../db/client.js';
import { logger } from '../logger.js';
import { getDriver } from '../modules/asp/driver.js';
import { loadTenantAspConfig } from '../modules/asp/service.js';
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
  invoice_number: string;
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
    }[]>`
      SELECT legal_name_en, legal_name_ar, registered_address, trn
      FROM tenants WHERE id = ${tenantId}
    `;

    return { invoice, tenant: tenants[0]! };
  });

  const { invoice, tenant } = context;

  // Guard against a duplicate job or a retry that raced the real thing. Filing
  // twice is a penalty for the merchant, so this check is worth its cost.
  if (invoice.status === 'ACCEPTED_BY_FTA' || invoice.status === 'SUBMITTED_TO_ASP') {
    log.info({ status: invoice.status }, 'skipping submission; invoice already in flight or cleared');
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

  log.info({ outcome: outcome.kind, attempt }, 'invoice transmission complete');
}

/** Map a VAT category code to its database enum. Kept here for the seed too. */
export function vatCategoryToDb(code: string) {
  return VAT_CATEGORIES[code as VatCategoryCode]?.dbValue ?? 'STANDARD';
}
