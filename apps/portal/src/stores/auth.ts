import type { LoginResponse, Permission, SessionUser } from '@uae/contracts';
import { can as roleCan, isPartnerRole, isPlatformRole } from '@uae/contracts';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Session state.
 *
 * Persisted to localStorage so a page reload does not sign the user out
 * mid-batch. That is a deliberate trade: a refresh token in localStorage is
 * reachable by XSS, but the token is rotated on every use and revocable
 * server-side, and the alternative (in-memory only) would lose a finance user's
 * place every time they reload a 10,000-row grid.
 */

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: SessionUser | null;
  setSession: (session: LoginResponse) => void;
  setUser: (user: SessionUser) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setSession: (session) =>
        set({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          user: session.user,
        }),
      setUser: (user) => set({ user }),
      clear: () => set({ accessToken: null, refreshToken: null, user: null }),
    }),
    { name: 'uae-einvoice-session' },
  ),
);

/**
 * Screen-level capability checks.
 *
 * These read the same SRS §5 matrix the API enforces, so a button is hidden for
 * exactly the roles whose request would be refused. Hiding is a courtesy, not a
 * control — the server decides.
 */
export function can(user: SessionUser | null, permission: Permission): boolean {
  return !!user && roleCan(user.role, permission);
}

export function isPlatformUser(user: SessionUser | null): boolean {
  return !!user && isPlatformRole(user.role);
}

export function isPartnerUser(user: SessionUser | null): boolean {
  return !!user && isPartnerRole(user.role);
}

/** Whether this user may change staged data. Approvers and auditors may not. */
export function canEdit(user: SessionUser | null): boolean {
  return can(user, 'invoice.edit');
}

/** Whether this user may file with the FTA. The tax approver, and only them. */
export function canFile(user: SessionUser | null): boolean {
  return can(user, 'invoice.submit');
}

export function isCompanyAdmin(user: SessionUser | null): boolean {
  return can(user, 'tenant.users.manage');
}

/** Where a user lands after signing in, which differs per tier. */
export function homePathFor(user: SessionUser | null): string {
  if (isPlatformUser(user)) return '/admin';
  if (isPartnerUser(user)) return '/partner/sub-tenants';
  return '/';
}
