import { z } from 'zod';
import { Role } from './enums.js';

/**
 * The capability matrix from SRS v2.1 §5, expressed once.
 *
 * Routes and portal screens ask "does this role have this permission?" rather
 * than listing roles inline. When v2.2 moves a capability between roles, it
 * moves here and nowhere else.
 */

export const Permission = z.enum([
  /** Onboard tenants and partners, edit ASP connections, create platform staff. */
  'platform.manage',
  /** Cross-tenant read: tenant list, transmissions, platform-wide audit. */
  'platform.read',
  /** Onboard and manage the sub-tenants under a channel partner. */
  'partner.subtenants.manage',
  /** Read a partner's own roll-up of its sub-tenants. */
  'partner.read',
  /** Edit the company tax profile. */
  'tenant.profile.manage',
  /** Invite, deactivate and re-invite users within the tenant. */
  'tenant.users.manage',
  /** Read invoices, batches, staged rows and the dashboard. */
  'invoice.read',
  /** Upload batches and correct staged rows. */
  'invoice.edit',
  /** Hand a prepared batch to the tax approver. Does not reach the FTA. */
  'invoice.submit_for_approval',
  /** File with the FTA. Reserved to the tax approver by the SRS. */
  'invoice.submit',
  /** Read the audit trail. */
  'audit.read',
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  GLOBAL_ADMIN: ['platform.manage', 'platform.read', 'audit.read'],

  PARTNER_ADMIN: ['partner.subtenants.manage', 'partner.read', 'audit.read'],

  COMPANY_ADMIN: [
    'tenant.profile.manage',
    'tenant.users.manage',
    'invoice.read',
    'invoice.edit',
    'invoice.submit_for_approval',
    'audit.read',
  ],

  ACCOUNTANT: ['invoice.read', 'invoice.edit', 'invoice.submit_for_approval'],

  // The SRS gives the approver the filing power and nothing else: preparation
  // and correction stay with the accountant, and a row the approver disagrees
  // with goes back to them rather than being edited on the way out.
  TAX_APPROVER_CFO: ['invoice.read', 'invoice.submit', 'audit.read'],

  AUDITOR: ['invoice.read', 'audit.read'],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function canAny(role: Role, ...permissions: Permission[]): boolean {
  return permissions.some((p) => can(role, p));
}
