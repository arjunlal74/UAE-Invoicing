import type { AdminDashboardResponse } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Card,
  Spinner,
  StatusBadge,
  cx,
  formatDateTime,
} from '../../components/ui';
import { api } from '../../lib/api';

/**
 * The platform operator's landing page.
 *
 * Not the merchant dashboard with wider filters: an operator arrives asking
 * "is anything broken, and is anyone stuck waiting on me?", so every tile that
 * needs action links straight to the screen where the action is taken, and the
 * totals sit underneath rather than at the top.
 */
export function AdminDashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-dashboard'],
    queryFn: () => api<AdminDashboardResponse>('/api/v1/admin/dashboard'),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="py-16">
        <Spinner label="Loading…" />
      </div>
    );
  }

  const a = data.needsAttention;
  const byRole = data.users.byRole;
  // The three admin roles are one tile. They are different authorities — the
  // platform's, a partner's and a company's — but the question this tile
  // answers is "how many people can administer something", and splitting it
  // three ways would leave three tiles reading 1 on most installations.
  const admins =
    (byRole.GLOBAL_ADMIN ?? 0) + (byRole.PARTNER_ADMIN ?? 0) + (byRole.COMPANY_ADMIN ?? 0);
  const attentionTotal =
    a.stuckTransmissions +
    a.rejectedByFta +
    a.validationFailed +
    a.tenantsPendingActivation +
    a.aspNotConfigured +
    a.pendingInvites +
    a.failedMail;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-slate-900">Platform overview</h1>

      {!a.mailConfigured && (
        <Alert kind="warn" title="No outgoing mail account is configured">
          Invitations are not being e-mailed — the link is shown to whoever creates the account to
          pass on by hand.{' '}
          <Link to="/admin/mail" className="underline">
            Configure outgoing mail
          </Link>
          .
        </Alert>
      )}

      <Card title="Needs attention">
        {attentionTotal === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">
            Nothing is waiting. No stuck transmissions, rejections or pending activations.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Attention
              count={a.stuckTransmissions}
              label="Awaiting a verdict"
              shade="amber"
              detail="Sent to a provider over an hour ago with no response."
              // Not a bare status: that would also return every document sent
              // in the last minute and behaving perfectly.
              to="/admin/transmissions?stuck=true"
              tone="warn"
            />
            <Attention
              count={a.rejectedByFta}
              label="Rejected by the FTA"
              shade="rose"
              detail="Not filed. The tenant must correct and resubmit."
              to="/admin/transmissions?status=REJECTED_BY_FTA"
              tone="danger"
            />
            <Attention
              count={a.validationFailed}
              label="Failed validation"
              shade="orange"
              detail="Never reached a provider."
              to="/admin/transmissions?status=VALIDATION_FAILED"
              tone="danger"
            />
            <Attention
              count={a.tenantsPendingActivation}
              label="Tenants pending activation"
              shade="sky"
              detail="Onboarded but not yet able to file."
              to="/admin/tenants?status=PENDING"
              tone="warn"
            />
            <Attention
              count={a.aspNotConfigured}
              label="Provider connections not live"
              shade="violet"
              detail="These tenants cannot submit until the connection is active."
              to="/admin/tenants?aspStatus=NOT_LIVE"
              tone="warn"
            />
            <Attention
              count={a.pendingInvites}
              label="Invitations not accepted"
              shade="teal"
              detail="Accounts created but never signed in to."
              to="/admin/staff?pending=true"
              tone="warn"
            />
            <Attention
              count={a.failedMail}
              label="E-mails failed this week"
              shade="fuchsia"
              detail="Delivery was attempted and refused."
              to="/admin/mail?status=FAILED"
              tone="danger"
            />
          </div>
        )}
      </Card>

      {/* Who is on the platform, by tier and by role. The throughput figures
          that used to sit here are a question the transmissions monitor and the
          status card below answer better, and answered twice they disagreed the
          moment one of them was filtered. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Channel partners"
          shade="emerald"
          value={(data.tenants.byType.CHANNEL_PARTNER ?? 0).toLocaleString()}
        />
        <Stat
          label="Enterprise tenants"
          shade="sky"
          value={(data.tenants.byType.ENTERPRISE_TENANT ?? 0).toLocaleString()}
        />
        <Stat
          label="Managed tenants"
          shade="amber"
          value={(data.tenants.byType.MANAGED_SUB_TENANT ?? 0).toLocaleString()}
        />
        <Stat label="Admins"
          shade="violet" value={admins.toLocaleString()}>
          <span className="text-xs text-slate-500">Platform, partner and company</span>
        </Stat>
        <Stat label="Accountants"
          shade="cyan" value={(byRole.ACCOUNTANT ?? 0).toLocaleString()} />
        <Stat label="Tax approvers"
          shade="rose" value={(byRole.TAX_APPROVER_CFO ?? 0).toLocaleString()} />
        <Stat label="Auditors"
          shade="lime" value={(byRole.AUDITOR ?? 0).toLocaleString()} />
        <Stat label="Total users"
          shade="slate" value={data.users.total.toLocaleString()}>
          <span className="text-xs text-slate-500">
            {data.users.active.toLocaleString()} active
          </span>
        </Stat>
      </div>

      <Card title="Busiest tenants (30 days)">
        {data.topTenants.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">No tenants yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Tenant</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Invoices</th>
                <th className="pb-2 text-right font-medium">Accepted</th>
                <th className="pb-2 text-right font-medium">Rejected</th>
                <th className="pb-2 text-right font-medium">Value (AED)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.topTenants.map((tenant) => (
                <tr key={tenant.tenantId} className="hover:bg-slate-50">
                  <td className="py-2 font-medium text-slate-800">{tenant.tenantName}</td>
                  <td className="py-2">
                    <StatusBadge status={tenant.status} />
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {tenant.invoices.toLocaleString()}
                  </td>
                  <td className="py-2 text-right tabular-nums text-ok-700">
                    {tenant.accepted.toLocaleString()}
                  </td>
                  <td
                    className={cx(
                      'py-2 text-right tabular-nums',
                      tenant.rejected > 0 ? 'font-medium text-danger-700' : 'text-slate-400',
                    )}
                  >
                    {tenant.rejected.toLocaleString()}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatAmount(tenant.valueAed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Recent activity"
        actions={
          <Link to="/admin/audit" className="text-sm text-brand-600 underline">
            Audit log
          </Link>
        }
      >
        {data.recentActivity.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.recentActivity.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <span className="font-mono text-xs text-slate-700">{entry.action}</span>
                  {entry.tenantName && (
                    <span className="ml-2 text-slate-500">{entry.tenantName}</span>
                  )}
                </div>
                <div className="whitespace-nowrap text-xs text-slate-500">
                  {entry.actorName ?? 'system'} · {formatDateTime(entry.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  shade,
  children,
}: {
  label: string;
  value: string;
  shade: keyof typeof TILE_SHADES;
  children?: ReactNode;
}) {
  return (
    <div className={cx('rounded-lg border p-3 shadow-sm', TILE_SHADES[shade])}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
      {children}
    </div>
  );
}

/**
 * A tint per tile, so a reader can say which one they were looking at.
 *
 * These are identity, not severity. Every one is a 50, pale enough that the
 * figure sitting on it stays the loudest thing in the tile — which matters more
 * here than anywhere else on the page, because an attention tile only appears
 * at all when something is wrong, and the severity has to survive the tint.
 */
const TILE_SHADES = {
  amber: 'border-amber-200 bg-amber-50 hover:bg-amber-100/60',
  rose: 'border-rose-200 bg-rose-50 hover:bg-rose-100/60',
  orange: 'border-orange-200 bg-orange-50 hover:bg-orange-100/60',
  sky: 'border-sky-200 bg-sky-50 hover:bg-sky-100/60',
  violet: 'border-violet-200 bg-violet-50 hover:bg-violet-100/60',
  teal: 'border-teal-200 bg-teal-50 hover:bg-teal-100/60',
  fuchsia: 'border-fuchsia-200 bg-fuchsia-50 hover:bg-fuchsia-100/60',
  emerald: 'border-emerald-200 bg-emerald-50',
  cyan: 'border-cyan-200 bg-cyan-50',
  lime: 'border-lime-200 bg-lime-50',
  slate: 'border-slate-300 bg-slate-100',
};

/** Rendered only when it is non-zero — a wall of noughts is not attention. */
function Attention({
  count,
  label,
  detail,
  to,
  tone,
  shade,
}: {
  count: number;
  label: string;
  detail: string;
  to: string;
  /** Severity. Kept on the figure, which frees the tint to be identity. */
  tone: 'danger' | 'warn';
  shade: keyof typeof TILE_SHADES;
}) {
  if (count === 0) return null;

  return (
    <Link
      to={to}
      className={cx('block rounded-lg border p-3 transition-colors', TILE_SHADES[shade])}
    >
      <div
        className={cx(
          'text-2xl font-semibold tabular-nums',
          tone === 'danger' ? 'text-danger-700' : 'text-warn-700',
        )}
      >
        {count.toLocaleString()}
      </div>
      <div className="text-sm font-medium text-slate-800">{label}</div>
      <p className="mt-0.5 text-xs text-slate-600">{detail}</p>
    </Link>
  );
}
