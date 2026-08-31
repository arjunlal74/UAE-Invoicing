import type {
  BalanceResponse,
  BundleSummary,
  LoginResponse,
  PaginatedResult,
  PartnerOverview,
  SubTenantSummary,
} from '@uae/contracts';
import { PROVISIONING_MODE_LABELS } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Modal,
  PageHeader,
  Spinner,
  StatusBadge,
  cx,
  formatDate,
  inputClass,
} from '../../components/ui';
import { CreateSubTenantModal } from '../../components/SubTenantFormModal';
import { CustodyStaffModal } from '../../components/CustodyStaffModal';
import { ProvisioningModeModal } from '../../components/ProvisioningModeModal';
import { SubTenantRecordModal } from '../../components/SubTenantRecordModal';
import { ApiError, api, queryString } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';

/**
 * The channel partner's book of clients (SRS v2.1 §2).
 *
 * A partner sees who is onboarded underneath it and how much they are filing —
 * never the invoices themselves. The API enforces that boundary; this screen
 * simply has nothing that would ask for them.
 *
 * A list, and only a list. Onboarding is a dialog rather than a panel above the
 * table, because the two are different visits: a partner arrives here far more
 * often to look somebody up than to add somebody, and the form used to push the
 * rows they came for off the bottom of the screen. The roll-up figures moved to
 * the dashboard for the same reason.
 */
export function PartnerSubTenantsPage() {
  // Seeded from the URL so a dashboard tile lands on the rows it counted rather
  // than on every client with the question discarded.
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const statusFilter = params.get('status') ?? '';
  const aspFilter = params.get('aspStatus') ?? '';
  const invitesFilter = params.get('invites') ?? '';

  const modeFilter = params.get('mode') ?? '';

  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<SubTenantSummary | null>(null);
  const [editing, setEditing] = useState<SubTenantSummary | null>(null);
  const [allocatingTo, setAllocatingTo] = useState<SubTenantSummary | null>(null);
  const [staffFor, setStaffFor] = useState<SubTenantSummary | null>(null);
  const [changingMode, setChangingMode] = useState<SubTenantSummary | null>(null);
  const [custodyError, setCustodyError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const enterCustody = useAuthStore((s) => s.enterCustody);

  /** Filters live in the URL, so the screen a partner is looking at can be sent. */
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const overview = useQuery({
    queryKey: ['partner-overview'],
    queryFn: () => api<PartnerOverview>('/api/v1/partner/overview'),
  });

  // A partner's own bundles are its master pools (§15.4). The `unallocatedUnits`
  // on each is what governs whether another slice can be cut for a client.
  const balance = useQuery({
    queryKey: ['partner-balance'],
    queryFn: () => api<BalanceResponse>('/api/v1/billing/balance'),
  });

  const pools = balance.data?.bundles ?? [];
  const unallocated = pools
    .filter((pool) => pool.status === 'ACTIVE')
    .reduce((sum, pool) => sum + pool.unallocatedUnits, 0);

  const listQuery = queryString({
    q: search,
    status: statusFilter,
    aspStatus: aspFilter,
    invites: invitesFilter,
    mode: modeFilter,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['partner-sub-tenants', search, statusFilter, aspFilter, invitesFilter, modeFilter],
    queryFn: () =>
      api<PaginatedResult<SubTenantSummary>>(`/api/v1/partner/sub-tenants${listQuery}`),
  });

  const filtered = Boolean(statusFilter || aspFilter || invitesFilter || modeFilter || search);

  /**
   * Opening a client's books (§3).
   *
   * The session that comes back belongs to the client, not to the partner, so
   * the cache is emptied before landing in it: every query already in memory
   * was answered for the partner, and a stale one rendered under the client's
   * name would be showing one company another's figures.
   */
  const openCustody = useMutation({
    mutationFn: (tenant: SubTenantSummary) =>
      api<LoginResponse>(`/api/v1/partner/sub-tenants/${tenant.id}/custody-session`, {
        method: 'POST',
      }),
    onSuccess: (session) => {
      setCustodyError(null);
      queryClient.clear();
      enterCustody(session);
      navigate('/');
    },
    onError: (err) =>
      setCustodyError(
        err instanceof ApiError ? err.message : 'That account could not be opened.',
      ),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={overview.data?.partnerName ?? 'Sub-tenants'}
        description="Companies you onboard and manage on the platform."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Onboard a sub-tenant
          </Button>
        }
      />

      {custodyError && <Alert kind="danger">{custodyError}</Alert>}

      {pools.length > 0 && unallocated === 0 && (
        <Alert kind="warn" title="Your master pool is fully allocated">
          Every unit has been promised to a client. Existing sub-tenants can keep filing against
          their slices, but a new one cannot be given units until the pool is topped up.
        </Alert>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <input
            className={`${inputClass} max-w-xs`}
            placeholder="Search by name, code or TRN"
            defaultValue={search}
            onBlur={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSearch((e.target as HTMLInputElement).value);
            }}
          />
          <select
            className={`${inputClass} max-w-[12rem]`}
            value={statusFilter}
            onChange={(e) => setFilter('status', e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="ARCHIVED">Archived</option>
          </select>
          <select
            className={`${inputClass} max-w-[16rem]`}
            value={aspFilter}
            onChange={(e) => setFilter('aspStatus', e.target.value)}
          >
            <option value="">Any provider connection</option>
            <option value="NOT_LIVE">Connection not live</option>
            <option value="ACTIVE">Connection active</option>
          </select>
          <select
            className={`${inputClass} max-w-[16rem]`}
            value={modeFilter}
            onChange={(e) => setFilter('mode', e.target.value)}
          >
            <option value="">Both provisioning modes</option>
            <option value="FULLY_MANAGED_CUSTODY">
              {PROVISIONING_MODE_LABELS.FULLY_MANAGED_CUSTODY}
            </option>
            <option value="COLLABORATIVE">{PROVISIONING_MODE_LABELS.COLLABORATIVE}</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={invitesFilter === 'pending'}
              onChange={(e) => setFilter('invites', e.target.checked ? 'pending' : '')}
            />
            Invitation not accepted
          </label>
          {filtered && (
            <Button
              size="sm"
              onClick={() => {
                setSearch('');
                setParams(new URLSearchParams(), { replace: true });
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading sub-tenants…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title={filtered ? 'No sub-tenants match' : 'No sub-tenants yet'}
            description={
              filtered
                ? 'Nothing in your book answers that. Clear the filters to see every client.'
                : 'Onboard your first client to start filing on their behalf.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">TRN</th>
                <th className="px-4 py-2 font-medium">Provisioning</th>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 text-right font-medium">Users</th>
                <th className="px-4 py-2 text-right font-medium">Invoices</th>
                <th className="px-4 py-2 font-medium">Onboarded</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((tenant) => (
                <tr key={tenant.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-800">{tenant.legalNameEn}</div>
                    <div className="text-xs text-slate-400">{tenant.companyCode}</div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{tenant.trn ?? '—'}</td>
                  <td className="px-4 py-2">
                    <ModeCell tenant={tenant} />
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={tenant.status} />
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={tenant.aspStatus} />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{tenant.userCount}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{tenant.invoiceCount}</td>
                  <td className="px-4 py-2 text-slate-500">{formatDate(tenant.createdAt)}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        className={ACTION}
                        label="View"
                        onClick={() => setViewing(tenant)}
                      >
                        <Icon name="view" />
                      </Button>

                      <Button
                        size="sm"
                        className={ACTION}
                        label="Edit"
                        disabled={tenant.isLocked}
                        title={
                          tenant.isLocked
                            ? 'Locked by the platform. Ask them to unlock it to edit.'
                            : 'Edit'
                        }
                        onClick={() => setEditing(tenant)}
                      >
                        <Icon name="edit" />
                      </Button>

                      {/* Custody only: there are no books of somebody else's to
                          open, and nobody to authorise, when the client runs its
                          own account. */}
                      {tenant.provisioningMode === 'FULLY_MANAGED_CUSTODY' && (
                        <>
                          <Button
                            size="sm"
                            variant="primary"
                            className={ACTION}
                            label="Open books"
                            disabled={openCustody.isPending}
                            onClick={() => openCustody.mutate(tenant)}
                          >
                            <Icon name="books" />
                          </Button>
                          <Button
                            size="sm"
                            className={ACTION}
                            label="Authorised staff"
                            onClick={() => setStaffFor(tenant)}
                          >
                            <Icon name="staff" />
                          </Button>
                        </>
                      )}

                      <Button
                        size="sm"
                        className={ACTION}
                        label="Change provisioning mode"
                        onClick={() => setChangingMode(tenant)}
                      >
                        <Icon name="swap" />
                      </Button>

                      <Button
                        size="sm"
                        className={ACTION}
                        label="Allocate units"
                        onClick={() => setAllocatingTo(tenant)}
                      >
                        <Icon name="allocate" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CreateSubTenantModal onClose={() => setCreating(false)} />}
      {viewing && (
        <SubTenantRecordModal subTenant={viewing} readOnly onClose={() => setViewing(null)} />
      )}
      {editing && (
        <SubTenantRecordModal subTenant={editing} onClose={() => setEditing(null)} />
      )}
      {staffFor && (
        <CustodyStaffModal subTenant={staffFor} onClose={() => setStaffFor(null)} />
      )}
      {changingMode && (
        <ProvisioningModeModal subTenant={changingMode} onClose={() => setChangingMode(null)} />
      )}

      {allocatingTo && (
        <AllocateSliceModal
          subTenant={allocatingTo}
          pools={pools}
          onClose={() => setAllocatingTo(null)}
          onDone={() => {
            setAllocatingTo(null);
            queryClient.invalidateQueries({ queryKey: ['partner-balance'] });
            queryClient.invalidateQueries({ queryKey: ['partner-overview'] });
            queryClient.invalidateQueries({ queryKey: ['partner-dashboard'] });
          }}
        />
      )}
    </div>
  );
}

/**
 * Every verb the same width, so the column reads as a column.
 *
 * Icons rather than words, on the same reasoning as the platform's tenant list:
 * a custody row carries six actions, and six labelled buttons took more of the
 * row than the figures did. Each keeps its verb as an accessible name and a
 * tooltip — a glyph is shorthand for someone who already knows what it means,
 * never the only way to find out.
 */
const ACTION = 'w-9 justify-center';

/**
 * Which of the two modes a client is in, and — for a custody client — whether
 * anyone can actually work in it (§3).
 *
 * The staff count is on the same line as the mode rather than in a column of
 * its own because it only means anything for one of the two, and a column that
 * is empty on half the rows reads as missing data. Zero is called out: a
 * custody client nobody is authorised for is an account whose filing has
 * stopped, not a quiet one.
 */
function ModeCell({ tenant }: { tenant: SubTenantSummary }) {
  const custody = tenant.provisioningMode === 'FULLY_MANAGED_CUSTODY';

  return (
    <div>
      <span
        className={cx(
          'inline-block rounded px-1.5 py-0.5 text-xs font-medium',
          custody ? 'bg-violet-100 text-violet-800' : 'bg-slate-100 text-slate-600',
        )}
      >
        {custody ? 'Custody' : 'Collaborative'}
      </span>
      {custody && (
        <div
          className={cx(
            'mt-0.5 text-xs',
            tenant.custodyStaffCount === 0 ? 'font-medium text-warn-700' : 'text-slate-500',
          )}
        >
          {tenant.custodyStaffCount === 0
            ? 'nobody authorised'
            : `${tenant.custodyStaffCount} authorised`}
        </div>
      )}
    </div>
  );
}

/**
 * Carving a slice out of the partner's master pool — §15.4.
 *
 * The two figures a partner needs are different questions and both are on
 * screen: *unallocated* is how much of the pool has not been promised to a
 * client yet, and governs whether this slice can be cut; *remaining* is how much
 * has not been filed. A partner can have allocated every unit it owns and still
 * have most of them unspent, so showing only one of them would answer the wrong
 * question half the time.
 */
function AllocateSliceModal({
  subTenant,
  pools,
  onClose,
  onDone,
}: {
  subTenant: SubTenantSummary;
  pools: BundleSummary[];
  onClose: () => void;
  onDone: () => void;
}) {
  const usable = pools.filter((p) => p.status === 'ACTIVE' && p.unallocatedUnits > 0);

  const [form, setForm] = useState({
    parentBundleId: usable.length === 1 ? usable[0]!.id : '',
    reference: `SLICE-${subTenant.companyCode}-${new Date().toISOString().slice(0, 7)}`,
    purchasedUnits: '',
    minimumBufferUnits: '',
    expiresAt: '',
  });

  const units = Number(form.purchasedUnits) || 0;
  const pool = usable.find((p) => p.id === form.parentBundleId);
  const overPool = pool ? units > pool.unallocatedUnits : false;

  const create = useMutation({
    mutationFn: () =>
      api('/api/v1/billing/bundles', {
        method: 'POST',
        body: {
          tenantId: subTenant.id,
          parentBundleId: form.parentBundleId,
          reference: form.reference.trim(),
          purchasedUnits: units,
          allowOverage: false,
          minimumBufferUnits: Number(form.minimumBufferUnits) || 0,
          expiresAt: form.expiresAt || null,
        },
      }),
    onSuccess: onDone,
  });

  return (
    <Modal title={`Allocate units to ${subTenant.legalNameEn}`} onClose={onClose}>
      <div className="space-y-4">
        {usable.length === 0 ? (
          <Alert kind="warn" title="No pool with units left to allocate">
            Every unit in your master pools has already been promised to a client. Ask your account
            manager to top up before onboarding another.
          </Alert>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              A slice comes out of your master pool. When this client files an invoice the unit is
              deducted from their slice <em>and</em> from the pool it was cut from.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From master pool">
                <select
                  className={inputClass}
                  value={form.parentBundleId}
                  onChange={(e) => setForm({ ...form, parentBundleId: e.target.value })}
                >
                  <option value="">Select a pool…</option>
                  {usable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.reference} · {p.unallocatedUnits.toLocaleString()} unallocated
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reference" hint="Unique for this client.">
                <input
                  className={inputClass}
                  value={form.reference}
                  onChange={(e) => setForm({ ...form, reference: e.target.value })}
                />
              </Field>
              <Field label="Units">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={form.purchasedUnits}
                  onChange={(e) => setForm({ ...form, purchasedUnits: e.target.value })}
                  placeholder="5000"
                />
              </Field>
              <Field
                label="Low-balance alert at"
                hint="Units left before you and they are emailed. Blank for none."
              >
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={form.minimumBufferUnits}
                  onChange={(e) => setForm({ ...form, minimumBufferUnits: e.target.value })}
                  placeholder="500"
                />
              </Field>
              <Field label="Expires" hint="Leave blank if the units do not lapse.">
                <input
                  className={inputClass}
                  type="date"
                  value={form.expiresAt}
                  onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                />
              </Field>
            </div>

            {pool && (
              <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                <strong>{pool.reference}</strong>:{' '}
                <span className="tabular-nums">{pool.unallocatedUnits.toLocaleString()}</span>{' '}
                unallocated of {pool.purchasedUnits.toLocaleString()}, and{' '}
                <span className="tabular-nums">{pool.remainingUnits.toLocaleString()}</span> not yet
                filed against.
                {units > 0 && !overPool && (
                  <>
                    {' '}
                    After this slice:{' '}
                    <strong className="tabular-nums">
                      {(pool.unallocatedUnits - units).toLocaleString()}
                    </strong>{' '}
                    left to allocate.
                  </>
                )}
              </div>
            )}

            {overPool && (
              <Alert kind="danger" title="More than the pool has left">
                {units.toLocaleString()} units against {pool!.unallocatedUnits.toLocaleString()}{' '}
                unallocated. Reduce the slice, or have your master pool topped up.
              </Alert>
            )}

            {create.error && (
              <Alert kind="danger">
                {create.error instanceof ApiError
                  ? create.error.message
                  : 'That allocation could not be made.'}
              </Alert>
            )}
          </>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          {usable.length > 0 && (
            <Button
              variant="primary"
              disabled={
                !form.parentBundleId ||
                form.reference.trim().length < 2 ||
                units < 1 ||
                overPool ||
                create.isPending
              }
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Allocating…' : 'Allocate units'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
