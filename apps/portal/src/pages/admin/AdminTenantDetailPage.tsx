import { ROLE_LABELS } from '@uae/contracts';
import type {
  AspConfigResponse,
  AspConnectionStatus,
  AspProviderType,
  PaginatedResult,
  ProviderSummary,
  TenantDetail,
  TenantStatus,
  TenantType,
  UserSummary,
} from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
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
const EDIT_FIRST = 'Press Edit to change this tenant.';

export function AdminTenantDetailPage() {
  const { tenantId = '' } = useParams();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);
  // Read or write is settled before the page loads, by which button was
  // pressed in the list. Carrying it in the URL rather than in state means the
  // link can be sent to someone, and a refresh does not silently unlock a
  // record that was opened to be read.
  const editable = params.get('edit') === '1';

  // Seeded from the record once it arrives, so the fields are not empty on
  // the first paint and a half-typed name is not lost to a background refetch.
  const [names, setNames] = useState({ legalNameEn: '', legalNameAr: '', peppolParticipantId: '' });

  const { data: tenant, isLoading } = useQuery({
    queryKey: ['admin-tenant', tenantId],
    queryFn: () => api<TenantDetail>(`/api/v1/admin/tenants/${tenantId}`),
  });

  const { data: users } = useQuery({
    queryKey: ['admin-tenant-users', tenantId],
    queryFn: () => api<PaginatedResult<UserSummary>>(`/api/v1/admin/tenants/${tenantId}/users`),
  });

  // The record arrives after the first render, so the fields are seeded when
  // it does — and only then, or every refetch would overwrite what is being
  // typed.
  useEffect(() => {
    if (tenant)
      setNames({
        legalNameEn: tenant.legalNameEn,
        legalNameAr: tenant.legalNameAr ?? '',
        peppolParticipantId: tenant.peppolParticipantId ?? '',
      });
  }, [tenant?.id, tenant?.updatedAt]);

  const renamed =
    !!tenant &&
    (names.legalNameEn !== tenant.legalNameEn ||
      names.legalNameAr !== (tenant.legalNameAr ?? '') ||
      names.peppolParticipantId !== (tenant.peppolParticipantId ?? ''));

  const renameTenant = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/tenants/${tenantId}`, {
        method: 'PATCH',
        body: {
          legalNameEn: names.legalNameEn.trim(),
          legalNameAr: names.legalNameAr.trim() || undefined,
          // Null clears it; the server does not silently re-derive from the TRN.
          peppolParticipantId: names.peppolParticipantId.trim() || null,
        },
      }),
    onSuccess: () => {
      setMessage({ kind: 'ok', text: 'Identity saved.' });
      void queryClient.invalidateQueries({ queryKey: ['admin-tenant', tenantId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
    },
    onError: (cause) =>
      setMessage({
        kind: 'danger',
        text: cause instanceof ApiError ? cause.message : 'Those names could not be saved.',
      }),
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
          {/* The two names are the only identity a platform operator may
              correct. The rest identify this tenant to the tax authority and
              on every document already filed under it, so they are shown and
              not offered — the endpoint refuses them too. */}
          {editable && (
            <div className="mb-4 grid gap-3 border-b border-slate-100 pb-4 sm:grid-cols-2">
              <Field label="Legal name (English)" required>
                <input
                  className={inputClass}
                  value={names.legalNameEn}
                  onChange={(event) => setNames({ ...names, legalNameEn: event.target.value })}
                />
              </Field>

              <Field label="Legal name (Arabic)">
                <input
                  className={`${inputClass} arabic`}
                  lang="ar"
                  dir="rtl"
                  value={names.legalNameAr}
                  onChange={(event) => setNames({ ...names, legalNameAr: event.target.value })}
                />
              </Field>

              <Field
                label="Peppol participant id"
                hint="Defaulted from the TRN as 0235:<TIN>. Change it only if the provider issued something else."
              >
                <input
                  className={inputClass}
                  placeholder="0235:1002938475"
                  value={names.peppolParticipantId}
                  onChange={(event) =>
                    setNames({ ...names, peppolParticipantId: event.target.value })
                  }
                />
              </Field>

              <div className="sm:col-span-2 flex justify-end">
                <Button
                  variant="primary"
                  disabled={!names.legalNameEn.trim() || renameTenant.isPending || !renamed}
                  onClick={() => renameTenant.mutate()}
                >
                  {renameTenant.isPending ? 'Saving…' : 'Save identity'}
                </Button>
              </div>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Detail label="Company code" value={tenant.companyCode} />
            <Detail label="TRN" value={tenant.trn ?? '—'} mono />
            <Detail
              label="Peppol participant id"
              value={tenant.peppolParticipantId ?? '—'}
              mono
            />
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
                disabled={!editable || setStatus.isPending}
                title={editable ? undefined : EDIT_FIRST}
              >
                Activate
              </Button>
            )}
            {tenant.status === 'ACTIVE' && (
              <Button
                variant="danger"
                onClick={() => setStatus.mutate('SUSPENDED')}
                disabled={!editable || setStatus.isPending}
                title={editable ? undefined : EDIT_FIRST}
              >
                Suspend
              </Button>
            )}
            {tenant.status === 'SUSPENDED' && (
              <Button
                onClick={() => setStatus.mutate('PENDING')}
                disabled={!editable || setStatus.isPending}
                title={editable ? undefined : EDIT_FIRST}
              >
                Return to pending
              </Button>
            )}
          </div>
        </Card>
      </div>

      <AspConfigSection
        tenantId={tenantId}
        tenantType={tenant.tenantType}
        readOnly={!editable}
      />

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

function AspConfigSection({
  tenantId,
  tenantType,
  readOnly,
}: {
  tenantId: string;
  tenantType: TenantType;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | null>(null);

  // A channel partner resells capacity and never files, so it has no provider
  // connection — and asking for one returns a 404 that has nothing to report.
  const files = tenantType !== 'CHANNEL_PARTNER';

  const {
    data: config,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['asp-config', tenantId],
    queryFn: () => api<AspConfigResponse>(`/api/v1/admin/tenants/${tenantId}/asp-config`),
    enabled: files,
    // A missing configuration is an answer, not a blip worth retrying at.
    retry: false,
  });

  // Only the ones still being bought from: a retired provider stays on file
  // for the contracts already against it, and the server refuses it here too.
  const { data: providers } = useQuery({
    queryKey: ['asp-providers', 'picker'],
    queryFn: () => api<{ items: ProviderSummary[] }>('/api/v1/admin/providers'),
  });
  const selectable = (providers?.items ?? []).filter((provider) => provider.isActive);

  const [form, setForm] = useState<{
    aspProviderId?: string | null;
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
          aspProviderId:
            form.aspProviderId === undefined ? config?.aspProviderId : form.aspProviderId,
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

  if (!files) {
    return (
      <Card title="Provider connection">
        <p className="py-2 text-sm text-slate-600">
          A channel partner resells capacity and does not file its own invoices, so it has no
          provider connection. Its sub-tenants each have their own.
        </p>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card title="Provider connection">
        <Spinner />
      </Card>
    );
  }

  // Absent and still loading used to render identically, so a tenant with no
  // configuration span for a spinner that never stopped.
  if (error || !config) {
    return (
      <Card title="Provider connection">
        <Alert kind="warn" title="No provider connection on file">
          This tenant has no connection record, so it cannot file. One is normally created at
          onboarding — re-onboarding is not needed, but a platform administrator has to add it
          before the tenant is activated.
        </Alert>
      </Card>
    );
  }

  const value = <K extends keyof typeof form>(key: K, fallback: string) =>
    (form[key] as string | undefined) ?? fallback;

  // The cascade: the chosen protocol, and the providers reachable over it.
  const providerType = (form.providerType ?? config.providerType) as AspProviderType;
  const linkedId = form.aspProviderId === undefined ? config.aspProviderId : form.aspProviderId;
  const matching = selectable.filter((provider) => provider.providerType === providerType);
  /** Whether this connection actually leaves the building. */
  const network = providerType !== 'MOCK';

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
        {/* Type first, then who. The type decides which providers can even be
            reached this way, so choosing it first narrows the list below rather
            than letting an operator pick a provider and then a type that
            contradicts it. */}
        <Field label="Provider type">
          <select
            className={inputClass}
            disabled={readOnly}
            value={providerType}
            onChange={(event) => {
              const next = event.target.value as AspProviderType;
              // A provider that does not speak the newly chosen protocol cannot
              // stay selected — leaving it would show a name in a box that its
              // own list no longer offers.
              const keep = matching.find((provider) => provider.id === linkedId);
              setForm({
                ...form,
                providerType: next,
                ...(keep && keep.providerType === next ? {} : { aspProviderId: null }),
              });
            }}
          >
            <option value="MOCK">Simulator (development)</option>
            <option value="GENERIC_REST">Third-party (REST)</option>
            {/* Hidden while its driver is unimplemented, but kept for a
                connection already on it, or the select would show a blank. */}
            {providerType === 'NATIVE_AS4' && (
              <option value="NATIVE_AS4">Native (AS4 gateway)</option>
            )}
          </select>
        </Field>

        <Field
          label="Accredited provider"
          hint={
            matching.length === 0
              ? 'No provider on file is reached this way. Set one up on the providers screen.'
              : 'Choosing one fills in what they are called and where they are reached.'
          }
        >
          <select
            className={inputClass}
            disabled={readOnly || matching.length === 0}
            value={linkedId ?? ''}
            onChange={(event) => {
              const chosen = matching.find((provider) => provider.id === event.target.value);
              // The provider owns what it is called and where it is reached, so
              // picking one fills those in rather than leaving the operator to
              // copy them across from the providers screen by hand. They stay
              // editable: a merchant occasionally sits on a different endpoint,
              // and the master's value is a default rather than a rule. The
              // type is not filled here — the list is already narrowed to it.
              setForm({
                ...form,
                aspProviderId: event.target.value || null,
                ...(chosen
                  ? {
                      displayName: chosen.name,
                      apiEndpoint: chosen.apiEndpoint,
                      // The account the provider knows this platform by. A
                      // provider that issues one per merchant can still have
                      // it overwritten below; this is the default, not a rule.
                      providerAccountId: chosen.providerAccountId ?? '',
                    }
                  : {}),
              });
            }}
          >
            <option value="">— Not linked to an accredited provider —</option>
            {matching.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
                {provider.accreditationReference ? ` · ${provider.accreditationReference}` : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Display name" hint="Shown to the merchant.">
          <input
            className={inputClass}
            disabled={readOnly}
            value={value('displayName', config.displayName)}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </Field>

        <Field label="Connection status">
          <select
            className={inputClass}
            disabled={readOnly}
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

        {/* Both are addressed to a network the simulator never touches, so
            they are off for it — matching the providers screen, and keeping
            anyone from filling in a value that nothing will ever send. */}
        <Field
          label="API endpoint"
          required={network}
          hint={
            network
              ? "Base URL of the provider's API."
              : 'Not used by the simulator — it never leaves this system.'
          }
        >
          <input
            className={inputClass}
            disabled={readOnly || !network}
            placeholder="https://api.provider.ae"
            value={value('apiEndpoint', config.apiEndpoint)}
            onChange={(e) => setForm({ ...form, apiEndpoint: e.target.value })}
          />
        </Field>

        <Field
          label="Provider account id"
          required={network}
          hint={
            network
              ? 'What this platform is called at that provider. Filled from the provider — change it only if they issued this merchant its own.'
              : 'Not used by the simulator — it never leaves this system.'
          }
        >
          <input
            className={inputClass}
            disabled={readOnly || !network}
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
            disabled={readOnly}
              autoComplete="off"
              value={form.clientId ?? ''}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            />
          </Field>
          <Field label="Client secret">
            <input
              className={inputClass}
            disabled={readOnly}
              type="password"
              autoComplete="new-password"
              value={form.clientSecret ?? ''}
              onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
            />
          </Field>
          <Field label="API key">
            <input
              className={inputClass}
            disabled={readOnly}
              type="password"
              autoComplete="new-password"
              value={form.apiKey ?? ''}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </Field>
          <Field label="Webhook signing secret">
            <input
              className={inputClass}
            disabled={readOnly}
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
          <Button
            onClick={() => test.mutate()}
            disabled={readOnly || test.isPending}
            title={readOnly ? EDIT_FIRST : undefined}
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={readOnly || save.isPending || Object.keys(form).length === 0}
            title={readOnly ? EDIT_FIRST : undefined}
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
