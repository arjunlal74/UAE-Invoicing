import { ROLE_LABELS } from '@uae/contracts';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { can, isPartnerUser, isPlatformUser, useAuthStore } from '../stores/auth';
import { StatusBadge, cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  /** Only the dashboard needs exact matching; every other path is a prefix. */
  end?: boolean;
}

/**
 * Navigation is built from the same capability matrix the API enforces, so a
 * role never sees a link to a screen its requests would be refused.
 */
const MERCHANT_NAV: (NavItem & { needs?: Parameters<typeof can>[1] })[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/upload', label: 'Upload invoices', needs: 'invoice.edit' },
  { to: '/batches', label: 'Batches' },
  { to: '/approvals', label: 'Approvals', needs: 'invoice.submit' },
  { to: '/invoices', label: 'Invoices' },
  { to: '/settings', label: 'Settings' },
];

const ADMIN_NAV: NavItem[] = [
  // Exact matching, or every /admin/* route would light this up as well.
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/tenants', label: 'Tenants' },
  { to: '/admin/transmissions', label: 'Transmissions' },
  { to: '/admin/audit', label: 'Audit log' },
  { to: '/admin/staff', label: 'Staff' },
  { to: '/admin/mail', label: 'Mail' },
];

const PARTNER_NAV: NavItem[] = [{ to: '/partner/sub-tenants', label: 'Sub-tenants' }];

export function AppLayout() {
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();

  const platform = isPlatformUser(user);
  const partner = isPartnerUser(user);

  const nav = platform
    ? ADMIN_NAV
    : partner
      ? PARTNER_NAV
      : MERCHANT_NAV.filter((item) => !item.needs || can(user, item.needs));

  const signOut = async () => {
    // Best effort: the server-side revoke matters, but a network failure must
    // not trap the user in a session they have asked to end.
    try {
      if (refreshToken) await api('/api/v1/auth/logout', { method: 'POST', body: { refreshToken } });
    } catch {
      /* ignore */
    }
    clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-brand-700 text-white">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-2.5">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="rounded bg-white/15 px-2 py-1 text-xs font-bold tracking-wide">
                UAE
              </span>
              <span className="text-sm font-semibold">
                E-Invoicing{' '}
                {platform ? 'Administration' : partner ? 'Partner Portal' : 'Portal'}
              </span>
            </div>

            <nav className="flex items-center gap-1">
              {nav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cx(
                      'rounded px-3 py-1.5 text-sm transition-colors',
                      isActive ? 'bg-white/20 font-medium' : 'text-white/80 hover:bg-white/10',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3 text-sm">
            <div className="text-right leading-tight">
              <div className="font-medium">{user?.fullName}</div>
              <div className="text-xs text-white/70">
                {user?.tenantName ?? 'Platform'} · {user ? ROLE_LABELS[user.role] : ''}
              </div>
            </div>
            <NavLink
              to="/security"
              className={({ isActive }) =>
                cx(
                  'rounded border border-white/30 px-2.5 py-1 text-xs hover:bg-white/10',
                  isActive && 'bg-white/20',
                )
              }
            >
              Security
            </NavLink>
            <button
              onClick={signOut}
              className="rounded border border-white/30 px-2.5 py-1 text-xs hover:bg-white/10"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* A merchant whose account is not yet live needs to know before they
          spend an afternoon preparing invoices they cannot submit. */}
      {!platform && !partner && user?.tenantStatus && user.tenantStatus !== 'ACTIVE' && (
        <div className="border-b border-warn-200 bg-warn-50 px-4 py-2">
          <div className="mx-auto flex max-w-[1600px] items-center gap-2 text-sm text-warn-700">
            <StatusBadge status={user.tenantStatus} />
            <span>
              Your account is not yet active with our network provider. You can upload files and
              correct errors now, but invoices cannot be submitted to the FTA until activation
              completes.
            </span>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-[1600px] px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
