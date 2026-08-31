import type { SubTenantSummary } from '@uae/contracts';
import { PROVISIONING_MODE_DESCRIPTIONS, PROVISIONING_MODE_LABELS } from '@uae/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EMIRATES } from '@uae/domain';
import { useState } from 'react';
import { Alert, Button, Field, Modal, StatusBadge, formatDate, inputClass } from './ui';
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
        </div>

        {/* The state of the account, which is read rather than set here: the
            provisioning mode has its own dialog, and the two status badges are
            the platform's to change. */}
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Account</dt>
              <dd>
                <StatusBadge status={subTenant.status} />
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Provider connection</dt>
              <dd>
                <StatusBadge status={subTenant.aspStatus} />
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Provisioning</dt>
              <dd className="font-medium text-slate-800">
                {PROVISIONING_MODE_LABELS[subTenant.provisioningMode]}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">
                {custody ? 'Authorised staff' : 'Their own users'}
              </dt>
              <dd className="tabular-nums text-slate-800">
                {custody ? subTenant.custodyStaffCount : subTenant.userCount}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Invoices filed</dt>
              <dd className="tabular-nums text-slate-800">{subTenant.invoiceCount}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500">Onboarded</dt>
              <dd className="text-slate-800">{formatDate(subTenant.createdAt)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            {PROVISIONING_MODE_DESCRIPTIONS[subTenant.provisioningMode]}
          </p>
        </div>

        {subTenant.isLocked && (
          <Alert kind="warn" title="This record is locked by the platform">
            Its details cannot be edited until they unlock it. Filing is unaffected.
          </Alert>
        )}
      </div>
    </Modal>
  );
}
