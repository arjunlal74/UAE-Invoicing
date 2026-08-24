import { Permission, ROLE_PERMISSIONS, Role, can } from '@uae/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The SRS §16 matrix, asserted directly.
 *
 * These are the statements the specification makes in prose. Encoding them here
 * means a future edit to ROLE_PERMISSIONS that quietly widens who can file with
 * the FTA fails a test rather than shipping.
 */
describe('role permissions', () => {
  const ALL_ROLES = Role.options;

  it('reserves filing with the FTA to the tax approver', () => {
    const filers = ALL_ROLES.filter((role) => can(role, 'invoice.submit'));
    expect(filers).toEqual(['TAX_APPROVER_CFO']);
  });

  it('lets accountants prepare invoices but never file them', () => {
    expect(can('ACCOUNTANT', 'invoice.edit')).toBe(true);
    expect(can('ACCOUNTANT', 'invoice.submit_for_approval')).toBe(true);
    expect(can('ACCOUNTANT', 'invoice.submit')).toBe(false);
  });

  it('keeps the company admin out of the filing decision', () => {
    expect(can('COMPANY_ADMIN', 'tenant.users.manage')).toBe(true);
    expect(can('COMPANY_ADMIN', 'invoice.edit')).toBe(true);
    expect(can('COMPANY_ADMIN', 'invoice.submit')).toBe(false);
  });

  it('gives the auditor reads and nothing else', () => {
    // §16: "Read-only access to Customer/Supplier Directories, archived WORM
    // XMLs, dispute reports, and audit logs." Every entry is a read, and the
    // assertion is on the whole list so that adding a write to this role fails
    // here rather than being noticed in production.
    expect(ROLE_PERMISSIONS.AUDITOR).toEqual([
      'invoice.read',
      'directory.read',
      'ap.read',
      'reports.read',
      'audit.read',
    ]);
    for (const permission of ROLE_PERMISSIONS.AUDITOR) {
      expect(permission.endsWith('.read')).toBe(true);
    }
  });

  // --- SRS v2.7 §16, the dual-module additions -----------------------------

  it('reserves purchase-invoice acceptance to the tax approver', () => {
    // §16 gives the approver "authorize AP payments"; accepting a supplier
    // invoice is what releases it for payment.
    const posters = ALL_ROLES.filter((role) => can(role, 'ap.post'));
    expect(posters).toEqual(['TAX_APPROVER_CFO']);
  });

  it('lets the accountant verify inbound bills but not release them', () => {
    expect(can('ACCOUNTANT', 'ap.read')).toBe(true);
    expect(can('ACCOUNTANT', 'ap.verify')).toBe(true);
    expect(can('ACCOUNTANT', 'ap.post')).toBe(false);
  });

  it('gives directory maintenance to the company admin and the accountant', () => {
    // §16 names the company administrator as the maintainer, and §7's builder
    // wireframe puts a quick-add next to the customer picker the accountant uses.
    const maintainers = ALL_ROLES.filter((role) => can(role, 'directory.manage'));
    expect(maintainers).toEqual(['COMPANY_ADMIN', 'ACCOUNTANT']);
  });

  it('keeps the auditor out of every module write path', () => {
    for (const permission of ['directory.manage', 'ap.verify', 'ap.post'] as const) {
      expect(can('AUDITOR', permission)).toBe(false);
    }
  });

  it('grants every declared permission to at least one role', () => {
    // A capability nobody holds is either dead code or a guard that can never
    // be satisfied — both worth catching at the point the matrix is edited.
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flat());
    expect(Permission.options.filter((p) => !granted.has(p))).toEqual([]);
  });

  it('keeps platform and partner administration out of tenant data', () => {
    for (const role of ['GLOBAL_ADMIN', 'PARTNER_ADMIN'] as const) {
      expect(can(role, 'invoice.read')).toBe(false);
      expect(can(role, 'invoice.edit')).toBe(false);
      expect(can(role, 'invoice.submit')).toBe(false);
    }
  });

  it('confines sub-tenant management to the partner administrator', () => {
    const managers = ALL_ROLES.filter((role) => can(role, 'partner.subtenants.manage'));
    expect(managers).toEqual(['PARTNER_ADMIN']);
  });

  it('confines platform administration to the global admin', () => {
    const admins = ALL_ROLES.filter((role) => can(role, 'platform.manage'));
    expect(admins).toEqual(['GLOBAL_ADMIN']);
  });

  it('describes every role exactly once', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ALL_ROLES].sort());
  });
});
