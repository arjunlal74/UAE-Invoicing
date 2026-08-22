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

export const IngestionSource = z.enum([
  'REST_API',
  'EXCEL_UPLOAD',
  'CSV_UPLOAD',
  'SFTP',
  'POS_CONNECTOR',
]);
export type IngestionSource = z.infer<typeof IngestionSource>;

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

export const InvoiceStatus = z.enum([
  'INGESTED',
  'VALIDATED',
  'VALIDATION_FAILED',
  'PENDING_CFO_APPROVAL',
  'SUBMITTED_TO_ASP',
  'ACCEPTED_BY_FTA',
  'REJECTED_BY_FTA',
  'ARCHIVED',
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

/** Statuses from which a submission may legitimately be attempted. */
export const SUBMITTABLE_STATUSES: InvoiceStatus[] = ['VALIDATED', 'REJECTED_BY_FTA'];

/** Statuses a tax approver can act on from the approval queue. */
export const APPROVABLE_STATUSES: InvoiceStatus[] = ['PENDING_CFO_APPROVAL'];

/** Statuses that are final — no further transitions are accepted. */
export const TERMINAL_STATUSES: InvoiceStatus[] = ['ACCEPTED_BY_FTA', 'ARCHIVED'];

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
};

/** One-line summary of each role, shown next to the pickers that assign them. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  GLOBAL_ADMIN: 'Platform operations, tenant and partner onboarding, tax logic updates.',
  PARTNER_ADMIN: 'Onboards and manages sub-tenants under a channel partner.',
  COMPANY_ADMIN: 'Company tax profile, user invitations and provider settings.',
  ACCOUNTANT: 'Prepares invoices and corrects staged rows. Cannot file with the FTA.',
  TAX_APPROVER_CFO: 'The only role that can file invoices with the FTA.',
  AUDITOR: 'Read-only access to invoices, archives and the audit trail.',
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
