import type { InventoryAccountRow, InventoryMovement } from '@uae/contracts';
import type { Tx } from '../../db/client.js';
import { withPlatformAccess } from '../../db/client.js';
import { badRequest } from '../../lib/errors.js';

/**
 * The supply chain behind a data bundle — SRS v2.8 §15.
 *
 * v2.7 counted units leaving. This counts them arriving, which is what turns a
 * consumption meter into an inventory: before this, a platform administrator
 * could sell a hundred thousand units the platform had never bought, and the
 * first anyone would know is a provider refusing to clear invoices.
 *
 * Every figure here is a subtraction over two sources — what was procured, and
 * what was sold or consumed — computed in SQL rather than carried in a running
 * total. A stored balance is a number that can disagree with its own history;
 * these cannot, and at this cardinality (contracts and bundles, not invoices)
 * the aggregate is trivial.
 */

export interface HostInventory {
  /** §15.1: every unit ever bought from a provider. */
  totalProcuredUnits: number;
  /** Sold to direct tenants, or allocated as a partner master pool. */
  totalSoldUnits: number;
  /** Opening + purchases − sales. What is left to sell. */
  currentStockUnits: number;
  /** §15.1: procured − consumed anywhere downstream. The operational buffer. */
  totalConsumedUnits: number;
  netAvailableUnits: number;
  minimumBufferUnits: number;
  belowBuffer: boolean;
  /** Units a day over the last 30 days, for "how long have we got". */
  dailyRunRate: number;
  daysRemaining: number | null;
  totalCostAed: string;
}

export async function loadHostInventory(): Promise<HostInventory> {
  return withPlatformAccess(async (tx) => {
    const rows = await tx<
      {
        procured: string;
        cost: string;
        sold: string;
        consumed: string;
        buffer: number;
        run_rate: string;
      }[]
    >`
      SELECT
        (SELECT coalesce(sum(total_units), 0) FROM asp_bundle_procurements
          WHERE expiry_date IS NULL OR expiry_date >= CURRENT_DATE)::text AS procured,
        (SELECT coalesce(sum(total_cost_aed), 0) FROM asp_bundle_procurements)::text AS cost,
        -- The null parent is what makes this the host's shelf: a partner's
        -- slice is carved out of the master pool the host already sold to the
        -- partner, so counting both would take the same unit off twice.
        (SELECT coalesce(sum(purchased_units), 0) FROM data_bundles
          WHERE parent_bundle_id IS NULL AND status <> 'EXPIRED')::text AS sold,
        -- Consumption is counted from the tenant's own rows only. A partner
        -- mirror row is the same physical invoice seen from the pool above it,
        -- and adding it would double the platform's consumption figure.
        (SELECT coalesce(sum(units), 0) FROM usage_ledger
          WHERE NOT is_parent_mirror)::text AS consumed,
        (SELECT minimum_buffer_units FROM platform_inventory_settings WHERE id) AS buffer,
        (SELECT coalesce(sum(units), 0) / 30.0 FROM usage_ledger
          WHERE NOT is_parent_mirror
            AND created_at > now() - interval '30 days')::text AS run_rate
    `;

    const row = rows[0]!;
    const procured = Number(row.procured);
    const sold = Number(row.sold);
    const consumed = Number(row.consumed);
    const netAvailable = procured - consumed;
    const runRate = Number(row.run_rate);

    return {
      totalProcuredUnits: procured,
      totalSoldUnits: sold,
      currentStockUnits: procured - sold,
      totalConsumedUnits: consumed,
      netAvailableUnits: netAvailable,
      minimumBufferUnits: row.buffer,
      belowBuffer: netAvailable < row.buffer,
      dailyRunRate: Math.round(runRate * 100) / 100,
      // Null rather than Infinity when nothing is being consumed: "unknown" is
      // the honest answer, and a dashboard should not print ∞ days.
      daysRemaining: runRate > 0 ? Math.floor(netAvailable / runRate) : null,
      totalCostAed: row.cost,
    };
  });
}


/**
 * The shelf as a movement statement over a window (SRS v2.8 §15.1).
 *
 * Opening + purchased − sold = closing, and it has to hold exactly or the four
 * figures are not a statement. That is why every one of them carries the same
 * two filters the cumulative shelf uses — a lapsed contract is off the shelf,
 * and a partner's slice is not a second sale of a unit already sold to the
 * partner. Relaxing either filter for one figure and not the others would
 * produce a closing balance that does not reconcile with the console above it.
 *
 * Dates are half-open at the top end internally (`< to + 1 day`) so that a
 * sale registered at any hour of the closing day counts, while the caller still
 * gets to think in inclusive dates.
 */
export async function loadInventoryMovement(
  from: string,
  to: string,
): Promise<InventoryMovement> {
  return withPlatformAccess(async (tx) => {
    const rows = await tx<
      {
        opening_procured: string;
        opening_sold: string;
        purchased: string;
        purchased_cost: string;
        sold: string;
        consumed: string;
        transactions: string;
        procured_to_date: string;
        consumed_to_date: string;
      }[]
    >`
      SELECT
        (SELECT coalesce(sum(total_units), 0) FROM asp_bundle_procurements
          WHERE (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
            AND purchase_date < ${from}::date)::text AS opening_procured,
        (SELECT coalesce(sum(purchased_units), 0) FROM data_bundles
          WHERE parent_bundle_id IS NULL AND status <> 'EXPIRED'
            AND created_at < ${from}::date)::text AS opening_sold,
        (SELECT coalesce(sum(total_units), 0) FROM asp_bundle_procurements
          WHERE (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
            AND purchase_date >= ${from}::date
            AND purchase_date <= ${to}::date)::text AS purchased,
        -- Filtered the same way as the units above, so the cost under the tile
        -- describes the purchases the tile counted and not a wider set.
        (SELECT coalesce(sum(total_cost_aed), 0) FROM asp_bundle_procurements
          WHERE (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
            AND purchase_date >= ${from}::date
            AND purchase_date <= ${to}::date)::text AS purchased_cost,
        (SELECT coalesce(sum(purchased_units), 0) FROM data_bundles
          WHERE parent_bundle_id IS NULL AND status <> 'EXPIRED'
            AND created_at >= ${from}::date
            AND created_at < (${to}::date + 1))::text AS sold,
        -- Tenant rows only. A partner mirror is the same physical invoice seen
        -- from the pool above it, and adding it would double the platform's
        -- consumption — the same reason the cumulative figure excludes it.
        (SELECT coalesce(sum(units), 0) FROM usage_ledger
          WHERE NOT is_parent_mirror
            AND created_at >= ${from}::date
            AND created_at < (${to}::date + 1))::text AS consumed,
        -- Rows, not units: a zero-rated event is still a transaction, and the
        -- same filters apply so the two figures describe one population.
        (SELECT count(*) FROM usage_ledger
          WHERE NOT is_parent_mirror
            AND created_at >= ${from}::date
            AND created_at < (${to}::date + 1))::text AS transactions,
        -- As at the close of the window, not today: a movement statement that
        -- mixed one figure from the closing date with another from now would
        -- not describe any single moment.
        (SELECT coalesce(sum(total_units), 0) FROM asp_bundle_procurements
          WHERE (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
            AND purchase_date <= ${to}::date)::text AS procured_to_date,
        (SELECT coalesce(sum(units), 0) FROM usage_ledger
          WHERE NOT is_parent_mirror
            AND created_at < (${to}::date + 1))::text AS consumed_to_date
    `;

    const row = rows[0]!;
    const opening = Number(row.opening_procured) - Number(row.opening_sold);
    const purchased = Number(row.purchased);
    const sold = Number(row.sold);
    const consumed = Number(row.consumed);

    // Both ends included: 1 March to 1 March is a day, not nothing, and a
    // zero here would divide the average into infinity.
    const days = Math.max(
      1,
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1,
    );

    return {
      from,
      to,
      openingUnits: opening,
      purchasedUnits: purchased,
      soldUnits: sold,
      closingUnits: opening + purchased - sold,
      purchasedCostAed: row.purchased_cost,
      consumedUnits: consumed,
      transactionCount: Number(row.transactions),
      dailyAverageUnits: Math.round((consumed / days) * 100) / 100,
      windowDays: days,
      unusedUnits: Number(row.procured_to_date) - Number(row.consumed_to_date),
    };
  });
}


/**
 * Every account's movement over the window, for the §15.5 per-tier tables.
 *
 * One query for all three tiers rather than one per tier, because they are the
 * same statement about different holders and three queries would be three
 * chances for them to disagree about what a balance is.
 *
 * Two axes, deliberately not netted together:
 *
 *   consumption   opening + purchased − consumed = unused    (all tiers)
 *   allocation    purchased to date − allocated to date = unsold  (partners)
 *
 * A sub-tenant filing draws down its own slice and mirrors onto the partner's
 * master pool, while carving the slice out of that pool does not touch it. So
 * a partner's consumption is its clients' filings, and subtracting allocation
 * from the same running figure would take the same unit off twice.
 *
 * Accounts that never held a bundle and never filed are left out entirely: a
 * table of zeroes for tenants who have no relationship with the inventory is
 * noise in the one place an operator is counting.
 */
export async function loadInventoryAccounts(
  from: string,
  to: string,
): Promise<InventoryAccountRow[]> {
  return withPlatformAccess(async (tx) => {
    const rows = await tx<
      {
        tenant_id: string;
        tenant_name: string;
        tier: InventoryAccountRow['tier'];
        opening_in: string;
        opening_out: string;
        purchased: string;
        consumed: string;
        sold: string;
        purchased_to_date: string;
        allocated_to_date: string;
      }[]
    >`
      SELECT t.id AS tenant_id,
             t.legal_name_en AS tenant_name,
             t.tenant_type AS tier,
             -- Everything before the window, netted, rather than a stored
             -- total: a carried number can disagree with its own history.
             (SELECT coalesce(sum(b.purchased_units), 0) FROM data_bundles b
               WHERE b.tenant_id = t.id AND b.created_at < ${from}::date)::text
               AS opening_in,
             (SELECT coalesce(sum(u.units), 0) FROM usage_ledger u
               WHERE u.tenant_id = t.id AND u.created_at < ${from}::date)::text
               AS opening_out,
             (SELECT coalesce(sum(b.purchased_units), 0) FROM data_bundles b
               WHERE b.tenant_id = t.id
                 AND b.created_at >= ${from}::date
                 AND b.created_at < (${to}::date + 1))::text AS purchased,
             -- Mirror rows included on purpose: under a partner they are the
             -- clients' filings, which is exactly what drew down its pool.
             (SELECT coalesce(sum(u.units), 0) FROM usage_ledger u
               WHERE u.tenant_id = t.id
                 AND u.created_at >= ${from}::date
                 AND u.created_at < (${to}::date + 1))::text AS consumed,
             (SELECT coalesce(sum(s.purchased_units), 0)
                FROM data_bundles s JOIN data_bundles m ON m.id = s.parent_bundle_id
               WHERE m.tenant_id = t.id
                 AND s.created_at >= ${from}::date
                 AND s.created_at < (${to}::date + 1))::text AS sold,
             (SELECT coalesce(sum(b.purchased_units), 0) FROM data_bundles b
               WHERE b.tenant_id = t.id
                 AND b.parent_bundle_id IS NULL
                 AND b.created_at < (${to}::date + 1))::text AS purchased_to_date,
             (SELECT coalesce(sum(s.purchased_units), 0)
                FROM data_bundles s JOIN data_bundles m ON m.id = s.parent_bundle_id
               WHERE m.tenant_id = t.id
                 AND s.created_at < (${to}::date + 1))::text AS allocated_to_date
      FROM tenants t
      WHERE t.tenant_type IN ('CHANNEL_PARTNER', 'ENTERPRISE_TENANT', 'MANAGED_SUB_TENANT')
        AND (EXISTS (SELECT 1 FROM data_bundles b WHERE b.tenant_id = t.id)
          OR EXISTS (SELECT 1 FROM usage_ledger u WHERE u.tenant_id = t.id))
      ORDER BY t.legal_name_en
      LIMIT 500
    `;

    return rows.map((row) => {
      const opening = Number(row.opening_in) - Number(row.opening_out);
      const purchased = Number(row.purchased);
      const consumed = Number(row.consumed);
      return {
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        tier: row.tier,
        openingUnits: opening,
        purchasedUnits: purchased,
        soldUnits: Number(row.sold),
        unsoldUnits: Number(row.purchased_to_date) - Number(row.allocated_to_date),
        consumedUnits: consumed,
        unusedUnits: opening + purchased - consumed,
      };
    });
  });
}

/**
 * Refuse to sell stock the platform does not hold.
 *
 * The whole point of §15.1's inventory formula. Called before a bundle is
 * created for a direct tenant or a partner master pool; a partner carving a
 * slice for its own sub-tenant is checked against the partner's pool instead
 * (see `assertPartnerPoolCovers`), because that unit already left the host.
 */
export async function assertHostStockCovers(tx: Tx, units: number): Promise<void> {
  const rows = await tx<{ procured: string; sold: string }[]>`
    SELECT
      (SELECT coalesce(sum(total_units), 0) FROM asp_bundle_procurements
        WHERE expiry_date IS NULL OR expiry_date >= CURRENT_DATE)::text AS procured,
      (SELECT coalesce(sum(purchased_units), 0) FROM data_bundles
        WHERE parent_bundle_id IS NULL AND status <> 'EXPIRED')::text AS sold
  `;

  const stock = Number(rows[0]!.procured) - Number(rows[0]!.sold);
  if (units > stock) {
    throw badRequest(
      `The platform holds ${stock.toLocaleString('en-GB')} unsold units and this allocation needs ${units.toLocaleString('en-GB')}. Register the provider purchase that covers it first.`,
      { availableUnits: stock, requestedUnits: units },
    );
  }
}

/**
 * §15.4: a partner may only slice what its own master pool still holds.
 *
 * Unallocated pool = master purchases − slices already carved. Note this is a
 * different figure from the partner's *consumption* balance: a partner can have
 * allocated every unit it owns and still have plenty unconsumed, and it is the
 * unallocated figure that governs whether another sub-tenant can be onboarded.
 */
export async function assertPartnerPoolCovers(
  tx: Tx,
  parentBundleId: string,
  units: number,
): Promise<void> {
  const rows = await tx<{ purchased: number; allocated: string }[]>`
    SELECT b.purchased_units AS purchased,
           (SELECT coalesce(sum(s.purchased_units), 0)
            FROM data_bundles s
            WHERE s.parent_bundle_id = b.id AND s.status <> 'EXPIRED')::text AS allocated
    FROM data_bundles b
    WHERE b.id = ${parentBundleId}
  `;

  const row = rows[0];
  if (!row) throw badRequest('That master bundle does not exist.');

  const unallocated = row.purchased - Number(row.allocated);
  if (units > unallocated) {
    throw badRequest(
      `That master pool has ${unallocated.toLocaleString('en-GB')} unallocated units left and this slice needs ${units.toLocaleString('en-GB')}. Top up the master bundle first.`,
      { unallocatedUnits: unallocated, requestedUnits: units },
    );
  }
}

// ---------------------------------------------------------------------------
// §15.5 the four-tier alert matrix
// ---------------------------------------------------------------------------

export type AlertTier = 'HOST' | 'CHANNEL_PARTNER' | 'ENTERPRISE_TENANT' | 'MANAGED_SUB_TENANT';

export interface BufferBreach {
  tier: AlertTier;
  tenantId: string | null;
  tenantName: string;
  bundleId: string | null;
  thresholdUnits: number;
  unitsRemaining: number;
  dailyRunRate: number;
  severity: 'WARNING' | 'CRITICAL';
}

/**
 * Half the floor is not a warning any more.
 *
 * The tier matrix in §15.5 names one threshold, but an account at 40% of its
 * floor and one at 4% need different words in the subject line — the first is a
 * reorder prompt and the second is about to stop filing.
 */
function severityOf(remaining: number, threshold: number): 'WARNING' | 'CRITICAL' {
  if (remaining <= 0) return 'CRITICAL';
  return remaining * 2 <= threshold ? 'CRITICAL' : 'WARNING';
}

/**
 * Every account currently under its floor and not already told about it.
 *
 * Evaluated as a sweep rather than at the point of consumption, because a floor
 * is breached in two ways: units go down, or an administrator raises the
 * threshold. Only the first passes through `consumeUnits`, and an alert that
 * fires for one cause but not the other is worse than no alert, because it
 * teaches people the absence of a warning means something.
 */
export async function findBufferBreaches(): Promise<BufferBreach[]> {
  const breaches: BufferBreach[] = [];

  const host = await loadHostInventory();
  if (host.minimumBufferUnits > 0 && host.belowBuffer) {
    const alerted = await withPlatformAccess(
      (tx) => tx<{ buffer_alerted_at: Date | null }[]>`
        SELECT buffer_alerted_at FROM platform_inventory_settings WHERE id
      `,
    );
    if (!alerted[0]?.buffer_alerted_at) {
      breaches.push({
        tier: 'HOST',
        tenantId: null,
        tenantName: 'Host main account',
        bundleId: null,
        thresholdUnits: host.minimumBufferUnits,
        unitsRemaining: host.netAvailableUnits,
        dailyRunRate: host.dailyRunRate,
        severity: severityOf(host.netAvailableUnits, host.minimumBufferUnits),
      });
    }
  }

  const rows = await withPlatformAccess(
    (tx) => tx<
      {
        bundle_id: string;
        tenant_id: string;
        tenant_name: string;
        tenant_type: AlertTier;
        threshold: number;
        remaining: number;
        run_rate: string;
      }[]
    >`
      SELECT b.id AS bundle_id,
             b.tenant_id,
             t.legal_name_en AS tenant_name,
             t.tenant_type::text AS tenant_type,
             b.minimum_buffer_units AS threshold,
             (b.purchased_units - b.consumed_units) AS remaining,
             (
               SELECT coalesce(sum(u.units), 0) / 30.0
               FROM usage_ledger u
               WHERE u.bundle_id = b.id AND u.created_at > now() - interval '30 days'
             )::text AS run_rate
      FROM data_bundles b
      JOIN tenants t ON t.id = b.tenant_id
      WHERE b.status = 'ACTIVE'
        AND b.minimum_buffer_units > 0
        AND b.buffer_alerted_at IS NULL
        AND (b.purchased_units - b.consumed_units) < b.minimum_buffer_units
        AND (b.expires_at IS NULL OR b.expires_at >= CURRENT_DATE)
    `,
  );

  for (const row of rows) {
    breaches.push({
      tier: row.tenant_type,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      bundleId: row.bundle_id,
      thresholdUnits: row.threshold,
      unitsRemaining: row.remaining,
      dailyRunRate: Math.round(Number(row.run_rate) * 100) / 100,
      severity: severityOf(row.remaining, row.threshold),
    });
  }

  return breaches;
}

/** Remember that a breach was announced, so it is announced once. */
export async function markAlerted(breach: BufferBreach, dispatched: boolean): Promise<void> {
  await withPlatformAccess(async (tx) => {
    await tx`
      INSERT INTO inventory_alerts_log (
        tenant_id, bundle_id, alert_tier, threshold_units, units_remaining,
        severity, daily_run_rate, notification_dispatched
      ) VALUES (
        ${breach.tenantId}, ${breach.bundleId}, ${breach.tier}::tenant_type,
        ${breach.thresholdUnits}, ${breach.unitsRemaining},
        ${breach.severity}::alert_severity, ${breach.dailyRunRate}, ${dispatched}
      )
    `;

    if (breach.bundleId) {
      await tx`UPDATE data_bundles SET buffer_alerted_at = now() WHERE id = ${breach.bundleId}`;
    } else {
      await tx`UPDATE platform_inventory_settings SET buffer_alerted_at = now() WHERE id`;
    }
  });
}

/**
 * Re-arm the alert for anything that has climbed back above its floor.
 *
 * Without this a single top-up would silence the account forever: the next time
 * it ran dry, `buffer_alerted_at` would still be set from months ago and
 * nothing would be sent.
 */
export async function rearmRecoveredBuffers(): Promise<number> {
  return withPlatformAccess(async (tx) => {
    const cleared = await tx<{ id: string }[]>`
      UPDATE data_bundles
      SET buffer_alerted_at = NULL
      WHERE buffer_alerted_at IS NOT NULL
        AND (purchased_units - consumed_units) >= minimum_buffer_units
      RETURNING id
    `;

    await tx`
      UPDATE platform_inventory_settings
      SET buffer_alerted_at = NULL
      WHERE id
        AND buffer_alerted_at IS NOT NULL
        AND (
          (SELECT coalesce(sum(total_units), 0) FROM asp_bundle_procurements
            WHERE expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
          - (SELECT coalesce(sum(units), 0) FROM usage_ledger WHERE NOT is_parent_mirror)
        ) >= minimum_buffer_units
    `;

    return cleared.length;
  });
}
