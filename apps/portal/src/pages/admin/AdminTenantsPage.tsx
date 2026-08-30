import type {
  PaginatedResult,
  ProviderSummary,
  TenantSummary,
  TenantType,
} from '@uae/contracts';
import { TENANT_TYPE_LABELS } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EMIRATES } from '@uae/domain';
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
  Spinner,
  StatusBadge,
  formatDate,
  statusLabel,
  inputClass,
} from '../../components/ui';
import { PdfActions } from '../../components/PdfActions';
import { TenantFormModal } from '../../components/TenantFormModal';
import { ApiError, api, queryString } from '../../lib/api';

/**
 * Tenant list and onboarding — the first screen of the admin panel, and the
 * first thing that has to work: nobody can use the product until a tenant
 * exists here.
 */
export function AdminTenantsPage() {
  // Seeded from the URL so a dashboard tile lands on the rows it counted
  // rather than on every tenant with the question discarded.
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(params.get('status') ?? '');
  const [typeFilter, setTypeFilter] = useState('');
  const [aspFilter, setAspFilter] = useState(params.get('aspStatus') ?? '');
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<TenantSummary | null>(null);
  const navigate = useNavigate();

  const exportQuery = queryString({
    q: search,
    status: statusFilter,
    tenantType: typeFilter,
    aspStatus: aspFilter,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['admin-tenants', search, statusFilter, typeFilter, aspFilter],
    queryFn: () =>
      api<PaginatedResult<TenantSummary>>(
        `/api/v1/admin/tenants${queryString({
          q: search,
          status: statusFilter,
          tenantType: typeFilter,
          aspStatus: aspFilter,
        })}`,
      ),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-900">Tenants</h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* The files cover the filtered list, not everything: a printed
              directory that quietly held a different set from the screen it
              was printed from is worse than none, because the reader cannot
              tell which one is wrong. */}
          <PdfActions
            path={`/api/v1/admin/tenants.pdf${exportQuery}`}
            xlsxPath={`/api/v1/admin/tenants.xlsx${exportQuery}`}
            disabled={!data?.items.length}
            label="PDF"
          />
          <Button variant="primary" onClick={() => setCreating(true)}>
            Onboard a tenant
          </Button>
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap gap-3">
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
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="ARCHIVED">Archived</option>
          </select>
          <select
            className={`${inputClass} max-w-[14rem]`}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">All tiers</option>
            {(Object.keys(TENANT_TYPE_LABELS) as TenantType[]).map((type) => (
              <option key={type} value={type}>
                {TENANT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading tenants…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title="No tenants"
            description="Onboard your first customer to get started."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Tier</th>
                <th className="px-4 py-2 font-medium">TRN</th>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 text-right font-medium">Invoices</th>
                <th className="px-4 py-2 font-medium">Onboarded</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((tenant) => (
                <tr key={tenant.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <div className="text-slate-800">{tenant.legalNameEn}</div>
                    <div className="arabic text-xs text-slate-500" lang="ar">
                      {tenant.legalNameAr}
                    </div>
                    <div className="text-xs text-slate-400">{tenant.companyCode}</div>
                  </td>
                  <td className="px-4 py-2">
                    <div className="text-slate-700">{TENANT_TYPE_LABELS[tenant.tenantType]}</div>
                    {tenant.parentName && (
                      <div className="text-xs text-slate-400">under {tenant.parentName}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{tenant.trn ?? '—'}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={tenant.status} />
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={tenant.aspStatus} />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{tenant.invoiceCount}</td>
                  <td className="px-4 py-2 text-slate-500">{formatDate(tenant.createdAt)}</td>
                  <td className="px-4 py-2">
                    <TenantActions
                      tenant={tenant}
                      onView={() => setViewing(tenant)}
                      onEdit={() => navigate(`/admin/tenants/${tenant.id}?edit=1`)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CreateTenantModal onClose={() => setCreating(false)} />}
      {viewing && <TenantFormModal tenant={viewing} readOnly onClose={() => setViewing(null)} />}
    </div>
  );
}

/**
 * Every verb the same width, so the column reads as a column.
 *
 * Icons rather than words: the row already carries eight columns, and four
 * labelled buttons took more of it than the figures did. Each one keeps its
 * verb as an accessible name and a tooltip — a glyph is shorthand for someone
 * who already knows what it means, never the only way to find out.
 */
const ACTION = 'w-9 justify-center';

/**
 * The four things an operator does to a tenant from the list.
 *
 * Lock and Suspend are deliberately separate buttons, because they are
 * separate questions. Locking freezes the record against edits and does not
 * touch filing; suspending stops the merchant filing and leaves their details
 * editable. Folding them into one control — as this page first did — means an
 * operator protecting a record from a typo takes a live merchant off the air.
 *
 * Editing is refused while locked, which is the whole point of the lock, so
 * the button says so rather than failing at the server.
 */
function TenantActions({
  tenant,
  onView,
  onEdit,
}: {
  tenant: TenantSummary;
  onView: () => void;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
  };
  const fail = (cause: unknown, fallback: string) =>
    setError(cause instanceof ApiError ? cause.message : fallback);

  const setLock = useMutation({
    mutationFn: (isLocked: boolean) =>
      api(`/api/v1/admin/tenants/${tenant.id}`, { method: 'PATCH', body: { isLocked } }),
    onSuccess: refresh,
    onError: (cause) => fail(cause, 'That record could not be locked.'),
  });

  const setStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'SUSPENDED') =>
      api(`/api/v1/admin/tenants/${tenant.id}/status`, {
        method: 'POST',
        // Omitted rather than nulled when reactivating: the field is optional,
        // not nullable, and a null fails validation.
        body: {
          status,
          ...(status === 'SUSPENDED' ? { reason: 'Suspended from the tenant list.' } : {}),
        },
      }),
    onSuccess: refresh,
    onError: (cause) => fail(cause, 'That status could not be changed.'),
  });

  const busy = setLock.isPending || setStatus.isPending;
  const suspended = tenant.status === 'SUSPENDED';

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex justify-end gap-1">
        <Button size="sm" className={ACTION} label="View" onClick={onView}>
          <Icon name="view" />
        </Button>

        <Button
          size="sm"
          className={ACTION}
          label="Edit"
          disabled={tenant.isLocked || busy}
          title={tenant.isLocked ? 'This record is locked. Unlock it to edit.' : 'Edit'}
          onClick={onEdit}
        >
          <Icon name="edit" />
        </Button>

        <Button
          size="sm"
          className={ACTION}
          label={tenant.isLocked ? 'Unlock' : 'Lock'}
          disabled={busy}
          title={
            tenant.isLocked
              ? 'Unlock — this record is frozen against edits. Filing is unaffected.'
              : 'Lock — freeze this record against edits. Filing is unaffected.'
          }
          onClick={() => setLock.mutate(!tenant.isLocked)}
        >
          <Icon name={tenant.isLocked ? 'unlock' : 'lock'} />
        </Button>

        <Button
          size="sm"
          className={ACTION}
          label={suspended ? 'Reactivate' : 'Suspend'}
          variant={suspended ? 'secondary' : 'danger'}
          disabled={busy}
          title={
            suspended
              ? 'Reactivate — let this tenant file again.'
              : 'Suspend — stop this tenant filing. Their record stays editable.'
          }
          onClick={() => setStatus.mutate(suspended ? 'ACTIVE' : 'SUSPENDED')}
        >
          <Icon name={suspended ? 'reactivate' : 'suspend'} />
        </Button>
      </div>

      {/* Below the row rather than beside it: an inline message pushed the
          buttons out of line and the column stopped being a column. */}
      {error && <span className="max-w-md text-right text-xs text-danger-700">{error}</span>}
    </div>
  );
}

/**
 * The fields a platform operator may correct after onboarding.
 *
 * Deliberately not the TRN, the company code or the tier. Those identify the
 * tenant to the tax authority and to every document already filed under them;
 * changing one is not an edit but a different company, and the endpoint does
 * not accept them either.
 */
function CreateTenantModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const [form, setForm] = useState({
    tenantType: 'ENTERPRISE_TENANT' as TenantType,
    companyCode: '',
    legalNameEn: '',
    legalNameAr: '',
    trn: '',
    street: '',
    city: '',
    emirate: 'Dubai',
    aspProviderId: '',
    adminEmail: '',
    adminFullName: '',
  });

  // Only the ones still being bought from. A retired provider is kept on file
  // for the contracts already against it, not offered for a new tenant.
  const { data: providers } = useQuery({
    queryKey: ['asp-providers', 'onboarding'],
    queryFn: () => api<{ items: ProviderSummary[] }>('/api/v1/admin/providers'),
  });
  const selectable = (providers?.items ?? []).filter((provider) => provider.isActive);
  const chosen = selectable.find((provider) => provider.id === form.aspProviderId);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; inviteUrl: string | null }>('/api/v1/admin/tenants', {
        method: 'POST',
        body: {
          tenantType: form.tenantType,
          companyCode: form.companyCode,
          legalNameEn: form.legalNameEn,
          legalNameAr: form.legalNameAr,
          // A channel partner resells capacity and never appears as the seller
          // on an invoice, so it is onboarded without a TRN of its own.
          trn: form.tenantType === 'CHANNEL_PARTNER' ? undefined : form.trn,
          isVatGroup: false,
          registeredAddress: {
            street: form.street,
            city: form.city || form.emirate,
            emirate: form.emirate,
            postalCode: '',
            countryCode: 'AE',
          },
          aspProviderId: form.aspProviderId || undefined,
          adminEmail: form.adminEmail || undefined,
          adminFullName: form.adminFullName || undefined,
        },
      }),
    onSuccess: (result) => {
      setError(null);
      setInviteUrl(result.inviteUrl);
      queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
      if (!result.inviteUrl) onClose();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That tenant could not be created.'),
  });

  if (inviteUrl) {
    return (
      // The invitation is shown exactly once, so a stray click on the backdrop
      // must not be what loses it.
      <Modal
        title="Tenant created"
        onClose={onClose}
        dismissOnBackdrop={false}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <Alert kind="ok" title="Send this invitation to the tenant administrator">
          <p className="mt-2 break-all rounded bg-white/60 p-2 font-mono text-xs">{inviteUrl}</p>
          <p className="mt-2 text-xs">
            The tenant starts in <strong>Pending</strong>. Configure their provider connection on
            the tenant page, then activate them.
          </p>
        </Alert>
      </Modal>
    );
  }

  return (
    <Modal
      title="Onboard a tenant"
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex flex-1 items-center justify-between gap-4">
          <p className="text-xs text-slate-500">
            The tenant is created as <strong>Pending</strong>. They can upload and correct invoices
            immediately, but cannot submit until their provider connection is active.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => create.mutate()}
              disabled={
                create.isPending ||
                !form.companyCode ||
                !form.legalNameEn ||
                !form.legalNameAr ||
                (form.tenantType !== 'CHANNEL_PARTNER' && form.trn.length !== 15)
              }
            >
              {create.isPending ? 'Creating…' : 'Create tenant'}
            </Button>
          </div>
        </div>
      }
    >
      {error && (
        <div className="mb-4">
          <Alert kind="danger">{error}</Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Tier"
          hint="Managed sub-tenants are onboarded by their channel partner, not here."
          required
        >
          <select
            className={inputClass}
            value={form.tenantType}
            onChange={(e) => setForm({ ...form, tenantType: e.target.value as TenantType })}
          >
            <option value="ENTERPRISE_TENANT">
              {TENANT_TYPE_LABELS.ENTERPRISE_TENANT} — files its own invoices
            </option>
            <option value="CHANNEL_PARTNER">
              {TENANT_TYPE_LABELS.CHANNEL_PARTNER} — manages sub-tenants
            </option>
          </select>
        </Field>

        <Field label="Company code" hint="Short identifier, used in batch references." required>
          <input
            className={inputClass}
            value={form.companyCode}
            onChange={(e) => setForm({ ...form, companyCode: e.target.value.toUpperCase() })}
          />
        </Field>

        <Field
          label="TRN"
          hint={
            form.tenantType === 'CHANNEL_PARTNER'
              ? 'Not required for a channel partner.'
              : '15 digits, starting with 1.'
          }
          required={form.tenantType !== 'CHANNEL_PARTNER'}
        >
          <input
            className={`${inputClass} font-mono`}
            maxLength={15}
            disabled={form.tenantType === 'CHANNEL_PARTNER'}
            value={form.tenantType === 'CHANNEL_PARTNER' ? '' : form.trn}
            onChange={(e) => setForm({ ...form, trn: e.target.value.replace(/\D/g, '') })}
          />
        </Field>

        <Field label="Emirate" required>
          <select
            className={inputClass}
            value={form.emirate}
            onChange={(e) => setForm({ ...form, emirate: e.target.value })}
          >
            {EMIRATES.map((emirate) => (
              <option key={emirate} value={emirate}>
                {emirate}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Legal name (English)" required>
          <input
            className={inputClass}
            value={form.legalNameEn}
            onChange={(e) => setForm({ ...form, legalNameEn: e.target.value })}
          />
        </Field>

        <Field label="Legal name (Arabic)" hint="Required on UAE tax invoices." required>
          <input
            className={`${inputClass} arabic`}
            lang="ar"
            value={form.legalNameAr}
            onChange={(e) => setForm({ ...form, legalNameAr: e.target.value })}
          />
        </Field>

        <Field label="Street address">
          <input
            className={inputClass}
            value={form.street}
            onChange={(e) => setForm({ ...form, street: e.target.value })}
          />
        </Field>

        <Field
          label="Accredited provider"
          hint={
            chosen
              ? 'Their connection details are filled in below. Credentials are issued per merchant and are added once they register you.'
              : 'Optional — the connection can be configured later from the tenant.'
          }
        >
          <select
            className={inputClass}
            value={form.aspProviderId}
            onChange={(e) => setForm({ ...form, aspProviderId: e.target.value })}
          >
            <option value="">— Choose later —</option>
            {selectable.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
                {provider.accreditationReference ? ` · ${provider.accreditationReference}` : ''}
              </option>
            ))}
          </select>
        </Field>

        {/* Read-only on purpose. These are facts about the provider, the same
            for every merchant on them, so they are shown to confirm the choice
            rather than offered for editing here — one provider changing its
            endpoint should be one edit on the provider, not one per tenant. */}
        {chosen && (
          <div className="rounded-lg border border-brand-100 bg-brand-50 p-3 text-xs text-slate-700">
            <div className="font-medium text-brand-800">Filled in from {chosen.name}</div>
            <dl className="mt-1 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-slate-500">Connection</dt>
              <dd>{chosen.providerType}</dd>
              <dt className="text-slate-500">Endpoint</dt>
              <dd className="break-all">{chosen.apiEndpoint || 'Not recorded on the provider'}</dd>
              <dt className="text-slate-500">Status</dt>
              <dd>Awaiting registration — credentials are issued per merchant</dd>
            </dl>
          </div>
        )}

        <Field
          label="Administrator name"
          hint={
            form.tenantType === 'CHANNEL_PARTNER'
              ? 'Optional — invited as the partner administrator.'
              : 'Optional — invited as the company administrator.'
          }
        >
          <input
            className={inputClass}
            value={form.adminFullName}
            onChange={(e) => setForm({ ...form, adminFullName: e.target.value })}
          />
        </Field>

        <Field label="Administrator email">
          <input
            className={inputClass}
            type="email"
            value={form.adminEmail}
            onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
          />
        </Field>
      </div>
    </Modal>
  );
}
