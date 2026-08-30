import { TENANT_TYPE_LABELS, type TenantSummary } from '@uae/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Modal, formatDate, inputClass, statusLabel } from './ui';
import { ApiError, api } from '../lib/api';

/**
 * One form for reading a tenant and for editing it.
 *
 * Viewing used to mean leaving the list for the detail page, which is a heavier
 * move than "what is this row". The same fields, disabled, answer that without
 * losing the reader's place — and a field added to the form cannot quietly fail
 * to appear on the screen people open first.
 *
 * Most of it is read-only in both modes. Only the two legal names can be
 * changed: the TRN, company code and tier identify this tenant to the tax
 * authority and on every document already filed under it, so altering one is
 * not an edit but a different company, and the endpoint refuses them too.
 */
export function TenantFormModal({
  tenant,
  readOnly = false,
  onClose,
}: {
  tenant: TenantSummary;
  readOnly?: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    legalNameEn: tenant.legalNameEn,
    legalNameAr: tenant.legalNameAr ?? '',
  });

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/tenants/${tenant.id}`, {
        method: 'PATCH',
        body: {
          legalNameEn: form.legalNameEn.trim(),
          legalNameAr: form.legalNameAr.trim() || undefined,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
      onClose();
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'Those changes could not be saved.'),
  });

  return (
    <Modal
      title={readOnly ? tenant.legalNameEn : `Edit ${tenant.companyCode}`}
      onClose={onClose}
      width="lg"
    >
      <div className="space-y-3">
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

          <Field label="Legal name (Arabic)">
            <input
              className={`${inputClass} arabic`}
              lang="ar"
              dir="rtl"
              disabled={readOnly}
              value={form.legalNameAr}
              onChange={(e) => setForm({ ...form, legalNameAr: e.target.value })}
            />
          </Field>

          {/* Shown in both modes and editable in neither. Reading a tenant
              without its TRN or its tier would send someone to the detail page
              for the two facts they most often came for. */}
          <Field label="Company code">
            <input className={inputClass} disabled value={tenant.companyCode} />
          </Field>

          <Field label="Tier">
            <input className={inputClass} disabled value={TENANT_TYPE_LABELS[tenant.tenantType]} />
          </Field>

          <Field label="TRN" hint="Identifies this tenant to the tax authority.">
            <input className={inputClass} disabled value={tenant.trn ?? '—'} />
          </Field>

          <Field label="Under" hint="The channel partner this account sits beneath.">
            <input className={inputClass} disabled value={tenant.parentName ?? '—'} />
          </Field>

          <Field label="Account">
            <input
              className={inputClass}
              disabled
              value={`${statusLabel(tenant.status)}${tenant.isLocked ? ' · record locked' : ''}`}
            />
          </Field>

          <Field label="Provider connection">
            <input className={inputClass} disabled value={statusLabel(tenant.aspStatus)} />
          </Field>

          <Field label="Onboarded">
            <input className={inputClass} disabled value={formatDate(tenant.createdAt)} />
          </Field>

          <Field label="Invoices filed">
            <input className={inputClass} disabled value={tenant.invoiceCount.toLocaleString()} />
          </Field>
        </div>

        {!readOnly && (
          <p className="text-xs text-slate-500">
            The TRN, company code and tier identify this tenant on every document already filed
            under it, so they are not editable here.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          {readOnly ? (
            <>
              {/* The users, the lifecycle and the provider connection live on
                  the full record. Without this the list has no route to it —
                  the name stopped being a link when these buttons arrived. */}
              <Button onClick={() => navigate(`/admin/tenants/${tenant.id}`)}>
                Open full record
              </Button>
              <Button variant="primary" onClick={onClose}>
                Close
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onClose}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!form.legalNameEn.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

