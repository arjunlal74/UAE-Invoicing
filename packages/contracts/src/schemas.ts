import { EMIRATES, INVOICE_NUMBER_PATTERN, TRN_PATTERN } from '@uae/domain';
import { z } from 'zod';
import {
  AspConnectionStatus,
  AspProviderType,
  BatchStatus,
  InvoiceStatus,
  InvoiceTypeDb,
  Role,
  TenantStatus,
  TenantType,
  ValidationSeverity,
} from './enums.js';

/** Request/response contracts. The API validates with these; the portal types against them. */

export const uuid = z.string().uuid();

export const trn = z
  .string()
  .trim()
  .regex(TRN_PATTERN, 'TRN must be exactly 15 digits starting with 1');

export const emirate = z.enum(EMIRATES);

// --- Auth -------------------------------------------------------------------

export const LoginRequest = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  /** Six-digit TOTP code; required once the account has MFA enrolled. */
  mfaCode: z.string().trim().regex(/^\d{6}$/).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const SessionUser = z.object({
  id: uuid,
  email: z.string(),
  fullName: z.string(),
  role: Role,
  tenantId: uuid.nullable(),
  tenantName: z.string().nullable(),
  tenantStatus: TenantStatus.nullable(),
  mfaEnabled: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUser>;

export const LoginResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(),
  user: SessionUser,
});
export type LoginResponse = z.infer<typeof LoginResponse>;

/** Returned instead of tokens when the account has MFA but no code was sent. */
export const MfaRequiredResponse = z.object({
  mfaRequired: z.literal(true),
});

export const MfaEnrolStartResponse = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type MfaEnrolStartResponse = z.infer<typeof MfaEnrolStartResponse>;

export const MfaEnrolConfirmRequest = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
});

export const RefreshRequest = z.object({ refreshToken: z.string().min(1) });

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, 'Use at least 12 characters'),
});

export const AcceptInviteRequest = z.object({
  token: z.string().min(1),
  fullName: z.string().trim().min(1).max(200),
  password: z.string().min(12, 'Use at least 12 characters'),
});

// --- Tenants ----------------------------------------------------------------

export const AddressSchema = z.object({
  street: z.string().trim().max(255).optional().default(''),
  city: z.string().trim().max(120).optional().default(''),
  emirate,
  postalCode: z.string().trim().max(20).optional().default(''),
  countryCode: z.string().trim().length(2).default('AE'),
});
export type Address = z.infer<typeof AddressSchema>;

export const CreateTenantRequest = z.object({
  /** Which tier of the v2.1 hierarchy this tenant is onboarded into. */
  tenantType: TenantType.default('ENTERPRISE_TENANT'),
  /** Required for a managed sub-tenant, rejected for every other tier. */
  parentTenantId: uuid.nullable().optional(),
  companyCode: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, hyphen and underscore only'),
  legalNameEn: z.string().trim().min(1).max(255),
  legalNameAr: z.string().trim().min(1).max(255),
  trn: trn.nullable().optional(),
  isVatGroup: z.boolean().default(false),
  vatGroupTrn: trn.nullable().optional(),
  registeredAddress: AddressSchema,
  /** Optional first administrator, invited as part of onboarding. */
  adminEmail: z.string().trim().toLowerCase().email().optional(),
  adminFullName: z.string().trim().min(1).max(200).optional(),
})
  .refine((v) => !v.isVatGroup || !!v.vatGroupTrn, {
    message: 'A VAT group TRN is required when the tenant is part of a VAT group',
    path: ['vatGroupTrn'],
  })
  .refine((v) => v.tenantType === 'CHANNEL_PARTNER' || v.tenantType === 'HOST' || !!v.trn, {
    message: 'A TRN is required for a tenant that files its own invoices',
    path: ['trn'],
  })
  .refine((v) => (v.tenantType === 'MANAGED_SUB_TENANT') === !!v.parentTenantId, {
    message: 'Only a managed sub-tenant has a parent, and it must have one',
    path: ['parentTenantId'],
  });
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export const UpdateTenantRequest = z.object({
  legalNameEn: z.string().trim().min(1).max(255).optional(),
  legalNameAr: z.string().trim().min(1).max(255).optional(),
  isVatGroup: z.boolean().optional(),
  vatGroupTrn: trn.nullable().optional(),
  registeredAddress: AddressSchema.optional(),
});

export const UpdateTenantStatusRequest = z.object({
  status: TenantStatus,
  /** Recorded on the audit trail — suspensions must be explicable later. */
  reason: z.string().trim().max(500).optional(),
});

export const TenantSummary = z.object({
  id: uuid,
  tenantType: TenantType,
  parentTenantId: uuid.nullable(),
  parentName: z.string().nullable(),
  companyCode: z.string(),
  legalNameEn: z.string(),
  legalNameAr: z.string(),
  trn: z.string().nullable(),
  status: TenantStatus,
  aspStatus: AspConnectionStatus,
  invoiceCount: z.number(),
  createdAt: z.string(),
});
export type TenantSummary = z.infer<typeof TenantSummary>;

export const TenantDetail = TenantSummary.extend({
  subTenantCount: z.number(),
  isVatGroup: z.boolean(),
  vatGroupTrn: z.string().nullable(),
  registeredAddress: AddressSchema,
  userCount: z.number(),
  updatedAt: z.string(),
});
export type TenantDetail = z.infer<typeof TenantDetail>;

// --- Users ------------------------------------------------------------------

export const InviteUserRequest = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(1).max(200),
  role: Role,
});

export const UserSummary = z.object({
  id: uuid,
  email: z.string(),
  fullName: z.string(),
  role: Role,
  tenantId: uuid.nullable(),
  isActive: z.boolean(),
  mfaEnabled: z.boolean(),
  lastLoginAt: z.string().nullable(),
  invitePending: z.boolean(),
  createdAt: z.string(),
});
export type UserSummary = z.infer<typeof UserSummary>;

// --- ASP configuration ------------------------------------------------------

export const UpsertAspConfigRequest = z.object({
  providerType: AspProviderType,
  displayName: z.string().trim().min(1).max(100),
  apiEndpoint: z.string().trim().url().or(z.literal('')),
  /**
   * Write-only. Never returned by the API — the detail response exposes only
   * whether credentials are present, so a compromised admin session cannot be
   * used to read back every tenant's provider secrets.
   */
  credentials: z
    .object({
      clientId: z.string().trim().optional(),
      clientSecret: z.string().trim().optional(),
      apiKey: z.string().trim().optional(),
      webhookSecret: z.string().trim().optional(),
    })
    .optional(),
  status: AspConnectionStatus,
  /** Provider-side identifier for this merchant, once registered. */
  providerAccountId: z.string().trim().max(255).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type UpsertAspConfigRequest = z.infer<typeof UpsertAspConfigRequest>;

export const AspConfigResponse = z.object({
  id: uuid,
  tenantId: uuid,
  providerType: AspProviderType,
  displayName: z.string(),
  apiEndpoint: z.string(),
  status: AspConnectionStatus,
  providerAccountId: z.string().nullable(),
  notes: z.string().nullable(),
  hasCredentials: z.boolean(),
  webhookUrl: z.string(),
  lastTestedAt: z.string().nullable(),
  lastTestResult: z.string().nullable(),
  updatedAt: z.string(),
});
export type AspConfigResponse = z.infer<typeof AspConfigResponse>;

export const TestConnectionResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().nullable(),
});

// --- Batches & staging ------------------------------------------------------

export const BatchSummary = z.object({
  id: uuid,
  reference: z.string(),
  fileName: z.string(),
  status: BatchStatus,
  totalRecords: z.number(),
  validRecords: z.number(),
  invalidRecords: z.number(),
  submittedRecords: z.number(),
  uploadedByName: z.string().nullable(),
  parseError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BatchSummary = z.infer<typeof BatchSummary>;

export const StagedLineDto = z.object({
  id: z.string(),
  lineNumber: z.string(),
  description: z.string(),
  hsCode: z.string(),
  quantity: z.string(),
  uom: z.string(),
  unitPrice: z.string(),
  lineDiscount: z.string(),
  vatCategory: z.string(),
  vatRate: z.string(),
  netAmount: z.string(),
  vatAmount: z.string(),
  lineTotal: z.string(),
  sourceRow: z.number().nullable(),
});

export const StagedInvoiceDto = z.object({
  id: z.string(),
  invoiceNumber: z.string(),
  invoiceType: z.string(),
  issueDate: z.string(),
  issueTime: z.string(),
  currency: z.string(),
  fxRate: z.string(),
  supplierTrn: z.string(),
  supplierName: z.string(),
  buyerTrn: z.string(),
  buyerName: z.string(),
  buyerEmirate: z.string(),
  poReference: z.string(),
  precedingInvoiceId: z.string(),
  paymentMeans: z.string(),
  lines: z.array(StagedLineDto),
  lineExtensionAmount: z.string(),
  taxExclusiveAmount: z.string(),
  vatTotalAmount: z.string(),
  taxInclusiveAmount: z.string(),
  payableAmount: z.string(),
  payableAmountAed: z.string(),
  sourceRow: z.number().nullable(),
});
export type StagedInvoiceDto = z.infer<typeof StagedInvoiceDto>;

export const ValidationFindingDto = z.object({
  ruleCode: z.string(),
  severity: ValidationSeverity,
  message: z.string(),
  field: z.string(),
  lineId: z.string().optional(),
  sheet: z.string(),
  cell: z.string().nullable(),
  jsonPath: z.string().optional(),
});
export type ValidationFindingDto = z.infer<typeof ValidationFindingDto>;

export const StagedRow = z.object({
  /** Staging row id — stable across edits and re-validation. */
  id: uuid,
  invoice: StagedInvoiceDto,
  findings: z.array(ValidationFindingDto),
  submittable: z.boolean(),
  status: InvoiceStatus.nullable(),
  invoiceId: uuid.nullable(),
});
export type StagedRow = z.infer<typeof StagedRow>;

export const StagingPage = z.object({
  batch: BatchSummary,
  rows: z.array(StagedRow),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type StagingPage = z.infer<typeof StagingPage>;

export const PatchStagedRowRequest = z.object({
  /** Partial invoice-level field updates. */
  invoice: StagedInvoiceDto.partial().omit({ id: true, lines: true }).optional(),
  /** Line updates keyed by line id; a null value removes the line. */
  lines: z.record(z.string(), StagedLineDto.partial().nullable()).optional(),
  /** Lines to append. */
  addLines: z.array(StagedLineDto.partial()).optional(),
});
export type PatchStagedRowRequest = z.infer<typeof PatchStagedRowRequest>;

export const SubmitBatchRequest = z.object({
  /** Omit to submit every submittable row in the batch. */
  rowIds: z.array(uuid).optional(),
});

export const SubmitBatchResponse = z.object({
  /** Handed to the ASP. Non-zero only when the caller may file with the FTA. */
  queued: z.number(),
  /** Parked in PENDING_CFO_APPROVAL for a tax approver to release. */
  pendingApproval: z.number(),
  skipped: z.number(),
  reasons: z.array(z.object({ rowId: uuid, reason: z.string() })),
});
export type SubmitBatchResponse = z.infer<typeof SubmitBatchResponse>;

export const AutoFixResponse = z.object({
  changed: z.number(),
  changes: z.array(
    z.object({
      rowId: uuid,
      invoiceNumber: z.string(),
      field: z.string(),
      from: z.string(),
      to: z.string(),
      reason: z.string(),
    }),
  ),
});

// --- Invoices ---------------------------------------------------------------

export const InvoiceSearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: InvoiceStatus.optional(),
  type: InvoiceTypeDb.optional(),
  buyerTrn: z.string().trim().optional(),
  batchId: uuid.optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amountMin: z.coerce.number().optional(),
  amountMax: z.coerce.number().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type InvoiceSearchQuery = z.infer<typeof InvoiceSearchQuery>;

export const InvoiceListItem = z.object({
  id: uuid,
  invoiceNumber: z.string(),
  invoiceType: InvoiceTypeDb,
  issueDate: z.string(),
  buyerName: z.string(),
  buyerTrn: z.string().nullable(),
  currencyCode: z.string(),
  payableAmount: z.string(),
  payableAmountAed: z.string(),
  status: InvoiceStatus,
  batchId: uuid.nullable(),
  createdByName: z.string().nullable(),
  approvedByName: z.string().nullable(),
  createdAt: z.string(),
});
export type InvoiceListItem = z.infer<typeof InvoiceListItem>;

export const TransmissionLogDto = z.object({
  id: uuid,
  aspProvider: z.string(),
  transmissionReference: z.string().nullable(),
  httpStatusCode: z.number().nullable(),
  status: z.string(),
  latencyMs: z.number().nullable(),
  errorMessage: z.string().nullable(),
  attempt: z.number(),
  createdAt: z.string(),
});

export const InvoiceDetail = InvoiceListItem.extend({
  peppolUuid: z.string(),
  issueTime: z.string(),
  exchangeRate: z.string(),
  sellerTrn: z.string(),
  sellerName: z.string(),
  buyerEmirate: z.string().nullable(),
  lineExtensionAmount: z.string(),
  taxExclusiveAmount: z.string(),
  taxInclusiveAmount: z.string(),
  vatTotalAmount: z.string(),
  qrCodeData: z.string().nullable(),
  ublXmlUri: z.string().nullable(),
  ublXmlSha256: z.string().nullable(),
  lines: z.array(StagedLineDto),
  findings: z.array(ValidationFindingDto),
  transmissions: z.array(TransmissionLogDto),
  ftaRejectionReason: z.string().nullable(),
  approvalNote: z.string().nullable(),
  approvedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  clearedAt: z.string().nullable(),
});
export type InvoiceDetail = z.infer<typeof InvoiceDetail>;

// --- Approvals (SRS v2.1 §5) ------------------------------------------------

/**
 * A tax approver acting on the queue. An empty `invoiceIds` means "every
 * invoice currently awaiting approval", which is the bulk-clearance case the
 * SRS calls for; naming ids explicitly handles the selective one.
 */
export const ApprovalDecisionRequest = z.object({
  invoiceIds: z.array(uuid).optional(),
  note: z.string().trim().max(500).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

export const ApprovalDecisionResponse = z.object({
  affected: z.number(),
  skipped: z.number(),
  reasons: z.array(z.object({ invoiceId: uuid, reason: z.string() })),
});
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponse>;

// --- Channel partner --------------------------------------------------------

export const SubTenantSummary = z.object({
  id: uuid,
  companyCode: z.string(),
  legalNameEn: z.string(),
  trn: z.string().nullable(),
  status: TenantStatus,
  aspStatus: AspConnectionStatus,
  invoiceCount: z.number(),
  userCount: z.number(),
  createdAt: z.string(),
});
export type SubTenantSummary = z.infer<typeof SubTenantSummary>;

export const CreateSubTenantRequest = z.object({
  companyCode: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, hyphen and underscore only'),
  legalNameEn: z.string().trim().min(1).max(255),
  legalNameAr: z.string().trim().min(1).max(255),
  trn,
  registeredAddress: AddressSchema,
  adminEmail: z.string().trim().toLowerCase().email(),
  adminFullName: z.string().trim().min(1).max(200),
});
export type CreateSubTenantRequest = z.infer<typeof CreateSubTenantRequest>;

export const PartnerOverview = z.object({
  partnerName: z.string(),
  subTenantCount: z.number(),
  activeSubTenantCount: z.number(),
  invoiceCount: z.number(),
  acceptedInvoiceCount: z.number(),
});
export type PartnerOverview = z.infer<typeof PartnerOverview>;

// --- Dashboard --------------------------------------------------------------

export const DashboardResponse = z.object({
  tenantStatus: TenantStatus,
  aspStatus: AspConnectionStatus,
  canSubmit: z.boolean(),
  counts: z.record(InvoiceStatus, z.number()),
  needsAttention: z.object({
    batchesWithErrors: z.number(),
    rejectedInvoices: z.number(),
    stuckTransmissions: z.number(),
  }),
  recentBatches: z.array(BatchSummary),
  last30Days: z.array(
    z.object({ date: z.string(), submitted: z.number(), accepted: z.number(), rejected: z.number() }),
  ),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;

// --- Admin monitoring -------------------------------------------------------

export const TransmissionMonitorQuery = z.object({
  tenantId: uuid.optional(),
  status: z.string().optional(),
  onlyProblems: z.coerce.boolean().default(true),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const TransmissionMonitorItem = z.object({
  invoiceId: uuid,
  invoiceNumber: z.string(),
  tenantId: uuid,
  tenantName: z.string(),
  status: InvoiceStatus,
  aspProvider: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  payableAmountAed: z.string(),
});
export type TransmissionMonitorItem = z.infer<typeof TransmissionMonitorItem>;

export const AuditLogQuery = z.object({
  tenantId: uuid.optional(),
  actorId: uuid.optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const AuditLogItem = z.object({
  id: z.string(),
  tenantId: uuid.nullable(),
  tenantName: z.string().nullable(),
  actorId: uuid.nullable(),
  actorName: z.string().nullable(),
  actorType: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  ipAddress: z.string().nullable(),
  changes: z.unknown().nullable(),
  createdAt: z.string(),
});
export type AuditLogItem = z.infer<typeof AuditLogItem>;

export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  });

export type PaginatedResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export { INVOICE_NUMBER_PATTERN };
