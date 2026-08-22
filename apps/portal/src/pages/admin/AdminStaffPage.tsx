import { ROLE_LABELS } from '@uae/contracts';
import type { PaginatedResult, Role, UserSummary } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Field,
  Spinner,
  formatDateTime,
  inputClass,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { can, useAuthStore } from '../../stores/auth';

// v2.1 collapses the platform tier to a single role, so this is a list of one.
// It stays a list because the picker and the server-side check both read it.
const PLATFORM_ROLES: Role[] = ['GLOBAL_ADMIN'];

export function AdminStaffPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    email: '',
    fullName: '',
    role: 'GLOBAL_ADMIN' as Role,
  });
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-staff'],
    queryFn: () => api<PaginatedResult<UserSummary>>('/api/v1/admin/staff'),
  });

  const invite = useMutation({
    mutationFn: () =>
      api<{ inviteUrl: string }>('/api/v1/admin/staff', { method: 'POST', body: form }),
    onSuccess: (result) => {
      setInviteUrl(result.inviteUrl);
      setError(null);
      setForm({ email: '', fullName: '', role: 'GLOBAL_ADMIN' });
      queryClient.invalidateQueries({ queryKey: ['admin-staff'] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That account could not be created.'),
  });

  const canInvite = can(user, 'platform.manage');

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Platform staff</h1>

      {inviteUrl && (
        <Alert kind="ok" title="Invitation created">
          <p className="mt-2 break-all rounded bg-white/60 p-2 font-mono text-xs">{inviteUrl}</p>
        </Alert>
      )}
      {error && <Alert kind="danger">{error}</Alert>}

      <Card title="Accounts">
        {isLoading ? (
          <Spinner />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Email</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 font-medium">2FA</th>
                <th className="pb-2 font-medium">Last sign-in</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data?.items.map((staff) => (
                <tr key={staff.id} className={staff.isActive ? '' : 'opacity-50'}>
                  <td className="py-2">
                    {staff.fullName}
                    {staff.invitePending && (
                      <span className="ml-2 rounded bg-warn-50 px-1.5 py-0.5 text-xs text-warn-700">
                        invite pending
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-slate-600">{staff.email}</td>
                  <td className="py-2 text-slate-600">
                    {ROLE_LABELS[staff.role]}
                  </td>
                  <td className="py-2 text-xs">
                    {staff.mfaEnabled ? (
                      <span className="text-ok-700">Enabled</span>
                    ) : (
                      <span className="text-warn-700">Not set up</span>
                    )}
                  </td>
                  <td className="py-2 text-slate-500">{formatDateTime(staff.lastLoginAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {canInvite && (
        <Card title="Invite a staff member">
          <div className="grid items-end gap-3 sm:grid-cols-4">
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
                {PLATFORM_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              variant="primary"
              onClick={() => invite.mutate()}
              disabled={!form.email || !form.fullName || invite.isPending}
            >
              {invite.isPending ? 'Inviting…' : 'Invite'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
