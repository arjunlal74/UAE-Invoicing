import { ROLE_PERMISSIONS, Role, can } from '@uae/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The SRS v2.1 §5 matrix, asserted directly.
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
    expect(ROLE_PERMISSIONS.AUDITOR).toEqual(['invoice.read', 'audit.read']);
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
