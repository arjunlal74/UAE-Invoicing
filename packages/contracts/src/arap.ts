import { z } from 'zod';
import {
  ApPostingStatus,
  BundleStatus,
  InvoiceDirection,
  InvoiceStatus,
  PartyType,
  RejectionReasonCode,
  ResponseStatusCode,
  ReversalMode,
} from './enums.js';
import { StagedInvoiceDto, StagedLineDto, emirate, trn, uuid } from './schemas.js';

/**
 * Contracts for the two v2.7 modules.
 *
 * Kept out of `schemas.ts` because that file is already the whole of v2.1–v2.3
 * and these are a coherent block on their own: the two master directories, the
 * in-app builders, the Peppol response engine that connects them, and the
 * metering that bills for the traffic.
 */

// ===========================================================================
// §6 Customer Master Directory (AR)
// ===========================================================================

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().nullable().transform((v) => v || null);

export const UpsertCustomerRequest = z
  .object({
    customerCode: optionalText(50),
    customerNameEn: z.string().trim().min(1).max(255),
    customerNameAr: optionalText(255),
    customerType: PartyType.default('B2B'),
    trn: trn.nullable().optional(),
    emirate,
    streetAddress: z.string().trim().max(500).default(''),
    building: optionalText(255),
    postalCode: optionalText(20),
    contactName: optionalText(150),
    contactEmail: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal('')),
    contactPhone: optionalText(50),
    defaultPaymentMeans: optionalText(5),
    notes: optionalText(2000),
    isActive: z.boolean().default(true),
  })
  // §6: the TRN is what makes a buyer a B2B party, and it is what the 380
  // document type requires. Without it the invoice can only ever be a 388, so
  // the two fields are validated together rather than independently.
  .refine((v) => v.customerType !== 'B2B' || !!v.trn, {
    message: 'A B2B customer must have a 15-digit TRN',
    path: ['trn'],
  });
export type UpsertCustomerRequest = z.infer<typeof UpsertCustomerRequest>;

export const CustomerSummary = z.object({
  id: uuid,
  customerCode: z.string().nullable(),
  customerNameEn: z.string(),
  customerNameAr: z.string().nullable(),
  customerType: PartyType,
  trn: z.string().nullable(),
  emirate: z.string(),
  streetAddress: z.string(),
  building: z.string().nullable(),
  postalCode: z.string().nullable(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  defaultPaymentMeans: z.string().nullable(),
  notes: z.string().nullable(),
  isActive: z.boolean(),
  /** Rolled up so the directory list can show who actually trades with us. */
  invoiceCount: z.number(),
  openDisputes: z.number(),
  createdAt: z.string(),
});
export type CustomerSummary = z.infer<typeof CustomerSummary>;

// ===========================================================================
// §12.1 Supplier Master Directory (AP)
// ===========================================================================

export const UpsertSupplierRequest = z.object({
  supplierCode: optionalText(50),
  supplierNameEn: z.string().trim().min(1).max(255),
  supplierNameAr: optionalText(255),
  trn: trn.nullable().optional(),
  emirate,
  streetAddress: z.string().trim().max(500).default(''),
  postalCode: optionalText(20),
  bankName: optionalText(150),
  bankIban: optionalText(34),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  contactName: optionalText(150),
  contactEmail: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal('')),
  contactPhone: optionalText(50),
  notes: optionalText(2000),
  isActive: z.boolean().default(true),
});
export type UpsertSupplierRequest = z.infer<typeof UpsertSupplierRequest>;

export const SupplierSummary = z.object({
  id: uuid,
  supplierCode: z.string().nullable(),
  supplierNameEn: z.string(),
  supplierNameAr: z.string().nullable(),
  trn: z.string().nullable(),
  emirate: z.string(),
  streetAddress: z.string(),
  postalCode: z.string().nullable(),
  bankName: z.string().nullable(),
  bankIban: z.string().nullable(),
  paymentTermsDays: z.number(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  notes: z.string().nullable(),
  /** §12.1 "New Supplier Detected": auto-created and not yet vetted. */
  isProvisional: z.boolean(),
  isActive: z.boolean(),
  invoiceCount: z.number(),
  /** §13.2 report 2 feeds off these two. */
  rejectedCount: z.number(),
  createdAt: z.string(),
});
export type SupplierSummary = z.infer<typeof SupplierSummary>;

export const DirectorySearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  includeInactive: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type DirectorySearchQuery = z.infer<typeof DirectorySearchQuery>;

// ===========================================================================
// §7 In-App Web Invoice Builder
// ===========================================================================

/**
 * A document being composed in the browser.
 *
 * The payload is the same `StagedInvoice` the Excel path produces, so one
 * validator, one calculator and one XML builder serve all three ingestion
 * channels. What the builder adds on top is the directory link and — for a
 * credit note — the reversal metadata that has no place in a spreadsheet row.
 */
export const SaveDraftRequest = z.object({
  /** Omitted when creating; supplied when saving an existing draft. */
  id: uuid.optional(),
  customerId: uuid.nullable().optional(),
  invoice: StagedInvoiceDto,
  /** Present only for a 381. */
  creditNote: z
    .object({
      referencedInvoiceId: uuid,
      reversalMode: ReversalMode,
      reasonCode: RejectionReasonCode,
      notes: z.string().trim().max(2000).optional().nullable(),
    })
    .optional(),
});
export type SaveDraftRequest = z.infer<typeof SaveDraftRequest>;

export const DraftResponse = z.object({
  id: uuid,
  invoice: StagedInvoiceDto,
  customerId: uuid.nullable(),
  status: InvoiceStatus,
  findings: z.array(
    z.object({
      ruleCode: z.string(),
      severity: z.string(),
      message: z.string(),
      field: z.string(),
      lineId: z.string().optional(),
    }),
  ),
  submittable: z.boolean(),
  creditNote: z
    .object({
      referencedInvoiceId: uuid.nullable(),
      referencedInvoiceNumber: z.string().nullable(),
      referencedFtaIrn: z.string().nullable(),
      reversalMode: ReversalMode.nullable(),
      reasonCode: RejectionReasonCode.nullable(),
      notes: z.string().nullable(),
    })
    .nullable(),
});
export type DraftResponse = z.infer<typeof DraftResponse>;

/** The next number in the tenant's own series, offered by the builder. */
export const NextNumberResponse = z.object({
  invoiceNumber: z.string(),
});
export type NextNumberResponse = z.infer<typeof NextNumberResponse>;

// ===========================================================================
// §8 In-App Web Credit Note Builder
// ===========================================================================

/**
 * §8.2 feature 1 — "1-Click Launch from Dispute Alerts".
 *
 * The server does the population rather than the browser: the original line
 * items, the preceding IRN and the buyer's dispute comment all live here, and
 * having the client re-assemble them from three separate reads would be three
 * chances to produce a credit note that does not actually match the invoice it
 * claims to reverse.
 */
export const PrepareCreditNoteRequest = z.object({
  referencedInvoiceId: uuid,
  reversalMode: ReversalMode.default('FULL_CANCELLATION'),
  /** Defaults to the dispute's own reason code when the invoice has one. */
  reasonCode: RejectionReasonCode.optional(),
});
export type PrepareCreditNoteRequest = z.infer<typeof PrepareCreditNoteRequest>;

export const CreditNotePreparation = z.object({
  invoice: StagedInvoiceDto,
  referenced: z.object({
    id: uuid,
    invoiceNumber: z.string(),
    issueDate: z.string(),
    ftaIrn: z.string().nullable(),
    payableAmount: z.string(),
    currencyCode: z.string(),
    status: InvoiceStatus,
    disputeReasonCode: RejectionReasonCode.nullable(),
    disputeComment: z.string().nullable(),
    /** Lines as filed, so the grid can show "original" beside "adjusted". */
    lines: z.array(StagedLineDto),
  }),
  reversalMode: ReversalMode,
  reasonCode: RejectionReasonCode,
});
export type CreditNotePreparation = z.infer<typeof CreditNotePreparation>;

// ===========================================================================
// §11 Disputes (AR) and §12.3 verification decisions (AP)
// ===========================================================================

/** The AP desk's verdict on one incoming purchase invoice (§12.3). */
export const ApDecisionRequest = z
  .object({
    invoiceIds: z.array(uuid).min(1).max(500),
    responseCode: z.enum(['AP', 'UQ', 'RE']),
    /** Required for RE, meaningless for AP. */
    reasonCode: RejectionReasonCode.optional(),
    /**
     * §12.3: a technical rejection is about the document (bad XML, wrong TRN);
     * a commercial one is about the trade. They are billed differently under
     * §15, so the clerk states which they mean rather than it being inferred.
     */
    isTechnical: z.boolean().default(false),
    comments: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.responseCode !== 'RE' || !!v.reasonCode, {
    message: 'A rejection must carry a reason code',
    path: ['reasonCode'],
  })
  .refine((v) => v.responseCode === 'AP' || !!v.comments, {
    message: 'Tell the supplier what the problem is',
    path: ['comments'],
  });
export type ApDecisionRequest = z.infer<typeof ApDecisionRequest>;

export const ApDecisionResponse = z.object({
  affected: z.number(),
  skipped: z.number(),
  reasons: z.array(z.object({ invoiceId: uuid, reason: z.string() })),
});
export type ApDecisionResponse = z.infer<typeof ApDecisionResponse>;

/** Manual PO / GRN linkage from the verification pane. */
export const MatchPurchaseRequest = z.object({
  poReference: z.string().trim().max(100).nullable().optional(),
  grnReference: z.string().trim().max(100).nullable().optional(),
  supplierId: uuid.nullable().optional(),
});
export type MatchPurchaseRequest = z.infer<typeof MatchPurchaseRequest>;

/** Simulated inbound reception, used by the AP desk's "receive XML" control. */
export const ReceivePurchaseInvoiceRequest = z.object({
  /** A complete UBL 2.1 Invoice document as delivered by the ASP. */
  ublXml: z.string().min(1),
  ftaIrn: z.string().trim().max(255).optional(),
});
export type ReceivePurchaseInvoiceRequest = z.infer<typeof ReceivePurchaseInvoiceRequest>;

// ===========================================================================
// Unified list item, used by both desks
// ===========================================================================

export const DocumentListItem = z.object({
  id: uuid,
  direction: InvoiceDirection,
  invoiceNumber: z.string(),
  invoiceType: z.string(),
  issueDate: z.string(),
  /** The other party: buyer for AR, supplier for AP. */
  counterpartyName: z.string(),
  counterpartyTrn: z.string().nullable(),
  currencyCode: z.string(),
  payableAmount: z.string(),
  payableAmountAed: z.string(),
  status: InvoiceStatus,
  ftaIrn: z.string().nullable(),
  poReference: z.string().nullable(),
  grnReference: z.string().nullable(),
  apPostingStatus: ApPostingStatus,
  latestResponseCode: ResponseStatusCode.nullable(),
  latestResponseReasonCode: RejectionReasonCode.nullable(),
  isCommercialDispute: z.boolean(),
  disputeResolved: z.boolean(),
  disputeOpenedAt: z.string().nullable(),
  disputeResolvedAt: z.string().nullable(),
  correctiveCreditNoteId: uuid.nullable(),
  supplierIsProvisional: z.boolean(),
  createdAt: z.string(),
});
export type DocumentListItem = z.infer<typeof DocumentListItem>;

export const DocumentSearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: InvoiceStatus.optional(),
  type: z.string().optional(),
  responseCode: ResponseStatusCode.optional(),
  reasonCode: RejectionReasonCode.optional(),
  /** AP only: 'unmatched' shows bills with no purchase order attached. */
  match: z.enum(['matched', 'unmatched']).optional(),
  disputes: z.enum(['open', 'resolved']).optional(),
  supplierId: uuid.optional(),
  customerId: uuid.optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type DocumentSearchQuery = z.infer<typeof DocumentSearchQuery>;

// ===========================================================================
// §13 Analytics and reports
// ===========================================================================

export const DisputeAnalytics = z.object({
  /** §13.1 KPI tiles. */
  kpis: z.object({
    outboundTotal: z.number(),
    outboundDisputed: z.number(),
    salesDisputeRatePct: z.number(),
    inboundTotal: z.number(),
    inboundRejected: z.number(),
    purchaseDisputeRatePct: z.number(),
    inputVatClaimableAed: z.string(),
    inputVatBlockedAed: z.string(),
    /** Mean time to resolution, in days. Null when nothing has resolved yet. */
    averageResolutionDays: z.number().nullable(),
    openDisputes: z.number(),
    unresolvedOver30Days: z.number(),
  }),
  /** §13.2 report 4 — outbound dispute aging. */
  aging: z.array(
    z.object({ bucket: z.string(), count: z.number(), amountAed: z.string() }),
  ),
  /** §13.2 report 5 — Pareto by reason code, both directions. */
  pareto: z.array(
    z.object({
      reasonCode: RejectionReasonCode,
      outbound: z.number(),
      inbound: z.number(),
      total: z.number(),
      cumulativePct: z.number(),
    }),
  ),
  /** §13.2 report 2 — supplier scorecard. */
  supplierScorecard: z.array(
    z.object({
      supplierId: uuid.nullable(),
      supplierName: z.string(),
      trn: z.string().nullable(),
      received: z.number(),
      rejected: z.number(),
      queried: z.number(),
      rejectionRatePct: z.number(),
      topReason: RejectionReasonCode.nullable(),
    }),
  ),
  /** §13.2 report 6 — cleared documents disputed and never credited. */
  nonCompliance: z.array(
    z.object({
      invoiceId: uuid,
      invoiceNumber: z.string(),
      counterpartyName: z.string(),
      disputeOpenedAt: z.string().nullable(),
      daysOpen: z.number(),
      reasonCode: RejectionReasonCode.nullable(),
      amountAed: z.string(),
    }),
  ),
});
export type DisputeAnalytics = z.infer<typeof DisputeAnalytics>;

export const ReportKey = z.enum([
  'ap-inbound-log',
  'supplier-scorecard',
  'input-tax-reconciliation',
  'ar-dispute-aging',
  'rejection-pareto',
  'fta-non-compliance',
]);
export type ReportKey = z.infer<typeof ReportKey>;

export const REPORT_CATALOG: {
  key: ReportKey;
  name: string;
  module: 'AR' | 'AP' | 'BOTH';
  description: string;
}[] = [
  {
    key: 'ap-inbound-log',
    name: 'Purchase inbound AP log',
    module: 'AP',
    description:
      'Every incoming supplier invoice with its FTA IRN, PO matching state and AP posting status.',
  },
  {
    key: 'supplier-scorecard',
    name: 'Supplier dispute scorecard',
    module: 'AP',
    description: 'Suppliers ranked by how often their invoices are queried or rejected.',
  },
  {
    key: 'input-tax-reconciliation',
    name: 'Input tax reconciliation',
    module: 'AP',
    description:
      'VAT paid on purchases, split into cleared-and-claimable and held-under-dispute.',
  },
  {
    key: 'ar-dispute-aging',
    name: 'Outbound sales dispute aging',
    module: 'AR',
    description: 'Customer disputes grouped into <15d, 16–30d, 31–60d and >60d buckets.',
  },
  {
    key: 'rejection-pareto',
    name: 'Rejection Pareto analysis',
    module: 'BOTH',
    description: 'Root cause breakdown by reason code across both directions.',
  },
  {
    key: 'fta-non-compliance',
    name: 'FTA audit non-compliance log',
    module: 'BOTH',
    description:
      'Disputed sales invoices with no corrective credit note issued within 30 days.',
  },
];

// ===========================================================================
// §15 Metering
// ===========================================================================

export const BundleSummary = z.object({
  id: uuid,
  tenantId: uuid,
  tenantName: z.string().nullable(),
  parentBundleId: uuid.nullable(),
  reference: z.string(),
  purchasedUnits: z.number(),
  consumedUnits: z.number(),
  remainingUnits: z.number(),
  usedPct: z.number(),
  status: BundleStatus,
  allowOverage: z.boolean(),
  validFrom: z.string(),
  expiresAt: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  /** v2.8 §15.3 — absolute floor, zero when the account has not set one. */
  minimumBufferUnits: z.number(),
  belowBuffer: z.boolean(),
  /**
   * v2.8 §15.4 — for a channel partner's master pool, the units already carved
   * into sub-tenant slices. Zero on a bundle nothing hangs off, which is every
   * bundle except a partner's.
   */
  allocatedUnits: z.number(),
  /**
   * Purchased − allocated: room to onboard another sub-tenant. A different
   * question from `remainingUnits`, which is purchased − *consumed* — a partner
   * can have allocated every unit it owns and still have most of them unspent.
   */
  unallocatedUnits: z.number(),
});
export type BundleSummary = z.infer<typeof BundleSummary>;

export const CreateBundleRequest = z.object({
  tenantId: uuid,
  /** Set when a channel partner carves a slice out of its own master pool. */
  parentBundleId: uuid.nullable().optional(),
  reference: z.string().trim().min(2).max(64),
  purchasedUnits: z.number().int().min(1).max(100_000_000),
  allowOverage: z.boolean().default(false),
  expiresAt: z.string().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  /**
   * v2.8 §15.2: the wholesale contract this sale is drawn from. Optional
   * because a partner carving a slice is not selling host stock — the units
   * left the host when the partner bought its master pool.
   */
  aspProcurementId: uuid.nullable().optional(),
  /** v2.8 §15.3: the floor this account should be warned at. */
  minimumBufferUnits: z.number().int().min(0).max(100_000_000).optional(),
});
export type CreateBundleRequest = z.infer<typeof CreateBundleRequest>;

export const UsageLedgerItem = z.object({
  id: z.string(),
  invoiceId: uuid.nullable(),
  invoiceNumber: z.string().nullable(),
  direction: InvoiceDirection,
  reason: z.string(),
  units: z.number(),
  isParentMirror: z.boolean(),
  createdAt: z.string(),
});
export type UsageLedgerItem = z.infer<typeof UsageLedgerItem>;

export const BalanceResponse = z.object({
  /** The tenant's own bundles, newest first. */
  bundles: z.array(BundleSummary),
  totalPurchased: z.number(),
  totalConsumed: z.number(),
  totalRemaining: z.number(),
  /** Highest usage percentage across active bundles; drives the banner. */
  usedPct: z.number(),
  /** The partner master pool this tenant also draws down, when there is one. */
  parentPool: BundleSummary.nullable(),
  canFile: z.boolean(),
  message: z.string().nullable(),
});
export type BalanceResponse = z.infer<typeof BalanceResponse>;

/** §15 consumption reasons, as written to `usage_ledger.reason`. */
export const USAGE_REASONS = {
  outboundClearance: 'OUTBOUND_CLEARANCE',
  creditNoteClearance: 'CREDIT_NOTE_CLEARANCE',
  apErpPosting: 'AP_ERP_POSTING',
  technicalRejection: 'TECHNICAL_REJECTION',
} as const;

export const USAGE_REASON_LABELS: Record<string, string> = {
  OUTBOUND_CLEARANCE: 'Sales invoice cleared',
  CREDIT_NOTE_CLEARANCE: 'Credit note cleared',
  AP_ERP_POSTING: 'Purchase bill posted to ERP',
  TECHNICAL_REJECTION: 'Technical rejection (no charge)',
};

// ===========================================================================
// Module dashboards
// ===========================================================================

export const ModuleDashboardResponse = z.object({
  direction: InvoiceDirection,
  counts: z.record(z.string(), z.number()),
  totalDocuments: z.number(),
  /** AR: awaiting the CFO. AP: awaiting the verification desk. */
  needsAction: z.number(),
  openDisputes: z.number(),
  /** AR: output VAT filed. AP: input VAT claimable. */
  vatTotalAed: z.string(),
  amountTotalAed: z.string(),
  erpSyncStatus: z.record(z.string(), z.number()),
  last30Days: z.array(
    z.object({
      date: z.string(),
      created: z.number(),
      cleared: z.number(),
      disputed: z.number(),
    }),
  ),
});
export type ModuleDashboardResponse = z.infer<typeof ModuleDashboardResponse>;
