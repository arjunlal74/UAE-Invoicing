import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EMIRATES, isValidTrn } from '@uae/domain';
import type { PaginatedResult, SupplierSummary } from '@uae/contracts';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Pagination,
  Spinner,
  inputClass,
} from '../../components/ui';
import { ApiError, api, queryString } from '../../lib/api';
import { can, useAuthStore } from '../../stores/auth';

/**
 * The Supplier Master Directory (SRS v2.7 §12.1).
 *
 * The AR directory's mirror, plus the fields you only need about someone you
 * pay. The one behaviour with no counterpart on the customer side is the
 * provisional flag: a purchase invoice from an unknown TRN creates a vendor
 * record automatically so the bill can be received, and this screen is where a
 * person confirms it is a real supplier before anyone is paid.
 */

type FormState = {
  supplierCode: string;
  supplierNameEn: string;
  supplierNameAr: string;
  trn: string;
  emirate: string;
  streetAddress: string;
  postalCode: string;
  bankName: string;
  bankIban: string;
  paymentTermsDays: number;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  isActive: boolean;
};

const EMPTY: FormState = {
  supplierCode: '',
  supplierNameEn: '',
  supplierNameAr: '',
  trn: '',
  emirate: 'Dubai',
  streetAddress: '',
  postalCode: '',
  bankName: '',
  bankIban: '',
  paymentTermsDays: 30,
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  notes: '',
  isActive: true,
};

function toForm(supplier: SupplierSummary): FormState {
  return {
    supplierCode: supplier.supplierCode ?? '',
    supplierNameEn: supplier.supplierNameEn,
    supplierNameAr: supplier.supplierNameAr ?? '',
    trn: supplier.trn ?? '',
    emirate: supplier.emirate,
    streetAddress: supplier.streetAddress,
    postalCode: supplier.postalCode ?? '',
    bankName: supplier.bankName ?? '',
    bankIban: supplier.bankIban ?? '',
    paymentTermsDays: supplier.paymentTermsDays,
    contactName: supplier.contactName ?? '',
    contactEmail: supplier.contactEmail ?? '',
    contactPhone: supplier.contactPhone ?? '',
    notes: supplier.notes ?? '',
    isActive: supplier.isActive,
  };
}

function toRequest(form: FormState) {
  return {
    ...form,
    supplierCode: form.supplierCode || null,
    supplierNameAr: form.supplierNameAr || null,
    trn: form.trn || null,
    postalCode: form.postalCode || null,
    bankName: form.bankName || null,
    bankIban: form.bankIban || null,
    contactName: form.contactName || null,
    contactEmail: form.contactEmail || null,
    contactPhone: form.contactPhone || null,
    notes: form.notes || null,
  };
}

export function SuppliersPage() {
  const user = useAuthStore((s) => s.user);
  const editable = can(user, 'directory.manage');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<SupplierSummary | null>(null);
  const [creating, setCreating] = useState(false);

  const pageSize = 25;
  const { data, isLoading } = useQuery({
    queryKey: ['suppliers', search, includeInactive, page],
    queryFn: () =>
      api<PaginatedResult<SupplierSummary>>(
        `/api/v1/suppliers${queryString({ q: search, includeInactive, page, pageSize })}`,
      ),
  });

  const close = () => {
    setEditing(null);
    setCreating(false);
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    close();
  };

  const deactivate = useMutation({
    mutationFn: (id: string) => api(`/api/v1/suppliers/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const provisional = data?.items.filter((s) => s.isProvisional).length ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Supplier directory"
        description="Vendors whose e-invoices arrive through the FTA Peppol network."
        actions={
          editable && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add supplier
            </Button>
          )
        }
      />

      {provisional > 0 && (
        <Alert kind="warn" title="Unvetted suppliers">
          {provisional} supplier{provisional === 1 ? ' was' : 's were'} created automatically from
          an incoming invoice. Confirm the bank and contact details before authorising payment —
          saving the record marks it vetted.
        </Alert>
      )}

      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <input
            className={inputClass}
            placeholder="Name, TRN or supplier code…"
            defaultValue={search}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setSearch((e.target as HTMLInputElement).value);
                setPage(1);
              }
            }}
            onBlur={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => {
                setIncludeInactive(e.target.checked);
                setPage(1);
              }}
            />
            Show deactivated suppliers
          </label>
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-6">
            <Spinner label="Loading suppliers…" />
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            title="No suppliers yet"
            description="Suppliers appear here automatically the first time one of their invoices arrives, or you can add them ahead of time."
            action={
              editable && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  Add a supplier
                </Button>
              )
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Supplier</th>
                <th className="px-4 py-2 font-medium">TRN</th>
                <th className="px-4 py-2 font-medium">Emirate</th>
                <th className="px-4 py-2 font-medium">Terms</th>
                <th className="px-4 py-2 text-right font-medium">Invoices</th>
                <th className="px-4 py-2 text-right font-medium">Rejected</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((supplier) => (
                <tr key={supplier.id} className={supplier.isActive ? '' : 'bg-slate-50/60'}>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{supplier.supplierNameEn}</span>
                      {supplier.isProvisional && (
                        <span className="rounded-full bg-warn-50 px-2 py-0.5 text-xs font-medium text-warn-700">
                          Unvetted
                        </span>
                      )}
                    </div>
                    {supplier.supplierNameAr && (
                      <div className="text-xs text-slate-500" dir="rtl">
                        {supplier.supplierNameAr}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">
                    {supplier.trn ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{supplier.emirate}</td>
                  <td className="px-4 py-2 text-slate-600">{supplier.paymentTermsDays} days</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                    {supplier.invoiceCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {supplier.rejectedCount > 0 ? (
                      <span className="font-medium text-danger-700">{supplier.rejectedCount}</span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        onClick={() => navigate(`/ap/inbox?supplierId=${supplier.id}`)}
                      >
                        Invoices
                      </Button>
                      {editable && (
                        <Button size="sm" onClick={() => setEditing(supplier)}>
                          Edit
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {data && <Pagination page={page} pageSize={pageSize} total={data.total} onPage={setPage} />}
      </div>

      {(creating || editing) && (
        <SupplierForm
          supplier={editing}
          onClose={close}
          onSaved={refresh}
          onDeactivate={
            editing && editing.isActive ? () => deactivate.mutate(editing.id) : undefined
          }
        />
      )}
    </div>
  );
}

function SupplierForm({
  supplier,
  onClose,
  onSaved,
  onDeactivate,
}: {
  supplier: SupplierSummary | null;
  onClose: () => void;
  onSaved: () => void;
  onDeactivate?: () => void;
}) {
  const [form, setForm] = useState<FormState>(supplier ? toForm(supplier) : EMPTY);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: () =>
      api(supplier ? `/api/v1/suppliers/${supplier.id}` : '/api/v1/suppliers', {
        method: supplier ? 'PUT' : 'POST',
        body: toRequest(form),
      }),
    onSuccess: onSaved,
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'The supplier could not be saved.'),
  });

  const trnValid = !form.trn || isValidTrn(form.trn);
  const canSave = form.supplierNameEn.trim().length > 0 && trnValid;

  return (
    <Modal
      title={supplier ? `Edit ${supplier.supplierNameEn}` : 'Add supplier'}
      onClose={onClose}
      width="lg"
      footer={
        <>
          {onDeactivate && (
            <Button variant="danger" onClick={onDeactivate} className="mr-auto">
              Deactivate
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : supplier?.isProvisional ? 'Confirm supplier' : 'Save supplier'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert kind="danger">{error}</Alert>}

        {supplier?.isProvisional && (
          <Alert kind="warn" title="Created from an incoming invoice">
            This record was generated automatically when a purchase invoice arrived from a TRN with
            no supplier on file. Saving it confirms the details and clears the unvetted flag.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Legal name (English)" required>
            <input
              className={inputClass}
              value={form.supplierNameEn}
              onChange={(e) => set('supplierNameEn', e.target.value)}
            />
          </Field>
          <Field label="Legal name (Arabic)">
            <input
              className={inputClass}
              dir="rtl"
              value={form.supplierNameAr}
              onChange={(e) => set('supplierNameAr', e.target.value)}
            />
          </Field>

          <Field
            label="Tax registration number"
            error={form.trn && !trnValid ? 'A TRN is 15 digits beginning with 1.' : undefined}
            hint="Incoming invoices are matched to this supplier by TRN."
          >
            <input
              className={inputClass}
              value={form.trn}
              maxLength={15}
              inputMode="numeric"
              onChange={(e) => set('trn', e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Field label="Supplier code">
            <input
              className={inputClass}
              value={form.supplierCode}
              onChange={(e) => set('supplierCode', e.target.value)}
            />
          </Field>

          <Field label="Emirate" required>
            <select
              className={inputClass}
              value={form.emirate}
              onChange={(e) => set('emirate', e.target.value)}
            >
              {EMIRATES.map((emirate) => (
                <option key={emirate} value={emirate}>
                  {emirate}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Street">
            <input
              className={inputClass}
              value={form.streetAddress}
              onChange={(e) => set('streetAddress', e.target.value)}
            />
          </Field>
          <Field label="PO box / postal code">
            <input
              className={inputClass}
              value={form.postalCode}
              onChange={(e) => set('postalCode', e.target.value)}
            />
          </Field>

          <Field label="Payment terms (days)">
            <input
              className={inputClass}
              type="number"
              min={0}
              max={365}
              value={form.paymentTermsDays}
              onChange={(e) => set('paymentTermsDays', Number(e.target.value) || 0)}
            />
          </Field>

          <Field label="Bank name">
            <input
              className={inputClass}
              value={form.bankName}
              onChange={(e) => set('bankName', e.target.value)}
            />
          </Field>
          <Field label="IBAN" hint="Verify this against the supplier directly, never from an email.">
            <input
              className={cxInput}
              value={form.bankIban}
              onChange={(e) => set('bankIban', e.target.value.toUpperCase())}
            />
          </Field>

          <Field label="Contact name">
            <input
              className={inputClass}
              value={form.contactName}
              onChange={(e) => set('contactName', e.target.value)}
            />
          </Field>
          <Field label="Contact email">
            <input
              className={inputClass}
              type="email"
              value={form.contactEmail}
              onChange={(e) => set('contactEmail', e.target.value)}
            />
          </Field>
          <Field label="Contact phone">
            <input
              className={inputClass}
              value={form.contactPhone}
              onChange={(e) => set('contactPhone', e.target.value)}
            />
          </Field>
        </div>

        <Field label="Notes">
          <textarea
            className={inputClass}
            rows={2}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

/** IBANs are read back character by character when someone is checking them. */
const cxInput = `${inputClass} font-mono tracking-wide`;
