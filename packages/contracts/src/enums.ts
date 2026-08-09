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
  'SUBMITTED_TO_ASP',
  'ACCEPTED_BY_FTA',
  'REJECTED_BY_FTA',
  'ARCHIVED',
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

/** Statuses from which a submission may legitimately be attempted. */
export const SUBMITTABLE_STATUSES: InvoiceStatus[] = ['VALIDATED', 'REJECTED_BY_FTA'];

/** Statuses that are final — no further transitions are accepted. */
export const TERMINAL_STATUSES: InvoiceStatus[] = ['ACCEPTED_BY_FTA', 'ARCHIVED'];

export const ValidationSeverity = z.enum(['INFO', 'WARNING', 'ERROR', 'FATAL']);
export type ValidationSeverity = z.infer<typeof ValidationSeverity>;

export const VatCategoryDb = z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE']);
export type VatCategoryDb = z.infer<typeof VatCategoryDb>;

/**
 * Roles. Platform roles operate across tenants; tenant roles are scoped to one.
 * The split matters for the auth guard: a PLATFORM_ADMIN has no tenant_id, so
 * any code path that assumes one must handle its absence.
 */
export const Role = z.enum([
  'PLATFORM_ADMIN',
  'PLATFORM_SUPPORT',
  'TENANT_ADMIN',
  'FINANCE_USER',
  'DATA_ENTRY_CLERK',
  'AUDITOR',
]);
export type Role = z.infer<typeof Role>;

export const PLATFORM_ROLES: Role[] = ['PLATFORM_ADMIN', 'PLATFORM_SUPPORT'];
export const TENANT_ROLES: Role[] = [
  'TENANT_ADMIN',
  'FINANCE_USER',
  'DATA_ENTRY_CLERK',
  'AUDITOR',
];

export const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_ADMIN: 'Platform Admin',
  PLATFORM_SUPPORT: 'Platform Support',
  TENANT_ADMIN: 'Tenant Admin',
  FINANCE_USER: 'Finance User',
  DATA_ENTRY_CLERK: 'Data Entry Clerk',
  AUDITOR: 'Auditor',
};

export function isPlatformRole(role: Role): boolean {
  return PLATFORM_ROLES.includes(role);
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
