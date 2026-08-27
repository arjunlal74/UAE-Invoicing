import {
  API_KEY_SCOPES,
  PARTNER_ROLES,
  PLATFORM_ROLES,
  ROLE_PERMISSIONS,
  Role,
  TENANT_ROLES,
  can,
} from '@uae/contracts';
import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, validateScopes } from '../apiKeys.js';
import { ctxCan, ctxCanAny, permissionsOf, type RequestContext } from '../../http/context.js';

/**
 * The credential and authority model for ingestion channel 1.
 *
 * These assertions are about blast radius, not about happy paths. An API key
 * is a long-lived string in somebody's configuration file, and every test here
 * pins down one of the properties that bounds what its disclosure would cost.
 */

describe('api key tokens', () => {
  it('is recognisable, and long enough not to be guessed', () => {
    const { token } = generateToken();

    // The literal marker is what lets a secret scanner find this in a public
    // repository before somebody else does.
    const match = /^uaeinv_(live|test)_(.+)$/.exec(token);
    expect(match).not.toBeNull();

    // 32 CSPRNG bytes as base64url — note the alphabet includes `_`, so the
    // secret is taken as the remainder rather than by splitting on underscores.
    expect(match![2]).toHaveLength(43);
    expect(match![2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never issues the same token twice', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(tokens.size).toBe(200);
  });

  it('stores a hash, and a prefix that is useless on its own', () => {
    const { token, tokenHash, keyPrefix } = generateToken();

    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).toHaveLength(64);
    // The stored material must not contain the secret in any form.
    expect(tokenHash).not.toContain(token);
    expect(token).not.toContain(tokenHash);
    // The prefix identifies the key in a list. It stops before the secret.
    expect(token.startsWith(keyPrefix)).toBe(true);
    expect(keyPrefix.length).toBeLessThan(token.length / 2);
  });

  it('hashes deterministically, so authentication is a single index probe', () => {
    expect(hashToken('uaeinv_test_abc')).toBe(hashToken('uaeinv_test_abc'));
    expect(hashToken('uaeinv_test_abc')).not.toBe(hashToken('uaeinv_test_abd'));
  });
});

describe('api key scopes', () => {
  it('refuses any permission not on the machine list', () => {
    expect(() => validateScopes(['platform.manage'])).toThrow(/cannot be granted/);
    expect(() => validateScopes(['tenant.users.manage'])).toThrow(/cannot be granted/);
    expect(() => validateScopes(['audit.read'])).toThrow(/cannot be granted/);
    // Including things that are not permissions at all.
    expect(() => validateScopes(['*'])).toThrow(/cannot be granted/);
  });

  it('never offers a scope that could mint another key or read the audit trail', () => {
    // The two that would turn a leaked key into a foothold: one escalates,
    // the other covers the tracks.
    expect(API_KEY_SCOPES).not.toContain('tenant.users.manage');
    expect(API_KEY_SCOPES).not.toContain('audit.read');
    expect(API_KEY_SCOPES).not.toContain('platform.manage');
    expect(API_KEY_SCOPES).not.toContain('platform.read');
  });

  it('accepts the machine list and de-duplicates it', () => {
    expect(validateScopes(['invoice.read', 'invoice.read'])).toEqual(['invoice.read']);
    expect(validateScopes([...API_KEY_SCOPES])).toEqual(API_KEY_SCOPES);
  });
});

describe('effective permissions', () => {
  const session = (role: Role): RequestContext => ({
    userId: 'u1',
    email: 'someone@example.ae',
    role,
    tenantId: 't1',
    ip: undefined,
    userAgent: undefined,
    mustRotatePassword: false,
  });

  const machine = (...scopes: (typeof API_KEY_SCOPES)[number][]): RequestContext => ({
    ...session('API_CLIENT'),
    apiKey: { id: 'k1', name: 'ERP', keyPrefix: 'uaeinv_live_ab' },
    scopes,
  });

  it('gives a session exactly what its role grants', () => {
    expect(permissionsOf(session('ACCOUNTANT'))).toEqual(ROLE_PERMISSIONS.ACCOUNTANT);
    expect(ctxCan(session('TAX_APPROVER_CFO'), 'invoice.submit')).toBe(true);
    expect(ctxCan(session('ACCOUNTANT'), 'invoice.submit')).toBe(false);
  });

  it('gives a key exactly its scopes, and nothing its role would imply', () => {
    const key = machine('invoice.read');
    expect(ctxCan(key, 'invoice.read')).toBe(true);
    expect(ctxCan(key, 'invoice.submit')).toBe(false);
    expect(ctxCanAny(key, 'invoice.submit', 'invoice.submit_for_approval')).toBe(false);
  });

  it('holds no authority in the role itself, so an un-migrated check fails closed', () => {
    // The property that makes this safe to add to a codebase full of existing
    // `can(ctx.role, …)` calls: every one of them refuses a machine.
    expect(ROLE_PERMISSIONS.API_CLIENT).toEqual([]);
    for (const permission of API_KEY_SCOPES) {
      expect(can('API_CLIENT', permission)).toBe(false);
    }
  });

  it('is never assignable to a person', () => {
    // `API_CLIENT` is a TypeScript-only role; the database `user_role` enum has
    // no such value, and none of the pickers offer it.
    expect(TENANT_ROLES).not.toContain('API_CLIENT');
    expect(PLATFORM_ROLES).not.toContain('API_CLIENT');
    expect(PARTNER_ROLES).not.toContain('API_CLIENT');
  });
});
