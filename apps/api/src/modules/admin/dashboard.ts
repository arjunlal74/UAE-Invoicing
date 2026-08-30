import type { Role, TenantStatus, TenantType } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { withPlatformAccess } from '../../db/client.js';
import { requirePlatform } from '../../http/context.js';

/**
 * The platform operator's landing page.
 *
 * Ordered around one question — "is anything broken, and is anyone stuck
 * waiting on me?" — so the attention counts come first and everything else is
 * context. The one-hour threshold below matches the Transmissions screen, so a
 * count here and the list it links to can never disagree.
 */

interface CountRow {
  key: string;
  count: string;
}

function tally<K extends string>(rows: CountRow[]): Record<K, number> {
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.count)])) as Record<K, number>;
}

export function registerAdminDashboardRoutes(app: FastifyInstance) {
  app.get('/api/v1/admin/dashboard', { preHandler: requirePlatform() }, async (_request, reply) => {
    const data = await withPlatformAccess(async (tx) => {
      const tenantsByStatus = await tx<CountRow[]>`
        SELECT status::text AS key, count(*)::text AS count FROM tenants GROUP BY status
      `;
      const tenantsByType = await tx<CountRow[]>`
        SELECT tenant_type::text AS key, count(*)::text AS count FROM tenants GROUP BY tenant_type
      `;

      const usersByRole = await tx<CountRow[]>`
        SELECT role::text AS key, count(*)::text AS count FROM users GROUP BY role
      `;

      const users = await tx<{ total: string; active: string; pending: string }[]>`
        SELECT
          count(*)::text AS total,
          count(*) FILTER (WHERE is_active)::text AS active,
          -- No password means the invitation was never accepted. These are the
          -- people who cannot get in and will eventually ask why.
          count(*) FILTER (WHERE password_hash IS NULL)::text AS pending
        FROM users
      `;

      const attention = await tx<{
        stuck: string;
        rejected: string;
        validation_failed: string;
        tenants_pending: string;
        asp_not_configured: string;
      }[]>`
        SELECT
          -- Handed to the provider but silent for an hour: the case a human has
          -- to look at. Same threshold as the Transmissions monitor.
          (SELECT count(*) FROM invoices
            WHERE direction = 'OUTBOUND_SALES_AR'
              AND status = 'SUBMITTED_TO_ASP'
              AND submitted_at < now() - interval '1 hour')::text AS stuck,
          (SELECT count(*) FROM invoices
            WHERE direction = 'OUTBOUND_SALES_AR' AND status = 'REJECTED_BY_FTA')::text
            AS rejected,
          (SELECT count(*) FROM invoices
            WHERE direction = 'OUTBOUND_SALES_AR' AND status = 'VALIDATION_FAILED')::text
            AS validation_failed,
          (SELECT count(*) FROM tenants WHERE status = 'PENDING')::text AS tenants_pending,
          -- A tenant whose provider connection is not live cannot file, however
          -- healthy the rest of its account looks.
          (SELECT count(*) FROM tenant_asp_configs
            WHERE is_active AND status <> 'ACTIVE')::text AS asp_not_configured
      `;

      const mail = await tx<{ configured: boolean; failed: string }[]>`
        SELECT
          EXISTS (SELECT 1 FROM mail_accounts WHERE is_default AND is_active) AS configured,
          (SELECT count(*) FROM mail_deliveries
            WHERE status = 'FAILED' AND created_at >= now() - interval '7 days')::text AS failed
      `;

      const topTenants = await tx<{
        tenant_id: string;
        tenant_name: string;
        status: string;
        invoices: string;
        accepted: string;
        rejected: string;
        value_aed: string;
      }[]>`
        SELECT
          t.id AS tenant_id, t.legal_name_en AS tenant_name, t.status::text AS status,
          count(i.id)::text AS invoices,
          count(i.id) FILTER (WHERE i.status = 'ACCEPTED_BY_FTA')::text AS accepted,
          count(i.id) FILTER (WHERE i.status = 'REJECTED_BY_FTA')::text AS rejected,
          coalesce(sum(i.payable_amount_aed), 0)::text AS value_aed
        FROM tenants t
        LEFT JOIN invoices i
          ON i.tenant_id = t.id AND i.created_at >= now() - interval '30 days'
        GROUP BY t.id, t.legal_name_en, t.status
        ORDER BY count(i.id) DESC, t.legal_name_en
        LIMIT 8
      `;

      const activity = await tx<{
        id: string;
        action: string;
        actor_name: string | null;
        tenant_name: string | null;
        created_at: Date;
      }[]>`
        SELECT a.id, a.action, a.actor_name, t.legal_name_en AS tenant_name, a.created_at
        FROM audit_trails a
        LEFT JOIN tenants t ON t.id = a.tenant_id
        ORDER BY a.created_at DESC
        LIMIT 8
      `;

      return {
        tenantsByStatus,
        tenantsByType,
        users: users[0]!,
        usersByRole,
        attention: attention[0]!,
        mail: mail[0]!,
        topTenants,
        activity,
      };
    });

    const tenantTotal = data.tenantsByStatus.reduce((sum, r) => sum + Number(r.count), 0);

    return reply.send({
      tenants: {
        total: tenantTotal,
        byStatus: tally<TenantStatus>(data.tenantsByStatus),
        byType: tally<TenantType>(data.tenantsByType),
      },
      users: {
        total: Number(data.users.total),
        active: Number(data.users.active),
        pendingInvites: Number(data.users.pending),
        byRole: tally<Role>(data.usersByRole),
      },
      needsAttention: {
        stuckTransmissions: Number(data.attention.stuck),
        rejectedByFta: Number(data.attention.rejected),
        validationFailed: Number(data.attention.validation_failed),
        tenantsPendingActivation: Number(data.attention.tenants_pending),
        aspNotConfigured: Number(data.attention.asp_not_configured),
        pendingInvites: Number(data.users.pending),
        failedMail: Number(data.mail.failed),
        mailConfigured: data.mail.configured,
      },
      topTenants: data.topTenants.map((t) => ({
        tenantId: t.tenant_id,
        tenantName: t.tenant_name,
        status: t.status as TenantStatus,
        invoices: Number(t.invoices),
        accepted: Number(t.accepted),
        rejected: Number(t.rejected),
        valueAed: t.value_aed,
      })),
      recentActivity: data.activity.map((a) => ({
        id: a.id,
        action: a.action,
        actorName: a.actor_name,
        tenantName: a.tenant_name,
        createdAt: a.created_at.toISOString(),
      })),
    });
  });
}
