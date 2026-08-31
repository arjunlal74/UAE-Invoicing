import type { ProvisioningMode } from '@uae/contracts';
import { PROVISIONING_MODE_DESCRIPTIONS, PROVISIONING_MODE_LABELS } from '@uae/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EMIRATES } from '@uae/domain';
import { useState } from 'react';
import { Alert, Button, Field, Modal, cx, inputClass } from './ui';
import { ApiError, api } from '../lib/api';

/**
 * Onboarding a client, as a dialog over the book it joins.
 *
 * It used to be a panel that pushed the list of clients off the screen: a
 * partner opening the page to look somebody up was met by eight empty fields,
 * and the one thing the page is for had scrolled away. The form is the same
 * form — the same fields, the same rules, the same endpoint — but it is now
 * something the partner asks for, and closing it puts the list back exactly
 * where it was.
 *
 * Modelled on the platform's own onboarding dialog so the two consoles behave
 * alike, because the people who administer a partner have usually seen that one
 * first.
 */
export function CreateSubTenantModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    inviteUrl: string | null;
    emailed: boolean;
    mode: ProvisioningMode;
  } | null>(null);

  const [form, setForm] = useState({
    companyCode: '',
    legalNameEn: '',
    legalNameAr: '',
    trn: '',
    street: '',
    emirate: 'Dubai',
    provisioningMode: 'COLLABORATIVE' as ProvisioningMode,
    adminEmail: '',
    adminFullName: '',
  });

  const custody = form.provisioningMode === 'FULLY_MANAGED_CUSTODY';

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; inviteUrl: string | null; emailed: boolean }>(
        '/api/v1/partner/sub-tenants',
        {
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
            provisioningMode: form.provisioningMode,
            // Omitted rather than sent empty in custody: there is no
            // administrator, and an empty string would fail the e-mail rule
            // for a field the mode says is not there.
            adminEmail: custody ? undefined : form.adminEmail,
            adminFullName: custody ? undefined : form.adminFullName,
          },
        },
      ),
    onSuccess: (result) => {
      setError(null);
      setCreated({
        inviteUrl: result.inviteUrl,
        emailed: result.emailed,
        mode: form.provisioningMode,
      });
      void queryClient.invalidateQueries({ queryKey: ['partner-sub-tenants'] });
      void queryClient.invalidateQueries({ queryKey: ['partner-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['partner-dashboard'] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That sub-tenant could not be created.'),
  });

  if (created && created.mode === 'FULLY_MANAGED_CUSTODY') {
    return (
      <Modal
        title="Sub-tenant created"
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <Alert kind="ok" title={`${form.legalNameEn} is in your custody`}>
          <p className="mt-2 text-xs">
            No activation link was sent — the client has no login of its own. Authorise the members
            of your staff who will work in this account from{' '}
            <strong>Staff</strong> on its row, and they can open its books from there.
          </p>
          <p className="mt-2 text-xs">
            It starts in <strong>Pending</strong> and cannot file until the platform activates its
            provider connection.
          </p>
        </Alert>
      </Modal>
    );
  }

  if (created) {
    return (
      // The link is shown exactly once, and where the mail did not go out it is
      // the only copy, so a stray click on the backdrop must not be what loses
      // it.
      <Modal
        title="Sub-tenant created"
        onClose={onClose}
        dismissOnBackdrop={false}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <Alert
          kind={created.emailed ? 'ok' : 'warn'}
          title={
            created.emailed
              ? `Invitation e-mailed to ${form.adminEmail}`
              : 'Send this invitation to their administrator'
          }
        >
          <p className="mt-2 break-all rounded bg-white/60 p-2 font-mono text-xs">
            {created.inviteUrl}
          </p>
          <p className="mt-2 text-xs">
            {created.emailed
              ? 'The link is here as well, in case they need it passing on by hand. '
              : 'Outgoing mail is not configured, so this link is the only copy. '}
            The sub-tenant starts in <strong>Pending</strong> and cannot file until the platform
            activates their provider connection.
          </p>
        </Alert>
      </Modal>
    );
  }

  return (
    <Modal
      title="Onboard a sub-tenant"
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex flex-1 items-center justify-between gap-4">
          <p className="text-xs text-slate-500">
            Their invoices are metered against your master bundle once billing is switched on.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => create.mutate()}
              disabled={
                create.isPending ||
                !form.companyCode ||
                !form.legalNameEn ||
                !form.legalNameAr ||
                form.trn.length !== 15 ||
                // Only the collaborative mode has an administrator to invite.
                (!custody && (!form.adminEmail || !form.adminFullName))
              }
            >
              {create.isPending ? 'Creating…' : 'Create sub-tenant'}
            </Button>
          </div>
        </div>
      }
    >
      {error && (
        <div className="mb-4">
          <Alert kind="danger">{error}</Alert>
        </div>
      )}

      {/* First, because it decides what the rest of the form asks for (§3). */}
      <fieldset className="mb-4">
        <legend className="mb-2 text-sm font-medium text-slate-700">Provisioning</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['COLLABORATIVE', 'FULLY_MANAGED_CUSTODY'] as ProvisioningMode[]).map((mode) => (
            <label
              key={mode}
              className={cx(
                'flex cursor-pointer gap-2 rounded-md border p-3 transition-colors',
                form.provisioningMode === mode
                  ? 'border-brand-400 bg-brand-50'
                  : 'border-slate-200 hover:bg-slate-50',
              )}
            >
              <input
                type="radio"
                name="provisioningMode"
                className="mt-0.5"
                checked={form.provisioningMode === mode}
                onChange={() => setForm({ ...form, provisioningMode: mode })}
              />
              <span>
                <span className="block text-sm font-medium text-slate-800">
                  {PROVISIONING_MODE_LABELS[mode]}
                </span>
                <span className="mt-0.5 block text-xs text-slate-600">
                  {PROVISIONING_MODE_DESCRIPTIONS[mode]}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
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
            dir="rtl"
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

        {/* Absent in custody rather than disabled: there is nobody to name, and
            a greyed-out pair of fields would read as something still to fill
            in. What replaces them is the authorisation of your own staff, which
            happens on the client's row once it exists. */}
        {!custody && (
          <>
            <Field
              label="Administrator name"
              hint="Invited as their company administrator."
              required
            >
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
          </>
        )}
      </div>

      {custody && (
        <div className="mt-4">
          <Alert kind="info" title="No activation link will be sent">
            The client gets no login. Once it exists, authorise the members of your staff who will
            file for it — each with the role they are to hold inside its books.
          </Alert>
        </div>
      )}
    </Modal>
  );
}
