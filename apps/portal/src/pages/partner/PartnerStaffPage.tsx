import type { PaginatedResult, PartnerStaffMember } from '@uae/contracts';
import { ROLE_LABELS } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Icon,
  PageHeader,
  Spinner,
  cx,
  formatDateTime,
  inputClass,
} from '../../components/ui';
import { PartnerStaffFormModal } from '../../components/PartnerStaffFormModal';
import { ApiError, api, queryString } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';

/**
 * The firm's own people.
 *
 * A partner managing thirty clients has more than one person doing it, and
 * until now the only way to add the second was to ask the platform. This is the
 * same screen a company administrator has over their own staff, bounded by the
 * partner tenant: invite, read, correct, and lock out.
 *
 * Locking is the one destructive-feeling action here and it is deliberately not
 * a delete: the person stays on the record as the author of whatever they filed
 * for a client, and the account opens again if they come back.
 */
export function PartnerStaffPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const statusFilter = params.get('status') ?? '';

  const [inviting, setInviting] = useState(false);
  const [viewing, setViewing] = useState<PartnerStaffMember | null>(null);
  const [editing, setEditing] = useState<PartnerStaffMember | null>(null);
  const [error, setError] = useState<string | null>(null);

  const me = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const { data, isLoading } = useQuery({
    queryKey: ['partner-staff', search, statusFilter],
    queryFn: () =>
      api<PaginatedResult<PartnerStaffMember>>(
        `/api/v1/partner/staff${queryString({ q: search, status: statusFilter })}`,
      ),
  });

  const setLocked = useMutation({
    mutationFn: ({ id, locked }: { id: string; locked: boolean }) =>
      api(`/api/v1/partner/staff/${id}/${locked ? 'lock' : 'unlock'}`, { method: 'POST' }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['partner-staff'] });
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'That account could not be changed.'),
  });

  const filtered = Boolean(search || statusFilter);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Staff"
        description="The people at your firm who manage clients and work in their books."
        actions={
          <Button variant="primary" onClick={() => setInviting(true)}>
            Invite a colleague
          </Button>
        }
      />

      {error && <Alert kind="danger">{error}</Alert>}

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <input
            className={`${inputClass} max-w-xs`}
            placeholder="Search by name or email"
            defaultValue={search}
            onBlur={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSearch((e.target as HTMLInputElement).value);
            }}
          />
          <select
            className={`${inputClass} max-w-[16rem]`}
            value={statusFilter}
            onChange={(e) => setFilter('status', e.target.value)}
          >
            <option value="">Everyone</option>
            <option value="active">Can sign in</option>
            <option value="pending">Invitation not accepted</option>
            <option value="locked">Locked out</option>
          </select>
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
            <Spinner label="Loading staff…" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title={filtered ? 'Nobody matches' : 'No colleagues yet'}
            description={
              filtered
                ? 'Clear the filters to see everyone at your firm.'
                : 'Invite the people who will manage your clients.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Two-factor</th>
                <th className="px-4 py-2 font-medium">Last sign-in</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((member) => {
                const self = member.id === me?.id;
                return (
                  <tr key={member.id} className={cx('hover:bg-slate-50', !member.isActive && 'bg-slate-50/60')}>
                    <td className="px-4 py-2">
                      <div
                        className={cx(
                          'font-medium',
                          member.isActive ? 'text-slate-800' : 'text-slate-400 line-through',
                        )}
                      >
                        {member.fullName}
                      </div>
                      <div className="mt-0.5 flex gap-1.5 text-xs">
                        {self && <span className="text-slate-400">you</span>}
                        {!member.isActive && (
                          <span className="rounded bg-danger-50 px-1.5 py-0.5 text-danger-700">
                            locked
                          </span>
                        )}
                        {member.isActive && !member.hasSignedIn && (
                          <span className="rounded bg-warn-50 px-1.5 py-0.5 text-warn-700">
                            invitation not accepted
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{member.email}</td>
                    <td className="px-4 py-2 text-slate-600">{ROLE_LABELS[member.role]}</td>
                    <td className="px-4 py-2 text-xs">
                      {member.mfaEnabled ? (
                        <span className="text-ok-700">Enabled</span>
                      ) : (
                        <span className="text-warn-700">Not set up</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {member.lastLoginAt ? formatDateTime(member.lastLoginAt) : 'Never'}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          className={ACTION}
                          label="View"
                          onClick={() => setViewing(member)}
                        >
                          <Icon name="view" />
                        </Button>

                        <Button
                          size="sm"
                          className={ACTION}
                          label="Edit"
                          onClick={() => setEditing(member)}
                        >
                          <Icon name="edit" />
                        </Button>

                        {/* Locking the account you are signed in with is never
                            what anybody meant, and at a one-person firm there
                            would be nobody left to undo it. */}
                        <Button
                          size="sm"
                          className={ACTION}
                          label={member.isActive ? 'Lock account' : 'Unlock account'}
                          disabled={self || setLocked.isPending}
                          title={
                            self
                              ? 'You cannot lock your own account.'
                              : member.isActive
                                ? 'Lock: they can no longer sign in'
                                : 'Unlock: let them sign in again'
                          }
                          onClick={() =>
                            setLocked.mutate({ id: member.id, locked: member.isActive })
                          }
                        >
                          <Icon name={member.isActive ? 'lock' : 'unlock'} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {inviting && <PartnerStaffFormModal mode="create" onClose={() => setInviting(false)} />}
      {viewing && (
        <PartnerStaffFormModal mode="view" member={viewing} onClose={() => setViewing(null)} />
      )}
      {editing && (
        <PartnerStaffFormModal mode="edit" member={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/** Every verb the same width, as on the client list. */
const ACTION = 'w-9 justify-center';
