import type { ProvisioningMode, TenantStatus } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { withPlatformAccess } from '../../db/client.js';
import { requireContext, requirePartner } from '../../http/context.js';
import { forbidden, notFound } from '../../lib/errors.js';

/**
 * The channel partner's landing page (SRS v2.1 §2).
 *
 * The same question the platform dashboard answers — "is anything broken, and
 * is anyone waiting on me?" — asked at a partner's scale. Every figure is
 * bounded by `parent_tenant_id = <the caller's tenant>`, which is what stops
 * one reseller's dashboard from counting another's clients; the partner's own
 * row is included only where the question is about the partner itself (its
 * master pools), never in the client counts.
 *
 * Reads run through `withPlatformAccess` for the same reason the rest of this
 * module does: row-level security scopes a connection to a single tenant, and a
 * partner legitimately spans several. The parent filter replaces RLS here, so
 * it is not optional on any query below.
 *
 * The one-hour stuck threshold matches the platform's transmissions monitor, so
 * a partner and the operator it telephones never read different numbers off the
 * same backlog.
 */

interface CountRow {
  key: string;
  count: string;
}

function tally<K extends string>(rows: CountRow[]): Record<K, number> {
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.count)])) as Record<K, number>;
}

export function registerPartnerDashboardRoutes(app: FastifyInstance) {
  app.get('/api/v1/partner/dashboard', { preHandler: requirePartner() }, async (request, reply) => {
    const ctx = requireContext(request);
    if (!ctx.tenantId) {
      throw forbidden('A partner administrator must belong to a partner tenant.');
    }
    const partnerId = ctx.tenantId;

    const data = await withPlatformAccess(async (tx) => {
      const partners = await tx<{ legal_name_en: string }[]>`
        SELECT legal_name_en FROM tenants WHERE id = ${partnerId}
      `;
      if (!partners[0]) throw notFound('Partner');

      const subTenantsByStatus = await tx<CountRow[]>`
        SELECT status::text AS key, count(*)::text AS count
        FROM tenants WHERE parent_tenant_id = ${partnerId}
        GROUP BY status
      `;

      const subTenantsByMode = await tx<CountRow[]>`
        SELECT provisioning_mode::text AS key, count(*)::text AS count
        FROM tenants WHERE parent_tenant_id = ${partnerId}
        GROUP BY provisioning_mode
      `;

      // §3: a custody client nobody is authorised for cannot be worked in at
      // all. The partner is the one who files for it, so this is its filing
      // stopping, not a client's own account going quiet.
      const custodyWithoutStaff = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM tenants t
        WHERE t.parent_tenant_id = ${partnerId}
          AND t.provisioning_mode = 'FULLY_MANAGED_CUSTODY'
          AND t.status <> 'ARCHIVED'
          AND NOT EXISTS (
            SELECT 1 FROM partner_custody_grants g
            WHERE g.tenant_id = t.id AND g.revoked_at IS NULL
          )
      `;

      const users = await tx<{ total: string; active: string; pending: string }[]>`
        SELECT
          count(*)::text AS total,
          count(*) FILTER (WHERE u.is_active)::text AS active,
          -- No password means the invitation was never accepted. These are the
          -- client administrators who cannot get in, and who will ask the
          -- partner that onboarded them rather than the platform.
          count(*) FILTER (WHERE u.password_hash IS NULL)::text AS pending
        FROM users u
        JOIN tenants t ON t.id = u.tenant_id
        WHERE t.parent_tenant_id = ${partnerId}
      `;

      const invoices = await tx<{
        total: string;
        accepted: string;
        rejected: string;
        last_30: string;
        stuck: string;
        validation_failed: string;
      }[]>`
        SELECT
          count(*)::text AS total,
          count(*) FILTER (WHERE i.status = 'ACCEPTED_BY_FTA')::text AS accepted,
          count(*) FILTER (WHERE i.status = 'REJECTED_BY_FTA')::text AS rejected,
          count(*) FILTER (WHERE i.created_at >= now() - interval '30 days')::text AS last_30,
          -- Handed to a provider and silent for an hour: the case a human has
          -- to look at. Same threshold as the platform's monitor.
          count(*) FILTER (
            WHERE i.status = 'SUBMITTED_TO_ASP'
              AND i.submitted_at < now() - interval '1 hour'
          )::text AS stuck,
          count(*) FILTER (WHERE i.status = 'VALIDATION_FAILED')::text AS validation_failed
        FROM invoices i
        JOIN tenants t ON t.id = i.tenant_id
        WHERE t.parent_tenant_id = ${partnerId}
          AND i.direction = 'OUTBOUND_SALES_AR'
      `;

      const connections = await tx<{ not_live: string }[]>`
        SELECT count(*)::text AS not_live
        FROM tenant_asp_configs c
        JOIN tenants t ON t.id = c.tenant_id
        WHERE t.parent_tenant_id = ${partnerId}
          AND c.is_active
          AND c.status <> 'ACTIVE'
      `;

      // The partner's own pools, and what has been carved out of them. The two
      // figures answer different questions: what is allocated governs whether
      // another client can be promised units, what is consumed whether the
      // units already promised are being spent.
      const pools = await tx<{ purchased: string; consumed: string; allocated: string }[]>`
        SELECT
          coalesce(sum(b.purchased_units), 0)::text AS purchased,
          coalesce(sum(b.consumed_units), 0)::text AS consumed,
          coalesce(sum(
            (SELECT coalesce(sum(s.purchased_units), 0)
             FROM data_bundles s
             WHERE s.parent_bundle_id = b.id AND s.status <> 'EXPIRED')
          ), 0)::text AS allocated
        FROM data_bundles b
        WHERE b.tenant_id = ${partnerId} AND b.status = 'ACTIVE'
      `;

      // Two kinds of client trouble, counted per client rather than per bundle:
      // a client with three slices under the floor is one telephone call, not
      // three.
      const slices = await tx<{ without_units: string; below_buffer: string }[]>`
        SELECT
          count(*) FILTER (WHERE b.live_bundles = 0)::text AS without_units,
          count(*) FILTER (WHERE b.breached > 0)::text AS below_buffer
        FROM tenants t
        JOIN LATERAL (
          SELECT
            count(*) FILTER (
              WHERE d.status = 'ACTIVE'
                AND (d.expires_at IS NULL OR d.expires_at >= CURRENT_DATE)
            ) AS live_bundles,
            count(*) FILTER (
              WHERE d.status = 'ACTIVE'
                AND d.minimum_buffer_units > 0
                AND d.purchased_units - d.consumed_units < d.minimum_buffer_units
            ) AS breached
          FROM data_bundles d
          WHERE d.tenant_id = t.id
        ) b ON TRUE
        WHERE t.parent_tenant_id = ${partnerId}
          -- An archived client is not a gap left to fill.
          AND t.status <> 'ARCHIVED'
      `;

      const topSubTenants = await tx<{
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
          ON i.tenant_id = t.id
         AND i.direction = 'OUTBOUND_SALES_AR'
         AND i.created_at >= now() - interval '30 days'
        WHERE t.parent_tenant_id = ${partnerId}
        GROUP BY t.id, t.legal_name_en, t.status
        ORDER BY count(i.id) DESC, t.legal_name_en
        LIMIT 8
      `;

      // The partner's own trail as well as its clients'. Onboarding a client is
      // recorded against the client, but a partner suspending its own account
      // is recorded against the partner, and hiding that from the partner would
      // leave a gap exactly where it was looking.
      const activity = await tx<{
        id: string;
        action: string;
        actor_name: string | null;
        tenant_name: string | null;
        created_at: Date;
      }[]>`
        SELECT a.id, a.action, a.actor_name, t.legal_name_en AS tenant_name, a.created_at
        FROM audit_trails a
        JOIN tenants t ON t.id = a.tenant_id
        WHERE t.parent_tenant_id = ${partnerId} OR t.id = ${partnerId}
        ORDER BY a.created_at DESC
        LIMIT 8
      `;

      return {
        partnerName: partners[0].legal_name_en,
        subTenantsByStatus,
        subTenantsByMode,
        custodyWithoutStaff: custodyWithoutStaff[0]!,
        users: users[0]!,
        invoices: invoices[0]!,
        connections: connections[0]!,
        pools: pools[0]!,
        slices: slices[0]!,
        topSubTenants,
        activity,
      };
    });

    const byStatus = tally<TenantStatus>(data.subTenantsByStatus);
    const byMode = tally<ProvisioningMode>(data.subTenantsByMode);
    const subTenantTotal = Object.values(byStatus).reduce((sum, n) => sum + n, 0);

    const purchased = Number(data.pools.purchased);
    const consumed = Number(data.pools.consumed);
    const allocated = Number(data.pools.allocated);
    const unallocated = purchased - allocated;

    return reply.send({
      partnerName: data.partnerName,
      subTenants: { total: subTenantTotal, byStatus, byMode },
      users: {
        total: Number(data.users.total),
        active: Number(data.users.active),
        pendingInvites: Number(data.users.pending),
      },
      invoices: {
        total: Number(data.invoices.total),
        accepted: Number(data.invoices.accepted),
        rejected: Number(data.invoices.rejected),
        last30Days: Number(data.invoices.last_30),
      },
      inventory: {
        purchasedUnits: purchased,
        allocatedUnits: allocated,
        unallocatedUnits: unallocated,
        consumedUnits: consumed,
        remainingUnits: purchased - consumed,
      },
      needsAttention: {
        subTenantsPendingActivation: byStatus.PENDING ?? 0,
        aspNotConfigured: Number(data.connections.not_live),
        pendingInvites: Number(data.users.pending),
        subTenantsWithoutUnits: Number(data.slices.without_units),
        subTenantsBelowBuffer: Number(data.slices.below_buffer),
        custodyWithoutStaff: Number(data.custodyWithoutStaff.count),
        rejectedByFta: Number(data.invoices.rejected),
        stuckTransmissions: Number(data.invoices.stuck),
        validationFailed: Number(data.invoices.validation_failed),
        // A partner with no pool at all has nothing to allocate, which is a
        // different problem from having promised everything away — calling an
        // empty shelf "fully allocated" would send them to the wrong
        // conversation with their account manager.
        poolFullyAllocated: purchased > 0 && unallocated <= 0,
      },
      topSubTenants: data.topSubTenants.map((t) => ({
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
