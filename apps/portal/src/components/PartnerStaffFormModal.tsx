import type { PartnerStaffMember } from '@uae/contracts';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@uae/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Field, Modal, formatDateTime, inputClass } from './ui';
import { ApiError, api } from '../lib/api';

/**
 * One dialog for inviting a colleague, reading their record and correcting it.
 *
 * Three modes rather than three components, on the same reasoning as the client
 * record: they are the same eight facts, and a separate read-only screen is a
 * second place for a field to be forgotten. Viewing is the form disabled.
 *
 * Everyone here is a partner administrator, so the role is shown and not
 * chosen. It is the only role that means anything at a firm — the console and
 * the custody sessions opened from it are behind the same permission — and what
 * separates a junior from a signatory is the role their authorisation carries
 * inside each client's books, which is set per client rather than here.
 */
export function PartnerStaffFormModal({
  member,
  mode,
  onClose,
}: {
  /** Absent when inviting somebody new. */
  member?: PartnerStaffMember;
  mode: 'create' | 'view' | 'edit';
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<{ inviteUrl: string; emailed: boolean } | null>(null);
  const [form, setForm] = useState({
    fullName: member?.fullName ?? '',
    email: member?.email ?? '',
  });

  const readOnly = mode === 'view';
  // Before somebody accepts, the address is an unaccepted invitation with a
  // typo in it. Afterwards it is the credential they sign in with, and the
  // server refuses to change it — so the field says so rather than failing.
  const emailFixed = mode === 'edit' && !!member?.hasSignedIn;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['partner-staff'] });
    void queryClient.invalidateQueries({ queryKey: ['partner-dashboard'] });
  };

  const invite = useMutation({
    mutationFn: () =>
      api<{ id: string; inviteUrl: string; emailed: boolean }>('/api/v1/partner/staff', {
        method: 'POST',
        body: { fullName: form.fullName.trim(), email: form.email.trim() },
      }),
    onSuccess: (result) => {
      setError(null);
      setInvited({ inviteUrl: result.inviteUrl, emailed: result.emailed });
      refresh();
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'That account could not be created.'),
  });

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/partner/staff/${member!.id}`, {
        method: 'PATCH',
        body: {
          fullName: form.fullName.trim(),
          email: emailFixed ? undefined : form.email.trim(),
        },
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'Those changes could not be saved.'),
  });

  if (invited) {
    return (
      // The link is shown once, and where the mail did not go out it is the
      // only copy, so a stray click on the backdrop must not be what loses it.
      <Modal
        title="Colleague invited"
        onClose={onClose}
        dismissOnBackdrop={false}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <Alert
          kind={invited.emailed ? 'ok' : 'warn'}
          title={
            invited.emailed
              ? `Invitation e-mailed to ${form.email}`
              : 'Send this invitation to them'
          }
        >
          <p className="mt-2 break-all rounded bg-white/60 p-2 font-mono text-xs">
            {invited.inviteUrl}
          </p>
          <p className="mt-2 text-xs">
            {invited.emailed
              ? 'The link is here as well, in case it needs passing on by hand. '
              : 'Outgoing mail is not configured, so this link is the only copy. '}
            They can sign in once they have set a password, and can be authorised for a custody
            client from that client's row.
          </p>
        </Alert>
      </Modal>
    );
  }

  const title =
    mode === 'create' ? 'Invite a colleague' : readOnly ? member!.fullName : `Edit ${member!.fullName}`;

  return (
    <Modal
      title={title}
      onClose={onClose}
      width="lg"
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                !form.fullName.trim() ||
                !form.email.trim() ||
                invite.isPending ||
                save.isPending
              }
              onClick={() => (mode === 'create' ? invite.mutate() : save.mutate())}
            >
              {mode === 'create'
                ? invite.isPending
                  ? 'Inviting…'
                  : 'Send invitation'
                : save.isPending
                  ? 'Saving…'
                  : 'Save changes'}
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-4">
        {error && <Alert kind="danger">{error}</Alert>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name" required={!readOnly}>
            <input
              className={inputClass}
              disabled={readOnly}
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </Field>

          <Field
            label="Email"
            required={mode === 'create'}
            hint={
              emailFixed
                ? 'They have signed in, so this is how they log in and cannot be changed here.'
                : 'Where the invitation is sent. They sign in with it.'
            }
          >
            <input
              className={inputClass}
              type="email"
              disabled={readOnly || emailFixed}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>

          <Field label="Role" hint={ROLE_DESCRIPTIONS.PARTNER_ADMIN}>
            <input className={inputClass} disabled value={ROLE_LABELS.PARTNER_ADMIN} />
          </Field>

          {member && (
            <>
              <Field label="Account">
                <input
                  className={inputClass}
                  disabled
                  value={
                    !member.isActive
                      ? 'Locked — cannot sign in'
                      : member.hasSignedIn
                        ? 'Active'
                        : 'Invited, not yet accepted'
                  }
                />
              </Field>

              <Field label="Two-factor authentication">
                <input
                  className={inputClass}
                  disabled
                  value={member.mfaEnabled ? 'Enabled' : 'Not set up'}
                />
              </Field>

              <Field label="Last sign-in">
                <input
                  className={inputClass}
                  disabled
                  value={member.lastLoginAt ? formatDateTime(member.lastLoginAt) : 'Never'}
                />
              </Field>

              <Field label="Added">
                <input className={inputClass} disabled value={formatDateTime(member.createdAt)} />
              </Field>
            </>
          )}
        </div>

        {mode === 'create' && (
          <Alert kind="info" title="They are invited, not created with a password">
            Nobody here can set or see somebody else's password. They choose one from the
            invitation link, and until they do the account cannot sign in or be authorised for a
            client.
          </Alert>
        )}
      </div>
    </Modal>
  );
}
