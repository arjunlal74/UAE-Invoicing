import {
  ApDecisionRequest,
  DocumentSearchQuery,
  MatchPurchaseRequest,
  ReceivePurchaseInvoiceRequest,
  USAGE_REASONS,
  can,
  type ApDecisionResponse,
  type ApPostingStatus,
  type InvoiceStatus,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withTenant } from '../../db/client.js';
import { ctxCan, requireContext, requirePermission } from '../../http/context.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { RESPONSE_JOB_OPTIONS, responseSendQueue } from '../../queue/queues.js';
import { toDocumentListItem, type DocumentRow, DOCUMENT_SELECT } from '../documents/mapper.js';
import { consumeUnits, unitsFor } from '../metering/service.js';
import { recordApDecision } from '../responses/service.js';
import { autoMatchPurchaseOrders, receivePurchaseInvoice } from './service.js';

/**
 * The Inbound Purchase Verification Desk — SRS v2.7 §12.
 *
 * Module 2's entire user-facing surface: the inbox, the document under review,
 * and the three verdicts a clerk can reach for. The shape of the screen comes
 * straight from the §12.2 wireframe, and so does the ordering of the actions —
 * accept, query, reject — because that is the order of decreasing likelihood
 * and the accept path is the one used a hundred times a day.
 */

/** The status a purchase invoice lands in once the desk has ruled on it. */
const STATUS_FOR_DECISION: Record<'AP' | 'UQ' | 'RE', InvoiceStatus> = {
  AP: 'ACCEPTED_BY_BUYER',
  UQ: 'UNDER_QUERY',
  RE: 'REJECTED_COMMERCIAL',
};

/**
 * §12.3: accepting posts the bill; querying holds payment; rejecting blocks it.
 * The posting status is the field the tenant's own ledger integration reads, so
 * it has to be set by the same transaction that records the verdict.
 */
const POSTING_FOR_DECISION: Record<'AP' | 'UQ' | 'RE', ApPostingStatus> = {
  AP: 'POSTED',
  UQ: 'ON_HOLD',
  RE: 'BLOCKED',
};

export function registerApRoutes(app: FastifyInstance) {
  // --- §12.2 the inbox -----------------------------------------------------
  app.get(
    '/api/v1/ap/invoices',
    { preHandler: requirePermission('ap.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const query = DocumentSearchQuery.parse(request.query);
      const offset = (query.page - 1) * query.pageSize;

      // Written once and used by both the page query and its count, so a
      // filtered list cannot paginate against an unfiltered total.
      const filters = `
        tenant_id = $1
        AND direction = 'INBOUND_PURCHASE_AP'
        AND ($2::text IS NULL OR status::text = $2)
        AND ($3::uuid IS NULL OR supplier_id = $3::uuid)
        AND ($4::text IS NULL OR (
              $4 = 'matched' AND po_reference IS NOT NULL AND po_reference <> ''
            ) OR (
              $4 = 'unmatched' AND (po_reference IS NULL OR po_reference = '')
            ))
        AND ($5::text IS NULL OR latest_response_reason_code::text = $5)
        AND ($6::date IS NULL OR issue_date >= $6::date)
        AND ($7::date IS NULL OR issue_date <= $7::date)
        AND ($8::text IS NULL OR
              invoice_number ILIKE '%' || $8 || '%' OR
              seller_name ILIKE '%' || $8 || '%' OR
              seller_trn LIKE $8 || '%' OR
              coalesce(po_reference, '') ILIKE '%' || $8 || '%')
        AND ($9::text IS NULL OR latest_response_code::text = $9)
        -- §12.3 disputes, the inbound mirror of the AR dispute desk: bills this
        -- tenant has queried or rejected and sent back to the supplier.
        --
        -- Resolved is read from the response log rather than from the invoice,
        -- because accepting a bill clears is_commercial_dispute and nulls
        -- dispute_opened_at — and sets dispute_resolved on every acceptance,
        -- including bills nobody ever disputed. The row alone therefore cannot
        -- tell a settled argument from an uneventful approval. A verdict of
        -- UQ or RE in the log can.
        AND ($10::text IS NULL
             OR ($10 = 'open' AND is_commercial_dispute AND NOT dispute_resolved)
             OR ($10 = 'resolved' AND dispute_resolved AND EXISTS (
                   SELECT 1 FROM invoice_responses r
                   WHERE r.invoice_id = invoices.id
                     AND r.response_direction = 'OUTBOUND_TO_SUPPLIER'
                     AND r.response_code IN ('RE', 'UQ'))))

        -- The three verdicts, asked one at a time: the authority's, this
        -- desk's, and our ledger's.
        AND ($11::text IS NULL OR ap_posting_status::text = $11)
        AND ($12::text IS NULL OR
             ($12 = 'cleared' AND fta_irn IS NOT NULL) OR
             ($12 = 'uncleared' AND fta_irn IS NULL))
        AND ($13::text IS NULL OR
             ($13 = 'none' AND latest_response_code IS NULL) OR
             ($13 <> 'none' AND latest_response_code::text = $13))
      `;

      const filterValues = [
        ctx.tenantId,
        query.status ?? null,
        query.supplierId ?? null,
        query.match ?? null,
        query.reasonCode ?? null,
        query.dateFrom ?? null,
        query.dateTo ?? null,
        query.q ?? null,
        query.responseCode ?? null,
        query.disputes ?? null,
        query.postingState ?? null,
        query.ftaState ?? null,
        query.verdict ?? null,
      ];

      const result = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx.unsafe<DocumentRow[]>(
          `SELECT ${DOCUMENT_SELECT}
           FROM invoices
           WHERE ${filters}
           -- Unreviewed first: the desk exists to clear a queue, and a bill
           -- someone has already ruled on is reference material.
           ORDER BY (latest_response_code IS NULL) DESC, issue_date DESC, created_at DESC
           LIMIT $14 OFFSET $15`,
          [...filterValues, query.pageSize, offset],
        );

        const matching = await tx.unsafe<{ count: string }[]>(
          `SELECT count(*)::text AS count FROM invoices WHERE ${filters}`,
          filterValues,
        );

        const summary = await tx<
          {
            total: string;
            needs_review: string;
            accepted: string;
            disputed: string;
            unmatched: string;
          }[]
        >`
          SELECT
            count(*)::text AS total,
            count(*) FILTER (WHERE latest_response_code IS NULL)::text AS needs_review,
            count(*) FILTER (WHERE latest_response_code = 'AP')::text AS accepted,
            count(*) FILTER (WHERE latest_response_code IN ('RE', 'UQ'))::text AS disputed,
            count(*) FILTER (WHERE po_reference IS NULL OR po_reference = '')::text AS unmatched
          FROM invoices
          WHERE tenant_id = ${ctx.tenantId} AND direction = 'INBOUND_PURCHASE_AP'
        `;

        return { rows, summary: summary[0]!, matching: Number(matching[0]!.count) };
      });

      return reply.send({
        items: result.rows.map(toDocumentListItem),
        // The counters across the top of the §12.2 wireframe. They describe the
        // whole inbox, not the filtered page, which is what makes them useful
        // while a filter is applied.
        summary: {
          total: Number(result.summary.total),
          needsReview: Number(result.summary.needs_review),
          accepted: Number(result.summary.accepted),
          disputed: Number(result.summary.disputed),
          unmatched: Number(result.summary.unmatched),
        },
        // What the current filter matches, which is what the pager needs. The
        // inbox-wide figure is `summary.total` above.
        total: result.matching,
        page: query.page,
        pageSize: query.pageSize,
      });
    },
  );

  // --- §12.2 the verification pane's PO / GRN linkage ----------------------
  app.patch(
    '/api/v1/ap/invoices/:id/match',
    { preHandler: requirePermission('ap.verify') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = MatchPurchaseRequest.parse(request.body ?? {});

      await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<{ id: string; latest_response_code: string | null }[]>`
          SELECT id, latest_response_code::text AS latest_response_code
          FROM invoices
          WHERE id = ${id} AND direction = 'INBOUND_PURCHASE_AP'
          FOR UPDATE
        `;
        const invoice = rows[0];
        if (!invoice) throw notFound('Purchase invoice');
        if (invoice.latest_response_code) {
          throw conflict(
            'This invoice has already been ruled on. The purchase order reference can no longer be changed.',
          );
        }

        if (body.supplierId) {
          const suppliers = await tx<{ id: string }[]>`
            SELECT id FROM suppliers WHERE id = ${body.supplierId} AND tenant_id = ${ctx.tenantId}
          `;
          if (!suppliers[0]) throw notFound('Supplier');
        }

        await tx`
          UPDATE invoices SET
            po_reference  = coalesce(${body.poReference ?? null}, po_reference),
            grn_reference = coalesce(${body.grnReference ?? null}, grn_reference),
            supplier_id   = coalesce(${body.supplierId ?? null}::uuid, supplier_id)
          WHERE id = ${id}
        `;
      });

      await audit(actorFromContext(ctx), {
        action: 'PURCHASE_INVOICE_MATCHED',
        resourceType: 'INVOICE',
        resourceId: id,
        tenantId: ctx.tenantId,
        changes: {
          poReference: body.poReference ?? null,
          grnReference: body.grnReference ?? null,
          supplierId: body.supplierId ?? null,
        },
      });

      return reply.send({ id });
    },
  );

  // --- §12.2 "Auto-Match with POs" -----------------------------------------
  app.post(
    '/api/v1/ap/auto-match',
    { preHandler: requirePermission('ap.verify') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const result = await withTenant(ctx.tenantId, (tx) =>
        autoMatchPurchaseOrders(tx, ctx.tenantId!),
      );

      return reply.send({
        flagged: result.matched,
        message:
          result.matched === 0
            ? 'Every unreviewed purchase invoice already carries a purchase order reference.'
            : `${result.matched} invoice${result.matched === 1 ? '' : 's'} placed on hold: no purchase order reference was supplied by the supplier.`,
      });
    },
  );

  // --- §12.3 the verdict ---------------------------------------------------
  app.post(
    '/api/v1/ap/decision',
    { preHandler: requirePermission('ap.verify') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = ApDecisionRequest.parse(request.body);

      // §16 reserves "authorize AP payments" to the tax approver. Accepting a
      // bill is what releases it for payment, so an accountant may query or
      // reject on their own but the acceptance needs the CFO's authority.
      if (body.responseCode === 'AP' && !ctxCan(ctx, 'ap.post')) {
        throw badRequest(
          'Accepting a purchase invoice releases it for payment, which is reserved to your tax approver. Use "Under query" to flag it for them instead.',
        );
      }

      const outcome = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<
          {
            id: string;
            invoice_number: string;
            seller_name: string;
            latest_response_code: string | null;
            status: InvoiceStatus;
          }[]
        >`
          SELECT id, invoice_number, seller_name,
                 latest_response_code::text AS latest_response_code, status
          FROM invoices
          WHERE tenant_id = ${ctx.tenantId}
            AND direction = 'INBOUND_PURCHASE_AP'
            AND id = ANY(${body.invoiceIds}::uuid[])
          ORDER BY created_at
          FOR UPDATE
        `;

        const decided: { id: string; invoiceNumber: string; responseId: string }[] = [];
        const reasons: { invoiceId: string; reason: string }[] = [];

        const accepted = body.responseCode === 'AP';
        const nextStatus: InvoiceStatus =
          body.responseCode === 'RE' && body.isTechnical
            ? 'REJECTED_TECHNICAL'
            : STATUS_FOR_DECISION[body.responseCode];
        // A technical rejection is a complaint about the document, not about
        // the trade, so it does not open a commercial dispute and does not
        // appear in the §13 dispute analytics.
        const opensDispute = !accepted && !body.isTechnical;
        const disputeOpenedAt = opensDispute ? new Date() : null;

        for (const invoice of rows) {
          // Re-affirming an existing verdict is harmless; reversing one is not.
          // A bill that was rejected and is now to be accepted needs the
          // supplier's corrected document, not a change of mind on ours.
          if (invoice.latest_response_code === 'RE' && body.responseCode !== 'RE') {
            reasons.push({
              invoiceId: invoice.id,
              reason:
                'This invoice was rejected and returned to the supplier. Ask them to issue a credit note or a corrected invoice.',
            });
            continue;
          }
          if (invoice.latest_response_code === 'AP' && body.responseCode !== 'AP') {
            reasons.push({
              invoiceId: invoice.id,
              reason:
                'This invoice has already been accepted and posted. Raise a debit note with the supplier instead.',
            });
            continue;
          }

          const responseId = await recordApDecision(tx, {
            tenantId: ctx.tenantId!,
            invoiceId: invoice.id,
            responseCode: body.responseCode,
            reasonCode: body.reasonCode ?? null,
            isTechnical: body.isTechnical,
            comments: body.comments ?? null,
            userId: ctx.userId,
          });

          await tx`
            UPDATE invoices SET
              status = ${nextStatus}::invoice_status,
              latest_response_code = ${body.responseCode}::response_status_code,
              latest_response_reason_code = ${body.reasonCode ?? null}::rejection_reason_code,
              latest_response_comment = ${body.comments ?? null},
              ap_posting_status = ${POSTING_FOR_DECISION[body.responseCode]}::ap_posting_status,
              ap_reviewed_by_user_id = ${ctx.userId},
              ap_reviewed_at = CURRENT_TIMESTAMP,
              is_commercial_dispute = ${opensDispute},
              dispute_opened_at = ${disputeOpenedAt},
              dispute_resolved = ${accepted},
              dispute_resolved_at = ${accepted ? new Date() : null},
              -- §10.6: an accepted bill is pushed into the buyer's own ERP.
              -- Anything else has nothing to post.
              erp_reverse_sync_status = ${
                accepted ? 'PENDING' : 'NOT_APPLICABLE'
              }::erp_sync_status
            WHERE id = ${invoice.id}
          `;

          decided.push({
            id: invoice.id,
            invoiceNumber: invoice.invoice_number,
            responseId,
          });
        }

        return { decided, reasons };
      });

      // Transmission and metering happen after the commit, for the same reason
      // batch submission enqueues late: a rolled-back transaction would leave
      // the worker chasing rows that no longer exist and the meter charging for
      // decisions that were never recorded.
      for (const item of outcome.decided) {
        await responseSendQueue().add(
          'response',
          { responseId: item.responseId, invoiceId: item.id, tenantId: ctx.tenantId },
          { ...RESPONSE_JOB_OPTIONS, jobId: `response-${item.responseId}` },
        );

        // §15: reception and verification are included in the base bundle; only
        // the ERP posting of an accepted bill consumes a unit, and a technical
        // rejection consumes nothing at all.
        const reason =
          body.responseCode === 'AP'
            ? USAGE_REASONS.apErpPosting
            : body.isTechnical
              ? USAGE_REASONS.technicalRejection
              : null;

        if (reason) {
          await consumeUnits({
            tenantId: ctx.tenantId,
            invoiceId: item.id,
            direction: 'INBOUND_PURCHASE_AP',
            reason,
            units: unitsFor(reason),
          });
        }
      }

      await audit(actorFromContext(ctx), {
        action: 'PURCHASE_INVOICE_DECIDED',
        resourceType: 'INVOICE',
        resourceId: outcome.decided[0]?.id ?? null,
        tenantId: ctx.tenantId,
        changes: {
          responseCode: body.responseCode,
          reasonCode: body.reasonCode ?? null,
          isTechnical: body.isTechnical,
          comments: body.comments ?? null,
          invoiceNumbers: outcome.decided.map((d) => d.invoiceNumber),
          skipped: outcome.reasons.length,
        },
      });

      const response: ApDecisionResponse = {
        affected: outcome.decided.length,
        skipped: outcome.reasons.length,
        reasons: outcome.reasons,
      };
      return reply.send(response);
    },
  );

  // --- Reception -----------------------------------------------------------
  // The webhook path (see modules/webhooks) is how a real ASP delivers. This
  // endpoint is the same reception logic reachable by hand, which is what makes
  // the module testable before a provider contract exists and what lets a desk
  // ingest a document that arrived out of band.
  app.post(
    '/api/v1/ap/invoices/receive',
    { preHandler: requirePermission('ap.verify') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const body = ReceivePurchaseInvoiceRequest.parse(request.body);

      const result = await receivePurchaseInvoice({
        tenantId: ctx.tenantId,
        ublXml: body.ublXml,
        ftaIrn: body.ftaIrn ?? null,
        source: 'manual',
        actor: actorFromContext(ctx),
        actorUserId: ctx.userId,
      });

      return reply.status(result.duplicate ? 200 : 201).send({
        id: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        duplicate: result.duplicate,
        supplierCreated: result.supplierCreated,
        warnings: result.warnings,
        message: result.duplicate
          ? 'This purchase invoice had already been received; the existing record was opened.'
          : 'Purchase invoice received and queued for verification.',
      });
    },
  );
}
