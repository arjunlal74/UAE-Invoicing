import type { InvoiceStatus, ResponseStatusCode } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { withTenant } from '../../db/client.js';
import { requireContext, requirePermission } from '../../http/context.js';
import { notFound } from '../../lib/errors.js';
import { BATCH_SELECT, toBatchSummary, type BatchRow } from '../batches/routes.js';
import { parsePeriod, toReportingPeriod } from '../metering/period.js';

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

    // The volume cards read through a window; the attention counts do not.
    // "Three invoices the FTA refused" is true until somebody fixes them, and
    // scoping it to a month would retire a problem by waiting.
    const period = parsePeriod(request.query);

    const data = await withTenant(ctx.tenantId, async (tx) => {
      const tenants = await tx<{ status: string }[]>`
        SELECT status FROM tenants WHERE id = ${ctx.tenantId}
      `;
      const configs = await tx<{ status: string }[]>`
        SELECT status FROM tenant_asp_configs WHERE tenant_id = ${ctx.tenantId} AND is_active
      `;

      // Everything on this page is the AR module (SRS v2.7 §1.2). The AP desk
      // has its own overview, and mixing the two would count a supplier's bill
      // as one of the tenant's own filings.
      const statusCounts = await tx<{ status: InvoiceStatus; count: string }[]>`
        SELECT status, count(*)::text AS count FROM invoices
        WHERE tenant_id = ${ctx.tenantId} AND direction = 'OUTBOUND_SALES_AR'
          AND (${period.from}::date IS NULL OR issue_date >= ${period.from}::date)
          AND (${period.to}::date IS NULL OR issue_date <= ${period.to}::date)
        GROUP BY status
      `;

      const attention = await tx<{
        batches_with_errors: string;
        rejected_invoices: string;
        stuck_transmissions: string;
        customer_queries: string;
        customer_rejections: string;
        conditional_acceptances: string;
      }[]>`
        SELECT
          (SELECT count(*) FROM batch_uploads
            WHERE tenant_id = ${ctx.tenantId} AND status = 'STAGED_WITH_ERRORS')::text
            AS batches_with_errors,
          (SELECT count(*) FROM invoices
            WHERE tenant_id = ${ctx.tenantId} AND direction = 'OUTBOUND_SALES_AR'
              AND status = 'REJECTED_BY_FTA')::text
            AS rejected_invoices,
          -- "Stuck" means handed to the provider but with no verdict for an
          -- hour. These are exactly the invoices a merchant would otherwise
          -- discover were missing only at the end of a filing period.
          (SELECT count(*) FROM invoices
            WHERE tenant_id = ${ctx.tenantId} AND direction = 'OUTBOUND_SALES_AR'
              AND status = 'SUBMITTED_TO_ASP'
              AND submitted_at < now() - interval '1 hour')::text
            AS stuck_transmissions,
          -- Cleared by the FTA and held up by the buyer anyway. Nothing else on
          -- this page would show these: the clearance tiles still count them as
          -- accepted, because they are.
          --
          -- Split by verdict rather than reported as one dispute figure: the
          -- answer to a query is an explanation, the answer to a rejection is a
          -- credit note, and a merchant sizing up the morning needs to know
          -- which of the two is waiting.
          (SELECT count(*) FROM invoices
            WHERE tenant_id = ${ctx.tenantId} AND direction = 'OUTBOUND_SALES_AR'
              AND latest_response_code = 'UQ'
              AND is_commercial_dispute AND NOT dispute_resolved)::text
            AS customer_queries,
          -- Covers a technical rejection as well as a commercial one: both
          -- arrive as RE and both open a dispute, they simply differ in whether
          -- the buyer is arguing about the XML or about the trade.
          (SELECT count(*) FROM invoices
            WHERE tenant_id = ${ctx.tenantId} AND direction = 'OUTBOUND_SALES_AR'
              AND latest_response_code = 'RE'
              AND is_commercial_dispute AND NOT dispute_resolved)::text
            AS customer_rejections,
          -- A conditional acceptance closes the dispute but not the matter: the
          -- condition rides in the buyer's comment and somebody has to meet it.
          -- Signing it off on the dispute desk is what retires one.
          (SELECT count(*) FROM invoices
            WHERE tenant_id = ${ctx.tenantId} AND direction = 'OUTBOUND_SALES_AR'
              AND latest_response_code = 'CA' AND NOT condition_met)::text
            AS conditional_acceptances
      `;

      // §11. The buyer verdict is a second axis over the same invoices, so this
      // is grouped by response code rather than by status: AP and CA both land
      // on ACCEPTED_BY_BUYER, and a merchant chasing a conditional acceptance
      // needs them apart.
      const responseCounts = await tx<{ code: ResponseStatusCode; count: string }[]>`
        SELECT latest_response_code::text AS code, count(*)::text AS count
        FROM invoices
        WHERE tenant_id = ${ctx.tenantId} AND direction = 'OUTBOUND_SALES_AR'
          AND latest_response_code IS NOT NULL
          AND (${period.from}::date IS NULL OR issue_date >= ${period.from}::date)
          AND (${period.to}::date IS NULL OR issue_date <= ${period.to}::date)
        GROUP BY latest_response_code
      `;

      const awaiting = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM invoices
        WHERE tenant_id = ${ctx.tenantId} AND direction = 'OUTBOUND_SALES_AR'
          AND status IN ('ACCEPTED_BY_FTA', 'DELIVERED_TO_BUYER')
          AND latest_response_code IS NULL
          AND (${period.from}::date IS NULL OR issue_date >= ${period.from}::date)
          AND (${period.to}::date IS NULL OR issue_date <= ${period.to}::date)
      `;

      const recentBatches = await tx.unsafe<BatchRow[]>(
        `SELECT ${BATCH_SELECT}
         FROM batch_uploads b
         LEFT JOIN users u ON u.id = b.uploaded_by_user_id
         WHERE b.tenant_id = $1
         ORDER BY b.created_at DESC LIMIT 5`,
        [ctx.tenantId],
      );

      return {
        tenants,
        configs,
        statusCounts,
        attention: attention[0]!,
        responseCounts,
        awaiting: awaiting[0]!,
        recentBatches,
      };
    });

    const counts = Object.fromEntries(
      data.statusCounts.map((r) => [r.status, Number(r.count)]),
    ) as Record<InvoiceStatus, number>;

    return reply.send({
      // Stated back, so the page can label what its volume cards cover
      // rather than the reader inferring it from the picker.
      period: toReportingPeriod(period),
      tenantStatus: data.tenants[0]?.status ?? 'PENDING',
      aspStatus: data.configs[0]?.status ?? 'NOT_CONFIGURED',
      canSubmit: data.tenants[0]?.status === 'ACTIVE' && data.configs[0]?.status === 'ACTIVE',
      counts,
      needsAttention: {
        batchesWithErrors: Number(data.attention.batches_with_errors),
        rejectedInvoices: Number(data.attention.rejected_invoices),
        stuckTransmissions: Number(data.attention.stuck_transmissions),
        customerQueries: Number(data.attention.customer_queries),
        customerRejections: Number(data.attention.customer_rejections),
        conditionalAcceptances: Number(data.attention.conditional_acceptances),
      },
      customerResponses: {
        byCode: Object.fromEntries(data.responseCounts.map((r) => [r.code, Number(r.count)])),
        awaitingResponse: Number(data.awaiting.count),
      },
      recentBatches: data.recentBatches.map(toBatchSummary),
    });
  });
}
