import type { LoginResponse, Role, SessionUser } from '@uae/contracts';
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

const PLATFORM_ROLES: Role[] = ['PLATFORM_ADMIN', 'PLATFORM_SUPPORT'];
const EDITOR_ROLES: Role[] = ['TENANT_ADMIN', 'FINANCE_USER', 'DATA_ENTRY_CLERK'];

export function isPlatformUser(user: SessionUser | null): boolean {
  return !!user && PLATFORM_ROLES.includes(user.role);
}

/** Whether this user may change staged data or submit. Auditors may not. */
export function canEdit(user: SessionUser | null): boolean {
  return !!user && EDITOR_ROLES.includes(user.role);
}

export function isTenantAdmin(user: SessionUser | null): boolean {
  return user?.role === 'TENANT_ADMIN';
}
