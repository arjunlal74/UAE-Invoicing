import { InvoiceDirection, type ModuleDashboardResponse } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { withTenant } from '../../db/client.js';
import { requireContext, requirePermission } from '../../http/context.js';
import { notFound } from '../../lib/errors.js';

/**
 * Per-module landing pages (SRS v2.7 §1.2).
 *
 * The v2.1 dashboard answered one question — "did my invoices clear?" — and
 * that question now has two forms with different owners. The AR desk wants to
 * know what is stuck before the FTA; the AP desk wants to know what is sitting
 * unreviewed and how much input tax is blocked behind it. One endpoint, scoped
 * by direction, because the shape of the answer is genuinely the same even
 * though the words on the tiles differ.
 */
export function registerModuleDashboardRoutes(app: FastifyInstance) {
  app.get(
    '/api/v1/dashboard/module',
    { preHandler: requirePermission('invoice.read', 'ap.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const direction = InvoiceDirection.parse(
        (request.query as { direction?: string }).direction ?? 'OUTBOUND_SALES_AR',
      );
      const outbound = direction === 'OUTBOUND_SALES_AR';

      const data = await withTenant(ctx.tenantId, async (tx) => {
        const statusCounts = await tx<{ status: string; count: string }[]>`
          SELECT status::text AS status, count(*)::text AS count
          FROM invoices
          WHERE tenant_id = ${ctx.tenantId} AND direction = ${direction}::invoice_direction
          GROUP BY status
        `;

        const totals = await tx<
          {
            total: string;
            needs_action: string;
            open_disputes: string;
            vat_total: string;
            amount_total: string;
          }[]
        >`
          SELECT
            count(*) FILTER (WHERE status <> 'DRAFT')::text AS total,
            -- AR: prepared and waiting for the approver. AP: received and
            -- waiting for the verification desk. Both are "somebody has to do
            -- something before this document moves".
            count(*) FILTER (
              WHERE (${outbound} AND status = 'PENDING_CFO_APPROVAL')
                 OR (NOT ${outbound} AND latest_response_code IS NULL AND status <> 'DRAFT')
            )::text AS needs_action,
            count(*) FILTER (WHERE is_commercial_dispute AND NOT dispute_resolved)::text
              AS open_disputes,
            coalesce(sum(vat_total_amount) FILTER (WHERE status <> 'DRAFT'), 0)::text AS vat_total,
            coalesce(sum(payable_amount_aed) FILTER (WHERE status <> 'DRAFT'), 0)::text
              AS amount_total
          FROM invoices
          WHERE tenant_id = ${ctx.tenantId} AND direction = ${direction}::invoice_direction
        `;

        const erp = await tx<{ status: string; count: string }[]>`
          SELECT erp_reverse_sync_status::text AS status, count(*)::text AS count
          FROM invoices
          WHERE tenant_id = ${ctx.tenantId}
            AND direction = ${direction}::invoice_direction
            AND erp_reverse_sync_status <> 'NOT_APPLICABLE'
          GROUP BY erp_reverse_sync_status
        `;

        return { statusCounts, totals: totals[0]!, erp };
      });

      const response: ModuleDashboardResponse = {
        direction,
        counts: Object.fromEntries(data.statusCounts.map((r) => [r.status, Number(r.count)])),
        totalDocuments: Number(data.totals.total),
        needsAction: Number(data.totals.needs_action),
        openDisputes: Number(data.totals.open_disputes),
        vatTotalAed: data.totals.vat_total,
        amountTotalAed: data.totals.amount_total,
        erpSyncStatus: Object.fromEntries(data.erp.map((r) => [r.status, Number(r.count)])),
      };

      return reply.send(response);
    },
  );
}
