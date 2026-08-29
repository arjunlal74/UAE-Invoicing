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
// The accredited provider master
// ---------------------------------------------------------------------------

export const CreateProviderRequest = z.object({
  name: z.string().trim().min(2).max(120),
  /** The provider's entry on the MoF's published accreditation list. */
  accreditationReference: z.string().trim().max(100).nullable().optional(),
  contactName: z.string().trim().max(150).nullable().optional(),
  contactEmail: z.string().trim().email().max(255).nullable().optional(),
  contactPhone: z.string().trim().max(50).nullable().optional(),
  website: z.string().trim().max(255).nullable().optional(),
  /** Pre-fills the rate on a new contract; the contract's own rate governs. */
  defaultCostPerUnitAed: z.number().min(0).max(10_000).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type CreateProviderRequest = z.infer<typeof CreateProviderRequest>;

/** Everything is editable, including retirement — nothing is ever deleted. */
export const UpdateProviderRequest = CreateProviderRequest.partial().extend({
  isActive: z.boolean().optional(),
  /**
   * Independent of retirement: this one freezes the record's own details. While
   * it is set the server refuses every other field, so an unlock is the only
   * edit a locked provider accepts.
   */
  isLocked: z.boolean().optional(),
});
export type UpdateProviderRequest = z.infer<typeof UpdateProviderRequest>;

export const ProviderSummary = z.object({
  id: uuid,
  name: z.string(),
  accreditationReference: z.string().nullable(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  website: z.string().nullable(),
  defaultCostPerUnitAed: z.string().nullable(),
  isActive: z.boolean(),
  /** Frozen against edits. Says nothing about whether they can be bought from. */
  isLocked: z.boolean(),
  notes: z.string().nullable(),
  /**
   * What has been bought from them **within the period being reported on**,
   * not since the beginning. A lifetime figure only ever grows, so by the
   * second year it says nothing about whether this provider is still being used
   * or what a renewal ought to cost.
   */
  contractCount: z.number(),
  totalUnitsPurchased: z.number(),
  totalSpendAed: z.string(),
  /**
   * Contracts on file at any date. Kept beside the period figures because
   * "0 contracts this quarter" and "0 contracts ever" are different facts, and
   * only one of them makes a provider safe to retire.
   */
  lifetimeContractCount: z.number(),
  /**
   * The most recent contract on file and the rate it was struck at, whenever
   * they fall — unscoped, like the lifetime count above. A period total says
   * what a provider has supplied; these say what they last charged, which is
   * the figure a renewal is argued from.
   */
  lastPurchaseDate: z.string().nullable(),
  lastCostPerUnitAed: z.string().nullable(),
  createdAt: z.string(),
});
export type ProviderSummary = z.infer<typeof ProviderSummary>;

// ---------------------------------------------------------------------------
// §15.1 Wholesale procurement
// ---------------------------------------------------------------------------

export const CreateProcurementRequest = z.object({
  /** A row in the provider master, not a typed-in name. */
  aspProviderId: uuid,
  /** The provider's own contract number. Unique, because it identifies the buy. */
  contractReference: z.string().trim().min(2).max(100),
  totalUnits: z.number().int().min(1).max(1_000_000_000),
  /**
   * What the provider actually invoiced, and the authoritative figure.
   *
   * A wholesale contract is quoted as a lump sum — "1,000,000 units for AED
   * 85,000" — and the per-unit rate is a derivation from it. Storing the rate as
   * the source of truth and multiplying back would lose money on any unit count
   * that does not divide evenly: 999,999 units at a rate rounded to 0.0850 comes
   * back as AED 84,999.92, and the platform's cost reporting would then disagree
   * with the provider's own invoice.
   */
  totalCostAed: z.number().min(0).max(1_000_000_000),
  /**
   * Optional, and only a cross-check. The stored rate is derived from the total;
   * sending one that disagrees is refused rather than silently resolved, because
   * a mismatch means the two numbers came from different places.
   */
  costPerUnitAed: z.number().min(0).max(10_000).optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type CreateProcurementRequest = z.infer<typeof CreateProcurementRequest>;

export const ProcurementSummary = z.object({
  id: uuid,
  aspProviderId: uuid,
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

/**
 * The window the per-provider roll-up covers.
 *
 * Only that roll-up takes one. The console's own figures are balances — what is
 * on the shelf today is every purchase ever made minus every sale ever made —
 * and scoping those to a quarter would produce a number that looks like a
 * balance and is not one. What does need a window is the provider table, whose
 * contracts, units and spend would otherwise only ever grow.
 */
export const ReportingPeriod = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  label: z.string(),
});
export type ReportingPeriod = z.infer<typeof ReportingPeriod>;

// ---------------------------------------------------------------------------
// The data inventory report: units in, units out, over a window
// ---------------------------------------------------------------------------

/**
 * One movement, either direction. Deliberately generic: the platform buying
 * from a provider and a channel partner carving a slice for a sub-tenant are
 * the same event seen from two levels of the same chain, and one shape lets one
 * report and one page serve both.
 */
export const InventoryLedgerRow = z.object({
  date: z.string(),
  reference: z.string(),
  counterparty: z.string(),
  /** Whatever identifies the other side a second time: an accreditation
   *  reference, the tier of the buyer, the contract a slice came out of. */
  counterpartyDetail: z.string().nullable(),
  units: z.number(),
  /** Only the host's own purchases carry money; nothing records what a partner
   *  charged a sub-tenant, and a zero there would state a fact nobody entered. */
  costPerUnitAed: z.string().nullable(),
  totalCostAed: z.string().nullable(),
});
export type InventoryLedgerRow = z.infer<typeof InventoryLedgerRow>;

export const InventoryReport = z.object({
  scope: z.enum(['PLATFORM', 'PARTNER']),
  /** Whose shelf this is. */
  holderName: z.string(),
  period: ReportingPeriod,
  /** Every movement before the window, netted. Computed, never carried. */
  openingUnits: z.number(),
  purchasedUnits: z.number(),
  purchasedCostAed: z.string().nullable(),
  soldUnits: z.number(),
  /** opening + purchased − sold. What the window leaves on the shelf. */
  closingUnits: z.number(),
  purchases: z.array(InventoryLedgerRow),
  sales: z.array(InventoryLedgerRow),
});
export type InventoryReport = z.infer<typeof InventoryReport>;

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
