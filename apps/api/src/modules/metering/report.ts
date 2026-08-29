import type { InventoryLedgerRow, InventoryReport } from '@uae/contracts';
import { withPlatformAccess } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
import { toReportingPeriod, type ParsedPeriod } from './period.js';

/**
 * The data inventory report — units in, units out, over a window.
 *
 * Not a consumption report. Consumption is what tenants file and it is already
 * counted on the console; this is the stock ledger behind it: what was bought,
 * what was sold on, and what the movement leaves on the shelf. The two answer
 * different questions and one is no substitute for the other — a quarter can be
 * heavy on filing and empty of purchases, or the reverse.
 *
 * One shape serves two holders, because the platform and a channel partner are
 * the same business twice over. The host buys from an accredited provider and
 * sells bundles to tenants and partners; a partner buys those bundles from the
 * host and sells slices to its own sub-tenants. Only the counterparties differ,
 * so a single report and a single page cover both — which is also what keeps
 * the host's view of a partner and the partner's own view from drifting apart.
 *
 * The opening balance is every movement before the window rather than a stored
 * figure, for the same reason the console computes its balances: a carried
 * total is a number that can disagree with its own history.
 */

interface LedgerRow {
  date: Date;
  reference: string;
  counterparty: string;
  counterparty_detail: string | null;
  units: number;
  cost_per_unit_aed: string | null;
  total_cost_aed: string | null;
}

function toLedgerRow(row: LedgerRow): InventoryLedgerRow {
  return {
    date: row.date.toISOString().slice(0, 10),
    reference: row.reference,
    counterparty: row.counterparty,
    counterpartyDetail: row.counterparty_detail,
    units: Number(row.units),
    costPerUnitAed: row.cost_per_unit_aed,
    totalCostAed: row.total_cost_aed,
  };
}

function sum(rows: InventoryLedgerRow[], field: 'units'): number {
  return rows.reduce((total, row) => total + row[field], 0);
}

function spend(rows: InventoryLedgerRow[]): string | null {
  // Null rather than zero when nothing on the buy side carries a price: the
  // host does not record what a partner charged for a slice, and "AED 0.00"
  // would state a fact nobody entered.
  if (!rows.some((row) => row.totalCostAed !== null)) return null;
  return rows.reduce((total, row) => total + Number(row.totalCostAed ?? 0), 0).toFixed(2);
}

/** The platform's own ledger: provider contracts in, tenant and partner bundles out. */
export async function loadPlatformReport(period: ParsedPeriod): Promise<InventoryReport> {
  return withPlatformAccess(async (tx) => {
    const purchases = await tx<LedgerRow[]>`
      SELECT p.purchase_date AS date,
             p.contract_reference AS reference,
             v.name AS counterparty,
             v.accreditation_reference AS counterparty_detail,
             p.total_units AS units,
             p.cost_per_unit_aed::text AS cost_per_unit_aed,
             p.total_cost_aed::text AS total_cost_aed
      FROM asp_bundle_procurements p
      JOIN asp_providers v ON v.id = p.asp_provider_id
      WHERE (${period.from}::date IS NULL OR p.purchase_date >= ${period.from}::date)
        AND (${period.to}::date IS NULL OR p.purchase_date <= ${period.to}::date)
      ORDER BY p.purchase_date DESC, p.created_at DESC
    `;

    // The null parent is what makes a bundle a sale off the host's shelf: a
    // partner's slice is carved from a master pool the host already sold, and
    // counting both would take the same unit off twice.
    const sales = await tx<LedgerRow[]>`
      SELECT b.valid_from AS date,
             b.reference,
             t.legal_name_en AS counterparty,
             t.tenant_type::text AS counterparty_detail,
             b.purchased_units AS units,
             NULL::text AS cost_per_unit_aed,
             NULL::text AS total_cost_aed
      FROM data_bundles b
      JOIN tenants t ON t.id = b.tenant_id
      WHERE b.parent_bundle_id IS NULL
        AND (${period.from}::date IS NULL OR b.valid_from >= ${period.from}::date)
        AND (${period.to}::date IS NULL OR b.valid_from <= ${period.to}::date)
      ORDER BY b.valid_from DESC, b.created_at DESC
    `;

    const opening = await tx<{ bought: string; sold: string }[]>`
      SELECT
        (SELECT coalesce(sum(total_units), 0) FROM asp_bundle_procurements
          WHERE ${period.from}::date IS NOT NULL
            AND purchase_date < ${period.from}::date)::text AS bought,
        (SELECT coalesce(sum(purchased_units), 0) FROM data_bundles
          WHERE parent_bundle_id IS NULL
            AND ${period.from}::date IS NOT NULL
            AND valid_from < ${period.from}::date)::text AS sold
    `;

    return assemble('PLATFORM', 'This platform', period, opening[0]!, purchases, sales);
  });
}

/**
 * A channel partner's ledger: master pools bought from the host, sub-tenant
 * slices sold on. Read through `withPlatformAccess` for the same reason the
 * partner routes are — row-level security scopes a connection to one tenant,
 * and a partner legitimately spans its whole book — so the parent filter below
 * is what replaces it and is not optional.
 */
export async function loadPartnerReport(
  tenantId: string,
  period: ParsedPeriod,
): Promise<InventoryReport> {
  return withPlatformAccess(async (tx) => {
    const partner = await tx<{ legal_name_en: string; tenant_type: string }[]>`
      SELECT legal_name_en, tenant_type::text FROM tenants WHERE id = ${tenantId}
    `;
    const row = partner[0];
    if (!row) throw notFound('Partner');
    if (row.tenant_type !== 'CHANNEL_PARTNER') {
      // Every other tier buys and consumes; only a partner resells, so only a
      // partner has two sides to report on.
      throw notFound('Channel partner');
    }

    const purchases = await tx<LedgerRow[]>`
      SELECT b.valid_from AS date,
             b.reference,
             'This platform' AS counterparty,
             (SELECT p.contract_reference FROM asp_bundle_procurements p
               WHERE p.id = b.asp_procurement_id) AS counterparty_detail,
             b.purchased_units AS units,
             NULL::text AS cost_per_unit_aed,
             NULL::text AS total_cost_aed
      FROM data_bundles b
      WHERE b.tenant_id = ${tenantId}
        AND b.parent_bundle_id IS NULL
        AND (${period.from}::date IS NULL OR b.valid_from >= ${period.from}::date)
        AND (${period.to}::date IS NULL OR b.valid_from <= ${period.to}::date)
      ORDER BY b.valid_from DESC, b.created_at DESC
    `;

    const sales = await tx<LedgerRow[]>`
      SELECT b.valid_from AS date,
             b.reference,
             t.legal_name_en AS counterparty,
             m.reference AS counterparty_detail,
             b.purchased_units AS units,
             NULL::text AS cost_per_unit_aed,
             NULL::text AS total_cost_aed
      FROM data_bundles b
      JOIN data_bundles m ON m.id = b.parent_bundle_id
      JOIN tenants t ON t.id = b.tenant_id
      WHERE m.tenant_id = ${tenantId}
        AND (${period.from}::date IS NULL OR b.valid_from >= ${period.from}::date)
        AND (${period.to}::date IS NULL OR b.valid_from <= ${period.to}::date)
      ORDER BY b.valid_from DESC, b.created_at DESC
    `;

    const opening = await tx<{ bought: string; sold: string }[]>`
      SELECT
        (SELECT coalesce(sum(purchased_units), 0) FROM data_bundles
          WHERE tenant_id = ${tenantId} AND parent_bundle_id IS NULL
            AND ${period.from}::date IS NOT NULL
            AND valid_from < ${period.from}::date)::text AS bought,
        (SELECT coalesce(sum(b.purchased_units), 0) FROM data_bundles b
          JOIN data_bundles m ON m.id = b.parent_bundle_id
          WHERE m.tenant_id = ${tenantId}
            AND ${period.from}::date IS NOT NULL
            AND b.valid_from < ${period.from}::date)::text AS sold
    `;

    return assemble('PARTNER', row.legal_name_en, period, opening[0]!, purchases, sales);
  });
}

function assemble(
  scope: 'PLATFORM' | 'PARTNER',
  holderName: string,
  period: ParsedPeriod,
  opening: { bought: string; sold: string },
  purchaseRows: LedgerRow[],
  saleRows: LedgerRow[],
): InventoryReport {
  const purchases = purchaseRows.map(toLedgerRow);
  const sales = saleRows.map(toLedgerRow);
  const openingUnits = Number(opening.bought) - Number(opening.sold);
  const purchasedUnits = sum(purchases, 'units');
  const soldUnits = sum(sales, 'units');

  return {
    scope,
    holderName,
    period: toReportingPeriod(period),
    openingUnits,
    purchasedUnits,
    purchasedCostAed: spend(purchases),
    soldUnits,
    closingUnits: openingUnits + purchasedUnits - soldUnits,
    purchases,
    sales,
  };
}
