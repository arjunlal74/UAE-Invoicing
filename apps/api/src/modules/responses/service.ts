import type {
  InvoiceStatus,
  RejectionReasonCode,
  ResponseStatusCode,
} from '@uae/contracts';
import { CLEARED_STATUSES, TECHNICAL_REASON_CODES } from '@uae/contracts';
import { SYSTEM_ACTOR, audit, type AuditActor } from '../../audit/audit.js';
import { withPlatformAccess, type Tx } from '../../db/client.js';
import { logger } from '../../logger.js';
import { queueDisputeAlert } from '../../mail/outbox.js';
import { buildKey, putObject } from '../../storage/objectStore.js';

/**
 * The Peppol Invoice Response (IMR) engine — SRS v2.7 §11.
 *
 * Once the FTA has cleared a sales invoice the tax authority is finished with
 * it, but the *buyer* is not. They send back an ApplicationResponse saying they
 * acknowledge it, are querying it, or are refusing to pay it, and that verdict
 * drives a completely separate lifecycle from clearance: a disputed invoice is
 * still perfectly cleared, it simply now needs a credit note.
 *
 * Keeping the two axes apart is the point of this module. `applyStatusUpdate`
 * owns the clearance axis and must never be given a buyer verdict to apply;
 * this owns the commercial one and must never overwrite a clearance status.
 */

/** How a buyer's verdict maps onto our own document lifecycle. */
const STATUS_FOR_RESPONSE: Record<ResponseStatusCode, InvoiceStatus> = {
  AB: 'ACKNOWLEDGED',
  IP: 'DELIVERED_TO_BUYER',
  UQ: 'UNDER_QUERY',
  // A conditional acceptance is an acceptance for ledger purposes; the
  // condition rides in the buyer's comment for a human to read.
  CA: 'ACCEPTED_BY_BUYER',
  AP: 'ACCEPTED_BY_BUYER',
  RE: 'REJECTED_COMMERCIAL',
};

/** The codes that mean the buyer is withholding payment (§11, §13.1). */
const DISPUTE_CODES: ResponseStatusCode[] = ['UQ', 'RE'];

export interface BuyerResponseInput {
  tenantId: string;
  /** Whichever identifier the sender used; the first match wins. */
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  peppolUuid?: string | null;
  responseCode: ResponseStatusCode;
  reasonCode?: RejectionReasonCode | null;
  comments?: string | null;
  /** The document as received, archived to WORM storage before anything else. */
  rawXml?: string | null;
  source: 'webhook' | 'poll' | 'manual';
}

export interface BuyerResponseResult {
  applied: boolean;
  invoiceId?: string;
  reason?: string;
  /** Set when this response opened a dispute, so the caller can alert. */
  disputeOpened?: boolean;
}

/**
 * Record a buyer's verdict on one of our sales invoices.
 *
 * Idempotent by consequence rather than by key: the response log is append-only
 * (a buyer may legitimately query, then reject, then accept a corrected
 * document), but re-delivering the same verdict simply rewrites the same
 * projection onto the invoice.
 */
export async function applyBuyerResponse(
  input: BuyerResponseInput,
): Promise<BuyerResponseResult> {
  const archived = input.rawXml
    ? await archiveResponse(input.tenantId, input.rawXml, input.invoiceNumber ?? 'response')
    : null;

  const outcome = await withPlatformAccess(async (tx) => {
    const rows = await tx<
      {
        id: string;
        invoice_number: string;
        status: InvoiceStatus;
        buyer_name: string;
        fta_irn: string | null;
        is_commercial_dispute: boolean;
        dispute_opened_at: Date | null;
        payable_amount: string;
        currency_code: string;
      }[]
    >`
      SELECT id, invoice_number, status, buyer_name, fta_irn, is_commercial_dispute,
             dispute_opened_at, payable_amount, currency_code
      FROM invoices
      WHERE tenant_id = ${input.tenantId}
        AND direction = 'OUTBOUND_SALES_AR'
        AND (
          (${input.invoiceId ?? null}::uuid IS NOT NULL AND id = ${input.invoiceId ?? null}::uuid)
          OR (${input.peppolUuid ?? null}::uuid IS NOT NULL AND peppol_uuid = ${input.peppolUuid ?? null}::uuid)
          OR (${input.invoiceNumber ?? null}::text IS NOT NULL AND invoice_number = ${input.invoiceNumber ?? null})
        )
      LIMIT 1
      FOR UPDATE
    `;

    const invoice = rows[0];
    if (!invoice) {
      logger.warn({ input }, 'buyer response did not match any outbound invoice');
      return { applied: false as const, reason: 'no matching invoice' };
    }

    // A buyer cannot pass judgement on a document that has not reached them.
    // Applying it anyway would show a merchant an invoice that was "rejected by
    // the buyer" while it was still sitting in the approval queue.
    if (!CLEARED_STATUSES.includes(invoice.status)) {
      logger.warn(
        { invoiceId: invoice.id, status: invoice.status },
        'buyer response for an invoice that has not been cleared',
      );
      return {
        applied: false as const,
        invoiceId: invoice.id,
        reason: `invoice is ${invoice.status}, not yet with the buyer`,
      };
    }

    const isTechnical =
      input.reasonCode !== null &&
      input.reasonCode !== undefined &&
      TECHNICAL_REASON_CODES.includes(input.reasonCode);

    const nextStatus: InvoiceStatus =
      input.responseCode === 'RE' && isTechnical
        ? 'REJECTED_TECHNICAL'
        : STATUS_FOR_RESPONSE[input.responseCode];

    const opensDispute = DISPUTE_CODES.includes(input.responseCode);
    const closesDispute = input.responseCode === 'AP' || input.responseCode === 'CA';

    await tx`
      INSERT INTO invoice_responses (
        tenant_id, invoice_id, response_direction, response_code, status_reason_code,
        is_technical, comments, raw_response_xml_s3_uri
      ) VALUES (
        ${input.tenantId}, ${invoice.id}, 'INBOUND_FROM_BUYER',
        ${input.responseCode}::response_status_code,
        ${input.reasonCode ?? null}::rejection_reason_code,
        ${isTechnical}, ${input.comments ?? null}, ${archived?.uri ?? null}
      )
    `;

    await tx`
      UPDATE invoices SET
        status = ${nextStatus}::invoice_status,
        latest_response_code = ${input.responseCode}::response_status_code,
        latest_response_reason_code = ${input.reasonCode ?? null}::rejection_reason_code,
        latest_response_comment = ${input.comments ?? null},
        is_commercial_dispute = ${opensDispute ? true : closesDispute ? false : invoice.is_commercial_dispute},
        -- The clock starts on the FIRST dispute, not the latest one. A buyer
        -- who queries, is answered, and then rejects has been holding payment
        -- the whole time, and §13.1 aging has to say so.
        dispute_opened_at = ${
          opensDispute
            ? (invoice.dispute_opened_at ?? new Date())
            : closesDispute
              ? null
              : invoice.dispute_opened_at
        },
        dispute_resolved = ${closesDispute},
        dispute_resolved_at = ${closesDispute ? new Date() : null}
      WHERE id = ${invoice.id}
    `;

    return {
      applied: true as const,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      buyerName: invoice.buyer_name,
      ftaIrn: invoice.fta_irn,
      from: invoice.status,
      to: nextStatus,
      disputeOpened: opensDispute && !invoice.is_commercial_dispute,
    };
  });

  if (!outcome.applied) return outcome;

  await audit(
    { ...SYSTEM_ACTOR, actorType: input.source === 'webhook' ? 'ASP_WEBHOOK' : 'SYSTEM' },
    {
      action: 'INVOICE_RESPONSE_RECEIVED',
      resourceType: 'INVOICE',
      resourceId: outcome.invoiceId,
      tenantId: input.tenantId,
      changes: {
        from: outcome.from,
        to: outcome.to,
        responseCode: input.responseCode,
        reasonCode: input.reasonCode ?? null,
        comments: input.comments ?? null,
        source: input.source,
      },
    },
  );

  // §5.5 Template E. Sent only when a dispute OPENS: a buyer who queries twice
  // about the same invoice should not generate two identical alerts, and an
  // acceptance needs no chasing.
  if (outcome.disputeOpened) {
    await notifyDispute(input.tenantId, {
      invoiceId: outcome.invoiceId,
      invoiceNumber: outcome.invoiceNumber,
      buyerName: outcome.buyerName,
      ftaIrn: outcome.ftaIrn,
      responseCode: input.responseCode,
      reasonCode: input.reasonCode ?? null,
      comments: input.comments ?? null,
    });
  }

  return {
    applied: true,
    invoiceId: outcome.invoiceId,
    disputeOpened: outcome.disputeOpened,
  };
}

/**
 * Record our AP desk's verdict on a supplier's invoice (§12.3).
 *
 * The mirror image of the above: same table, opposite direction, and the
 * transmission of the resulting ApplicationResponse is a separate queued job so
 * that a supplier's unreachable endpoint does not block the clerk's screen.
 */
export async function recordApDecision(
  tx: Tx,
  params: {
    tenantId: string;
    invoiceId: string;
    responseCode: ResponseStatusCode;
    reasonCode: RejectionReasonCode | null;
    isTechnical: boolean;
    comments: string | null;
    userId: string;
  },
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO invoice_responses (
      tenant_id, invoice_id, response_direction, response_code, status_reason_code,
      is_technical, comments, created_by_user_id
    ) VALUES (
      ${params.tenantId}, ${params.invoiceId}, 'OUTBOUND_TO_SUPPLIER',
      ${params.responseCode}::response_status_code,
      ${params.reasonCode ?? null}::rejection_reason_code,
      ${params.isTechnical}, ${params.comments}, ${params.userId}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Load the full IMR log for one document, newest first. */
export async function loadResponses(tx: Tx, invoiceId: string) {
  return tx<
    {
      id: string;
      response_direction: 'INBOUND_FROM_BUYER' | 'OUTBOUND_TO_SUPPLIER';
      response_code: ResponseStatusCode;
      status_reason_code: RejectionReasonCode | null;
      is_technical: boolean;
      comments: string | null;
      created_by_name: string | null;
      transmitted_at: Date | null;
      transmission_error: string | null;
      received_at: Date;
    }[]
  >`
    SELECT r.id, r.response_direction, r.response_code, r.status_reason_code,
           r.is_technical, r.comments, r.transmitted_at, r.transmission_error, r.received_at,
           (SELECT full_name FROM users u WHERE u.id = r.created_by_user_id) AS created_by_name
    FROM invoice_responses r
    WHERE r.invoice_id = ${invoiceId}
    ORDER BY r.received_at DESC
  `;
}

/**
 * §8.2 feature 7 — automated dispute closure.
 *
 * Called once a corrective credit note clears. Ties the two documents together
 * in both directions and closes the dispute, which is what stops the invoice
 * appearing on the §13.2 non-compliance report.
 */
export async function resolveDisputeWithCreditNote(
  tx: Tx,
  params: { invoiceId: string; creditNoteId: string },
): Promise<void> {
  await tx`
    UPDATE invoices SET
      dispute_resolved = TRUE,
      dispute_resolved_at = CURRENT_TIMESTAMP,
      corrective_credit_note_id = ${params.creditNoteId}
    WHERE id = ${params.invoiceId}
  `;
}

async function archiveResponse(tenantId: string, xml: string, identifier: string) {
  try {
    return await putObject(
      buildKey(tenantId, 'response', identifier, 'xml'),
      Buffer.from(xml, 'utf8'),
      'application/xml',
      { tenantId, kind: 'application-response' },
    );
  } catch (err) {
    // §19 puts these documents under a WORM retention lock, but losing the
    // archive must not lose the verdict itself — the buyer is still refusing to
    // pay whether or not we managed to file their letter.
    logger.error({ err, tenantId }, 'failed to archive inbound application response');
    return null;
  }
}

async function notifyDispute(
  tenantId: string,
  dispute: {
    invoiceId: string;
    invoiceNumber: string;
    buyerName: string;
    ftaIrn: string | null;
    responseCode: ResponseStatusCode;
    reasonCode: RejectionReasonCode | null;
    comments: string | null;
  },
): Promise<void> {
  const recipients = await withPlatformAccess(
    (tx) => tx<{ email: string; full_name: string }[]>`
      SELECT email, full_name FROM users
      WHERE tenant_id = ${tenantId}
        AND is_active
        AND role IN ('COMPANY_ADMIN', 'TAX_APPROVER_CFO', 'ACCOUNTANT')
    `,
  );

  for (const recipient of recipients) {
    await queueDisputeAlert({
      to: recipient.email,
      contactName: recipient.full_name,
      invoiceId: dispute.invoiceId,
      invoiceNumber: dispute.invoiceNumber,
      buyerName: dispute.buyerName,
      ftaIrn: dispute.ftaIrn,
      responseCode: dispute.responseCode,
      reasonCode: dispute.reasonCode,
      comments: dispute.comments,
      tenantId,
    });
  }
}

export type { AuditActor };
