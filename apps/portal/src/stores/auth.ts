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

/** A session set aside so another can be used, and swapped back afterwards. */
interface ParkedSession {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: SessionUser | null;
  /**
   * The partner's own session, parked while its staff member works inside a
   * custody client (SRS §3).
   *
   * Parked rather than replaced: the two sessions are separate on the server —
   * different tenants, different roles, separately revocable — and holding on
   * to the partner's means leaving a client is instant, rather than a sign-in
   * every time somebody looks at a second client.
   */
  parked: ParkedSession | null;
  setSession: (session: LoginResponse) => void;
  setUser: (user: SessionUser) => void;
  /** Park the current session and take up a custody one. */
  enterCustody: (session: LoginResponse) => void;
  /** Put the parked session back. False if there was nothing parked. */
  leaveCustody: () => boolean;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      parked: null,
      // Deliberately does not touch `parked`: this is what a token refresh
      // calls, and a refresh of the custody session must not discard the
      // partner session waiting behind it.
      setSession: (session) =>
        set({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          user: session.user,
        }),
      setUser: (user) => set({ user }),
      enterCustody: (session) => {
        const { accessToken, refreshToken, user } = get();
        set({
          parked:
            accessToken && refreshToken && user ? { accessToken, refreshToken, user } : null,
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          user: session.user,
        });
      },
      leaveCustody: () => {
        const { parked } = get();
        if (!parked) return false;
        set({
          accessToken: parked.accessToken,
          refreshToken: parked.refreshToken,
          user: parked.user,
          parked: null,
        });
        return true;
      },
      clear: () => set({ accessToken: null, refreshToken: null, user: null, parked: null }),
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

/**
 * Whether this session is a channel partner's staff member working inside a
 * custody client (SRS §3).
 *
 * Read from the session rather than from the role: during custody the role is
 * the one the authorisation carries inside the client's books, which is
 * indistinguishable from the client's own staff — and that is the point. What
 * makes it a custody session is who they came from, which is `actingFor`.
 */
export function isCustodySession(user: SessionUser | null): boolean {
  return !!user?.actingFor;
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
  // The partner's dashboard, for the same reason the operator lands on theirs:
  // "is anything waiting on me?" is the question they signed in with.
  if (isPartnerUser(user)) return '/partner';
  return '/';
}
