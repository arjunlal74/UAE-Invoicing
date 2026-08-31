import { z } from 'zod';

/**
 * Enumerations shared by the API and the portal.
 *
 * These mirror the PostgreSQL enum types exactly. Keeping them in one place
 * means a new invoice status is added in a single file and both the server's
 * validation and the portal's status badges pick it up.
 */

export const TenantStatus = z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED']);
export type TenantStatus = z.infer<typeof TenantStatus>;

/**
 * Where a tenant sits in the v2.1 hierarchy.
 *
 * HOST is the platform owner itself and exists so the tier is nameable; it has
 * no tenant row in practice. A MANAGED_SUB_TENANT always hangs off a
 * CHANNEL_PARTNER — the database enforces that, not just this enum.
 */
export const TenantType = z.enum([
  'HOST',
  'ENTERPRISE_TENANT',
  'CHANNEL_PARTNER',
  'MANAGED_SUB_TENANT',
]);
export type TenantType = z.infer<typeof TenantType>;

export const TENANT_TYPE_LABELS: Record<TenantType, string> = {
  HOST: 'Host',
  ENTERPRISE_TENANT: 'Enterprise tenant',
  CHANNEL_PARTNER: 'Channel partner',
  MANAGED_SUB_TENANT: 'Managed sub-tenant',
};

/** Tiers that file invoices under their own TRN. */
export const FILING_TENANT_TYPES: TenantType[] = ['ENTERPRISE_TENANT', 'MANAGED_SUB_TENANT'];

/**
 * How a managed sub-tenant was provisioned, and therefore who works in it (§3).
 *
 * The distinction is not cosmetic: it decides whether an activation link is
 * ever sent, whether the client holds a login at all, and whether a channel
 * partner's own staff may sign into the account. Every other tier is
 * COLLABORATIVE — a company the platform onboarded directly runs itself by
 * definition — which is also why that is the default and the safe backfill.
 */
export const ProvisioningMode = z.enum(['COLLABORATIVE', 'FULLY_MANAGED_CUSTODY']);
export type ProvisioningMode = z.infer<typeof ProvisioningMode>;

export const PROVISIONING_MODE_LABELS: Record<ProvisioningMode, string> = {
  COLLABORATIVE: 'Collaborative',
  FULLY_MANAGED_CUSTODY: 'Fully managed custody',
};

export const PROVISIONING_MODE_DESCRIPTIONS: Record<ProvisioningMode, string> = {
  COLLABORATIVE:
    'The client is sent an activation link and works in the portal themselves.',
  FULLY_MANAGED_CUSTODY:
    'You hold the account. No activation link is sent; your authorised staff sign in and act for the client.',
};

export const IngestionSource = z.enum([
  'REST_API',
  'EXCEL_UPLOAD',
  'CSV_UPLOAD',
  'SFTP',
  'POS_CONNECTOR',
  /** SRS v2.7 §1.3 channel 3: composed in the browser builders. */
  'MANUAL_IN_APP_ENTRY',
  /** SRS v2.7 §12.1: received off the Peppol network as a purchase invoice. */
  'INBOUND_PEPPOL_AS4',
  'SAP_CONNECTOR',
  'ORACLE_CONNECTOR',
  'DYNAMICS_CONNECTOR',
  'NETSUITE_CONNECTOR',
]);
export type IngestionSource = z.infer<typeof IngestionSource>;

/**
 * Which half of the platform a document belongs to (SRS v2.7 §1.2).
 *
 * This is the single most load-bearing discriminator added by v2.7. Almost
 * every list, count and report is scoped by it, because "invoices" now means
 * two entirely different piles of paper depending on which way the arrow
 * points.
 */
export const InvoiceDirection = z.enum(['OUTBOUND_SALES_AR', 'INBOUND_PURCHASE_AP']);
export type InvoiceDirection = z.infer<typeof InvoiceDirection>;

export const DIRECTION_LABELS: Record<InvoiceDirection, string> = {
  OUTBOUND_SALES_AR: 'Outbound sales (AR)',
  INBOUND_PURCHASE_AP: 'Inbound purchases (AP)',
};

/** Short form, for column headers and badges where the long label will not fit. */
export const DIRECTION_SHORT: Record<InvoiceDirection, string> = {
  OUTBOUND_SALES_AR: 'AR',
  INBOUND_PURCHASE_AP: 'AP',
};

export const BatchStatus = z.enum([
  'UPLOADED',
  'PARSING',
  'STAGED_WITH_ERRORS',
  'VALIDATED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
]);
export type BatchStatus = z.infer<typeof BatchStatus>;

export const InvoiceTypeDb = z.enum([
  'TAX_INVOICE',
  'SIMPLIFIED_TAX_INVOICE',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
]);
export type InvoiceTypeDb = z.infer<typeof InvoiceTypeDb>;

/**
 * The document lifecycle, spanning both modules.
 *
 * v2.1 ended at the tax authority's verdict. v2.7 continues past it: once the
 * FTA has cleared a sales invoice the *buyer* gets a say, and the last four
 * statuses record what they said. The same values describe an inbound purchase
 * invoice from the other side of the table — there, we are the party issuing
 * the verdict.
 */
export const InvoiceStatus = z.enum([
  /** Composed in a browser builder and not yet handed to anyone. */
  'DRAFT',
  'INGESTED',
  'VALIDATED',
  'VALIDATION_FAILED',
  'PENDING_CFO_APPROVAL',
  'SUBMITTED_TO_ASP',
  'ACCEPTED_BY_FTA',
  'DELIVERED_TO_BUYER',
  'ACKNOWLEDGED',
  'UNDER_QUERY',
  'ACCEPTED_BY_BUYER',
  'REJECTED_TECHNICAL',
  'REJECTED_COMMERCIAL',
  'REJECTED_BY_FTA',
  'ARCHIVED',
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

/** Statuses from which a submission may legitimately be attempted. */
export const SUBMITTABLE_STATUSES: InvoiceStatus[] = ['VALIDATED', 'REJECTED_BY_FTA'];

/** Statuses a tax approver can act on from the approval queue. */
export const APPROVABLE_STATUSES: InvoiceStatus[] = ['PENDING_CFO_APPROVAL'];

/**
 * Statuses that are final for *clearance* purposes — a late verdict from the
 * tax authority must not overwrite them.
 *
 * Note that ACCEPTED_BY_FTA is terminal here while the buyer-driven statuses
 * that follow it are not listed at all: those are a separate axis, applied by
 * the IMR engine rather than by the clearance path, and a cleared invoice that
 * is later disputed has not become un-cleared.
 */
export const TERMINAL_STATUSES: InvoiceStatus[] = [
  'ACCEPTED_BY_FTA',
  'DELIVERED_TO_BUYER',
  'ACKNOWLEDGED',
  'UNDER_QUERY',
  'ACCEPTED_BY_BUYER',
  'REJECTED_COMMERCIAL',
  'ARCHIVED',
];

/** Statuses that mean the document reached the FTA and was accepted. */
export const CLEARED_STATUSES: InvoiceStatus[] = [
  'ACCEPTED_BY_FTA',
  'DELIVERED_TO_BUYER',
  'ACKNOWLEDGED',
  'UNDER_QUERY',
  'ACCEPTED_BY_BUYER',
  'REJECTED_COMMERCIAL',
];

/**
 * Peppol BIS Invoice Response 3.0 status codes (SRS v2.7 §11).
 *
 * The same six codes flow in both directions: a buyer sends them to us about a
 * sales invoice, and our AP desk sends them to a supplier about a purchase
 * invoice.
 */
export const ResponseStatusCode = z.enum(['AB', 'IP', 'UQ', 'CA', 'AP', 'RE']);
export type ResponseStatusCode = z.infer<typeof ResponseStatusCode>;

export const RESPONSE_CODE_LABELS: Record<ResponseStatusCode, string> = {
  AB: 'Acknowledged',
  IP: 'In process',
  UQ: 'Under query',
  CA: 'Conditionally accepted',
  AP: 'Accepted',
  RE: 'Rejected',
};

/** Codes the AP verification desk may issue. AB/IP/CA are network-level. */
export const AP_DECISION_CODES: ResponseStatusCode[] = ['AP', 'UQ', 'RE'];

/**
 * Reason codes (SRS v2.7 §11). Shared by IMR responses and by the credit note
 * builder's "reason for issuance" picker, because a credit note raised to
 * settle a PRI dispute should carry the same code the dispute did.
 */
export const RejectionReasonCode = z.enum(['REF', 'PRI', 'QTY', 'ITM', 'DEL', 'NON', 'OTH']);
export type RejectionReasonCode = z.infer<typeof RejectionReasonCode>;

export const REASON_CODE_LABELS: Record<RejectionReasonCode, string> = {
  REF: 'Reference / PO mismatch',
  PRI: 'Price dispute',
  QTY: 'Quantity discrepancy',
  ITM: 'Wrong or defective item',
  DEL: 'Delivery failure',
  NON: 'Non-compliant data',
  OTH: 'Other',
};

/**
 * §12.3 separates a technical rejection from a commercial one. NON is the only
 * reason that is technical by nature — bad XML, an unparseable TRN — and it is
 * the one that consumes no quota under §15.
 */
export const TECHNICAL_REASON_CODES: RejectionReasonCode[] = ['NON'];

/** §8.2 Mode A / Mode B. */
export const ReversalMode = z.enum(['FULL_CANCELLATION', 'PARTIAL_ADJUSTMENT']);
export type ReversalMode = z.infer<typeof ReversalMode>;

export const REVERSAL_MODE_LABELS: Record<ReversalMode, string> = {
  FULL_CANCELLATION: 'Full cancellation (100% reversal)',
  PARTIAL_ADJUSTMENT: 'Partial adjustment (line by line)',
};

/** Where an accepted purchase invoice has got to in the buyer's own ledger. */
export const ApPostingStatus = z.enum(['NOT_POSTED', 'POSTED', 'BLOCKED', 'ON_HOLD']);
export type ApPostingStatus = z.infer<typeof ApPostingStatus>;

export const AP_POSTING_LABELS: Record<ApPostingStatus, string> = {
  NOT_POSTED: 'Not posted',
  POSTED: 'Posted to ERP',
  BLOCKED: 'Blocked',
  ON_HOLD: 'On hold',
};

/** §10.6 reverse push back to the ERP the document came from. */
export const ErpSyncStatus = z.enum(['NOT_APPLICABLE', 'PENDING', 'SENT', 'FAILED']);
export type ErpSyncStatus = z.infer<typeof ErpSyncStatus>;

export const PartyType = z.enum(['B2B', 'B2C']);
export type PartyType = z.infer<typeof PartyType>;

export const BundleStatus = z.enum(['ACTIVE', 'EXHAUSTED', 'EXPIRED', 'SUSPENDED']);
export type BundleStatus = z.infer<typeof BundleStatus>;

export const ValidationSeverity = z.enum(['INFO', 'WARNING', 'ERROR', 'FATAL']);
export type ValidationSeverity = z.infer<typeof ValidationSeverity>;

export const VatCategoryDb = z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE']);
export type VatCategoryDb = z.infer<typeof VatCategoryDb>;

/**
 * Roles (SRS v2.1 §5).
 *
 * GLOBAL_ADMIN is the only role that is not scoped to a tenant, so any code
 * path that assumes a tenant id must handle its absence. PARTNER_ADMIN is
 * tenant-scoped like the rest — its tenant is the channel partner, and its
 * reach over sub-tenants comes from the hierarchy rather than from a null
 * tenant id.
 */
export const Role = z.enum([
  'GLOBAL_ADMIN',
  'PARTNER_ADMIN',
  'COMPANY_ADMIN',
  'ACCOUNTANT',
  'TAX_APPROVER_CFO',
  'AUDITOR',
  /**
   * Not a user role, and never stored in `users.role` — the database enum does
   * not have it. It is the role a request carries when it arrived on an API key
   * (§1.2 channel 1) rather than on a session, and it holds no permissions at
   * all: everything such a request may do comes from the key's own scopes. Any
   * code that asks `can(ctx.role, …)` about a machine caller therefore gets a
   * refusal, which is the answer we want from a check that has not been taught
   * about API keys yet.
   */
  'API_CLIENT',
]);
export type Role = z.infer<typeof Role>;

/** Roles that operate above any single tenant. */
export const PLATFORM_ROLES: Role[] = ['GLOBAL_ADMIN'];

/** Roles a channel partner administrator may hold. */
export const PARTNER_ROLES: Role[] = ['PARTNER_ADMIN'];

/** Roles a company administrator may hand out inside their own tenant. */
export const TENANT_ROLES: Role[] = [
  'COMPANY_ADMIN',
  'ACCOUNTANT',
  'TAX_APPROVER_CFO',
  'AUDITOR',
];

export const ROLE_LABELS: Record<Role, string> = {
  GLOBAL_ADMIN: 'Host Global Admin',
  PARTNER_ADMIN: 'Channel Partner Admin',
  COMPANY_ADMIN: 'Company Admin',
  ACCOUNTANT: 'Data Entry / Accountant',
  TAX_APPROVER_CFO: 'Tax Approver / CFO',
  AUDITOR: 'Compliance Auditor',
  API_CLIENT: 'ERP integration key',
};

/** One-line summary of each role, shown next to the pickers that assign them. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  GLOBAL_ADMIN: 'Platform operations, tenant and partner onboarding, tax logic updates.',
  PARTNER_ADMIN: 'Onboards and manages sub-tenants under a channel partner.',
  COMPANY_ADMIN: 'Company tax profile, user invitations and provider settings.',
  ACCOUNTANT: 'Prepares invoices and corrects staged rows. Cannot file with the FTA.',
  TAX_APPROVER_CFO: 'The only role that can file invoices with the FTA.',
  AUDITOR: 'Read-only access to invoices, archives and the audit trail.',
  API_CLIENT: 'A machine posting invoices over the API. Never assigned to a person.',
};

export function isPlatformRole(role: Role): boolean {
  return PLATFORM_ROLES.includes(role);
}

export function isPartnerRole(role: Role): boolean {
  return PARTNER_ROLES.includes(role);
}

export const AspProviderType = z.enum(['MOCK', 'GENERIC_REST', 'NATIVE_AS4']);
export type AspProviderType = z.infer<typeof AspProviderType>;

export const AspConnectionStatus = z.enum([
  'NOT_CONFIGURED',
  'PENDING_REGISTRATION',
  'ACTIVE',
  'DISABLED',
]);
export type AspConnectionStatus = z.infer<typeof AspConnectionStatus>;

export const TransmissionStatus = z.enum([
  'PENDING',
  'SENT',
  'ACKNOWLEDGED',
  'ACCEPTED',
  'REJECTED',
  'FAILED',
  'DEAD_LETTERED',
]);
export type TransmissionStatus = z.infer<typeof TransmissionStatus>;
