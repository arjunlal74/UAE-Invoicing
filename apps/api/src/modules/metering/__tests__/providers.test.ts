import { describe, expect, it } from 'vitest';
import { isUnlockOnly, providerAuditAction } from '../providers.js';

/**
 * Locking a provider record, isolated from the database.
 *
 * The lock and the retirement are independent states that read alike in prose
 * — both are "this provider is out of action" to a hurried eye — and confusing
 * them costs a due-diligence trail: a locked provider is still bought from, and
 * a retired one is still editable. These pin down which is which.
 */
describe('a locked provider accepts only the unlock', () => {
  it('lets the unlock through', () => {
    expect(isUnlockOnly({ isLocked: false })).toBe(true);
  });

  it('refuses an edit smuggled alongside the unlock', () => {
    expect(isUnlockOnly({ isLocked: false, name: 'Renamed while unlocking' })).toBe(false);
  });

  it('refuses a plain edit', () => {
    expect(isUnlockOnly({ contactEmail: 'billing@example.ae' })).toBe(false);
  });

  it('refuses a retirement, which is an edit like any other', () => {
    // Reaching "retired and locked" is retire first, then lock. The other order
    // would have the lock mean less than it says.
    expect(isUnlockOnly({ isActive: false })).toBe(false);
  });

  it('refuses a re-lock, which changes nothing and would read as permission', () => {
    expect(isUnlockOnly({ isLocked: true })).toBe(false);
  });

  it('refuses an empty body', () => {
    expect(isUnlockOnly({})).toBe(false);
  });
});

describe('what a PATCH is recorded as', () => {
  it('names the lock and the unlock separately', () => {
    expect(providerAuditAction({ isLocked: true })).toBe('PROVIDER_LOCKED');
    expect(providerAuditAction({ isLocked: false })).toBe('PROVIDER_UNLOCKED');
  });

  it('still calls a retirement a retirement', () => {
    expect(providerAuditAction({ isActive: false })).toBe('PROVIDER_RETIRED');
  });

  it('calls a reactivation an update, as it always has', () => {
    expect(providerAuditAction({ isActive: true })).toBe('PROVIDER_UPDATED');
  });

  it('calls everything else an update', () => {
    expect(providerAuditAction({ name: 'Accredited ASP UAE' })).toBe('PROVIDER_UPDATED');
  });
});
