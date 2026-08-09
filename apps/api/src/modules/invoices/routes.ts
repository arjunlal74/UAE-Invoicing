import { InvoiceSearchQuery, SUBMITTABLE_STATUSES, type InvoiceDetail, type InvoiceListItem } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withTenant } from '../../db/client.js';
import { EDITOR_ROLES, READER_ROLES, requireContext, requireRole } from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { SUBMIT_JOB_OPTIONS, invoiceSubmitQueue } from '../../queue/queues.js';
import { getObject, keyFromUri } from '../../storage/objectStore.js';

interface InvoiceRow {
  id: string;
  invoice_number: string;
  invoice_type: InvoiceListItem['invoiceType'];
  issue_date: Date;
  issue_time: string;
  buyer_name: string;
  buyer_trn: string | null;
  buyer_emirate: string | null;
  currency_code: string;
  exchange_rate: string;
  seller_trn: string;
  seller_name: string;
  payable_amount: string;
  payable_amount_aed: string;
  line_extension_amount: string;
  tax_exclusive_amount: string;
  tax_inclusive_amount: string;
  vat_total_amount: string;
  status: InvoiceListItem['status'];
  batch_upload_id: string | null;
  peppol_uuid: string;
  qr_code_data: string | null;
  ubl_xml_s3_uri: string | null;
  ubl_xml_sha256: string | null;
  fta_rejection_reason: string | null;
  submitted_at: Date | null;
  cleared_at: Date | null;
  created_at: Date;
}

function toListItem(row: InvoiceRow): InvoiceListItem {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    invoiceType: row.invoice_type,
    issueDate: row.issue_date.toISOString().slice(0, 10),
    buyerName: row.buyer_name,
    buyerTrn: row.buyer_trn,
    currencyCode: row.currency_code,
    payableAmount: row.payable_amount,
    payableAmountAed: row.payable_amount_aed,
    status: row.status,
    batchId: row.batch_upload_id,
    createdAt: row.created_at.toISOString(),
  };
}

export function registerInvoiceRoutes(app: FastifyInstance) {
  // --- Search --------------------------------------------------------------
  app.get('/api/v1/invoices', { preHandler: requireRole(...READER_ROLES) }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!ctx.tenantId) throw notFound('Tenant');

    const query = InvoiceSearchQuery.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;

    const result = await withTenant(ctx.tenantId, async (tx) => {
      // Full-text over the fields a finance user actually searches, with the
      // filters applied as plain predicates so the planner can use the indexes.
      const rows = await tx<InvoiceRow[]>`
        SELECT * FROM invoices
        WHERE tenant_id = ${ctx.tenantId}
          AND (${query.q ?? null}::text IS NULL OR
               to_tsvector('simple',
                 coalesce(invoice_number, '') || ' ' || coalesce(buyer_name, '') || ' ' ||
                 coalesce(buyer_trn, '') || ' ' || coalesce(po_reference, '')
               ) @@ plainto_tsquery('simple', ${query.q ?? ''})
               OR invoice_number ILIKE ${'%' + (query.q ?? '') + '%'})
          AND (${query.status ?? null}::text IS NULL OR status::text = ${query.status ?? null})
          AND (${query.type ?? null}::text IS NULL OR invoice_type::text = ${query.type ?? null})
          AND (${query.buyerTrn ?? null}::text IS NULL OR buyer_trn = ${query.buyerTrn ?? null})
          AND (${query.batchId ?? null}::uuid IS NULL OR batch_upload_id = ${query.batchId ?? null}::uuid)
          AND (${query.dateFrom ?? null}::date IS NULL OR issue_date >= ${query.dateFrom ?? null}::date)
          AND (${query.dateTo ?? null}::date IS NULL OR issue_date <= ${query.dateTo ?? null}::date)
          AND (${query.amountMin ?? null}::numeric IS NULL OR payable_amount_aed >= ${query.amountMin ?? null})
          AND (${query.amountMax ?? null}::numeric IS NULL OR payable_amount_aed <= ${query.amountMax ?? null})
        ORDER BY issue_date DESC, created_at DESC
        LIMIT ${query.pageSize} OFFSET ${offset}
      `;

      const counted = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM invoices
        WHERE tenant_id = ${ctx.tenantId}
          AND (${query.q ?? null}::text IS NULL OR
               to_tsvector('simple',
                 coalesce(invoice_number, '') || ' ' || coalesce(buyer_name, '') || ' ' ||
                 coalesce(buyer_trn, '') || ' ' || coalesce(po_reference, '')
               ) @@ plainto_tsquery('simple', ${query.q ?? ''})
               OR invoice_number ILIKE ${'%' + (query.q ?? '') + '%'})
          AND (${query.status ?? null}::text IS NULL OR status::text = ${query.status ?? null})
          AND (${query.type ?? null}::text IS NULL OR invoice_type::text = ${query.type ?? null})
          AND (${query.buyerTrn ?? null}::text IS NULL OR buyer_trn = ${query.buyerTrn ?? null})
          AND (${query.batchId ?? null}::uuid IS NULL OR batch_upload_id = ${query.batchId ?? null}::uuid)
          AND (${query.dateFrom ?? null}::date IS NULL OR issue_date >= ${query.dateFrom ?? null}::date)
          AND (${query.dateTo ?? null}::date IS NULL OR issue_date <= ${query.dateTo ?? null}::date)
          AND (${query.amountMin ?? null}::numeric IS NULL OR payable_amount_aed >= ${query.amountMin ?? null})
          AND (${query.amountMax ?? null}::numeric IS NULL OR payable_amount_aed <= ${query.amountMax ?? null})
      `;

      return { rows, total: Number(counted[0]!.count) };
    });

    return reply.send({
      items: result.rows.map(toListItem),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  // --- Detail --------------------------------------------------------------
  app.get(
    '/api/v1/invoices/:id',
    { preHandler: requireRole(...READER_ROLES) },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const detail = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<InvoiceRow[]>`SELECT * FROM invoices WHERE id = ${id}`;
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

        return { invoice, lines, findings, transmissions };
      });

      const response: InvoiceDetail = {
        ...toListItem(detail.invoice),
        peppolUuid: detail.invoice.peppol_uuid,
        issueTime: detail.invoice.issue_time,
        exchangeRate: detail.invoice.exchange_rate,
        sellerTrn: detail.invoice.seller_trn,
        sellerName: detail.invoice.seller_name,
        buyerEmirate: detail.invoice.buyer_emirate,
        lineExtensionAmount: detail.invoice.line_extension_amount,
        taxExclusiveAmount: detail.invoice.tax_exclusive_amount,
        taxInclusiveAmount: detail.invoice.tax_inclusive_amount,
        vatTotalAmount: detail.invoice.vat_total_amount,
        qrCodeData: detail.invoice.qr_code_data,
        ublXmlUri: detail.invoice.ubl_xml_s3_uri,
        ublXmlSha256: detail.invoice.ubl_xml_sha256,
        ftaRejectionReason: detail.invoice.fta_rejection_reason,
        submittedAt: detail.invoice.submitted_at?.toISOString() ?? null,
        clearedAt: detail.invoice.cleared_at?.toISOString() ?? null,
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
      };

      return reply.send(response);
    },
  );

  // --- Generated XML -------------------------------------------------------
  app.get(
    '/api/v1/invoices/:id/xml',
    { preHandler: requireRole(...READER_ROLES) },
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
        throw notFound('The XML for this invoice has not been generated yet');
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
    { preHandler: requireRole(...EDITOR_ROLES) },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      if (!ctx.tenantId) throw notFound('Tenant');

      const invoice = await withTenant(ctx.tenantId, async (tx) => {
        const rows = await tx<{ id: string; status: string; invoice_number: string }[]>`
          SELECT id, status, invoice_number FROM invoices WHERE id = ${id}
        `;
        const row = rows[0];
        if (!row) throw notFound('Invoice');

        // Retrying an accepted invoice would file it a second time.
        if (row.status === 'ACCEPTED_BY_FTA') {
          throw badRequest('This invoice has already been accepted by the FTA.');
        }
        if (row.status === 'SUBMITTED_TO_ASP') {
          throw badRequest('This invoice is already with the provider and awaiting a verdict.');
        }
        if (!SUBMITTABLE_STATUSES.includes(row.status as never) && row.status !== 'VALIDATION_FAILED') {
          throw badRequest(`An invoice with status ${row.status} cannot be retried.`);
        }

        await tx`UPDATE invoices SET status = 'VALIDATED' WHERE id = ${id}`;
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
