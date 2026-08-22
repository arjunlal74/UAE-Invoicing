import { ROLE_LABELS } from '@uae/contracts';
import type {
  AspConfigResponse,
  AspConnectionStatus,
  AspProviderType,
  PaginatedResult,
  TenantDetail,
  TenantStatus,
  UserSummary,
} from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Field,
  Spinner,
  StatusBadge,
  formatDateTime,
  inputClass,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';

/**
 * Tenant detail: identity, provider connection, users, and the activation
 * lifecycle. Onboarding is two-staged here because the provider registration in
 * the middle is an external process with a lead time.
 */
export function AdminTenantDetailPage() {
  const { tenantId = '' } = useParams();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);

  const { data: tenant, isLoading } = useQuery({
    queryKey: ['admin-tenant', tenantId],
    queryFn: () => api<TenantDetail>(`/api/v1/admin/tenants/${tenantId}`),
  });

  const { data: users } = useQuery({
    queryKey: ['admin-tenant-users', tenantId],
    queryFn: () => api<PaginatedResult<UserSummary>>(`/api/v1/admin/tenants/${tenantId}/users`),
  });

  const setStatus = useMutation({
    mutationFn: (status: TenantStatus) =>
      api(`/api/v1/admin/tenants/${tenantId}/status`, { method: 'POST', body: { status } }),
    onSuccess: (_data, status) => {
      setMessage({ kind: 'ok', text: `Tenant is now ${status.toLowerCase()}.` });
      queryClient.invalidateQueries({ queryKey: ['admin-tenant', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
    },
    onError: (err) =>
      setMessage({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'That status change failed.',
      }),
  });

  if (isLoading || !tenant) {
    return (
      <div className="py-16">
        <Spinner label="Loading tenant…" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Link to="/admin/tenants" className="text-sm text-brand-600 underline">
          ← All tenants
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-900">{tenant.legalNameEn}</h1>
          <StatusBadge status={tenant.status} />
        </div>
        <p className="arabic text-sm text-slate-500" lang="ar">
          {tenant.legalNameAr}
        </p>
      </div>

      {message && <Alert kind={message.kind === 'ok' ? 'ok' : 'danger'}>{message.text}</Alert>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Identity" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Detail label="Company code" value={tenant.companyCode} />
            <Detail label="TRN" value={tenant.trn ?? '—'} mono />
            <Detail label="Users" value={String(tenant.userCount)} />
            <Detail label="Invoices filed" value={String(tenant.invoiceCount)} />
            <Detail
              label="VAT group"
              value={tenant.isVatGroup ? (tenant.vatGroupTrn ?? 'Yes') : 'No'}
            />
            <Detail label="Emirate" value={tenant.registeredAddress?.emirate ?? '—'} />
          </dl>
        </Card>

        <Card title="Lifecycle">
          <p className="mb-3 text-sm text-slate-600">
            A tenant can only be activated once their provider connection is active — otherwise
            they would be told they can file when they cannot.
          </p>
          <div className="flex flex-wrap gap-2">
            {tenant.status !== 'ACTIVE' && (
              <Button
                variant="primary"
                onClick={() => setStatus.mutate('ACTIVE')}
                disabled={setStatus.isPending}
              >
                Activate
              </Button>
            )}
            {tenant.status === 'ACTIVE' && (
              <Button
                variant="danger"
                onClick={() => setStatus.mutate('SUSPENDED')}
                disabled={setStatus.isPending}
              >
                Suspend
              </Button>
            )}
            {tenant.status === 'SUSPENDED' && (
              <Button onClick={() => setStatus.mutate('PENDING')} disabled={setStatus.isPending}>
                Return to pending
              </Button>
            )}
          </div>
        </Card>
      </div>

      <AspConfigSection tenantId={tenantId} />

      <Card title={`Users (${users?.items.length ?? 0})`}>
        {!users || users.items.length === 0 ? (
          <p className="py-3 text-sm text-slate-500">No users yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Email</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Last sign-in</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.items.map((user) => (
                <tr key={user.id}>
                  <td className="py-2">{user.fullName}</td>
                  <td className="py-2 text-slate-600">{user.email}</td>
                  <td className="py-2 text-slate-600">
                    {ROLE_LABELS[user.role]}
                  </td>
                  <td className="py-2 text-xs">
                    {user.invitePending ? (
                      <span className="text-warn-700">Invite pending</span>
                    ) : user.isActive ? (
                      <span className="text-ok-700">Active</span>
                    ) : (
                      <span className="text-slate-400">Deactivated</span>
                    )}
                  </td>
                  <td className="py-2 text-slate-500">{formatDateTime(user.lastLoginAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function AspConfigSection({ tenantId }: { tenantId: string }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);

  const { data: config } = useQuery({
    queryKey: ['asp-config', tenantId],
    queryFn: () => api<AspConfigResponse>(`/api/v1/admin/tenants/${tenantId}/asp-config`),
  });

  const [form, setForm] = useState<{
    providerType?: AspProviderType;
    displayName?: string;
    apiEndpoint?: string;
    status?: AspConnectionStatus;
    providerAccountId?: string;
    notes?: string;
    clientId?: string;
    clientSecret?: string;
    apiKey?: string;
    webhookSecret?: string;
  }>({});

  const save = useMutation({
    mutationFn: () =>
      api<AspConfigResponse>(`/api/v1/admin/tenants/${tenantId}/asp-config`, {
        method: 'PUT',
        body: {
          providerType: form.providerType ?? config?.providerType ?? 'MOCK',
          displayName: form.displayName ?? config?.displayName ?? '',
          apiEndpoint: form.apiEndpoint ?? config?.apiEndpoint ?? '',
          status: form.status ?? config?.status ?? 'NOT_CONFIGURED',
          providerAccountId: form.providerAccountId ?? config?.providerAccountId ?? undefined,
          notes: form.notes ?? config?.notes ?? undefined,
          credentials:
            form.clientId || form.clientSecret || form.apiKey || form.webhookSecret
              ? {
                  clientId: form.clientId || undefined,
                  clientSecret: form.clientSecret || undefined,
                  apiKey: form.apiKey || undefined,
                  webhookSecret: form.webhookSecret || undefined,
                }
              : undefined,
        },
      }),
    onSuccess: () => {
      setMessage({ kind: 'ok', text: 'Provider connection saved.' });
      setForm({});
      queryClient.invalidateQueries({ queryKey: ['asp-config', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['admin-tenant', tenantId] });
    },
    onError: (err) =>
      setMessage({
        kind: 'danger',
        text: err instanceof ApiError ? err.message : 'That configuration could not be saved.',
      }),
  });

  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; message: string; latencyMs: number | null }>(
        `/api/v1/admin/tenants/${tenantId}/asp-config/test`,
        { method: 'POST' },
      ),
    onSuccess: (result) =>
      setMessage({
        kind: result.ok ? 'ok' : 'danger',
        text: `${result.message}${result.latencyMs !== null ? ` (${result.latencyMs}ms)` : ''}`,
      }),
  });

  if (!config) {
    return (
      <Card title="Provider connection">
        <Spinner />
      </Card>
    );
  }

  const value = <K extends keyof typeof form>(key: K, fallback: string) =>
    (form[key] as string | undefined) ?? fallback;

  return (
    <Card
      title="Provider connection (ASP)"
      actions={<StatusBadge status={config.status} />}
    >
      {message && (
        <div className="mb-4">
          <Alert kind={message.kind === 'ok' ? 'ok' : 'danger'}>{message.text}</Alert>
        </div>
      )}

      <Alert kind="info">
        No accredited provider has been selected for this platform yet. The{' '}
        <strong>Simulated provider</strong> runs the full pipeline without leaving this system, so
        merchants can be onboarded and tested now. Switch to <strong>Third-party REST</strong> once
        a provider contract and their API documentation are in place.
      </Alert>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Provider type">
          <select
            className={inputClass}
            value={value('providerType', config.providerType)}
            onChange={(e) => setForm({ ...form, providerType: e.target.value as AspProviderType })}
          >
            <option value="MOCK">Simulated provider (development)</option>
            <option value="GENERIC_REST">Third-party ASP over REST</option>
            <option value="NATIVE_AS4">Native AS4 gateway (Phase 2 — not implemented)</option>
          </select>
        </Field>

        <Field label="Display name" hint="Shown to the merchant.">
          <input
            className={inputClass}
            value={value('displayName', config.displayName)}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </Field>

        <Field label="Connection status">
          <select
            className={inputClass}
            value={value('status', config.status)}
            onChange={(e) =>
              setForm({ ...form, status: e.target.value as AspConnectionStatus })
            }
          >
            <option value="NOT_CONFIGURED">Not configured</option>
            <option value="PENDING_REGISTRATION">Awaiting provider registration</option>
            <option value="ACTIVE">Active</option>
            <option value="DISABLED">Disabled</option>
          </select>
        </Field>

        <Field label="API endpoint" hint="Base URL of the provider's API.">
          <input
            className={inputClass}
            placeholder="https://api.provider.ae"
            value={value('apiEndpoint', config.apiEndpoint)}
            onChange={(e) => setForm({ ...form, apiEndpoint: e.target.value })}
          />
        </Field>

        <Field label="Provider account id" hint="The merchant's identifier at the provider.">
          <input
            className={inputClass}
            value={value('providerAccountId', config.providerAccountId ?? '')}
            onChange={(e) => setForm({ ...form, providerAccountId: e.target.value })}
          />
        </Field>

        <Field label="Webhook URL" hint="Give this to the provider for clearance callbacks.">
          <input className={`${inputClass} font-mono text-xs`} value={config.webhookUrl} readOnly />
        </Field>
      </div>

      <div className="mt-5 border-t border-slate-100 pt-4">
        <h3 className="mb-1 text-sm font-medium text-slate-800">Credentials</h3>
        <p className="mb-3 text-xs text-slate-500">
          {config.hasCredentials
            ? 'Credentials are stored and encrypted. They are never displayed again — fill a field only to replace it.'
            : 'No credentials stored yet.'}
        </p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Client ID">
            <input
              className={inputClass}
              autoComplete="off"
              value={form.clientId ?? ''}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            />
          </Field>
          <Field label="Client secret">
            <input
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={form.clientSecret ?? ''}
              onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
            />
          </Field>
          <Field label="API key">
            <input
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={form.apiKey ?? ''}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </Field>
          <Field label="Webhook signing secret">
            <input
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={form.webhookSecret ?? ''}
              onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
            />
          </Field>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <div className="text-xs text-slate-500">
          {config.lastTestedAt
            ? `Last tested ${formatDateTime(config.lastTestedAt)} — ${config.lastTestResult}`
            : 'Never tested.'}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={save.isPending || Object.keys(form).length === 0}
          >
            {save.isPending ? 'Saving…' : 'Save connection'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={mono ? 'mt-0.5 font-mono text-xs' : 'mt-0.5'}>{value}</dd>
    </div>
  );
}
