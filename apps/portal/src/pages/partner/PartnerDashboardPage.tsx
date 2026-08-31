import type { PartnerDashboardResponse } from '@uae/contracts';
import { formatAmount } from '@uae/domain';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Spinner, StatusBadge, cx, formatDateTime } from '../../components/ui';
import { CreateSubTenantModal } from '../../components/SubTenantFormModal';
import { api } from '../../lib/api';

/**
 * The channel partner's landing page.
 *
 * Built to the same plan as the platform operator's dashboard, and for the same
 * reason: a partner arrives asking "is anything broken, and is anyone stuck
 * waiting on me?", so the tiles that need action come first and link to the
 * screen where the action is taken, and the totals sit underneath as context.
 *
 * What differs is the reach, not the shape. A partner sees its own book of
 * clients and nothing else, and it has no invoice screens at all — so the three
 * tiles counting documents in trouble are read-outs rather than links. They stay
 * on the page because a partner is the one its clients telephone, and "twelve of
 * your clients' invoices were refused" is worth knowing before the call comes,
 * even when the fix is theirs to make.
 */
export function PartnerDashboardPage() {
  // The same dialog the list opens. Onboarding is the one thing a partner comes
  // here to *do* rather than to read, and sending them to another screen first
  // to press the same button would be a step for nothing.
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['partner-dashboard'],
    queryFn: () => api<PartnerDashboardResponse>('/api/v1/partner/dashboard'),
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
    a.subTenantsPendingActivation +
    a.aspNotConfigured +
    a.pendingInvites +
    a.subTenantsWithoutUnits +
    a.subTenantsBelowBuffer +
    a.custodyWithoutStaff +
    a.rejectedByFta +
    a.stuckTransmissions +
    a.validationFailed;

  const clearanceRate =
    data.invoices.total === 0
      ? null
      : Math.round((data.invoices.accepted / data.invoices.total) * 1000) / 10;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{data.partnerName}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Your book of clients, and what it is filing.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          Onboard a sub-tenant
        </Button>
      </div>

      {creating && <CreateSubTenantModal onClose={() => setCreating(false)} />}

      {a.poolFullyAllocated && (
        <Alert kind="warn" title="Your master pool is fully allocated">
          Every unit you own has been promised to a client. They can keep filing against their
          slices, but a new client cannot be given units until the pool is topped up.{' '}
          <Link to="/partner/inventory" className="underline">
            Open your data inventory
          </Link>
          .
        </Alert>
      )}

      {data.inventory.purchasedUnits === 0 && (
        <Alert kind="warn" title="You have no active master bundle">
          Nothing can be allocated to a client until the platform sells you one. Your clients can
          prepare invoices in the meantime, but none of them will file.
        </Alert>
      )}

      <Card title="Needs attention">
        {attentionTotal === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">
            Nothing is waiting. No pending activations, unallocated clients or refused documents.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {/* §3: first, because it is the only one of these that means work
                has stopped rather than slowed. A custody client is one the
                partner files for, and nobody can open it. */}
            <Attention
              count={a.custodyWithoutStaff}
              label="Custody clients with no staff"
              shade="violet"
              detail="You file for these, and nobody at your firm is authorised to open them."
              to="/partner/sub-tenants?mode=FULLY_MANAGED_CUSTODY"
              tone="danger"
            />
            <Attention
              count={a.subTenantsPendingActivation}
              label="Clients pending activation"
              shade="sky"
              detail="Onboarded but not yet able to file."
              to="/partner/sub-tenants?status=PENDING"
              tone="warn"
            />
            <Attention
              count={a.aspNotConfigured}
              label="Provider connections not live"
              shade="cyan"
              detail="The platform activates these; your client cannot submit until it does."
              to="/partner/sub-tenants?aspStatus=NOT_LIVE"
              tone="warn"
            />
            <Attention
              count={a.pendingInvites}
              label="Invitations not accepted"
              shade="teal"
              detail="You sent these, so you are who chases them."
              to="/partner/sub-tenants?invites=pending"
              tone="warn"
            />
            <Attention
              count={a.subTenantsWithoutUnits}
              label="Clients with no units"
              shade="amber"
              detail="Never allocated a slice, so nothing they prepare can be filed."
              to="/partner/sub-tenants"
              tone="warn"
            />
            <Attention
              count={a.subTenantsBelowBuffer}
              label="Slices below their floor"
              shade="orange"
              detail="Running out. Top them up before their filing stops."
              to="/partner/inventory"
              tone="warn"
            />
            {/* No link on the three below: a partner has no invoice screen, by
                design. Sending them to a list they are not allowed to read
                would be worse than the count on its own. */}
            <Attention
              count={a.rejectedByFta}
              label="Rejected by the FTA"
              shade="rose"
              detail="Your clients' documents. They must correct and resubmit."
              tone="danger"
            />
            <Attention
              count={a.stuckTransmissions}
              label="Awaiting a verdict"
              shade="fuchsia"
              detail="With a provider for over an hour. The platform is looking at these."
              tone="warn"
            />
            <Attention
              count={a.validationFailed}
              label="Failed validation"
              shade="rose"
              detail="Never reached a provider."
              tone="danger"
            />
          </div>
        )}
      </Card>

      {/* Who is in the book, and how much of the pool is spoken for. The two
          inventory figures are different questions — what is left to promise a
          client, and what is left to file — and a partner regularly has none of
          the first and plenty of the second. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sub-tenants" shade="emerald" value={data.subTenants.total.toLocaleString()}>
          <span className="text-xs text-slate-500">
            {(data.subTenants.byStatus.ACTIVE ?? 0).toLocaleString()} active
          </span>
        </Stat>
        {/* §3, and the tile a partner reads first: how much of the book it runs
            itself. The two modes are different businesses — one is software you
            resell, the other is work your staff do. */}
        <Stat
          label="In your custody"
          shade="violet"
          value={(data.subTenants.byMode.FULLY_MANAGED_CUSTODY ?? 0).toLocaleString()}
        >
          <span className="text-xs text-slate-500">
            {(data.subTenants.byMode.COLLABORATIVE ?? 0).toLocaleString()} run their own account
          </span>
        </Stat>
        <Stat label="Client users" shade="cyan" value={data.users.total.toLocaleString()}>
          <span className="text-xs text-slate-500">
            {data.users.active.toLocaleString()} active
          </span>
        </Stat>
        <Stat label="Invoices filed" shade="sky" value={data.invoices.total.toLocaleString()}>
          <span className="text-xs text-slate-500">
            {data.invoices.last30Days.toLocaleString()} in the last 30 days
          </span>
        </Stat>
        <Stat
          label="Cleared by the FTA"
          shade="lime"
          value={data.invoices.accepted.toLocaleString()}
        >
          <span className="text-xs text-slate-500">
            {clearanceRate === null ? 'Nothing filed yet' : `${clearanceRate}% of what was filed`}
          </span>
        </Stat>
        <Stat
          label="Units purchased"
          shade="slate"
          value={data.inventory.purchasedUnits.toLocaleString()}
        />
        <Stat
          label="Units allocated"
          shade="violet"
          value={data.inventory.allocatedUnits.toLocaleString()}
        >
          <span className="text-xs text-slate-500">Promised to a client</span>
        </Stat>
        <Stat
          label="Units to allocate"
          shade="amber"
          value={data.inventory.unallocatedUnits.toLocaleString()}
        >
          <span className="text-xs text-slate-500">Free to promise</span>
        </Stat>
        <Stat
          label="Units left to file"
          shade="teal"
          value={data.inventory.remainingUnits.toLocaleString()}
        >
          <span className="text-xs text-slate-500">
            {data.inventory.consumedUnits.toLocaleString()} spent
          </span>
        </Stat>
      </div>

      <Card
        title="Busiest clients (30 days)"
        actions={
          <Link to="/partner/sub-tenants" className="text-sm text-brand-600 underline">
            All sub-tenants
          </Link>
        }
      >
        {data.topSubTenants.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">
            No clients onboarded yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Client</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Invoices</th>
                <th className="pb-2 text-right font-medium">Accepted</th>
                <th className="pb-2 text-right font-medium">Rejected</th>
                <th className="pb-2 text-right font-medium">Value (AED)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.topSubTenants.map((tenant) => (
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

      <Card title="Recent activity">
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
 * The same palette the platform dashboard uses, for the same reason: these are
 * identity, not severity. Every one is a 50, pale enough that the figure sitting
 * on it stays the loudest thing in the tile — which matters most on an attention
 * tile, since it only appears when something is wrong and the severity has to
 * survive the tint.
 */
const TILE_SHADES = {
  amber: 'border-amber-200 bg-amber-50',
  rose: 'border-rose-200 bg-rose-50',
  orange: 'border-orange-200 bg-orange-50',
  sky: 'border-sky-200 bg-sky-50',
  violet: 'border-violet-200 bg-violet-50',
  teal: 'border-teal-200 bg-teal-50',
  fuchsia: 'border-fuchsia-200 bg-fuchsia-50',
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
  /** Where the action is taken. Absent where a partner has no such screen. */
  to?: string;
  /** Severity. Kept on the figure, which frees the tint to be identity. */
  tone: 'danger' | 'warn';
  shade: keyof typeof TILE_SHADES;
}) {
  if (count === 0) return null;

  const body = (
    <>
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
    </>
  );

  if (!to) {
    return <div className={cx('rounded-lg border p-3', TILE_SHADES[shade])}>{body}</div>;
  }

  return (
    <Link
      to={to}
      className={cx(
        'block rounded-lg border p-3 transition-colors hover:brightness-95',
        TILE_SHADES[shade],
      )}
    >
      {body}
    </Link>
  );
}
