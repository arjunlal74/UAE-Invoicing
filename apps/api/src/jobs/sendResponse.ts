import type { RejectionReasonCode, ResponseStatusCode } from '@uae/contracts';
import { buildApplicationResponseXml } from '@uae/ubl';
import { randomUUID } from 'node:crypto';
import { SYSTEM_ACTOR, audit } from '../audit/audit.js';
import { withPlatformAccess } from '../db/client.js';
import { logger } from '../logger.js';
import { getDriver } from '../modules/asp/driver.js';
import { loadTenantAspConfig } from '../modules/asp/service.js';
import { buildKey, putObject } from '../storage/objectStore.js';
import type { SendResponseJob } from '../queue/queues.js';

/**
 * Transmit one AP verdict back to the supplier (SRS v2.7 §12.3).
 *
 * The verdict itself was recorded and became binding the moment the clerk
 * pressed the button; this job is only about delivery. That separation is why a
 * failure here is retried rather than rolled back — the supplier being
 * temporarily unreachable does not make their invoice acceptable.
 */
export class RetryableResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableResponseError';
  }
}

interface ResponseRow {
  id: string;
  invoice_id: string;
  tenant_id: string;
  peppol_response_uuid: string;
  response_code: ResponseStatusCode;
  status_reason_code: RejectionReasonCode | null;
  comments: string | null;
  transmitted_at: Date | null;
  raw_response_xml_s3_uri: string | null;
  invoice_number: string;
  invoice_issue_date: Date;
  invoice_peppol_uuid: string;
  seller_trn: string;
  seller_name: string;
  buyer_trn: string | null;
  buyer_name: string;
}

export async function sendResponseJob(job: SendResponseJob): Promise<void> {
  const log = logger.child({ responseId: job.responseId, invoiceId: job.invoiceId });

  const rows = await withPlatformAccess(
    (tx) => tx<ResponseRow[]>`
      SELECT r.id, r.invoice_id, r.tenant_id, r.peppol_response_uuid, r.response_code,
             r.status_reason_code, r.comments, r.transmitted_at, r.raw_response_xml_s3_uri,
             i.invoice_number, i.issue_date AS invoice_issue_date, i.peppol_uuid AS invoice_peppol_uuid,
             i.seller_trn, i.seller_name, i.buyer_trn, i.buyer_name
      FROM invoice_responses r
      JOIN invoices i ON i.id = r.invoice_id
      WHERE r.id = ${job.responseId}
    `,
  );

  const response = rows[0];
  if (!response) {
    log.warn('response row no longer exists; nothing to transmit');
    return;
  }
  if (response.transmitted_at) {
    log.info('response already transmitted; skipping');
    return;
  }

  const now = new Date();
  const xml = buildApplicationResponseXml({
    responseUuid: response.peppol_response_uuid,
    // The response carries its own identifier in the supplier's inbox, so it is
    // derived from the invoice it answers rather than being an opaque UUID a
    // human would have to cross-reference.
    responseId: `RSP-${response.invoice_number}-${response.peppol_response_uuid.slice(0, 8)}`,
    issueDate: now.toISOString().slice(0, 10),
    issueTime: now.toISOString().slice(11, 19),
    // We are the buyer here: the sender of the verdict, the recipient of the
    // invoice. Getting these the wrong way round routes the response back to
    // ourselves.
    sender: { trn: response.buyer_trn, name: response.buyer_name },
    recipient: { trn: response.seller_trn || null, name: response.seller_name },
    document: {
      invoiceNumber: response.invoice_number,
      issueDate: response.invoice_issue_date.toISOString().slice(0, 10),
      peppolUuid: response.invoice_peppol_uuid,
    },
    responseCode: response.response_code,
    reasonCode: response.status_reason_code,
    description: response.comments,
  });

  // Archived before transmission, for the same reason an outbound invoice is:
  // a document the supplier has acted on must be one we can still produce.
  let archivedUri = response.raw_response_xml_s3_uri;
  if (!archivedUri) {
    try {
      const stored = await putObject(
        buildKey(response.tenant_id, 'response', `${response.invoice_number}-out`, 'xml'),
        Buffer.from(xml, 'utf8'),
        'application/xml',
        { tenantId: response.tenant_id, kind: 'outbound-application-response' },
      );
      archivedUri = stored.uri;
      await withPlatformAccess(
        (tx) => tx`
          UPDATE invoice_responses SET raw_response_xml_s3_uri = ${archivedUri}
          WHERE id = ${response.id}
        `,
      );
    } catch (err) {
      log.error({ err }, 'failed to archive outbound application response');
    }
  }

  const aspConfig = await loadTenantAspConfig(response.tenant_id);
  const driver = getDriver(aspConfig.providerType);

  if (!driver.sendResponse) {
    // §18 Phase 1 reality: not every third-party ASP carries responses. The
    // verdict stands locally and the desk is told the supplier was not reached,
    // rather than the failure being hidden behind an endless retry.
    const message = `The configured provider (${aspConfig.displayName}) does not carry Peppol invoice responses. The verdict has been recorded but the supplier was not notified over the network.`;
    await withPlatformAccess(
      (tx) => tx`
        UPDATE invoice_responses SET transmission_error = ${message} WHERE id = ${response.id}
      `,
    );
    log.warn('ASP driver does not support application responses');
    return;
  }

  const outcome = await driver.sendResponse(
    {
      idempotencyKey: `${response.tenant_id}:response:${response.id}`,
      responseUuid: response.peppol_response_uuid,
      invoiceNumber: response.invoice_number,
      recipientTrn: response.seller_trn || null,
      responseCode: response.response_code,
      reasonCode: response.status_reason_code,
      responseXml: xml,
    },
    aspConfig,
  );

  await withPlatformAccess(
    (tx) => tx`
      UPDATE invoice_responses SET
        transmitted_at = ${outcome.kind === 'sent' ? new Date() : null},
        transmission_error = ${outcome.kind === 'sent' ? null : outcome.reason}
      WHERE id = ${response.id}
    `,
  );

  await audit(SYSTEM_ACTOR, {
    action: 'AP_RESPONSE_TRANSMITTED',
    resourceType: 'INVOICE',
    resourceId: response.invoice_id,
    tenantId: response.tenant_id,
    changes: {
      responseCode: response.response_code,
      reasonCode: response.status_reason_code,
      outcome: outcome.kind,
      provider: aspConfig.providerType,
      reference: outcome.kind === 'sent' ? outcome.transmissionReference : null,
    },
  });

  if (outcome.kind === 'retryable') {
    throw new RetryableResponseError(outcome.reason);
  }

  log.info({ outcome: outcome.kind }, 'application response transmission complete');
}

/** Deterministic id for a response that has not been persisted yet. */
export function newResponseUuid(): string {
  return randomUUID();
}
