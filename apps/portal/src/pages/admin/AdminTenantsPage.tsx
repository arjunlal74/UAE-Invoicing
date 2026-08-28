import type { PaginatedResult, TenantSummary, TenantType } from '@uae/contracts';
import { TENANT_TYPE_LABELS } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EMIRATES } from '@uae/domain';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  Spinner,
  StatusBadge,
  formatDate,
  inputClass,
} from '../../components/ui';
import { ApiError, api, queryString } from '../../lib/api';

/**
 * Tenant list and onboarding — the first screen of the admin panel, and the
 * first thing that has to work: nobody can use the product until a tenant
 * exists here.
 */
export function AdminTenantsPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-tenants', search, statusFilter, typeFilter],
    queryFn: () =>
      api<PaginatedResult<TenantSummary>>(
        `/api/v1/admin/tenants${queryString({
          q: search,
          status: statusFilter,
          tenantType: typeFilter,
        })}`,
      ),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Tenants</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          Onboard a tenant
        </Button>
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
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((tenant) => (
                <tr key={tenant.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <Link
                      to={`/admin/tenants/${tenant.id}`}
                      className="font-medium text-brand-600 underline"
                    >
                      {tenant.legalNameEn}
                    </Link>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CreateTenantModal onClose={() => setCreating(false)} />}
    </div>
  );
}

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
    adminEmail: '',
    adminFullName: '',
  });

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
