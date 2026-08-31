import type { SubTenantSummary } from '@uae/contracts';
import { PROVISIONING_MODE_DESCRIPTIONS, PROVISIONING_MODE_LABELS } from '@uae/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EMIRATES } from '@uae/domain';
import { useState } from 'react';
import { Alert, Button, Field, Modal, formatDate, inputClass, statusLabel } from './ui';
import { ApiError, api } from '../lib/api';

/**
 * One form for reading a client's record and for correcting it.
 *
 * The same shape the platform's own tenant dialog uses, and for the same
 * reason: viewing used to mean having no way to see anything the list column
 * did not carry, and a separate read-only screen is a second place for a field
 * to be forgotten. Disabled inputs answer "what is this row" without the
 * partner losing their place in the list.
 *
 * Most of it is read-only in both modes. Only the two legal names and the
 * registered address can be changed: the TRN and the company code identify this
 * company to the tax authority and appear on every document already filed under
 * it, so altering one is not a correction but a different company — and the
 * endpoint will not take them either.
 */
export function SubTenantRecordModal({
  subTenant,
  readOnly = false,
  onClose,
}: {
  subTenant: SubTenantSummary;
  readOnly?: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    legalNameEn: subTenant.legalNameEn,
    legalNameAr: subTenant.legalNameAr ?? '',
    street: subTenant.registeredAddress.street ?? '',
    emirate: subTenant.registeredAddress.emirate ?? 'Dubai',
  });

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/partner/sub-tenants/${subTenant.id}`, {
        method: 'PATCH',
        body: {
          legalNameEn: form.legalNameEn.trim(),
          legalNameAr: form.legalNameAr.trim() || undefined,
          registeredAddress: {
            ...subTenant.registeredAddress,
            street: form.street,
            city: form.emirate,
            emirate: form.emirate,
          },
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['partner-sub-tenants'] });
      onClose();
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'Those changes could not be saved.'),
  });

  const custody = subTenant.provisioningMode === 'FULLY_MANAGED_CUSTODY';

  return (
    <Modal
      title={readOnly ? subTenant.legalNameEn : `Edit ${subTenant.companyCode}`}
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
              disabled={save.isPending || !form.legalNameEn.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-4">
        {error && <Alert kind="danger">{error}</Alert>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Legal name (English)" required={!readOnly}>
            <input
              className={inputClass}
              disabled={readOnly}
              value={form.legalNameEn}
              onChange={(e) => setForm({ ...form, legalNameEn: e.target.value })}
            />
          </Field>

          <Field label="Legal name (Arabic)" hint="Required on UAE tax invoices.">
            <input
              className={`${inputClass} arabic`}
              lang="ar"
              dir="rtl"
              disabled={readOnly}
              value={form.legalNameAr}
              onChange={(e) => setForm({ ...form, legalNameAr: e.target.value })}
            />
          </Field>

          {/* Shown in both modes and editable in neither. A record read without
              its TRN or its company code is missing the two facts a partner
              most often opened it for. */}
          <Field label="Company code">
            <input className={inputClass} disabled value={subTenant.companyCode} />
          </Field>

          <Field label="TRN" hint="Identifies the company on every document already filed.">
            <input
              className={`${inputClass} font-mono`}
              disabled
              value={subTenant.trn ?? '—'}
            />
          </Field>

          <Field label="Street address">
            <input
              className={inputClass}
              disabled={readOnly}
              value={form.street}
              onChange={(e) => setForm({ ...form, street: e.target.value })}
            />
          </Field>

          <Field label="Emirate">
            <select
              className={inputClass}
              disabled={readOnly}
              value={form.emirate}
              onChange={(e) =>
                setForm({ ...form, emirate: e.target.value as (typeof EMIRATES)[number] })
              }
            >
              {EMIRATES.map((emirate) => (
                <option key={emirate} value={emirate}>
                  {emirate}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Peppol participant id"
            hint="This client's address on the network. Registered by the provider."
          >
            <input
              className={`${inputClass} font-mono`}
              disabled
              value={subTenant.peppolParticipantId ?? '—'}
            />
          </Field>

          {/* The rest of the record, in the same grid rather than a panel
              underneath it. These are read here and set elsewhere — the mode
              has its own dialog, the two statuses are the platform's to change
              — but a fact you cannot edit is still a fact you came to read, and
              splitting the two apart made the form look like it stopped at the
              address. */}
          <Field label="Provisioning" hint={PROVISIONING_MODE_DESCRIPTIONS[subTenant.provisioningMode]}>
            <input
              className={inputClass}
              disabled
              value={PROVISIONING_MODE_LABELS[subTenant.provisioningMode]}
            />
          </Field>

          <Field
            label={custody ? 'Authorised staff' : 'Their own users'}
            hint={
              custody
                ? 'People at your firm who may act for this client.'
                : 'Logins belonging to the client.'
            }
          >
            <input
              className={inputClass}
              disabled
              value={(custody ? subTenant.custodyStaffCount : subTenant.userCount).toLocaleString()}
            />
          </Field>

          <Field label="Account">
            <input
              className={inputClass}
              disabled
              value={`${statusLabel(subTenant.status)}${
                subTenant.isLocked ? ' · record locked' : ''
              }`}
            />
          </Field>

          <Field label="Provider connection">
            <input className={inputClass} disabled value={statusLabel(subTenant.aspStatus)} />
          </Field>

          <Field label="Invoices filed">
            <input
              className={inputClass}
              disabled
              value={subTenant.invoiceCount.toLocaleString()}
            />
          </Field>

          <Field label="Onboarded">
            <input className={inputClass} disabled value={formatDate(subTenant.createdAt)} />
          </Field>
        </div>

        {!readOnly && (
          <p className="text-xs text-slate-500">
            The TRN and company code identify this client on every document already filed under
            it, so they are not editable here. The provisioning mode has its own dialog, and the
            two statuses are set by the platform.
          </p>
        )}

        {subTenant.isLocked && (
          <Alert kind="warn" title="This record is locked by the platform">
            Its details cannot be edited until they unlock it. Filing is unaffected.
          </Alert>
        )}
      </div>
    </Modal>
  );
}
