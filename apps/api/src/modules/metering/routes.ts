import { CreateBundleRequest, USAGE_REASON_LABELS, type UsageLedgerItem } from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withPlatformAccess, withTenant } from '../../db/client.js';
import {
  requireContext,
  requirePermission,
  requirePlatform,
  resolveTenantId,
} from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import {
  BUNDLE_WITH_ALLOCATION,
  loadBalance,
  toBundleSummary,
  type BundleRow,
} from './service.js';
import { assertHostStockCovers } from './inventory.js';

/**
 * Data bundles and consumption (SRS v2.7 §15).
 *
 * Two audiences with different rights. A tenant reads their own balance and
 * ledger; the host sells bundles and a channel partner carves slices out of the
 * master pool it bought. Selling is `platform.manage` and slicing is
 * `partner.subtenants.manage`, so the same endpoint serves both with the
 * authority check deciding which parent bundle you are allowed to name.
 */
export function registerMeteringRoutes(app: FastifyInstance) {
  // --- The tenant's own balance --------------------------------------------
  app.get(
    '/api/v1/billing/balance',
    { preHandler: requirePermission('billing.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const tenantId = resolveTenantId(request);
      if (!tenantId) throw notFound('Tenant');

      const balance = await loadBalance(tenantId);
      void ctx;
      return reply.send(balance);
    },
  );

  // --- The consumption ledger ----------------------------------------------
  app.get(
    '/api/v1/billing/usage',
    { preHandler: requirePermission('billing.read') },
    async (request, reply) => {
      const tenantId = resolveTenantId(request);
      if (!tenantId) throw notFound('Tenant');

      const query = request.query as { page?: string; pageSize?: string };
      const page = Math.max(1, Number(query.page ?? 1));
      const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 50)));

      const result = await withTenant(tenantId, async (tx) => {
        const rows = await tx<
          {
            id: string;
            invoice_id: string | null;
            invoice_number: string | null;
            direction: UsageLedgerItem['direction'];
            reason: string;
            units: number;
            is_parent_mirror: boolean;
            created_at: Date;
          }[]
        >`
          SELECT l.id::text AS id, l.invoice_id, l.direction, l.reason, l.units,
                 l.is_parent_mirror, l.created_at,
                 (SELECT i.invoice_number FROM invoices i WHERE i.id = l.invoice_id)
                   AS invoice_number
          FROM usage_ledger l
          WHERE l.tenant_id = ${tenantId}
          ORDER BY l.created_at DESC
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
        `;

        const counted = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM usage_ledger WHERE tenant_id = ${tenantId}
        `;

        return { rows, total: Number(counted[0]!.count) };
      });

      return reply.send({
        items: result.rows.map(
          (row): UsageLedgerItem => ({
            id: row.id,
            invoiceId: row.invoice_id,
            invoiceNumber: row.invoice_number,
            direction: row.direction,
            reason: USAGE_REASON_LABELS[row.reason] ?? row.reason,
            units: row.units,
            isParentMirror: row.is_parent_mirror,
            createdAt: row.created_at.toISOString(),
          }),
        ),
        total: result.total,
        page,
        pageSize,
      });
    },
  );

  // --- Selling a bundle -----------------------------------------------------
  app.post(
    '/api/v1/billing/bundles',
    { preHandler: requirePermission('platform.manage', 'partner.subtenants.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const body = CreateBundleRequest.parse(request.body);

      const created = await withPlatformAccess(async (tx) => {
        const tenants = await tx<
          { id: string; tenant_type: string; parent_tenant_id: string | null; legal_name_en: string }[]
        >`
          SELECT id, tenant_type::text AS tenant_type, parent_tenant_id, legal_name_en
          FROM tenants WHERE id = ${body.tenantId}
        `;
        const tenant = tenants[0];
        if (!tenant) throw notFound('Tenant');

        // A partner may only load capacity for its own sub-tenants, and only
        // out of a master pool it actually owns. Without both checks a partner
        // could mint quota for anyone at the host's expense.
        if (ctx.role === 'PARTNER_ADMIN') {
          if (tenant.parent_tenant_id !== ctx.tenantId) {
            throw badRequest('That tenant is not one of your managed sub-tenants.');
          }
          if (!body.parentBundleId) {
            throw badRequest(
              'A partner allocation must be carved out of one of your own master bundles.',
            );
          }
        }

        if (body.parentBundleId) {
          const parents = await tx<BundleRow[]>`
            SELECT * FROM data_bundles WHERE id = ${body.parentBundleId}
          `;
          const parent = parents[0];
          if (!parent) throw notFound('Master bundle');

          if (ctx.role === 'PARTNER_ADMIN' && parent.tenant_id !== ctx.tenantId) {
            throw badRequest('That master bundle does not belong to you.');
          }

          // §2: slices are carved from the master pool, so the pool has to be
          // able to cover what has already been allocated plus this. Allowing
          // over-allocation would let a partner promise capacity twice and
          // discover the shortfall only when a client's filing failed.
          const allocated = await tx<{ total: string }[]>`
            SELECT coalesce(sum(purchased_units), 0)::text AS total
            FROM data_bundles WHERE parent_bundle_id = ${parent.id}
          `;
          const remaining = parent.purchased_units - Number(allocated[0]!.total);
          if (body.purchasedUnits > remaining) {
            throw badRequest(
              `That master bundle has ${remaining.toLocaleString()} unallocated units left; you asked to allocate ${body.purchasedUnits.toLocaleString()}.`,
            );
          }
        }

        // v2.8 §15.1: a bundle the host issues comes off the host's shelf, and
        // the shelf is only stocked by a registered provider purchase. Before
        // this the platform could sell units it had never bought, and the first
        // anyone would know was a provider refusing to clear an invoice.
        // A partner slice is exempt: those units left the host when the partner
        // bought its master pool, and double-counting them here would make the
        // host's stock fall twice for one sale.
        if (!body.parentBundleId) {
          await assertHostStockCovers(tx, body.purchasedUnits);
        }

        const rows = await tx<{ id: string }[]>`
          INSERT INTO data_bundles (
            tenant_id, parent_bundle_id, reference, purchased_units,
            allow_overage, expires_at, notes, asp_procurement_id, minimum_buffer_units
          ) VALUES (
            ${body.tenantId}, ${body.parentBundleId ?? null}, ${body.reference},
            ${body.purchasedUnits}, ${body.allowOverage},
            ${body.expiresAt ?? null}::date, ${body.notes ?? null},
            ${body.aspProcurementId ?? null}, ${body.minimumBufferUnits ?? 0}
          )
          RETURNING id
        `;

        return { id: rows[0]!.id, tenantName: tenant.legal_name_en };
      });

      await audit(actorFromContext(ctx), {
        action: 'BUNDLE_CREATED',
        resourceType: 'BUNDLE',
        resourceId: created.id,
        tenantId: body.tenantId,
        changes: {
          reference: body.reference,
          units: body.purchasedUnits,
          tenant: created.tenantName,
          parentBundleId: body.parentBundleId ?? null,
          allowOverage: body.allowOverage,
        },
      });

      return reply.status(201).send({ id: created.id });
    },
  );

  // --- Every bundle on the platform ----------------------------------------
  app.get('/api/v1/admin/bundles', { preHandler: requirePlatform() }, async (request, reply) => {
    const { tenantId } = request.query as { tenantId?: string };

    const rows = await withPlatformAccess((tx) =>
      tx.unsafe<BundleRow[]>(
        `SELECT ${BUNDLE_WITH_ALLOCATION}, t.legal_name_en AS tenant_name
         FROM data_bundles b
         JOIN tenants t ON t.id = b.tenant_id
         WHERE ($1::uuid IS NULL OR b.tenant_id = $1::uuid)
         ORDER BY b.created_at DESC
         LIMIT 500`,
        [tenantId ?? null],
      ),
    );

    return reply.send({ items: rows.map(toBundleSummary) });
  });

  // --- Suspend or reactivate a bundle --------------------------------------
  app.patch(
    '/api/v1/admin/bundles/:id',
    { preHandler: requirePermission('platform.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      const body = request.body as { status?: string; allowOverage?: boolean };

      if (body.status && !['ACTIVE', 'SUSPENDED', 'EXPIRED'].includes(body.status)) {
        throw badRequest('A bundle may be set to ACTIVE, SUSPENDED or EXPIRED.');
      }

      const updated = await withPlatformAccess(async (tx) => {
        const rows = await tx<BundleRow[]>`
          UPDATE data_bundles SET
            status = coalesce(${body.status ?? null}::bundle_status, status),
            allow_overage = coalesce(${body.allowOverage ?? null}, allow_overage)
          WHERE id = ${id}
          RETURNING *
        `;
        if (!rows[0]) throw notFound('Bundle');
        return rows[0];
      });

      await audit(actorFromContext(ctx), {
        action: 'BUNDLE_UPDATED',
        resourceType: 'BUNDLE',
        resourceId: id,
        tenantId: updated.tenant_id,
        changes: { status: body.status ?? null, allowOverage: body.allowOverage ?? null },
      });

      return reply.send(toBundleSummary(updated));
    },
  );
}
