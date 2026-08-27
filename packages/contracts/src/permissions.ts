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
  /** Read the customer (AR) and supplier (AP) master directories. */
  'directory.read',
  /** Create and edit directory entries, including the builder's quick-add. */
  'directory.manage',
  /** Read the inbound purchase inbox and open a supplier bill (§12.2). */
  'ap.read',
  /** Accept, query or reject an incoming purchase invoice (§12.3). */
  'ap.verify',
  /** Post an accepted purchase bill to the ledger and authorise payment. */
  'ap.post',
  /** Read the AR/AP dispute analytics and the reporting suite (§13). */
  'reports.read',
  /** See the tenant's own data bundle balance and consumption (§15). */
  'billing.read',
  /** Read the audit trail. */
  'audit.read',
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  GLOBAL_ADMIN: ['platform.manage', 'platform.read', 'audit.read'],

  PARTNER_ADMIN: [
    'partner.subtenants.manage',
    'partner.read',
    'billing.read',
    'audit.read',
  ],

  COMPANY_ADMIN: [
    'tenant.profile.manage',
    'tenant.users.manage',
    'invoice.read',
    'invoice.edit',
    'invoice.submit_for_approval',
    // §16: the company administrator is the role that "maintains Customer &
    // Supplier Directories".
    'directory.read',
    'directory.manage',
    'ap.read',
    'ap.verify',
    'reports.read',
    'billing.read',
    'audit.read',
  ],

  // §16 gives the accountant both desks: they compose AR documents and they
  // verify inbound AP bills. What they cannot do is release either one — filing
  // a sales invoice and authorising a purchase payment both sit with the CFO.
  ACCOUNTANT: [
    'invoice.read',
    'invoice.edit',
    'invoice.submit_for_approval',
    'directory.read',
    // The §7 builder wireframe puts a "Quick Add" next to the customer picker,
    // so the person composing the invoice must be able to create the buyer.
    'directory.manage',
    'ap.read',
    'ap.verify',
    'reports.read',
  ],

  // The SRS gives the approver the release powers and not the preparation ones:
  // composition and correction stay with the accountant, and a document the
  // approver disagrees with goes back to them rather than being edited on the
  // way out. v2.7 adds the AP side of the same gate — "authorize AP payments".
  TAX_APPROVER_CFO: [
    'invoice.read',
    'invoice.submit',
    'directory.read',
    'ap.read',
    'ap.verify',
    'ap.post',
    'reports.read',
    'billing.read',
    'audit.read',
  ],

  AUDITOR: ['invoice.read', 'directory.read', 'ap.read', 'reports.read', 'audit.read'],

  // Deliberately empty. A machine caller's authority is the scope list on its
  // key, resolved into `RequestContext.scopes`; the role grants nothing on its
  // own so that a permission check written before API keys existed fails closed.
  API_CLIENT: [],
};

/**
 * The scopes an API key may be granted.
 *
 * A machine integrates a ledger with a tax authority. It does not invite
 * colleagues, change the company's tax profile, or read the audit trail, so
 * those permissions are not on offer here however senior the person minting the
 * key is. Anything an operator has to think about is a thing a stolen key can
 * do, and this list is the whole of it.
 *
 * `invoice.submit` is included but is the one to hesitate over: a key holding
 * it files with the FTA without a human release step. That is precisely what an
 * automated ERP feed is for, and precisely why it is not the default.
 */
export const API_KEY_SCOPES: Permission[] = [
  'invoice.read',
  'invoice.edit',
  'invoice.submit_for_approval',
  'invoice.submit',
  'directory.read',
  'directory.manage',
  'ap.read',
  'reports.read',
];

export function isApiKeyScope(value: string): value is Permission {
  return (API_KEY_SCOPES as string[]).includes(value);
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function canAny(role: Role, ...permissions: Permission[]): boolean {
  return permissions.some((p) => can(role, p));
}
