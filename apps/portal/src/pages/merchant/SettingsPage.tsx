import type {
  MfaEnrolStartResponse,
  PaginatedResult,
  Role,
  TenantDetail,
  UserSummary,
} from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { isTenantAdmin, useAuthStore } from '../../stores/auth';

const TENANT_ROLES: Role[] = ['TENANT_ADMIN', 'FINANCE_USER', 'DATA_ENTRY_CLERK', 'AUDITOR'];

export function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const admin = isTenantAdmin(user);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-lg font-semibold text-slate-900">Settings</h1>
      <TaxProfile editable={admin} />
      <ProviderStatus />
      <SecuritySection />
      {admin && <UsersSection />}
    </div>
  );
}

function TaxProfile({ editable }: { editable: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-profile'],
    queryFn: () => api<TenantDetail>('/api/v1/tenant/profile'),
  });

  const [draft, setDraft] = useState<{ legalNameEn?: string; legalNameAr?: string } | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('/api/v1/tenant/profile', { method: 'PATCH', body }),
    onSuccess: () => {
      setSaved(true);
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['tenant-profile'] });
      setTimeout(() => setSaved(false), 3000);
    },
  });

  if (isLoading || !data) {
    return (
      <Card title="Tax profile">
        <Spinner />
      </Card>
    );
  }

  return (
    <Card title="Tax profile">
      {saved && (
        <div className="mb-4">
          <Alert kind="ok">Saved.</Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Tax Registration Number"
          hint="Your TRN identifies you to the FTA and cannot be changed here. Contact support if it is wrong."
        >
          <input className={inputClass} value={data.trn} disabled />
        </Field>

        <Field label="Company code" hint="Used in your batch references.">
          <input className={inputClass} value={data.companyCode} disabled />
        </Field>

        <Field label="Legal name (English)">
          <input
            className={inputClass}
            defaultValue={data.legalNameEn}
            disabled={!editable}
            onChange={(e) => setDraft((d) => ({ ...d, legalNameEn: e.target.value }))}
          />
        </Field>

        <Field label="Legal name (Arabic)">
          <input
            className={`${inputClass} arabic`}
            lang="ar"
            defaultValue={data.legalNameAr}
            disabled={!editable}
            onChange={(e) => setDraft((d) => ({ ...d, legalNameAr: e.target.value }))}
          />
        </Field>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
        <div className="text-sm text-slate-600">
          Account status: <StatusBadge status={data.status} />
          {data.isVatGroup && (
            <span className="ml-3 text-xs">VAT group: {data.vatGroupTrn}</span>
          )}
        </div>

        {editable && draft && (
          <Button variant="primary" onClick={() => save.mutate(draft)} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        )}
      </div>
    </Card>
  );
}

function ProviderStatus() {
  const { data } = useQuery({
    queryKey: ['asp-status'],
    queryFn: () =>
      api<{ status: string; providerName?: string; canSubmit: boolean; message: string }>(
        '/api/v1/tenant/asp-status',
      ),
  });

  if (!data) return null;

  return (
    <Card title="Network provider">
      <div className="flex items-start gap-3">
        <StatusBadge status={data.status} />
        <div className="text-sm">
          <p className="text-slate-700">{data.message}</p>
          {data.providerName && (
            <p className="mt-1 text-xs text-slate-500">Provider: {data.providerName}</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function SecuritySection() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [enrolment, setEnrolment] = useState<MfaEnrolStartResponse | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const start = useMutation({
    mutationFn: () => api<MfaEnrolStartResponse>('/api/v1/auth/mfa/start', { method: 'POST' }),
    onSuccess: setEnrolment,
  });

  const confirm = useMutation({
    mutationFn: () => api('/api/v1/auth/mfa/confirm', { method: 'POST', body: { code } }),
    onSuccess: () => {
      setDone(true);
      setEnrolment(null);
      if (user) setUser({ ...user, mfaEnabled: true });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That code was not accepted.'),
  });

  return (
    <Card title="Security">
      <div className="flex items-start justify-between gap-4">
        <div className="text-sm">
          <p className="font-medium text-slate-800">Two-factor authentication</p>
          <p className="mt-0.5 text-slate-600">
            {user?.mfaEnabled
              ? 'Enabled. You will be asked for a code from your authenticator app at each sign-in.'
              : 'Not enabled. Two-factor authentication is required for accounts that can file tax invoices.'}
          </p>
        </div>

        {!user?.mfaEnabled && !enrolment && (
          <Button variant="primary" onClick={() => start.mutate()} disabled={start.isPending}>
            Set up
          </Button>
        )}
      </div>

      {done && (
        <div className="mt-4">
          <Alert kind="ok">Two-factor authentication is now enabled.</Alert>
        </div>
      )}

      {enrolment && (
        <div className="mt-4 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm text-slate-700">
            Add this secret to your authenticator app, then enter the six-digit code it shows.
          </p>

          <div className="rounded border border-slate-300 bg-white p-3">
            <p className="mb-1 text-xs font-medium text-slate-500">Setup key</p>
            <p className="break-all font-mono text-sm">{enrolment.secret}</p>
          </div>

          {error && <Alert kind="danger">{error}</Alert>}

          <div className="flex items-end gap-2">
            <Field label="Code from your app">
              <input
                className={`${inputClass} w-40 text-center font-mono tracking-widest`}
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <Button
              variant="primary"
              onClick={() => confirm.mutate()}
              disabled={code.length !== 6 || confirm.isPending}
            >
              Confirm
            </Button>
            <Button onClick={() => setEnrolment(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function UsersSection() {
  const queryClient = useQueryClient();
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', fullName: '', role: 'FINANCE_USER' as Role });

  const { data } = useQuery({
    queryKey: ['tenant-users'],
    queryFn: () => api<PaginatedResult<UserSummary>>('/api/v1/tenant/users'),
  });

  const invite = useMutation({
    mutationFn: () => api<{ inviteUrl: string }>('/api/v1/tenant/users', { method: 'POST', body: form }),
    onSuccess: (result) => {
      setInviteUrl(result.inviteUrl);
      setError(null);
      setForm({ email: '', fullName: '', role: 'FINANCE_USER' });
      queryClient.invalidateQueries({ queryKey: ['tenant-users'] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That user could not be invited.'),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/tenant/users/${id}/deactivate`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tenant-users'] }),
  });

  return (
    <Card title="Users">
      {inviteUrl && (
        <div className="mb-4">
          <Alert kind="ok" title="Invitation created">
            <p>Send this link to the new user. It expires in seven days.</p>
            <p className="mt-2 break-all rounded bg-white/60 p-2 font-mono text-xs">{inviteUrl}</p>
          </Alert>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Alert kind="danger">{error}</Alert>
        </div>
      )}

      <table className="mb-5 w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="pb-2 font-medium">Name</th>
            <th className="pb-2 font-medium">Email</th>
            <th className="pb-2 font-medium">Role</th>
            <th className="pb-2 font-medium">2FA</th>
            <th className="pb-2 font-medium">Last sign-in</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data?.items.map((member) => (
            <tr key={member.id} className={member.isActive ? '' : 'opacity-50'}>
              <td className="py-2">
                {member.fullName}
                {member.invitePending && (
                  <span className="ml-2 rounded bg-warn-50 px-1.5 py-0.5 text-xs text-warn-700">
                    invite pending
                  </span>
                )}
              </td>
              <td className="py-2 text-slate-600">{member.email}</td>
              <td className="py-2 text-slate-600">{member.role.replace(/_/g, ' ').toLowerCase()}</td>
              <td className="py-2">
                {member.mfaEnabled ? (
                  <span className="text-xs text-ok-700">Enabled</span>
                ) : (
                  <span className="text-xs text-slate-400">Not set up</span>
                )}
              </td>
              <td className="py-2 text-slate-500">{formatDateTime(member.lastLoginAt)}</td>
              <td className="py-2 text-right">
                {member.isActive && (
                  <Button size="sm" variant="ghost" onClick={() => deactivate.mutate(member.id)}>
                    Deactivate
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="grid items-end gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4">
        <Field label="Full name">
          <input
            className={inputClass}
            value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          />
        </Field>
        <Field label="Email">
          <input
            className={inputClass}
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label="Role">
          <select
            className={inputClass}
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
          >
            {TENANT_ROLES.map((role) => (
              <option key={role} value={role}>
                {role.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
        <Button
          variant="primary"
          onClick={() => invite.mutate()}
          disabled={!form.email || !form.fullName || invite.isPending}
        >
          {invite.isPending ? 'Inviting…' : 'Invite user'}
        </Button>
      </div>
    </Card>
  );
}
