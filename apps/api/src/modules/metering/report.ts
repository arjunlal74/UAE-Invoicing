import type { InventoryStatement, InventoryStatementRow } from '@uae/contracts';
import { config } from '../../config.js';
import type { Tx } from '../../db/client.js';
import { withPlatformAccess } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
import { toReportingPeriod, type ParsedPeriod } from './period.js';

/**
 * The data inventory statement — one row per movement, with a running balance.
 *
 * The same four columns at every tier of the v2.1 hierarchy, because it is the
 * same unit changing hands down a chain: the platform buys from an accredited
 * provider and sells bundles on, a channel partner buys those bundles and
 * allocates slices, a tenant buys or is allocated and then consumes by filing.
 * Only the words over the two middle columns change with the holder —
 *
 *   Platform            Opening | Buy       | Sell     | Balance
 *   Channel partner     Opening | Buy       | Allocated| Balance
 *   Direct tenant       Opening | Buy       | Consumed | Balance
 *   Managed sub-tenant  Opening | Allocated | Consumed | Balance
 *
 * — so one query shape and one table serve all four, and the four cannot drift
 * into disagreeing about what a balance is.
 *
 * Every figure is derived from the movements themselves. The opening balance is
 * everything before the window netted out rather than a stored total, for the
 * same reason the console computes its balances: a carried number is one that
 * can disagree with its own history.
 */

/** Movements shown at once. Beyond this the earliest fold into the opening. */
const MAX_ROWS = 500;

type HolderKind = InventoryStatement['holderKind'];

interface MovementRow {
  date: Date;
  reference: string | null;
  description: string | null;
  in_units: string | number;
  out_units: string | number;
}

/** The operator's own name, which is the counterparty on everything it sells. */
async function platformName(tx: Tx): Promise<string> {
  const rows = await tx<{ legal_name_en: string }[]>`
    SELECT legal_name_en FROM platform_company WHERE id
  `;
  return rows[0]?.legal_name_en?.trim() || config().PLATFORM_NAME;
}

/**
 * What a consumption row is called on a statement. The ledger records why units
 * were taken; a tenant reading a statement wants to know which document did it.
 */
const DOCUMENT_DESCRIPTION = `
  CASE
    WHEN i.invoice_type = 'CREDIT_NOTE' THEN 'Credit note'
    WHEN i.invoice_type = 'DEBIT_NOTE' THEN 'Debit note'
    WHEN u.direction = 'INBOUND_PURCHASE_AP' THEN 'Purchase bill'
    WHEN i.id IS NOT NULL THEN 'Invoice'
    ELSE u.reason
  END
`;

// ---------------------------------------------------------------------------
// The movements, per holder
// ---------------------------------------------------------------------------

/** Provider contracts in, bundles sold to tenants and partners out. */
async function platformMovements(tx: Tx, from: string | null, to: string | null) {
  return tx<MovementRow[]>`
    SELECT p.purchase_date AS date,
           p.contract_reference AS reference,
           v.name AS description,
           p.total_units AS in_units,
           0 AS out_units
    FROM asp_bundle_procurements p
    JOIN asp_providers v ON v.id = p.asp_provider_id
    WHERE (${from}::date IS NULL OR p.purchase_date >= ${from}::date)
      AND (${to}::date IS NULL OR p.purchase_date <= ${to}::date)
    UNION ALL
    -- The null parent is what makes a bundle a sale off the host's shelf: a
    -- partner's slice is carved from a pool the host already sold, and counting
    -- both would take the same unit off twice.
    SELECT b.valid_from AS date,
           b.reference,
           t.legal_name_en AS description,
           0 AS in_units,
           b.purchased_units AS out_units
    FROM data_bundles b
    JOIN tenants t ON t.id = b.tenant_id
    WHERE b.parent_bundle_id IS NULL
      AND (${from}::date IS NULL OR b.valid_from >= ${from}::date)
      AND (${to}::date IS NULL OR b.valid_from <= ${to}::date)
    ORDER BY 1, 2
  `;
}

/** Bundles bought from the platform, slices allocated to sub-tenants. */
async function partnerMovements(
  tx: Tx,
  tenantId: string,
  seller: string,
  from: string | null,
  to: string | null,
) {
  return tx<MovementRow[]>`
    SELECT b.valid_from AS date,
           b.reference,
           ${seller} AS description,
           b.purchased_units AS in_units,
           0 AS out_units
    FROM data_bundles b
    WHERE b.tenant_id = ${tenantId}
      AND b.parent_bundle_id IS NULL
      AND (${from}::date IS NULL OR b.valid_from >= ${from}::date)
      AND (${to}::date IS NULL OR b.valid_from <= ${to}::date)
    UNION ALL
    SELECT s.valid_from AS date,
           s.reference,
           t.legal_name_en AS description,
           0 AS in_units,
           s.purchased_units AS out_units
    FROM data_bundles s
    JOIN data_bundles m ON m.id = s.parent_bundle_id
    JOIN tenants t ON t.id = s.tenant_id
    WHERE m.tenant_id = ${tenantId}
      AND (${from}::date IS NULL OR s.valid_from >= ${from}::date)
      AND (${to}::date IS NULL OR s.valid_from <= ${to}::date)
    ORDER BY 1, 2
  `;
}

/**
 * What a filing tenant sees: bundles arriving — bought from the platform, or
 * allocated by its partner — and documents taking units back out.
 *
 * Only the tenant's own ledger rows. A partner mirror row is the same physical
 * invoice seen from the pool above it, and counting it here would charge the
 * tenant twice for one filing.
 */
async function tenantMovements(
  tx: Tx,
  tenantId: string,
  seller: string,
  from: string | null,
  to: string | null,
) {
  return tx.unsafe<MovementRow[]>(
    `
    SELECT b.valid_from AS date,
           b.reference,
           CASE WHEN b.parent_bundle_id IS NULL THEN $2
                ELSE (SELECT p.legal_name_en FROM data_bundles m
                      JOIN tenants p ON p.id = m.tenant_id
                      WHERE m.id = b.parent_bundle_id)
           END AS description,
           b.purchased_units AS in_units,
           0 AS out_units
    FROM data_bundles b
    WHERE b.tenant_id = $1
      AND ($3::date IS NULL OR b.valid_from >= $3::date)
      AND ($4::date IS NULL OR b.valid_from <= $4::date)
    UNION ALL
    SELECT u.created_at::date AS date,
           i.invoice_number AS reference,
           ${DOCUMENT_DESCRIPTION} AS description,
           0 AS in_units,
           u.units AS out_units
    FROM usage_ledger u
    LEFT JOIN invoices i ON i.id = u.invoice_id
    WHERE u.tenant_id = $1
      AND NOT u.is_parent_mirror
      AND ($3::date IS NULL OR u.created_at::date >= $3::date)
      AND ($4::date IS NULL OR u.created_at::date <= $4::date)
    ORDER BY 1, 2
    `,
    [tenantId, seller, from, to],
  );
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function toRows(
  movements: MovementRow[],
  openingUnits: number,
): { rows: InventoryStatementRow[]; omitted: number; opening: number } {
  // Oldest first, because a running balance only reads in one direction, and
  // within a day everything arriving is recorded before anything leaving: you
  // cannot allocate units that have not landed, and a statement that dips
  // negative for one line reads as an error rather than as a sorting artefact.
  const ordered = [...movements].sort((a, b) => {
    const byDate = a.date.getTime() - b.date.getTime();
    if (byDate !== 0) return byDate;
    const aOut = Number(a.in_units) > 0 ? 0 : 1;
    const bOut = Number(b.in_units) > 0 ? 0 : 1;
    if (aOut !== bOut) return aOut - bOut;
    return (a.reference ?? '').localeCompare(b.reference ?? '');
  });

  let opening = openingUnits;
  let omitted = 0;

  // Too many to show: the earliest fold into the opening balance rather than
  // being dropped, so the balance beside the first visible row is still true.
  if (ordered.length > MAX_ROWS) {
    const folded = ordered.splice(0, ordered.length - MAX_ROWS);
    omitted = folded.length;
    opening = folded.reduce(
      (balance, row) => balance + Number(row.in_units) - Number(row.out_units),
      opening,
    );
  }

  let balance = opening;
  const rows = ordered.map((row) => {
    const inUnits = Number(row.in_units);
    const outUnits = Number(row.out_units);
    const line: InventoryStatementRow = {
      date: row.date.toISOString().slice(0, 10),
      reference: row.reference ?? '—',
      description: row.description ?? '—',
      openingUnits: balance,
      inUnits,
      outUnits,
      balanceUnits: balance + inUnits - outUnits,
    };
    balance = line.balanceUnits;
    return line;
  });

  return { rows, omitted, opening };
}

function assemble(
  holderKind: HolderKind,
  holderName: string,
  period: ParsedPeriod,
  openingBefore: number,
  movements: MovementRow[],
): InventoryStatement {
  const { rows, omitted, opening } = toRows(movements, openingBefore);
  const totalIn = rows.reduce((sum, row) => sum + row.inUnits, 0);
  const totalOut = rows.reduce((sum, row) => sum + row.outUnits, 0);

  return {
    holderKind,
    holderName,
    // An open-ended window still prints a sentence with two ends on it, so the
    // statement says which day it was run for.
    period: { ...toReportingPeriod(period), to: period.to ?? new Date().toISOString().slice(0, 10) },
    openingUnits: opening,
    totalInUnits: totalIn,
    totalOutUnits: totalOut,
    closingUnits: opening + totalIn - totalOut,
    omittedRows: omitted,
    rows,
  };
}

/** Everything before the window, netted, without listing any of it. */
function openingOf(movements: MovementRow[]): number {
  return movements.reduce(
    (balance, row) => balance + Number(row.in_units) - Number(row.out_units),
    0,
  );
}

/** The platform's own statement. */
export async function loadPlatformStatement(period: ParsedPeriod): Promise<InventoryStatement> {
  return withPlatformAccess(async (tx) => {
    const name = await platformName(tx);
    const before = period.from ? await platformMovements(tx, null, priorDay(period.from)) : [];
    const inside = await platformMovements(tx, period.from, period.to);
    return assemble('PLATFORM', name, period, openingOf(before), inside);
  });
}

/**
 * One tenant's statement, at whichever tier it sits.
 *
 * Read through `withPlatformAccess` because the movements span the tenant and
 * the pool above it — a sub-tenant's slice belongs to its partner's bundle —
 * so the tenant filter here is what replaces row-level security and is not
 * optional. Every caller has already established that this tenant is theirs
 * to read.
 */
export async function loadTenantStatement(
  tenantId: string,
  period: ParsedPeriod,
): Promise<InventoryStatement> {
  return withPlatformAccess(async (tx) => {
    const rows = await tx<{ legal_name_en: string; tenant_type: string }[]>`
      SELECT legal_name_en, tenant_type::text AS tenant_type FROM tenants WHERE id = ${tenantId}
    `;
    const tenant = rows[0];
    if (!tenant) throw notFound('Tenant');

    const seller = await platformName(tx);
    const partner = tenant.tenant_type === 'CHANNEL_PARTNER';
    // A HOST tenant row is the operator's own filing entity, which buys and
    // consumes like any direct tenant; only the reseller tier reads differently.
    const kind: HolderKind =
      partner || tenant.tenant_type === 'MANAGED_SUB_TENANT'
        ? (tenant.tenant_type as HolderKind)
        : 'ENTERPRISE_TENANT';
    const movements = (from: string | null, to: string | null) =>
      partner
        ? partnerMovements(tx, tenantId, seller, from, to)
        : tenantMovements(tx, tenantId, seller, from, to);

    const before = period.from ? await movements(null, priorDay(period.from)) : [];
    const inside = await movements(period.from, period.to);

    return assemble(
      kind,
      tenant.legal_name_en,
      period,
      openingOf(before),
      inside,
    );
  });
}

/** The day before the window opens — the last day the opening balance covers. */
function priorDay(from: string): string {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
