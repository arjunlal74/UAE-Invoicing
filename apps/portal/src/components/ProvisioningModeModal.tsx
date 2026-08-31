import type { PaginatedResult, PartnerStaffMember, SubTenantSummary } from '@uae/contracts';
import { PROVISIONING_MODE_LABELS, ROLE_LABELS } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Field, Modal, Spinner, inputClass } from './ui';
import { ApiError, api } from '../lib/api';

/**
 * Moving a client between the two provisioning modes (SRS §3).
 *
 * Both directions are real transitions rather than a flag being flipped, and
 * each has one loose end the dialog is here to close.
 *
 * Taking an account into custody leaves the client's own logins working — the
 * API will not disable somebody's access to their own tax records as a side
 * effect of a switch the partner made — so the users are listed here and
 * deactivated deliberately, one at a time, by whoever is taking the account on.
 *
 * Handing it back needs somebody to hand it to. If the client still has an
 * administrator from an earlier life the switch is enough; otherwise a name and
 * an address are required, and that person is invited on the spot. Either way
 * every custody authorisation ends with the switch: acting for a company is a
 * custody arrangement, and a company that runs itself has its own staff.
 */
export function ProvisioningModeModal({
  subTenant,
  onClose,
}: {
  subTenant: SubTenantSummary;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toCustody = subTenant.provisioningMode === 'COLLABORATIVE';
  const target = toCustody ? 'FULLY_MANAGED_CUSTODY' : 'COLLABORATIVE';

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ inviteUrl: string | null; emailed?: boolean } | null>(null);
  const [form, setForm] = useState({ adminFullName: '', adminEmail: '' });

  // Only when taking an account over: this is the list of people who would keep
  // their keys to it, which is the thing that has to be seen before the switch.
  const users = useQuery({
    queryKey: ['sub-tenant-users', subTenant.id],
    queryFn: () =>
      api<PaginatedResult<PartnerStaffMember>>(`/api/v1/partner/sub-tenants/${subTenant.id}/users`),
    enabled: toCustody,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['partner-sub-tenants'] });
    void queryClient.invalidateQueries({ queryKey: ['partner-dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['sub-tenant-users', subTenant.id] });
  };

  const change = useMutation({
    mutationFn: () =>
      api<{ inviteUrl: string | null; emailed?: boolean }>(
        `/api/v1/partner/sub-tenants/${subTenant.id}/provisioning-mode`,
        {
          method: 'PATCH',
          body: {
            provisioningMode: target,
            adminEmail: form.adminEmail || undefined,
            adminFullName: form.adminFullName || undefined,
          },
        },
      ),
    onSuccess: (result) => {
      setError(null);
      setDone(result);
      refresh();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That change could not be made.'),
  });

  const deactivate = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/v1/partner/users/${userId}/deactivate`, { method: 'POST' }),
    onSuccess: refresh,
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That account could not be deactivated.'),
  });

  const active = (users.data?.items ?? []).filter((user) => user.isActive);

  if (done) {
    return (
      <Modal
        title="Provisioning changed"
        onClose={onClose}
        dismissOnBackdrop={!done.inviteUrl}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        {toCustody ? (
          <Alert kind="ok" title={`${subTenant.legalNameEn} is now in your custody`}>
            <p className="mt-2 text-xs">
              Authorise the members of your staff who will file for it. Until somebody is
              authorised, nobody can open its books — including you.
            </p>
          </Alert>
        ) : (
          <Alert
            kind={done.inviteUrl && !done.emailed ? 'warn' : 'ok'}
            title={`${subTenant.legalNameEn} now runs its own account`}
          >
            {done.inviteUrl ? (
              <>
                <p className="mt-2 break-all rounded bg-white/60 p-2 font-mono text-xs">
                  {done.inviteUrl}
                </p>
                <p className="mt-2 text-xs">
                  {done.emailed
                    ? 'The invitation was e-mailed; this link is here in case it needs passing on by hand.'
                    : 'Outgoing mail is not configured, so this link is the only copy.'}
                </p>
              </>
            ) : (
              <p className="mt-2 text-xs">
                The client already had an administrator, who keeps the account.
              </p>
            )}
            <p className="mt-2 text-xs">
              Your staff's custody authorisations have ended. To keep working in this account, ask
              their administrator to invite you as one of their users.
            </p>
          </Alert>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title={`${PROVISIONING_MODE_LABELS[subTenant.provisioningMode]} → ${PROVISIONING_MODE_LABELS[target]}`}
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={change.isPending} onClick={() => change.mutate()}>
            {change.isPending
              ? 'Changing…'
              : toCustody
                ? 'Take into custody'
                : 'Hand the account over'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && <Alert kind="danger">{error}</Alert>}

        {toCustody ? (
          <>
            <p className="text-sm text-slate-600">
              {subTenant.legalNameEn} becomes an account you hold. No further activation links are
              sent, and the members of your staff you authorise will file for it.
            </p>

            {users.isLoading ? (
              <Spinner label="Checking who still has access…" />
            ) : active.length === 0 ? (
              <Alert kind="ok" title="Nobody at the client holds a login">
                Nothing else to close off — this account is already yours to run.
              </Alert>
            ) : (
              <div>
                <Alert kind="warn" title={`${active.length} of the client's logins still work`}>
                  Taking an account into custody does not lock its people out — that is your
                  decision, not a side effect of this switch. Deactivate the ones that should no
                  longer have access.
                </Alert>
                <table className="mt-3 w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {active.map((user) => (
                      <tr key={user.id}>
                        <td className="py-2">
                          <div className="font-medium text-slate-800">{user.fullName}</div>
                          <div className="text-xs text-slate-400">{user.email}</div>
                        </td>
                        <td className="py-2 text-slate-600">{ROLE_LABELS[user.role]}</td>
                        <td className="py-2 text-right">
                          <Button
                            size="sm"
                            disabled={deactivate.isPending}
                            onClick={() => deactivate.mutate(user.id)}
                          >
                            Deactivate
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              {subTenant.legalNameEn} takes over its own account. Your staff's custody
              authorisations end with this change
              {subTenant.custodyStaffCount > 0 &&
                ` — ${subTenant.custodyStaffCount} ${
                  subTenant.custodyStaffCount === 1 ? 'person is' : 'people are'
                } authorised today`}
              .
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Administrator name"
                hint="Not needed if the client already has an administrator."
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
          </>
        )}
      </div>
    </Modal>
  );
}
