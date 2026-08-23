import { TENANT_TYPE_LABELS, type AdminDashboardResponse, type TenantType } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
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
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Platform overview</h1>
        <Link to="/admin/tenants">
          <Button variant="primary">Onboard a tenant</Button>
        </Link>
      </div>

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
              label="awaiting a verdict"
              detail="Sent to a provider over an hour ago with no response."
              to="/admin/transmissions?status=SUBMITTED_TO_ASP"
              tone="warn"
            />
            <Attention
              count={a.rejectedByFta}
              label="rejected by the FTA"
              detail="Not filed. The tenant must correct and resubmit."
              to="/admin/transmissions?status=REJECTED_BY_FTA"
              tone="danger"
            />
            <Attention
              count={a.validationFailed}
              label="failed validation"
              detail="Never reached a provider."
              to="/admin/transmissions?status=VALIDATION_FAILED"
              tone="danger"
            />
            <Attention
              count={a.tenantsPendingActivation}
              label="tenants pending activation"
              detail="Onboarded but not yet able to file."
              to="/admin/tenants"
              tone="warn"
            />
            <Attention
              count={a.aspNotConfigured}
              label="provider connections not live"
              detail="These tenants cannot submit until the connection is active."
              to="/admin/tenants"
              tone="warn"
            />
            <Attention
              count={a.pendingInvites}
              label="invitations not accepted"
              detail="Accounts created but never signed in to."
              to="/admin/staff"
              tone="warn"
            />
            <Attention
              count={a.failedMail}
              label="e-mails failed this week"
              detail="Delivery was attempted and refused."
              to="/admin/mail"
              tone="danger"
            />
          </div>
        )}
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Tenants" value={data.tenants.total.toLocaleString()}>
          <span className="text-xs text-slate-500">
            {data.tenants.byStatus.ACTIVE ?? 0} active · {data.tenants.byStatus.SUSPENDED ?? 0}{' '}
            suspended
          </span>
        </Stat>
        <Stat label="Users" value={data.users.total.toLocaleString()}>
          <span className="text-xs text-slate-500">
            {data.users.active.toLocaleString()} active
          </span>
        </Stat>
        <Stat label="Invoices (30 days)" value={data.invoices.last30Days.toLocaleString()}>
          <span className="text-xs text-slate-500">
            {data.invoices.total.toLocaleString()} all time
          </span>
        </Stat>
        <Stat label="Cleared value" value={`AED ${formatAmount(data.invoices.clearedValueAed)}`}>
          <span className="text-xs text-slate-500">Accepted by the FTA</span>
        </Stat>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Tenants by tier">
          <ul className="space-y-2 text-sm">
            {(Object.keys(TENANT_TYPE_LABELS) as TenantType[])
              .filter((type) => type !== 'HOST')
              .map((type) => (
                <li key={type} className="flex items-center justify-between">
                  <span className="text-slate-600">{TENANT_TYPE_LABELS[type]}</span>
                  <span className="font-medium tabular-nums text-slate-900">
                    {(data.tenants.byType[type] ?? 0).toLocaleString()}
                  </span>
                </li>
              ))}
          </ul>
        </Card>

        <Card title="Invoices by status">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                'VALIDATED',
                'PENDING_CFO_APPROVAL',
                'SUBMITTED_TO_ASP',
                'ACCEPTED_BY_FTA',
                'REJECTED_BY_FTA',
                'VALIDATION_FAILED',
              ] as const
            ).map((status) => (
              <Link
                key={status}
                to={`/admin/transmissions?status=${status}`}
                className="rounded-lg border border-slate-200 p-2 transition-colors hover:border-brand-500 hover:bg-brand-50/40"
              >
                <div className="text-xl font-semibold tabular-nums text-slate-900">
                  {(data.invoices.byStatus[status] ?? 0).toLocaleString()}
                </div>
                <StatusBadge status={status} className="mt-1" />
              </Link>
            ))}
          </div>
        </Card>
      </div>

      <ActivityChart data={data.last30DaysTrend} />

      <Card
        title="Busiest tenants (30 days)"
        actions={
          <Link to="/admin/tenants" className="text-sm text-brand-600 underline">
            All tenants
          </Link>
        }
      >
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
                  <td className="py-2">
                    <Link
                      to={`/admin/tenants/${tenant.tenantId}`}
                      className="font-medium text-brand-600 underline"
                    >
                      {tenant.tenantName}
                    </Link>
                  </td>
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
  children,
}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
      {children}
    </div>
  );
}

/** Rendered only when it is non-zero — a wall of noughts is not attention. */
function Attention({
  count,
  label,
  detail,
  to,
  tone,
}: {
  count: number;
  label: string;
  detail: string;
  to: string;
  tone: 'danger' | 'warn';
}) {
  if (count === 0) return null;

  return (
    <Link
      to={to}
      className={cx(
        'block rounded-lg border p-3 transition-colors',
        tone === 'danger'
          ? 'border-danger-200 bg-danger-50 hover:bg-danger-50/70'
          : 'border-warn-200 bg-warn-50 hover:bg-warn-50/70',
      )}
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

/**
 * Platform-wide version of the merchant chart. Same hand-rolled bars for the
 * same reason: three series of thirty values does not justify a charting
 * dependency, and this one stays accessible and printable.
 */
function ActivityChart({ data }: { data: AdminDashboardResponse['last30DaysTrend'] }) {
  const max = Math.max(1, ...data.map((d) => d.submitted));
  const total = data.reduce((sum, d) => sum + d.submitted, 0);

  return (
    <Card title="Last 30 days, all tenants">
      {total === 0 ? (
        <p className="py-4 text-center text-sm text-slate-500">
          No invoices have been ingested in the last 30 days.
        </p>
      ) : (
        <>
          <div className="flex items-end gap-1" style={{ height: 120 }}>
            {data.map((day) => {
              const height = (day.submitted / max) * 100;
              const accepted = day.submitted > 0 ? (day.accepted / day.submitted) * height : 0;
              const rejected = day.submitted > 0 ? (day.rejected / day.submitted) * height : 0;
              const pending = height - accepted - rejected;

              return (
                <div
                  key={day.date}
                  className="flex flex-1 flex-col justify-end"
                  style={{ height: '100%' }}
                  title={`${day.date}: ${day.submitted} ingested, ${day.accepted} accepted, ${day.rejected} rejected`}
                >
                  {rejected > 0 && (
                    <div className="bg-danger-500" style={{ height: `${rejected}%` }} />
                  )}
                  {pending > 0.5 && (
                    <div className="bg-warn-500" style={{ height: `${pending}%` }} />
                  )}
                  {accepted > 0 && <div className="bg-ok-500" style={{ height: `${accepted}%` }} />}
                  {day.submitted === 0 && <div className="h-px bg-slate-200" />}
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex gap-4 text-xs text-slate-600">
            <Legend colour="bg-ok-500" label="Accepted" />
            <Legend colour="bg-warn-500" label="In flight" />
            <Legend colour="bg-danger-500" label="Rejected" />
          </div>
        </>
      )}
    </Card>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx('inline-block h-2.5 w-2.5 rounded-sm', colour)} />
      {label}
    </span>
  );
}
