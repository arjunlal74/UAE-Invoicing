import {
  CreateProcurementRequest,
  SetBufferRequest,
  type InventoryConsole,
  type InventoryTierRow,
  type ProcurementSummary,
  type TenantType,
} from '@uae/contracts';
import type { FastifyInstance } from 'fastify';
import { actorFromContext, audit } from '../../audit/audit.js';
import { withPlatformAccess, withTenant } from '../../db/client.js';
import { requireContext, requirePermission, requirePlatform } from '../../http/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { loadHostInventory } from './inventory.js';
import { parsePeriod } from './period.js';
import { loadPartnerReport, loadPlatformReport } from './report.js';

/**
 * The wholesale half of the bundle lifecycle — SRS v2.8 §15.
 *
 * Everything here is the host's own commercial position: what it bought, what
 * it paid, what is left on the shelf. None of it is tenant-visible, which is
 * why these routes sit behind `platform.manage` and the tables behind them are
 * outside row-level security rather than merely scoped by it.
 *
 * The one exception is the buffer endpoint at the bottom: §15.3 gives the floor
 * to the account holder, because the number that means "a week's filing" is
 * only knowable by the person doing the filing.
 */

interface ProcurementRow {
  id: string;
  asp_provider_id: string;
  asp_provider_name: string;
  contract_reference: string;
  total_units: number;
  cost_per_unit_aed: string;
  total_cost_aed: string;
  purchase_date: Date;
  expiry_date: Date | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: Date;
  allocated_units: string;
}

function toProcurementSummary(row: ProcurementRow): ProcurementSummary {
  const allocated = Number(row.allocated_units);
  return {
    id: row.id,
    aspProviderId: row.asp_provider_id,
    aspProviderName: row.asp_provider_name,
    contractReference: row.contract_reference,
    totalUnits: row.total_units,
    costPerUnitAed: row.cost_per_unit_aed,
    totalCostAed: row.total_cost_aed,
    purchaseDate: row.purchase_date.toISOString().slice(0, 10),
    expiryDate: row.expiry_date ? row.expiry_date.toISOString().slice(0, 10) : null,
    allocatedUnits: allocated,
    remainingUnits: row.total_units - allocated,
    notes: row.notes,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

const PROCUREMENT_SELECT = `
  p.id, p.asp_provider_id, p.contract_reference, p.total_units,
  (SELECT v.name FROM asp_providers v WHERE v.id = p.asp_provider_id) AS asp_provider_name,
  p.cost_per_unit_aed::text AS cost_per_unit_aed, p.total_cost_aed::text AS total_cost_aed,
  p.purchase_date, p.expiry_date, p.notes, p.created_at,
  (SELECT full_name FROM users u WHERE u.id = p.created_by_user_id) AS created_by_name,
  (SELECT coalesce(sum(b.purchased_units), 0)
   FROM data_bundles b WHERE b.asp_procurement_id = p.id)::text AS allocated_units
`;

export function registerInventoryRoutes(app: FastifyInstance) {
  // --- §15.1 register a wholesale purchase ---------------------------------
  app.post(
    '/api/v1/admin/procurements',
    { preHandler: requirePermission('platform.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const body = CreateProcurementRequest.parse(request.body);

      // The total is what the provider invoiced and is stored as given; the
      // rate is derived from it. The other direction loses money: 999,999 units
      // at a rate rounded to four places multiplies back to a total that is a
      // few fils off the contract, and the platform's cost reporting would then
      // disagree with the provider's own paperwork.
      const totalCost = body.totalCostAed.toFixed(2);
      const derivedRate = body.totalCostAed / body.totalUnits;

      // A stated rate is a cross-check, not an input. The tolerance is half a
      // unit of the stored precision, so a caller that computed the same figure
      // and rounded it agrees, while one that computed a genuinely different
      // number is told rather than quietly overruled.
      if (
        body.costPerUnitAed !== undefined &&
        Math.abs(body.costPerUnitAed - derivedRate) > 0.00005
      ) {
        throw badRequest(
          `The cost per unit you sent (${body.costPerUnitAed}) does not match AED ${totalCost} over ${body.totalUnits.toLocaleString('en-GB')} units, which is ${derivedRate.toFixed(4)}. Send one or the other.`,
          { statedRate: body.costPerUnitAed, derivedRate: Number(derivedRate.toFixed(4)) },
        );
      }

      const row = await withPlatformAccess(async (tx) => {
        const provider = await tx<{ id: string; name: string; is_active: boolean }[]>`
          SELECT id, name, is_active FROM asp_providers WHERE id = ${body.aspProviderId}
        `;
        if (!provider[0]) throw notFound('Provider');
        if (!provider[0].is_active) {
          throw badRequest(
            `"${provider[0].name}" has been retired. Reactivate it, or register this contract against a current provider.`,
          );
        }

        const existing = await tx<{ id: string }[]>`
          SELECT id FROM asp_bundle_procurements
          WHERE contract_reference = ${body.contractReference}
        `;
        if (existing[0]) {
          throw badRequest(
            `Contract reference "${body.contractReference}" has already been registered. Use the provider's own number, once.`,
          );
        }

        const inserted = await tx<{ id: string }[]>`
          INSERT INTO asp_bundle_procurements (
            asp_provider_id, contract_reference, total_units, cost_per_unit_aed,
            total_cost_aed, purchase_date, expiry_date, notes, created_by_user_id
          ) VALUES (
            ${body.aspProviderId}, ${body.contractReference}, ${body.totalUnits},
            ${derivedRate.toFixed(4)}, ${totalCost},
            -- coalesce, not the column DEFAULT: passing an explicit NULL
            -- overrides a DEFAULT rather than falling back to it, so an
            -- omitted purchase date would violate the NOT NULL constraint.
            coalesce(${body.purchaseDate ?? null}::date, CURRENT_DATE),
            ${body.expiryDate ?? null}::date,
            ${body.notes ?? null}, ${ctx.userId}
          )
          RETURNING id
        `;

        const rows = await tx.unsafe<ProcurementRow[]>(
          `SELECT ${PROCUREMENT_SELECT} FROM asp_bundle_procurements p WHERE p.id = $1`,
          [inserted[0]!.id],
        );
        return rows[0]!;
      });

      await audit(actorFromContext(ctx), {
        action: 'PROCUREMENT_REGISTERED',
        resourceType: 'PROCUREMENT',
        resourceId: row.id,
        tenantId: null,
        changes: {
          provider: row.asp_provider_name,
          providerId: body.aspProviderId,
          contractReference: body.contractReference,
          units: body.totalUnits,
          totalCostAed: totalCost,
          costPerUnitAed: derivedRate.toFixed(4),
        },
      });

      return reply.status(201).send(toProcurementSummary(row));
    },
  );

  // --- The stock ledger, for the platform or for one of its partners -------
  //
  // Two routes rather than a scope parameter, because "the platform's own
  // movements" and "one partner's movements" are different authorisations
  // wearing the same shape, and a mistyped id should 404 rather than silently
  // widen to everything.
  app.get(
    '/api/v1/admin/inventory/report',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      return reply.send(await loadPlatformReport(parsePeriod(request.query)));
    },
  );

  app.get(
    '/api/v1/admin/inventory/report/:tenantId',
    { preHandler: requirePlatform() },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      return reply.send(await loadPartnerReport(tenantId, parsePeriod(request.query)));
    },
  );

  // --- §15.1–15.5 the whole picture ----------------------------------------
  app.get(
    '/api/v1/admin/inventory',
    { preHandler: requirePlatform() },
    async (_request, reply) => {
      // Everything here is cumulative on purpose: the shelf is every purchase
      // ever made minus every sale ever made, and the contract list is most
      // recent first. The window that matters — the per-provider roll-up, which
      // would otherwise only grow — is on the provider list instead, chosen in
      // the dialog that shows those columns.
      const host = await loadHostInventory();

      const data = await withPlatformAccess(async (tx) => {
        const procurements = await tx.unsafe<ProcurementRow[]>(
          `SELECT ${PROCUREMENT_SELECT}
           FROM asp_bundle_procurements p
           ORDER BY p.purchase_date DESC, p.created_at DESC
           LIMIT 200`,
          [],
        );

        // One row per active bundle rather than per tenant: a tenant can hold
        // two bundles with different expiry dates, and rolling them together
        // would hide the one about to lapse.
        const tiers = await tx<
          {
            tenant_id: string;
            tenant_name: string;
            tenant_type: TenantType;
            bundle_id: string;
            purchased_units: number;
            consumed_units: number;
            allocated_units: string;
            minimum_buffer_units: number;
            run_rate: string;
          }[]
        >`
          SELECT b.tenant_id,
                 t.legal_name_en AS tenant_name,
                 t.tenant_type,
                 b.id AS bundle_id,
                 b.purchased_units,
                 b.consumed_units,
                 (SELECT coalesce(sum(s.purchased_units), 0)
                  FROM data_bundles s
                  WHERE s.parent_bundle_id = b.id AND s.status <> 'EXPIRED')::text
                   AS allocated_units,
                 b.minimum_buffer_units,
                 (SELECT coalesce(sum(u.units), 0) / 30.0
                  FROM usage_ledger u
                  WHERE u.bundle_id = b.id AND u.created_at > now() - interval '30 days')::text
                   AS run_rate
          FROM data_bundles b
          JOIN tenants t ON t.id = b.tenant_id
          WHERE b.status = 'ACTIVE'
          ORDER BY t.tenant_type, t.legal_name_en
          LIMIT 500
        `;

        return { procurements, tiers };
      });

      const tiers: InventoryTierRow[] = data.tiers.map((row) => {
        const available = row.purchased_units - row.consumed_units;
        const runRate = Math.round(Number(row.run_rate) * 100) / 100;
        return {
          tenantId: row.tenant_id,
          tenantName: row.tenant_name,
          tier: row.tenant_type,
          bundleId: row.bundle_id,
          purchasedUnits: row.purchased_units,
          consumedUnits: row.consumed_units,
          allocatedUnits: Number(row.allocated_units),
          availableUnits: available,
          minimumBufferUnits: row.minimum_buffer_units,
          belowBuffer: row.minimum_buffer_units > 0 && available < row.minimum_buffer_units,
          dailyRunRate: runRate,
          daysRemaining: runRate > 0 ? Math.floor(available / runRate) : null,
        };
      });

      const response: InventoryConsole = {
        host,
        procurements: data.procurements.map(toProcurementSummary),
        tiers,
      };

      return reply.send(response);
    },
  );

  // --- §15.5 tier 1: the host's own floor ----------------------------------
  app.patch(
    '/api/v1/admin/inventory/buffer',
    { preHandler: requirePermission('platform.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const body = SetBufferRequest.parse(request.body);

      await withPlatformAccess(
        (tx) => tx`
          UPDATE platform_inventory_settings
          SET minimum_buffer_units = ${body.minimumBufferUnits},
              updated_by_user_id = ${ctx.userId},
              -- Re-arm on any change. Lowering the floor below the current
              -- balance should let the next breach speak, and raising it above
              -- should not wait for a top-up to clear a stale flag.
              buffer_alerted_at = NULL
          WHERE id
        `,
      );

      await audit(actorFromContext(ctx), {
        action: 'INVENTORY_BUFFER_SET',
        resourceType: 'PLATFORM',
        resourceId: null,
        tenantId: null,
        changes: { tier: 'HOST', minimumBufferUnits: body.minimumBufferUnits },
      });

      return reply.send(await loadHostInventory());
    },
  );

  // --- §15.3 tiers 2–4: the account holder's own floor ---------------------
  /**
   * Open to the account that owns the bundle, and to the platform.
   *
   * §15.3 puts this with the tenant admin deliberately: the host knows how many
   * units a tenant has left, but only the tenant knows whether two thousand of
   * them is a fortnight or an afternoon.
   */
  app.patch(
    '/api/v1/billing/bundles/:id/buffer',
    { preHandler: requirePermission('platform.manage', 'tenant.users.manage', 'partner.subtenants.manage') },
    async (request, reply) => {
      const ctx = requireContext(request);
      const { id } = request.params as { id: string };
      const body = SetBufferRequest.parse(request.body);

      const bundle = await withPlatformAccess(async (tx) => {
        const rows = await tx<
          { id: string; tenant_id: string; reference: string; parent_tenant_id: string | null }[]
        >`
          SELECT b.id, b.tenant_id, b.reference, t.parent_tenant_id
          FROM data_bundles b
          JOIN tenants t ON t.id = b.tenant_id
          WHERE b.id = ${id}
        `;
        const row = rows[0];
        if (!row) throw notFound('Bundle');

        // A platform admin may set any floor. Everyone else may set the floor
        // on their own bundle, and a partner may also set one on a sub-tenant's
        // slice — it is the partner who gets the alert and holds the top-up.
        if (ctx.role !== 'GLOBAL_ADMIN') {
          const ownsIt = row.tenant_id === ctx.tenantId;
          const managesIt =
            ctx.role === 'PARTNER_ADMIN' && row.parent_tenant_id === ctx.tenantId;
          if (!ownsIt && !managesIt) throw notFound('Bundle');
        }

        await tx`
          UPDATE data_bundles
          SET minimum_buffer_units = ${body.minimumBufferUnits},
              buffer_alerted_at = NULL
          WHERE id = ${id}
        `;
        return row;
      });

      await audit(actorFromContext(ctx), {
        action: 'INVENTORY_BUFFER_SET',
        resourceType: 'BUNDLE',
        resourceId: id,
        tenantId: bundle.tenant_id,
        changes: { reference: bundle.reference, minimumBufferUnits: body.minimumBufferUnits },
      });

      return reply.send({ minimumBufferUnits: body.minimumBufferUnits });
    },
  );

  // --- The warnings an account was actually sent ---------------------------
  app.get(
    '/api/v1/billing/alerts',
    { preHandler: requirePermission('billing.read') },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx.tenantId) throw notFound('Tenant');

      const rows = await withTenant(
        ctx.tenantId,
        (tx) => tx<
          {
            id: string;
            tenant_id: string | null;
            alert_tier: TenantType;
            threshold_units: number;
            units_remaining: number;
            severity: 'WARNING' | 'CRITICAL';
            daily_run_rate: string | null;
            notification_dispatched: boolean;
            dispatched_at: Date;
          }[]
        >`
          SELECT id, tenant_id, alert_tier, threshold_units, units_remaining,
                 severity, daily_run_rate::text AS daily_run_rate,
                 notification_dispatched, dispatched_at
          FROM inventory_alerts_log
          WHERE tenant_id = ${ctx.tenantId}
          ORDER BY dispatched_at DESC
          LIMIT 50
        `,
      );

      return reply.send({
        items: rows.map((row) => ({
          id: row.id,
          tenantId: row.tenant_id,
          tenantName: null,
          alertTier: row.alert_tier,
          thresholdUnits: row.threshold_units,
          unitsRemaining: row.units_remaining,
          severity: row.severity,
          dailyRunRate: row.daily_run_rate === null ? null : Number(row.daily_run_rate),
          notificationDispatched: row.notification_dispatched,
          dispatchedAt: row.dispatched_at.toISOString(),
        })),
      });
    },
  );
}
