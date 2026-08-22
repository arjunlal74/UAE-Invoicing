import type { PaginatedResult, PartnerOverview, SubTenantSummary } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EMIRATES } from '@uae/domain';
import { useState } from 'react';
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
 * The channel partner portal (SRS v2.1 §2).
 *
 * A partner sees who is onboarded underneath it and how much they are filing —
 * never the invoices themselves. The API enforces that boundary; this screen
 * simply has nothing that would ask for them.
 */
export function PartnerSubTenantsPage() {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const overview = useQuery({
    queryKey: ['partner-overview'],
    queryFn: () => api<PartnerOverview>('/api/v1/partner/overview'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['partner-sub-tenants', search],
    queryFn: () =>
      api<PaginatedResult<SubTenantSummary>>(
        `/api/v1/partner/sub-tenants${queryString({ q: search })}`,
      ),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {overview.data?.partnerName ?? 'Sub-tenants'}
          </h1>
          <p className="text-sm text-slate-500">
            Companies you onboard and manage on the platform.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : 'Onboard a sub-tenant'}
        </Button>
      </div>

      {overview.data && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Sub-tenants" value={overview.data.subTenantCount} />
          <Stat label="Active" value={overview.data.activeSubTenantCount} />
          <Stat label="Invoices prepared" value={overview.data.invoiceCount} />
          <Stat label="Cleared by the FTA" value={overview.data.acceptedInvoiceCount} />
        </div>
      )}

      {creating && <CreateSubTenantForm onDone={() => setCreating(false)} />}

      <Card>
        <input
          className={`${inputClass} max-w-xs`}
          placeholder="Search by name, code or TRN"
          defaultValue={search}
          onBlur={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSearch((e.target as HTMLInputElement).value);
          }}
        />
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading sub-tenants…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title="No sub-tenants yet"
            description="Onboard your first client to start filing on their behalf."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">TRN</th>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 text-right font-medium">Users</th>
                <th className="px-4 py-2 text-right font-medium">Invoices</th>
                <th className="px-4 py-2 font-medium">Onboarded</th>
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
                    <StatusBadge status={tenant.status} />
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={tenant.aspStatus} />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{tenant.userCount}</td>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

function CreateSubTenantForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const [form, setForm] = useState({
    companyCode: '',
    legalNameEn: '',
    legalNameAr: '',
    trn: '',
    street: '',
    emirate: 'Dubai',
    adminEmail: '',
    adminFullName: '',
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; inviteUrl: string }>('/api/v1/partner/sub-tenants', {
        method: 'POST',
        body: {
          companyCode: form.companyCode,
          legalNameEn: form.legalNameEn,
          legalNameAr: form.legalNameAr,
          trn: form.trn,
          registeredAddress: {
            street: form.street,
            city: form.emirate,
            emirate: form.emirate,
            postalCode: '',
            countryCode: 'AE',
          },
          adminEmail: form.adminEmail,
          adminFullName: form.adminFullName,
        },
      }),
    onSuccess: (result) => {
      setError(null);
      setInviteUrl(result.inviteUrl);
      queryClient.invalidateQueries({ queryKey: ['partner-sub-tenants'] });
      queryClient.invalidateQueries({ queryKey: ['partner-overview'] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That sub-tenant could not be created.'),
  });

  if (inviteUrl) {
    return (
      <Card title="Sub-tenant created">
        <Alert kind="ok" title="Send this invitation to their administrator">
          <p className="mt-2 break-all rounded bg-white/60 p-2 font-mono text-xs">{inviteUrl}</p>
          <p className="mt-2 text-xs">
            The sub-tenant starts in <strong>Pending</strong> and cannot file until the platform
            activates their provider connection.
          </p>
        </Alert>
        <div className="mt-4">
          <Button onClick={onDone}>Done</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Onboard a sub-tenant">
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

        <Field label="Administrator name" hint="Invited as their company administrator." required>
          <input
            className={inputClass}
            value={form.adminFullName}
            onChange={(e) => setForm({ ...form, adminFullName: e.target.value })}
          />
        </Field>

        <Field label="Administrator email" required>
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
          Their invoices are metered against your master bundle once billing is switched on.
        </p>
        <Button
          variant="primary"
          onClick={() => create.mutate()}
          disabled={
            create.isPending ||
            !form.companyCode ||
            !form.legalNameEn ||
            !form.legalNameAr ||
            !form.adminEmail ||
            !form.adminFullName ||
            form.trn.length !== 15
          }
        >
          {create.isPending ? 'Creating…' : 'Create sub-tenant'}
        </Button>
      </div>
    </Card>
  );
}
