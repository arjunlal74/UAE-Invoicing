import type { BalanceResponse, BundleSummary, InvoiceDirection } from '@uae/contracts';
import { USAGE_REASONS } from '@uae/contracts';
import { withPlatformAccess, type Tx } from '../../db/client.js';
import { logger } from '../../logger.js';

/**
 * The metering engine (SRS v2.7 §15).
 *
 * Two tiers, and the second one is the whole reason this is not a single
 * counter on `tenants`. A channel partner buys one master bundle and carves
 * slices out of it for the clients it manages; when one of those clients files
 * an invoice the unit comes off BOTH their slice and the partner's master pool.
 * That "dual deduction" (§2) is what lets a partner sell 5,000 rows to each of
 * twenty clients out of a 100,000-row purchase and still know where they stand.
 *
 * Everything here is idempotent by (invoice, reason). A submission job that is
 * retried after a provider timeout re-enters this path, and double-charging is
 * the first thing a tenant notices and the last thing they forgive.
 */

export interface BundleRow {
  id: string;
  tenant_id: string;
  parent_bundle_id: string | null;
  reference: string;
  purchased_units: number;
  consumed_units: number;
  status: BundleSummary['status'];
  allow_overage: boolean;
  valid_from: Date;
  expires_at: Date | null;
  alerted_threshold: number;
  minimum_buffer_units: number;
  buffer_alerted_at: Date | null;
  notes: string | null;
  created_at: Date;
  tenant_name?: string | null;
  /** Present only where the query asked for it — see BUNDLE_WITH_ALLOCATION. */
  allocated_units?: string | null;
}

/**
 * A bundle plus what has been carved out of it.
 *
 * Not folded into every bundle query: the figure only means anything for a
 * channel partner's master pool, and a correlated subquery on a path that runs
 * per filed invoice would be paying for it everywhere to use it in one place.
 */
export const BUNDLE_WITH_ALLOCATION = `
  b.*,
  (SELECT coalesce(sum(s.purchased_units), 0)
   FROM data_bundles s
   WHERE s.parent_bundle_id = b.id AND s.status <> 'EXPIRED')::text AS allocated_units
`;

export function toBundleSummary(row: BundleRow): BundleSummary {
  const remaining = row.purchased_units - row.consumed_units;
  const allocated = Number(row.allocated_units ?? 0);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name ?? null,
    parentBundleId: row.parent_bundle_id,
    reference: row.reference,
    purchasedUnits: row.purchased_units,
    consumedUnits: row.consumed_units,
    remainingUnits: remaining,
    usedPct:
      row.purchased_units === 0
        ? 0
        : Math.round((row.consumed_units / row.purchased_units) * 1000) / 10,
    status: row.status,
    allowOverage: row.allow_overage,
    validFrom: row.valid_from.toISOString().slice(0, 10),
    expiresAt: row.expires_at ? row.expires_at.toISOString().slice(0, 10) : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    allocatedUnits: allocated,
    unallocatedUnits: row.purchased_units - allocated,
    minimumBufferUnits: row.minimum_buffer_units,
    // v2.8 §15.3: an absolute floor, separate from the percentage warnings.
    // Zero means the account has not set one, and never reads as breached.
    belowBuffer: row.minimum_buffer_units > 0 && remaining < row.minimum_buffer_units,
  };
}

/**
 * The bundle a tenant's next unit should come out of.
 *
 * Oldest first, so a bundle with an expiry date is spent before it lapses
 * rather than being stranded behind a newer purchase.
 */
async function activeBundle(tx: Tx, tenantId: string): Promise<BundleRow | null> {
  const rows = await tx<BundleRow[]>`
    SELECT * FROM data_bundles
    WHERE tenant_id = ${tenantId}
      AND status = 'ACTIVE'
      AND valid_from <= CURRENT_DATE
      AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
    ORDER BY expires_at NULLS LAST, created_at
    LIMIT 1
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export interface ConsumeRequest {
  tenantId: string;
  invoiceId: string | null;
  direction: InvoiceDirection;
  reason: string;
  units: number;
}

export interface ConsumeResult {
  charged: boolean;
  /** Already billed under this (invoice, reason) pair. */
  duplicate: boolean;
  /** Bundle exhausted and overage not permitted. */
  blocked: boolean;
  remaining: number | null;
  /** Threshold (80/90/100) crossed by this deduction, for the alert. */
  thresholdCrossed: number | null;
  message: string | null;
}

/**
 * Take `units` off the tenant's pool, and off their partner's master pool too
 * when there is one.
 *
 * Called after the fact — a document is metered because it was filed, not in
 * order to be allowed to file. `assertCanFile` is the gate that runs first; this
 * is the ledger entry that follows. Splitting them that way means a provider
 * outage mid-submission cannot leave a tenant billed for a document that never
 * left the building.
 */
export async function consumeUnits(request: ConsumeRequest): Promise<ConsumeResult> {
  const empty: ConsumeResult = {
    charged: false,
    duplicate: false,
    blocked: false,
    remaining: null,
    thresholdCrossed: null,
    message: null,
  };

  try {
    return await withPlatformAccess(async (tx) => {
      // A zero-unit reason (§15: technical rejections) still earns a ledger row.
      // "You were not charged for this" is an answer, and an absent row is not.
      if (request.units === 0) {
        const written = await writeLedger(tx, request, null, false);
        return { ...empty, duplicate: !written };
      }

      const bundle = await activeBundle(tx, request.tenantId);
      if (!bundle) {
        logger.warn(
          { tenantId: request.tenantId, reason: request.reason },
          'no active data bundle; document filed unmetered',
        );
        const written = await writeLedger(tx, request, null, false);
        return {
          ...empty,
          charged: written,
          duplicate: !written,
          message: 'No active data bundle; this document was recorded but not charged.',
        };
      }

      const written = await writeLedger(tx, request, bundle.id, false);
      if (!written) return { ...empty, duplicate: true, remaining: remainingOf(bundle) };

      const nextConsumed = bundle.consumed_units + request.units;
      const before = pctOf(bundle.consumed_units, bundle.purchased_units);
      const after = pctOf(nextConsumed, bundle.purchased_units);
      const threshold = crossedThreshold(before, after, bundle.alerted_threshold);

      await tx`
        UPDATE data_bundles SET
          consumed_units = ${nextConsumed},
          alerted_threshold = ${Math.max(bundle.alerted_threshold, threshold ?? 0)},
          status = CASE
            WHEN ${nextConsumed} >= purchased_units AND NOT allow_overage
              THEN 'EXHAUSTED'::bundle_status
            ELSE status
          END
        WHERE id = ${bundle.id}
      `;

      // §2: the sub-tenant's slice and the partner's master pool are both drawn
      // down. The mirror row is flagged so a partner's own consumption report
      // can tell "my clients used this" from "I used this".
      if (bundle.parent_bundle_id) {
        await mirrorToParent(tx, request, bundle.parent_bundle_id);
      }

      return {
        charged: true,
        duplicate: false,
        blocked: false,
        remaining: bundle.purchased_units - nextConsumed,
        thresholdCrossed: threshold,
        message: null,
      };
    });
  } catch (err) {
    // Metering must never be the reason a filed invoice fails to record its own
    // outcome. A missed charge is a billing reconciliation; a lost clearance
    // status is a compliance incident.
    logger.error({ err, request }, 'metering failed');
    return { ...empty, message: 'Usage could not be recorded.' };
  }
}

async function mirrorToParent(tx: Tx, request: ConsumeRequest, parentBundleId: string) {
  const parents = await tx<BundleRow[]>`
    SELECT * FROM data_bundles WHERE id = ${parentBundleId} FOR UPDATE
  `;
  const parent = parents[0];
  if (!parent) return;

  const written = await writeLedger(
    tx,
    { ...request, tenantId: parent.tenant_id },
    parent.id,
    true,
  );
  if (!written) return;

  await tx`
    UPDATE data_bundles SET
      consumed_units = consumed_units + ${request.units},
      status = CASE
        WHEN consumed_units + ${request.units} >= purchased_units AND NOT allow_overage
          THEN 'EXHAUSTED'::bundle_status
        ELSE status
      END
    WHERE id = ${parent.id}
  `;
}

/** Returns false when this (invoice, reason, mirror) triple was already billed. */
async function writeLedger(
  tx: Tx,
  request: ConsumeRequest,
  bundleId: string | null,
  isParentMirror: boolean,
): Promise<boolean> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO usage_ledger (
      tenant_id, bundle_id, invoice_id, direction, reason, units, is_parent_mirror
    ) VALUES (
      ${request.tenantId}, ${bundleId}, ${request.invoiceId},
      ${request.direction}::invoice_direction, ${request.reason}, ${request.units},
      ${isParentMirror}
    )
    ON CONFLICT (invoice_id, reason, is_parent_mirror)
      WHERE invoice_id IS NOT NULL
      DO NOTHING
    RETURNING id
  `;
  return inserted.length > 0;
}

function remainingOf(bundle: BundleRow): number {
  return bundle.purchased_units - bundle.consumed_units;
}

function pctOf(consumed: number, purchased: number): number {
  return purchased === 0 ? 0 : (consumed / purchased) * 100;
}

/** §15: alerts at 80%, 90% and 100%, each fired once. */
function crossedThreshold(before: number, after: number, alreadyAlerted: number): number | null {
  for (const threshold of [100, 90, 80]) {
    if (after >= threshold && before < threshold && alreadyAlerted < threshold) {
      return threshold;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface FilingAllowance {
  allowed: boolean;
  reason: string | null;
  remaining: number | null;
}

/**
 * May this tenant file `units` more documents?
 *
 * A tenant with no bundle at all is allowed through: the platform is sold
 * prepaid, but an operator who has not yet loaded a bundle should not discover
 * that fact as a failed VAT filing on the last day of the period. The absence
 * shows on the balance screen and in the admin console instead.
 */
export async function checkFilingAllowance(
  tenantId: string,
  units = 1,
  tx?: Tx,
): Promise<FilingAllowance> {
  const run = async (t: Tx): Promise<FilingAllowance> => {
    const rows = await t<BundleRow[]>`
      SELECT * FROM data_bundles
      WHERE tenant_id = ${tenantId}
        AND valid_from <= CURRENT_DATE
        AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
        AND status IN ('ACTIVE', 'EXHAUSTED')
      ORDER BY expires_at NULLS LAST, created_at
    `;

    if (rows.length === 0) return { allowed: true, reason: null, remaining: null };

    const usable = rows.find(
      (b) => b.status === 'ACTIVE' && (b.allow_overage || remainingOf(b) >= units),
    );
    if (usable) return { allowed: true, reason: null, remaining: remainingOf(usable) };

    return {
      allowed: false,
      remaining: 0,
      reason:
        'Your prepaid data bundle is exhausted. Top it up, or ask your account manager to enable overage, before filing more documents.',
    };
  };

  return tx ? run(tx) : withPlatformAccess(run);
}

// ---------------------------------------------------------------------------
// Balance for the portal
// ---------------------------------------------------------------------------

export async function loadBalance(tenantId: string): Promise<BalanceResponse> {
  return withPlatformAccess(async (tx) => {
    const bundles = await tx.unsafe<BundleRow[]>(
      `SELECT ${BUNDLE_WITH_ALLOCATION}
       FROM data_bundles b WHERE b.tenant_id = $1
       ORDER BY b.created_at DESC`,
      [tenantId],
    );

    // The partner master pool this tenant also draws down, reached through any
    // one of its slices — they all point at the same parent.
    const parentId = bundles.find((b) => b.parent_bundle_id)?.parent_bundle_id ?? null;
    const parents = parentId
      ? await tx<BundleRow[]>`
          SELECT b.*, t.legal_name_en AS tenant_name
          FROM data_bundles b
          JOIN tenants t ON t.id = b.tenant_id
          WHERE b.id = ${parentId}
        `
      : [];

    const active = bundles.filter((b) => b.status === 'ACTIVE');
    const totalPurchased = bundles.reduce((sum, b) => sum + b.purchased_units, 0);
    const totalConsumed = bundles.reduce((sum, b) => sum + b.consumed_units, 0);
    const usedPct = active.length
      ? Math.max(...active.map((b) => pctOf(b.consumed_units, b.purchased_units)))
      : totalPurchased === 0
        ? 0
        : pctOf(totalConsumed, totalPurchased);

    const allowance = await checkFilingAllowance(tenantId, 1, tx);

    return {
      bundles: bundles.map(toBundleSummary),
      totalPurchased,
      totalConsumed,
      totalRemaining: totalPurchased - totalConsumed,
      usedPct: Math.round(usedPct * 10) / 10,
      parentPool: parents[0] ? toBundleSummary(parents[0]) : null,
      canFile: allowance.allowed,
      message:
        allowance.reason ??
        (bundles.length === 0
          ? 'No data bundle has been loaded for this account yet. Documents are recorded but not metered.'
          : null),
    };
  });
}

/**
 * §15 in one function: how many units a document costs.
 *
 * Drafts are free, technical rejections are free, and everything that actually
 * crossed the network costs one.
 */
export function unitsFor(reason: string): number {
  return reason === USAGE_REASONS.technicalRejection ? 0 : 1;
}
