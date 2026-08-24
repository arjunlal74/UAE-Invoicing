import {
  InvoiceSearchQuery,
  SUBMITTABLE_STATUSES,
  type InvoiceDetail,
  type InvoiceResponseDto,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withTenant } from '../../db/client.js';
import { requireContext, requirePermission } from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { SUBMIT_JOB_OPTIONS, invoiceSubmitQueue } from '../../queue/queues.js';
import { getObject, keyFromUri } from '../../storage/objectStore.js';
import { DOCUMENT_SELECT, toInvoiceListItem, type DocumentRow } from '../documents/mapper.js';
import { loadResponses } from '../responses/service.js';

/**
 * Document search and detail.
 *
 * v2.7 makes this endpoint serve both modules (§1.2): the AR desk asks for
 * OUTBOUND_SALES_AR, the AP desk's detail view asks for a specific document
 * regardless of direction, and the contract defaults the filter so that a
 * caller who forgets gets their own sales invoices rather than a mixture.
 */

export function registerInvoiceRoutes(app: FastifyInstance) {
  // --- Search --------------------------------------------------------------
  app.get('/api/v1/invoices', { preHandler: requirePermission('invoice.read') }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!ctx.tenantId) throw notFound('Tenant');

    const query = InvoiceSearchQuery.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;

    // The filter list is written once and used by both the page query and the
    // count. Positional parameters rather than the tagged template because the
    // SELECT list is itself a constant string.
    const filters = `
      tenant_id = $1
      AND direction = $2::invoice_direction
      AND ($3::text IS NULL OR
           to_tsvector('simple',
             coalesce(invoice_number, '') || ' ' || coalesce(buyer_name, '') || ' ' ||
             coalesce(seller_name, '') || ' ' || coalesce(buyer_trn, '') || ' ' ||
             coalesce(seller_trn, '') || ' ' || coalesce(po_reference, '')
           ) @@ plainto_tsquery('simple', $3)
           OR invoice_number ILIKE '%' || $3 || '%')
      AND ($4::text IS NULL OR status::text = $4)
      AND ($5::text IS NULL OR invoice_type::text = $5)
      AND ($6::text IS NULL OR buyer_trn = $6)
      AND ($7::uuid IS NULL OR batch_upload_id = $7::uuid)
      AND ($8::date IS NULL OR issue_date >= $8::date)
      AND ($9::date IS NULL OR issue_date <= $9::date)
      AND ($10::numeric IS NULL OR payable_amount_aed >= $10)
      AND ($11::numeric IS NULL OR payable_amount_aed <= $11)
    `;

    const params = [
      ctx.tenantId,
      query.direction,
      query.q ?? null,
      query.status ?? null,
      query.type ?? null,
      query.buyerTrn ?? null,
      query.batchId ?? null,
      query.dateFrom ?? null,
      query.dateTo ?? null,
      query.amountMin ?? null,
      query.amountMax ?? null,
    ];

    const result = await withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.unsafe<DocumentRow[]>(
        `SELECT ${DOCUMENT_SELECT}
         FROM invoices
         WHERE ${filters}
         ORDER BY issue_date DESC, created_at DESC
         LIMIT $12 OFFSET $13`,
        [...params, query.pageSize, offset],
      );

      const counted = await tx.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM invoices WHERE ${filters}`,
        params,
      );

      return { rows, total: Number(counted[0]!.count) };
    });

    return reply.send({
      items: result.rows.map(toInvoiceListItem),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  // --- Detail --------------------------------------------------------------
  app.get(
    '/api/v1/invoices/:id',
    { preHandler: requirePermission('invoice.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const detail = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx.unsafe<DocumentRow[]>(
          `SELECT ${DOCUMENT_SELECT} FROM invoices WHERE id = $1`,
          [id],
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
          SELECT * FROM invoice_line_items WHERE invoice_id = ${id} ORDER BY line_number
        `;

        const findings = await tx<
          {
            rule_code: string;
            severity: InvoiceDetail['findings'][number]['severity'];
            error_message: string;
            json_path: string | null;
            excel_sheet_name: string | null;
            excel_cell_reference: string | null;
          }[]
        >`
          SELECT * FROM validation_logs WHERE invoice_id = ${id} ORDER BY created_at
        `;

        const transmissions = await tx<
          {
            id: string;
            asp_provider: string;
            transmission_reference: string | null;
            http_status_code: number | null;
            status: string;
            latency_ms: number | null;
            error_message: string | null;
            attempt: number;
            created_at: Date;
          }[]
        >`
          SELECT * FROM transmission_logs WHERE invoice_id = ${id} ORDER BY created_at DESC
        `;

        const responses = await loadResponses(tx, id);

        return { invoice, lines, findings, transmissions, responses };
      });

      const invoice = detail.invoice;

      const response: InvoiceDetail = {
        ...toInvoiceListItem(invoice),
        peppolUuid: invoice.peppol_uuid,
        issueTime: invoice.issue_time,
        exchangeRate: invoice.exchange_rate,
        sellerTrn: invoice.seller_trn,
        sellerName: invoice.seller_name,
        buyerEmirate: invoice.buyer_emirate,
        lineExtensionAmount: invoice.line_extension_amount,
        taxExclusiveAmount: invoice.tax_exclusive_amount,
        taxInclusiveAmount: invoice.tax_inclusive_amount,
        vatTotalAmount: invoice.vat_total_amount,
        qrCodeData: invoice.qr_code_data,
        ublXmlUri: invoice.ubl_xml_s3_uri,
        ublXmlSha256: invoice.ubl_xml_sha256,
        ftaRejectionReason: invoice.fta_rejection_reason,
        approvalNote: invoice.approval_note,
        approvedAt: invoice.approved_at?.toISOString() ?? null,
        submittedAt: invoice.submitted_at?.toISOString() ?? null,
        clearedAt: invoice.cleared_at?.toISOString() ?? null,

        ftaCryptographicStamp: invoice.fta_cryptographic_stamp,
        mlsStatus: invoice.mls_status,
        referencedInvoiceId: invoice.referenced_invoice_id,
        referencedInvoiceNumber: invoice.referenced_invoice_number,
        referencedFtaIrn: invoice.referenced_fta_irn,
        creditNoteReasonCode: invoice.credit_note_reason_code,
        creditNoteReversalMode: invoice.credit_note_reversal_mode,
        creditNoteNotes: invoice.credit_note_notes,
        latestResponseCode: invoice.latest_response_code,
        latestResponseReasonCode: invoice.latest_response_reason_code,
        latestResponseComment: invoice.latest_response_comment,
        disputeOpenedAt: invoice.dispute_opened_at?.toISOString() ?? null,
        disputeResolvedAt: invoice.dispute_resolved_at?.toISOString() ?? null,
        correctiveCreditNoteId: invoice.corrective_credit_note_id,
        correctiveCreditNoteNumber: invoice.corrective_credit_note_number,
        supplierId: invoice.supplier_id,
        supplierName: invoice.supplier_name_en,
        supplierIsProvisional: invoice.supplier_is_provisional === true,
        poReference: invoice.po_reference,
        grnReference: invoice.grn_reference,
        apPostingStatus: invoice.ap_posting_status,
        apReviewedByName: invoice.ap_reviewed_by_name,
        apReviewedAt: invoice.ap_reviewed_at?.toISOString() ?? null,
        customerId: invoice.customer_id,
        erpReverseSyncStatus: invoice.erp_reverse_sync_status,
        erpReverseSyncedAt: invoice.erp_reverse_synced_at?.toISOString() ?? null,

        lines: detail.lines.map((l) => ({
          id: String(l.line_number),
          lineNumber: String(l.line_number),
          description: l.item_name,
          hsCode: l.hs_code ?? '',
          quantity: l.quantity,
          uom: l.unit_of_measure,
          unitPrice: l.unit_price,
          lineDiscount: l.discount_amount,
          vatCategory: l.vat_category,
          vatRate: l.vat_rate,
          netAmount: l.net_amount,
          vatAmount: l.vat_amount,
          lineTotal: l.total_amount,
          sourceRow: null,
        })),
        findings: detail.findings.map((f) => ({
          ruleCode: f.rule_code,
          severity: f.severity,
          message: f.error_message,
          field: '',
          sheet: f.excel_sheet_name ?? '',
          cell: f.excel_cell_reference,
          jsonPath: f.json_path ?? undefined,
        })),
        transmissions: detail.transmissions.map((t) => ({
          id: t.id,
          aspProvider: t.asp_provider,
          transmissionReference: t.transmission_reference,
          httpStatusCode: t.http_status_code,
          status: t.status,
          latencyMs: t.latency_ms,
          errorMessage: t.error_message,
          attempt: t.attempt,
          createdAt: t.created_at.toISOString(),
        })),
        responses: detail.responses.map(
          (r): InvoiceResponseDto => ({
            id: r.id,
            responseDirection: r.response_direction,
            responseCode: r.response_code,
            statusReasonCode: r.status_reason_code,
            isTechnical: r.is_technical,
            comments: r.comments,
            createdByName: r.created_by_name,
            transmittedAt: r.transmitted_at?.toISOString() ?? null,
            transmissionError: r.transmission_error,
            receivedAt: r.received_at.toISOString(),
          }),
        ),
      };

      return reply.send(response);
    },
  );

  // --- Generated XML -------------------------------------------------------
  app.get(
    '/api/v1/invoices/:id/xml',
    { preHandler: requirePermission('invoice.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const rows = await withTenant(
        ctx.tenantId,
        (tx) => tx<{ ubl_xml_s3_uri: string | null; invoice_number: string }[]>`
          SELECT ubl_xml_s3_uri, invoice_number FROM invoices WHERE id = ${id}
        `,
      );

      const row = rows[0];
      if (!row) throw notFound('Invoice');
      if (!row.ubl_xml_s3_uri) {
        throw notFound('The XML for this document has not been generated yet');
      }

      const buffer = await getObject(keyFromUri(row.ubl_xml_s3_uri));
      return reply
        .header('content-type', 'application/xml; charset=utf-8')
        .header('content-disposition', `attachment; filename="${row.invoice_number}.xml"`)
        .send(buffer);
    },
  );

  // --- Retry ---------------------------------------------------------------
  app.post(
    '/api/v1/invoices/:id/retry',
    { preHandler: requirePermission('invoice.submit') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const invoice = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<
          { id: string; status: string; invoice_number: string; direction: string }[]
        >`
          SELECT id, status, invoice_number, direction::text AS direction
          FROM invoices WHERE id = ${id}
        `;
        const row = rows[0];
        if (!row) throw notFound('Invoice');

        // A purchase invoice is not ours to file. It arrived cleared.
        if (row.direction === 'INBOUND_PURCHASE_AP') {
          throw badRequest(
            'This is an inbound purchase invoice. It was filed by your supplier, not by you.',
          );
        }

        // Retrying an accepted invoice would file it a second time.
        if (row.status === 'ACCEPTED_BY_FTA') {
          throw badRequest('This invoice has already been accepted by the FTA.');
        }
        if (row.status === 'SUBMITTED_TO_ASP') {
          throw badRequest('This invoice is already with the provider and awaiting a verdict.');
        }
        if (row.status === 'PENDING_CFO_APPROVAL') {
          throw badRequest('Approve this invoice from the approvals queue rather than retrying it.');
        }
        if (row.status === 'DRAFT') {
          throw badRequest('This document is still a draft. Submit it from the builder.');
        }
        if (!SUBMITTABLE_STATUSES.includes(row.status as never) && row.status !== 'VALIDATION_FAILED') {
          throw badRequest(`A document with status ${row.status} cannot be retried.`);
        }

        await tx`
          UPDATE invoices
          SET status = 'VALIDATED',
              approved_by_user_id = ${ctx.userId},
              approved_at = CURRENT_TIMESTAMP
          WHERE id = ${id}
        `;
        return row;
      });

      await invoiceSubmitQueue().add(
        'submit',
        { invoiceId: id, tenantId: ctx.tenantId, actorUserId: ctx.userId },
        { ...SUBMIT_JOB_OPTIONS, jobId: `submit-${id}-${Date.now()}` },
      );

      await audit(actorFromContext(ctx), {
        action: 'INVOICE_RETRIED',
        resourceType: 'INVOICE',
        resourceId: id,
        tenantId: ctx.tenantId,
        changes: { invoiceNumber: invoice.invoice_number },
      });

      return reply.send({ queued: true });
    },
  );
}
