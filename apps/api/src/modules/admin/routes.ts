import { AuditLogQuery, TransmissionMonitorQuery } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withPlatformAccess } from '../../db/client.js';
import { requireContext, requirePlatform } from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { SUBMIT_JOB_OPTIONS, invoiceSubmitQueue } from '../../queue/queues.js';

/**
 * Platform operations: the transmission monitor and the audit log.
 *
 * The transmission monitor is the support desk. When a merchant calls to say an
 * invoice never went through, this is the screen that answers why.
 */
export function registerAdminRoutes(app: FastifyInstance) {
  app.get('/api/v1/admin/transmissions', { preHandler: requirePlatform() }, async (request, reply) => {
    const query = TransmissionMonitorQuery.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;

    const result = await withPlatformAccess(async (tx) => {
      const rows = await tx<
        {
          invoice_id: string;
          invoice_number: string;
          tenant_id: string;
          tenant_name: string;
          status: string;
          asp_provider: string | null;
          last_attempt_at: Date | null;
          attempts: string;
          last_error: string | null;
          payable_amount_aed: string;
        }[]
      >`
        SELECT
          i.id AS invoice_id, i.invoice_number, i.tenant_id,
          t.legal_name_en AS tenant_name, i.status::text AS status,
          i.payable_amount_aed,
          last_log.asp_provider, last_log.created_at AS last_attempt_at,
          last_log.error_message AS last_error,
          coalesce(log_counts.attempts, 0)::text AS attempts
        FROM invoices i
        JOIN tenants t ON t.id = i.tenant_id
        LEFT JOIN LATERAL (
          SELECT asp_provider, created_at, error_message
          FROM transmission_logs l
          WHERE l.invoice_id = i.id
          ORDER BY l.created_at DESC LIMIT 1
        ) last_log ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*) AS attempts FROM transmission_logs l WHERE l.invoice_id = i.id
        ) log_counts ON TRUE
        WHERE (${query.tenantId ?? null}::uuid IS NULL OR i.tenant_id = ${query.tenantId ?? null}::uuid)
          AND (${query.status ?? null}::text IS NULL OR i.status::text = ${query.status ?? null})
          AND (
            ${query.onlyProblems} = FALSE
            OR i.status IN ('REJECTED_BY_FTA', 'VALIDATION_FAILED')
            -- Handed over but silent for an hour: the case that needs a human.
            OR (i.status = 'SUBMITTED_TO_ASP' AND i.submitted_at < now() - interval '1 hour')
          )
        ORDER BY coalesce(last_log.created_at, i.created_at) DESC
        LIMIT ${query.pageSize} OFFSET ${offset}
      `;

      const counted = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM invoices i
        WHERE (${query.tenantId ?? null}::uuid IS NULL OR i.tenant_id = ${query.tenantId ?? null}::uuid)
          AND (${query.status ?? null}::text IS NULL OR i.status::text = ${query.status ?? null})
          AND (
            ${query.onlyProblems} = FALSE
            OR i.status IN ('REJECTED_BY_FTA', 'VALIDATION_FAILED')
            OR (i.status = 'SUBMITTED_TO_ASP' AND i.submitted_at < now() - interval '1 hour')
          )
      `;

      return { rows, total: Number(counted[0]!.count) };
    });

    return reply.send({
      items: result.rows.map((r) => ({
        invoiceId: r.invoice_id,
        invoiceNumber: r.invoice_number,
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        status: r.status,
        aspProvider: r.asp_provider,
        lastAttemptAt: r.last_attempt_at?.toISOString() ?? null,
        attempts: Number(r.attempts),
        lastError: r.last_error,
        payableAmountAed: r.payable_amount_aed,
      })),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.post(
    '/api/v1/admin/transmissions/:invoiceId/retry',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { invoiceId } = request.params as { invoiceId: string };

      const invoice = await withPlatformAccess(async (tx) => {
        const rows = await tx<{ id: string; tenant_id: string; status: string; invoice_number: string }[]>`
          SELECT id, tenant_id, status::text AS status, invoice_number
          FROM invoices WHERE id = ${invoiceId}
        `;
        const row = rows[0];
        if (!row) throw notFound('Invoice');
        if (row.status === 'ACCEPTED_BY_FTA') {
          throw badRequest('This invoice has already been accepted. Retrying would file a duplicate.');
        }

        await tx`UPDATE invoices SET status = 'VALIDATED' WHERE id = ${invoiceId}`;
        return row;
      });

      await invoiceSubmitQueue().add(
        'submit',
        { invoiceId, tenantId: invoice.tenant_id, actorUserId: ctx.userId },
        { ...SUBMIT_JOB_OPTIONS, jobId: `submit-${invoiceId}-${Date.now()}` },
      );

      await audit(actorFromContext(ctx), {
        action: 'INVOICE_RETRIED',
        resourceType: 'INVOICE',
        resourceId: invoiceId,
        tenantId: invoice.tenant_id,
        changes: { invoiceNumber: invoice.invoice_number, by: 'platform' },
      });

      return reply.send({ queued: true });
    },
  );

  // --- Audit log -----------------------------------------------------------
  app.get('/api/v1/admin/audit', { preHandler: requirePlatform() }, async (request, reply) => {
    const query = AuditLogQuery.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;

    const result = await withPlatformAccess(async (tx) => {
      const rows = await tx<
        {
          id: string;
          tenant_id: string | null;
          tenant_name: string | null;
          actor_id: string | null;
          actor_name: string | null;
          actor_type: string;
          action: string;
          resource_type: string;
          resource_id: string | null;
          ip_address: string | null;
          changes: unknown;
          created_at: Date;
        }[]
      >`
        SELECT a.id::text AS id, a.tenant_id, t.legal_name_en AS tenant_name,
               a.actor_id, a.actor_name, a.actor_type, a.action,
               a.resource_type, a.resource_id, a.ip_address::text AS ip_address,
               a.changes, a.created_at
        FROM audit_trails a
        LEFT JOIN tenants t ON t.id = a.tenant_id
        WHERE (${query.tenantId ?? null}::uuid IS NULL OR a.tenant_id = ${query.tenantId ?? null}::uuid)
          AND (${query.actorId ?? null}::uuid IS NULL OR a.actor_id = ${query.actorId ?? null}::uuid)
          AND (${query.action ?? null}::text IS NULL OR a.action = ${query.action ?? null})
          AND (${query.resourceType ?? null}::text IS NULL OR a.resource_type = ${query.resourceType ?? null})
          AND (${query.dateFrom ?? null}::date IS NULL OR a.created_at >= ${query.dateFrom ?? null}::date)
          AND (${query.dateTo ?? null}::date IS NULL OR a.created_at < (${query.dateTo ?? null}::date + 1))
        ORDER BY a.created_at DESC
        LIMIT ${query.pageSize} OFFSET ${offset}
      `;

      const counted = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM audit_trails a
        WHERE (${query.tenantId ?? null}::uuid IS NULL OR a.tenant_id = ${query.tenantId ?? null}::uuid)
          AND (${query.actorId ?? null}::uuid IS NULL OR a.actor_id = ${query.actorId ?? null}::uuid)
          AND (${query.action ?? null}::text IS NULL OR a.action = ${query.action ?? null})
          AND (${query.resourceType ?? null}::text IS NULL OR a.resource_type = ${query.resourceType ?? null})
          AND (${query.dateFrom ?? null}::date IS NULL OR a.created_at >= ${query.dateFrom ?? null}::date)
          AND (${query.dateTo ?? null}::date IS NULL OR a.created_at < (${query.dateTo ?? null}::date + 1))
      `;

      return { rows, total: Number(counted[0]!.count) };
    });

    return reply.send({
      items: result.rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        actorId: r.actor_id,
        actorName: r.actor_name,
        actorType: r.actor_type,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        ipAddress: r.ip_address,
        changes: r.changes,
        createdAt: r.created_at.toISOString(),
      })),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  /** Tenant-scoped audit log, for a merchant's own auditor role. */
  app.get('/api/v1/tenant/audit', async (request, reply) => {
    const { requireRole } = await import('../../http/context.js');
    await requireRole('TENANT_ADMIN', 'AUDITOR')(request, reply);

    const ctx = requireContext(request);
    if (!ctx.tenantId) throw notFound('Tenant');

    const query = AuditLogQuery.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;

    const { withTenant } = await import('../../db/client.js');
    const result = await withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx<
        {
          id: string;
          actor_id: string | null;
          actor_name: string | null;
          actor_type: string;
          action: string;
          resource_type: string;
          resource_id: string | null;
          ip_address: string | null;
          changes: unknown;
          created_at: Date;
        }[]
      >`
        SELECT id::text AS id, actor_id, actor_name, actor_type, action,
               resource_type, resource_id, ip_address::text AS ip_address, changes, created_at
        FROM audit_trails
        WHERE tenant_id = ${ctx.tenantId}
        ORDER BY created_at DESC
        LIMIT ${query.pageSize} OFFSET ${offset}
      `;
      const counted = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM audit_trails WHERE tenant_id = ${ctx.tenantId}
      `;
      return { rows, total: Number(counted[0]!.count) };
    });

    return reply.send({
      items: result.rows.map((r) => ({
        id: r.id,
        tenantId: ctx.tenantId,
        tenantName: null,
        actorId: r.actor_id,
        actorName: r.actor_name,
        actorType: r.actor_type,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        ipAddress: r.ip_address,
        changes: r.changes,
        createdAt: r.created_at.toISOString(),
      })),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });
}
