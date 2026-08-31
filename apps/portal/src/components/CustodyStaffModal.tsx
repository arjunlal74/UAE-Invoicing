import type {
  CustodyGrant,
  PaginatedResult,
  PartnerStaffMember,
  Role,
  SubTenantSummary,
} from '@uae/contracts';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, TENANT_ROLES } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Field, Modal, Spinner, formatDate, inputClass } from './ui';
import { ApiError, api } from '../lib/api';

/**
 * Who may act for a client held in custody (SRS §3).
 *
 * Two decisions in one dialog, because they are the same decision: which member
 * of the firm's staff, and what they may do once inside. The role is the one
 * they hold *in the client's books* rather than their rank at the partner — an
 * auditing firm puts juniors on preparation and keeps filing with a signatory,
 * and that is exactly the line ACCOUNTANT and TAX_APPROVER_CFO already draw
 * inside a tenant.
 *
 * A partner administrator is not on this list by default and has to add
 * themselves like anyone else. That is deliberate: the answer to "who was
 * allowed into this company's records" has to be this table, with nothing
 * implicit sitting outside it.
 */
export function CustodyStaffModal({
  subTenant,
  onClose,
}: {
  subTenant: SubTenantSummary;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<{ userId: string; role: Role }>({
    userId: '',
    // The commonest case in an auditing firm: staff prepare, a signatory files.
    role: 'ACCOUNTANT',
  });

  const grants = useQuery({
    queryKey: ['custody-staff', subTenant.id],
    queryFn: () =>
      api<{ items: CustodyGrant[] }>(`/api/v1/partner/sub-tenants/${subTenant.id}/custody-staff`),
  });

  const staff = useQuery({
    queryKey: ['partner-staff'],
    queryFn: () => api<PaginatedResult<PartnerStaffMember>>('/api/v1/partner/staff'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['custody-staff', subTenant.id] });
    // The row shows how many people are authorised, and the dashboard counts
    // the clients nobody is.
    void queryClient.invalidateQueries({ queryKey: ['partner-sub-tenants'] });
    void queryClient.invalidateQueries({ queryKey: ['partner-dashboard'] });
  };

  const authorised = new Set((grants.data?.items ?? []).map((grant) => grant.userId));
  const candidates = (staff.data?.items ?? []).filter(
    (member) => member.isActive && !authorised.has(member.id),
  );

  const grant = useMutation({
    mutationFn: () =>
      api(`/api/v1/partner/sub-tenants/${subTenant.id}/custody-staff`, {
        method: 'POST',
        body: { userId: pick.userId, role: pick.role },
      }),
    onSuccess: () => {
      setError(null);
      setPick({ userId: '', role: pick.role });
      refresh();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That authorisation could not be given.'),
  });

  const withdraw = useMutation({
    mutationFn: (grantId: string) =>
      api(`/api/v1/partner/custody-grants/${grantId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That authorisation could not be withdrawn.'),
  });

  return (
    <Modal
      title={`Authorised staff — ${subTenant.legalNameEn}`}
      onClose={onClose}
      width="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-4">
        {error && <Alert kind="danger">{error}</Alert>}

        <p className="text-sm text-slate-600">
          These are the people at your firm who can open {subTenant.legalNameEn}'s books and work in
          them. Everything they do there is recorded against their own name.
        </p>

        {grants.isLoading ? (
          <Spinner label="Loading authorisations…" />
        ) : (grants.data?.items ?? []).length === 0 ? (
          <Alert kind="warn" title="Nobody is authorised yet">
            This client is in your custody and has no login of its own, so until somebody here is
            authorised its invoices cannot be prepared or filed at all.
          </Alert>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Member of staff</th>
                <th className="pb-2 font-medium">Role in this client</th>
                <th className="pb-2 font-medium">Authorised</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {grants.data!.items.map((row) => (
                <tr key={row.id}>
                  <td className="py-2">
                    <div className="font-medium text-slate-800">{row.userName}</div>
                    <div className="text-xs text-slate-400">{row.userEmail}</div>
                  </td>
                  <td className="py-2">{ROLE_LABELS[row.role]}</td>
                  <td className="py-2 text-xs text-slate-500">
                    {formatDate(row.createdAt)}
                    {row.grantedByName && ` · by ${row.grantedByName}`}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={withdraw.isPending}
                      onClick={() => withdraw.mutate(row.id)}
                    >
                      Withdraw
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <h3 className="mb-2 text-sm font-medium text-slate-700">Authorise someone</h3>
          {candidates.length === 0 ? (
            <p className="text-sm text-slate-500">
              Everyone on your staff is already authorised for this client.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[1fr,1fr,auto] sm:items-end">
              <Field label="Member of staff">
                <select
                  className={inputClass}
                  value={pick.userId}
                  onChange={(e) => setPick({ ...pick, userId: e.target.value })}
                >
                  <option value="">Select…</option>
                  {candidates.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.fullName}
                      {member.hasSignedIn ? '' : ' (invitation not accepted)'}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Role in this client" hint={ROLE_DESCRIPTIONS[pick.role]}>
                <select
                  className={inputClass}
                  value={pick.role}
                  onChange={(e) => setPick({ ...pick, role: e.target.value as Role })}
                >
                  {TENANT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </Field>
              <Button
                variant="primary"
                className="mb-1"
                disabled={!pick.userId || grant.isPending}
                onClick={() => grant.mutate()}
              >
                {grant.isPending ? 'Authorising…' : 'Authorise'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
