import type { PaginatedResult, TenantSummary } from '@uae/contracts';
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
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-tenants', search, statusFilter],
    queryFn: () =>
      api<PaginatedResult<TenantSummary>>(
        `/api/v1/admin/tenants${queryString({ q: search, status: statusFilter })}`,
      ),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Tenants</h1>
        <Button variant="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : 'Onboard a tenant'}
        </Button>
      </div>

      {creating && <CreateTenantForm onDone={() => setCreating(false)} />}

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
                  <td className="px-4 py-2 font-mono text-xs">{tenant.trn}</td>
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
    </div>
  );
}

function CreateTenantForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const [form, setForm] = useState({
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
          companyCode: form.companyCode,
          legalNameEn: form.legalNameEn,
          legalNameAr: form.legalNameAr,
          trn: form.trn,
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
      if (!result.inviteUrl) onDone();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That tenant could not be created.'),
  });

  if (inviteUrl) {
    return (
      <Card title="Tenant created">
        <Alert kind="ok" title="Send this invitation to the tenant administrator">
          <p className="mt-2 break-all rounded bg-white/60 p-2 font-mono text-xs">{inviteUrl}</p>
          <p className="mt-2 text-xs">
            The tenant starts in <strong>Pending</strong>. Configure their provider connection on
            the tenant page, then activate them.
          </p>
        </Alert>
        <div className="mt-4">
          <Button onClick={onDone}>Done</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Onboard a tenant">
      {error && (
        <div className="mb-4">
          <Alert kind="danger">{error}</Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Company code" hint="Short identifier, used in batch references." required>
          <input
            className={inputClass}
            value={form.companyCode}
            onChange={(e) => setForm({ ...form, companyCode: e.target.value.toUpperCase() })}
          />
        </Field>

        <Field label="TRN" hint="15 digits, starting with 1." required>
          <input
            className={`${inputClass} font-mono`}
            maxLength={15}
            value={form.trn}
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

        <Field label="Administrator name" hint="Optional — invited as the first user.">
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

      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
        <p className="text-xs text-slate-500">
          The tenant is created as <strong>Pending</strong>. They can upload and correct invoices
          immediately, but cannot submit until their provider connection is active.
        </p>
        <Button
          variant="primary"
          onClick={() => create.mutate()}
          disabled={
            create.isPending ||
            !form.companyCode ||
            !form.legalNameEn ||
            !form.legalNameAr ||
            form.trn.length !== 15
          }
        >
          {create.isPending ? 'Creating…' : 'Create tenant'}
        </Button>
      </div>
    </Card>
  );
}
