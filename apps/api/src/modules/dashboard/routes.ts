import type { InvoiceStatus } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { withTenant } from '../../db/client.js';
import { requireContext, requirePermission } from '../../http/context.js';
import { notFound } from '../../lib/errors.js';
import { BATCH_SELECT, toBatchSummary, type BatchRow } from '../batches/routes.js';

/**
 * The merchant landing page.
 *
 * Built around one question — "did my invoices actually clear?" — so the
 * needs-attention counts come first and the pretty chart is secondary.
 */
export function registerDashboardRoutes(app: FastifyInstance) {
  app.get('/api/v1/dashboard', { preHandler: requirePermission('invoice.read') }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!ctx.tenantId) throw notFound('Tenant');

    const data = await withTenant(ctx.tenantId, async (tx) => {
      const tenants = await tx<{ status: string }[]>`
        SELECT status FROM tenants WHERE id = ${ctx.tenantId}
      `;
      const configs = await tx<{ status: string }[]>`
        SELECT status FROM tenant_asp_configs WHERE tenant_id = ${ctx.tenantId} AND is_active
      `;

      const statusCounts = await tx<{ status: InvoiceStatus; count: string }[]>`
        SELECT status, count(*)::text AS count FROM invoices
        WHERE tenant_id = ${ctx.tenantId}
        GROUP BY status
      `;

      const attention = await tx<{
        batches_with_errors: string;
        rejected_invoices: string;
        stuck_transmissions: string;
      }[]>`
        SELECT
          (SELECT count(*) FROM batch_uploads
            WHERE tenant_id = ${ctx.tenantId} AND status = 'STAGED_WITH_ERRORS')::text
            AS batches_with_errors,
          (SELECT count(*) FROM invoices
            WHERE tenant_id = ${ctx.tenantId} AND status = 'REJECTED_BY_FTA')::text
            AS rejected_invoices,
          -- "Stuck" means handed to the provider but with no verdict for an
          -- hour. These are exactly the invoices a merchant would otherwise
          -- discover were missing only at the end of a filing period.
          (SELECT count(*) FROM invoices
            WHERE tenant_id = ${ctx.tenantId} AND status = 'SUBMITTED_TO_ASP'
              AND submitted_at < now() - interval '1 hour')::text
            AS stuck_transmissions
      `;

      const recentBatches = await tx.unsafe<BatchRow[]>(
        `SELECT ${BATCH_SELECT}
         FROM batch_uploads b
         LEFT JOIN users u ON u.id = b.uploaded_by_user_id
         WHERE b.tenant_id = $1
         ORDER BY b.created_at DESC LIMIT 5`,
        [ctx.tenantId],
      );

      const trend = await tx<{ date: string; submitted: string; accepted: string; rejected: string }[]>`
        SELECT
          to_char(d.day, 'YYYY-MM-DD') AS date,
          count(i.id) FILTER (WHERE i.id IS NOT NULL)::text AS submitted,
          count(i.id) FILTER (WHERE i.status = 'ACCEPTED_BY_FTA')::text AS accepted,
          count(i.id) FILTER (WHERE i.status = 'REJECTED_BY_FTA')::text AS rejected
        FROM generate_series(CURRENT_DATE - interval '29 days', CURRENT_DATE, interval '1 day') AS d(day)
        LEFT JOIN invoices i
          ON i.tenant_id = ${ctx.tenantId} AND i.created_at::date = d.day::date
        GROUP BY d.day
        ORDER BY d.day
      `;

      return { tenants, configs, statusCounts, attention: attention[0]!, recentBatches, trend };
    });

    const counts = Object.fromEntries(
      data.statusCounts.map((r) => [r.status, Number(r.count)]),
    ) as Record<InvoiceStatus, number>;

    return reply.send({
      tenantStatus: data.tenants[0]?.status ?? 'PENDING',
      aspStatus: data.configs[0]?.status ?? 'NOT_CONFIGURED',
      canSubmit: data.tenants[0]?.status === 'ACTIVE' && data.configs[0]?.status === 'ACTIVE',
      counts,
      needsAttention: {
        batchesWithErrors: Number(data.attention.batches_with_errors),
        rejectedInvoices: Number(data.attention.rejected_invoices),
        stuckTransmissions: Number(data.attention.stuck_transmissions),
      },
      recentBatches: data.recentBatches.map(toBatchSummary),
      last30Days: data.trend.map((t) => ({
        date: t.date,
        submitted: Number(t.submitted),
        accepted: Number(t.accepted),
        rejected: Number(t.rejected),
      })),
    });
  });
}
