import { z } from 'zod';
import { TenantType } from './enums.js';

/**
 * The multi-tier data bundle inventory lifecycle — SRS v2.8 §15.
 *
 * v2.7 modelled the retail half: a tenant holds a bundle and filing an invoice
 * draws it down. What it never modelled is where the host's units come from,
 * which meant the platform could sell what it had never bought. These are the
 * shapes for the wholesale half — procurement in, stock on the shelf, and the
 * floor each tier must not fall below.
 */

const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// §15.1 Wholesale procurement
// ---------------------------------------------------------------------------

export const CreateProcurementRequest = z.object({
  aspProviderName: z.string().trim().min(2).max(100),
  /** The provider's own contract number. Unique, because it identifies the buy. */
  contractReference: z.string().trim().min(2).max(100),
  totalUnits: z.number().int().min(1).max(1_000_000_000),
  /**
   * Quoted in fils per unit on real wholesale contracts, so four decimals —
   * rounding to two loses real money across a million-unit purchase.
   */
  costPerUnitAed: z.number().min(0).max(10_000),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type CreateProcurementRequest = z.infer<typeof CreateProcurementRequest>;

export const ProcurementSummary = z.object({
  id: uuid,
  aspProviderName: z.string(),
  contractReference: z.string(),
  totalUnits: z.number(),
  costPerUnitAed: z.string(),
  totalCostAed: z.string(),
  purchaseDate: z.string(),
  expiryDate: z.string().nullable(),
  /** How much of this contract has been sold on to tenants and partners. */
  allocatedUnits: z.number(),
  remainingUnits: z.number(),
  notes: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});
export type ProcurementSummary = z.infer<typeof ProcurementSummary>;

// ---------------------------------------------------------------------------
// §15.1 / §15.2 the host's position
// ---------------------------------------------------------------------------

export const HostInventorySummary = z.object({
  /** Every unit bought from a provider on a contract that has not lapsed. */
  totalProcuredUnits: z.number(),
  /** Sold to direct tenants, or allocated as a channel partner master pool. */
  totalSoldUnits: z.number(),
  /** Opening + purchases − sales. What is left to sell. */
  currentStockUnits: z.number(),
  /** Consumed anywhere downstream, counted once rather than per tier. */
  totalConsumedUnits: z.number(),
  /** Procured − consumed. The operational buffer §15.1 calls the net balance. */
  netAvailableUnits: z.number(),
  minimumBufferUnits: z.number(),
  belowBuffer: z.boolean(),
  dailyRunRate: z.number(),
  /** Null when nothing has been consumed lately — "unknown", not "forever". */
  daysRemaining: z.number().nullable(),
  totalCostAed: z.string(),
});
export type HostInventorySummary = z.infer<typeof HostInventorySummary>;

/** One row of the §15.5 tier table, as the console draws it. */
export const InventoryTierRow = z.object({
  tenantId: uuid.nullable(),
  tenantName: z.string(),
  tier: TenantType,
  bundleId: uuid.nullable(),
  purchasedUnits: z.number(),
  consumedUnits: z.number(),
  /** For a partner: what it has carved out to sub-tenants (§15.4). */
  allocatedUnits: z.number(),
  availableUnits: z.number(),
  minimumBufferUnits: z.number(),
  belowBuffer: z.boolean(),
  dailyRunRate: z.number(),
  daysRemaining: z.number().nullable(),
});
export type InventoryTierRow = z.infer<typeof InventoryTierRow>;

export const InventoryConsole = z.object({
  host: HostInventorySummary,
  procurements: z.array(ProcurementSummary),
  tiers: z.array(InventoryTierRow),
});
export type InventoryConsole = z.infer<typeof InventoryConsole>;

// ---------------------------------------------------------------------------
// §15.3 / §15.5 the floor
// ---------------------------------------------------------------------------

export const SetBufferRequest = z.object({
  /**
   * An absolute number of units, not a percentage. A tenant filing four
   * thousand invoices a month does not care that 80% of a bundle is gone; it
   * cares that fewer than two thousand units remain, because that is a week.
   * Zero switches the floor alert off for the account.
   */
  minimumBufferUnits: z.number().int().min(0).max(100_000_000),
});
export type SetBufferRequest = z.infer<typeof SetBufferRequest>;

export const InventoryAlertItem = z.object({
  id: uuid,
  tenantId: uuid.nullable(),
  tenantName: z.string().nullable(),
  alertTier: TenantType,
  thresholdUnits: z.number(),
  unitsRemaining: z.number(),
  severity: z.enum(['WARNING', 'CRITICAL']),
  dailyRunRate: z.number().nullable(),
  notificationDispatched: z.boolean(),
  dispatchedAt: z.string(),
});
export type InventoryAlertItem = z.infer<typeof InventoryAlertItem>;
