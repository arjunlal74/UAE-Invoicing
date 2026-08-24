import { TERMINAL_STATUSES, type InvoiceStatus } from '@uae/contracts';
import { SYSTEM_ACTOR, audit } from '../../audit/audit.js';
import { withPlatformAccess } from '../../db/client.js';
import { logger } from '../../logger.js';
import { buildKey, putObject } from '../../storage/objectStore.js';

/**
 * Apply a clearance verdict to an invoice.
 *
 * Shared by the webhook receiver and the polling sweeper, because the same
 * verdict can legitimately arrive by both routes and must produce the same
 * result exactly once.
 */

export interface StatusUpdate {
  invoiceId?: string;
  transmissionReference?: string | null;
  peppolUuid?: string | null;
  invoiceNumber?: string | null;
  tenantId: string;
  verdict: 'ACCEPTED' | 'REJECTED' | 'PENDING';
  reason?: string;
  ruleCode?: string;
  receipt?: string;
  /** SRS v2.7 §10.6 — the clearance identifiers, captured onto the invoice. */
  irn?: string;
  cryptographicStamp?: string;
  mlsStatus?: string;
  source: 'webhook' | 'poll';
}

export interface StatusApplyResult {
  applied: boolean;
  invoiceId?: string;
  reason?: string;
}

export async function applyStatusUpdate(update: StatusUpdate): Promise<StatusApplyResult> {
  if (update.verdict === 'PENDING') return { applied: false, reason: 'still pending' };

  const archived = update.receipt
    ? await archiveReceipt(update)
    : null;

  return withPlatformAccess(async (tx) => {
    // Locate the invoice by whichever identifier the provider supplied. A
    // provider may echo back its own reference, our UUID, or the invoice
    // number, and we should not depend on which.
    const rows = await tx<
      {
        id: string;
        tenant_id: string;
        status: InvoiceStatus;
        invoice_number: string;
        invoice_type: string;
        referenced_invoice_id: string | null;
      }[]
    >`
      SELECT i.id, i.tenant_id, i.status, i.invoice_number, i.invoice_type::text AS invoice_type,
             i.referenced_invoice_id
      FROM invoices i
      WHERE i.tenant_id = ${update.tenantId}
        -- Clearance verdicts only ever concern documents we filed. A purchase
        -- invoice arrived already cleared; a provider callback that matched one
        -- would be re-opening someone else's settled document.
        AND i.direction = 'OUTBOUND_SALES_AR'
        AND (
          (${update.invoiceId ?? null}::uuid IS NOT NULL AND i.id = ${update.invoiceId ?? null}::uuid)
          OR (${update.peppolUuid ?? null}::uuid IS NOT NULL AND i.peppol_uuid = ${update.peppolUuid ?? null}::uuid)
          OR (${update.invoiceNumber ?? null}::text IS NOT NULL AND i.invoice_number = ${update.invoiceNumber ?? null})
          OR (${update.transmissionReference ?? null}::text IS NOT NULL AND EXISTS (
                SELECT 1 FROM transmission_logs l
                WHERE l.invoice_id = i.id
                  AND l.transmission_reference = ${update.transmissionReference ?? null}
             ))
        )
      LIMIT 1
      FOR UPDATE
    `;

    const invoice = rows[0];
    if (!invoice) {
      logger.warn({ update }, 'status update did not match any invoice');
      return { applied: false, reason: 'no matching invoice' };
    }

    // A late "rejected" must never overwrite an "accepted". Providers do
    // re-deliver out of order, and a wrongly-reverted acceptance would send a
    // merchant chasing an invoice that was already filed.
    if (TERMINAL_STATUSES.includes(invoice.status)) {
      return { applied: false, invoiceId: invoice.id, reason: `already ${invoice.status}` };
    }

    const nextStatus: InvoiceStatus =
      update.verdict === 'ACCEPTED' ? 'ACCEPTED_BY_FTA' : 'REJECTED_BY_FTA';

    if (invoice.status === nextStatus) {
      return { applied: false, invoiceId: invoice.id, reason: 'already applied' };
    }

    const accepted = update.verdict === 'ACCEPTED';

    await tx`
      UPDATE invoices SET
        status               = ${nextStatus}::invoice_status,
        fta_rejection_reason = ${accepted ? null : (update.reason ?? 'Rejected')},
        cleared_at           = ${accepted ? new Date() : null},
        -- §10.6. coalesce rather than overwrite: a later status poll that has
        -- no IRN in it must not erase the one the webhook already delivered.
        fta_irn              = coalesce(${update.irn ?? null}, fta_irn),
        fta_cryptographic_stamp = coalesce(${update.cryptographicStamp ?? null}, fta_cryptographic_stamp),
        mls_status           = coalesce(${update.mlsStatus ?? null}, mls_status),
        -- §10.6 reverse push: a cleared document owes its IRN back to whichever
        -- system produced it.
        erp_reverse_sync_status = CASE
          WHEN ${accepted} AND source_channel <> 'MANUAL_IN_APP_ENTRY'
            THEN 'PENDING'::erp_sync_status
          ELSE erp_reverse_sync_status
        END
      WHERE id = ${invoice.id}
    `;

    // §8.2 feature 7 — automated dispute closure. A credit note that clears
    // settles the invoice it references: the output tax is reversed, so the
    // document stops appearing on the §13.2 non-compliance report.
    if (accepted && invoice.referenced_invoice_id) {
      await tx`
        UPDATE invoices SET
          dispute_resolved          = TRUE,
          dispute_resolved_at       = CURRENT_TIMESTAMP,
          corrective_credit_note_id = ${invoice.id}
        WHERE id = ${invoice.referenced_invoice_id}
          AND is_commercial_dispute
          AND NOT dispute_resolved
      `;
    }

    await tx`
      UPDATE transmission_logs SET
        status = ${update.verdict === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED'}::transmission_status,
        error_message = ${update.reason ?? null}
      WHERE invoice_id = ${invoice.id}
        AND (${update.transmissionReference ?? null}::text IS NULL
             OR transmission_reference = ${update.transmissionReference ?? null})
        AND status IN ('SENT', 'ACKNOWLEDGED', 'PENDING')
    `;

    if (update.verdict === 'REJECTED') {
      await tx`
        INSERT INTO validation_logs (
          tenant_id, invoice_id, rule_code, severity, error_message
        ) VALUES (
          ${update.tenantId}, ${invoice.id},
          ${update.ruleCode ?? 'ASP-REJECTION'}, 'ERROR',
          ${update.reason ?? 'Rejected by the tax authority.'}
        )
      `;
    }

    if (archived) {
      logger.info({ invoiceId: invoice.id, uri: archived.uri }, 'clearance receipt archived');
    }

    await audit(
      { ...SYSTEM_ACTOR, actorType: update.source === 'webhook' ? 'ASP_WEBHOOK' : 'SYSTEM' },
      {
        action: 'INVOICE_STATUS_CHANGED',
        resourceType: 'INVOICE',
        resourceId: invoice.id,
        tenantId: update.tenantId,
        changes: {
          from: invoice.status,
          to: nextStatus,
          reason: update.reason ?? null,
          ruleCode: update.ruleCode ?? null,
          ftaIrn: update.irn ?? null,
          source: update.source,
        },
      },
    );

    return { applied: true, invoiceId: invoice.id };
  });
}

/**
 * The signed receipt is the non-repudiation evidence — legal proof the document
 * was delivered and acknowledged. It goes to WORM storage before the invoice
 * status is touched, so an archive failure does not leave us claiming an
 * acceptance we cannot prove.
 */
async function archiveReceipt(update: StatusUpdate) {
  try {
    const identifier =
      update.transmissionReference ?? update.peppolUuid ?? update.invoiceNumber ?? 'receipt';
    return await putObject(
      buildKey(update.tenantId, 'receipt', identifier, 'json'),
      Buffer.from(update.receipt!, 'utf8'),
      'application/json',
      { tenantId: update.tenantId, kind: 'clearance-receipt' },
    );
  } catch (err) {
    logger.error({ err, update }, 'failed to archive clearance receipt');
    return null;
  }
}
