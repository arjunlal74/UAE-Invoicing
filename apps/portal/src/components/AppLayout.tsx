import { ROLE_LABELS } from '@uae/contracts';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { can, isPartnerUser, isPlatformUser, useAuthStore } from '../stores/auth';
import { StatusBadge, cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  /** Only a section's own landing page needs exact matching. */
  end?: boolean;
  needs?: Parameters<typeof can>[1];
}

/**
 * Navigation for a platform that is now two products in a trench coat.
 *
 * SRS v2.7 §1.2 splits the tenant workspace into an outbound sales module and an
 * inbound purchase module, and the people who use them are different: an AR
 * clerk composing invoices and an AP clerk approving bills share a login and
 * almost nothing else. A single flat menu of fourteen links would make both of
 * them read past the eleven that are not theirs, so the modules are the primary
 * axis and each carries its own second row.
 */
interface Module {
  key: string;
  label: string;
  /** Where clicking the module tab lands. */
  home: string;
  /** Which URL prefixes belong to this module. */
  match: (path: string) => boolean;
  items: NavItem[];
  needs?: Parameters<typeof can>[1];
}

const OUTBOUND_PATHS = ['/upload', '/batches', '/invoices', '/approvals', '/ar'];

const MODULES: Module[] = [
  {
    key: 'ar',
    label: 'Outbound',
    home: '/',
    match: (path) => path === '/' || OUTBOUND_PATHS.some((p) => path.startsWith(p)),
    // Ordered the way the work runs: set up who you are billing, raise the
    // document, then push it out in bulk, and only then look at what came back.
    items: [
      { to: '/', label: 'Overview', end: true },
      { to: '/ar/customers', label: 'Customers', needs: 'directory.read' },
      { to: '/ar/new-invoice', label: 'New invoice', needs: 'invoice.edit' },
      { to: '/ar/drafts', label: 'Drafts', needs: 'invoice.edit' },
      { to: '/upload', label: 'Excel upload', needs: 'invoice.edit' },
      { to: '/batches', label: 'Batches' },
      { to: '/invoices', label: 'Sales documents' },
      { to: '/ar/disputes', label: 'Disputes' },
      { to: '/approvals', label: 'Approvals', needs: 'invoice.submit' },
    ],
  },
  {
    key: 'ap',
    label: 'Inbound',
    home: '/ap',
    match: (path) => path.startsWith('/ap'),
    needs: 'ap.read',
    // Same shape as outbound, mirrored: know who is billing you, see what they
    // sent, rule on it, then chase what you sent back.
    items: [
      { to: '/ap', label: 'Overview', end: true },
      { to: '/ap/suppliers', label: 'Suppliers', needs: 'directory.read' },
      { to: '/ap/documents', label: 'Purchase documents' },
      { to: '/ap/inbox', label: 'Verification desk' },
      { to: '/ap/disputes', label: 'Disputes' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    home: '/reports',
    match: (path) => path.startsWith('/reports'),
    needs: 'reports.read',
    items: [
      { to: '/reports', label: 'Dispute analytics', end: true },
      { to: '/reports/library', label: 'Report library' },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    home: '/settings',
    match: (path) => path.startsWith('/settings'),
    items: [
      { to: '/settings', label: 'Company profile', end: true },
      { to: '/settings/usage', label: 'Usage & balance', needs: 'billing.read' },
      { to: '/settings/api-keys', label: 'API keys', needs: 'tenant.users.manage' },
    ],
  },
];

const ADMIN_NAV: NavItem[] = [
  // Exact matching, or every /admin/* route would light this up as well.
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/tenants', label: 'Tenants' },
  { to: '/admin/transmissions', label: 'Transmissions' },
  { to: '/admin/inventory', label: 'Data inventory' },
  { to: '/admin/audit', label: 'Audit log' },
  { to: '/admin/staff', label: 'Staff' },
  { to: '/admin/mail', label: 'Mail' },
];

const PARTNER_NAV: NavItem[] = [{ to: '/partner/sub-tenants', label: 'Sub-tenants' }];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cx(
    'rounded px-3 py-1.5 text-sm transition-colors',
    isActive ? 'bg-white/20 font-medium' : 'text-white/80 hover:bg-white/10',
  );

export function AppLayout() {
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const platform = isPlatformUser(user);
  const partner = isPartnerUser(user);
  const merchant = !platform && !partner;

  const modules = MODULES.filter((m) => !m.needs || can(user, m.needs)).map((m) => ({
    ...m,
    items: m.items.filter((item) => !item.needs || can(user, item.needs)),
  }));

  // Fall back to the first module the user can see rather than to a fixed one:
  // an auditor has no AR overview to land on.
  const activeModule = modules.find((m) => m.match(pathname)) ?? modules[0];

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
      {/* Pinned: the nav and the module menu are how you get anywhere, and the
          dashboards and grids below are long enough that scrolling back up to
          reach them was a tax on every navigation. */}
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-brand-700 text-white shadow-sm">
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
              {platform &&
                ADMIN_NAV.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} className={linkClass}>
                    {item.label}
                  </NavLink>
                ))}

              {partner &&
                PARTNER_NAV.map((item) => (
                  <NavLink key={item.to} to={item.to} className={linkClass}>
                    {item.label}
                  </NavLink>
                ))}

              {merchant &&
                modules.map((module) => (
                  <NavLink
                    key={module.key}
                    to={module.home}
                    className={cx(
                      'rounded px-3 py-1.5 text-sm transition-colors',
                      module.key === activeModule?.key
                        ? 'bg-white/20 font-medium'
                        : 'text-white/80 hover:bg-white/10',
                    )}
                  >
                    {module.label}
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

        {/* The active module's own menu. Only merchants have one — the admin and
            partner consoles are single-purpose. */}
        {merchant && activeModule && activeModule.items.length > 1 && (
          <div className="border-t border-white/10 bg-brand-800/40">
            <div className="mx-auto flex max-w-[1600px] items-center gap-1 px-4 py-1.5">
              {activeModule.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={linkClass}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* A merchant whose account is not yet live needs to know before they
          spend an afternoon preparing invoices they cannot submit. */}
      {merchant && user?.tenantStatus && user.tenantStatus !== 'ACTIVE' && (
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
