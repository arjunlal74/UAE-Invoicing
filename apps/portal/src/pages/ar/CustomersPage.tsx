import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EMIRATES, PAYMENT_MEANS, isValidTrn } from '@uae/domain';
import type { CustomerSummary, PaginatedResult } from '@uae/contracts';
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
 * The Customer Master Directory (SRS v2.7 §6).
 *
 * The point of this screen is not record-keeping for its own sake — it is that
 * the in-app invoice builder can fill an entire buyer party block from one
 * search, and that B2B/B2C (which decides 380 versus 388) is decided once here
 * rather than re-guessed on every invoice.
 */

type FormState = {
  customerCode: string;
  customerNameEn: string;
  customerNameAr: string;
  customerType: 'B2B' | 'B2C';
  trn: string;
  emirate: string;
  streetAddress: string;
  building: string;
  postalCode: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  defaultPaymentMeans: string;
  notes: string;
  isActive: boolean;
};

const EMPTY: FormState = {
  customerCode: '',
  customerNameEn: '',
  customerNameAr: '',
  customerType: 'B2B',
  trn: '',
  emirate: 'Dubai',
  streetAddress: '',
  building: '',
  postalCode: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  defaultPaymentMeans: '30',
  notes: '',
  isActive: true,
};

function toForm(customer: CustomerSummary): FormState {
  return {
    customerCode: customer.customerCode ?? '',
    customerNameEn: customer.customerNameEn,
    customerNameAr: customer.customerNameAr ?? '',
    customerType: customer.customerType,
    trn: customer.trn ?? '',
    emirate: customer.emirate,
    streetAddress: customer.streetAddress,
    building: customer.building ?? '',
    postalCode: customer.postalCode ?? '',
    contactName: customer.contactName ?? '',
    contactEmail: customer.contactEmail ?? '',
    contactPhone: customer.contactPhone ?? '',
    defaultPaymentMeans: customer.defaultPaymentMeans ?? '30',
    notes: customer.notes ?? '',
    isActive: customer.isActive,
  };
}

function toRequest(form: FormState) {
  return {
    ...form,
    customerCode: form.customerCode || null,
    customerNameAr: form.customerNameAr || null,
    // A B2C individual has no TRN, and sending an empty string would fail the
    // 15-digit check rather than being read as "not applicable".
    trn: form.customerType === 'B2B' ? form.trn : null,
    building: form.building || null,
    postalCode: form.postalCode || null,
    contactName: form.contactName || null,
    contactEmail: form.contactEmail || null,
    contactPhone: form.contactPhone || null,
    defaultPaymentMeans: form.defaultPaymentMeans || null,
    notes: form.notes || null,
  };
}

export function CustomersPage() {
  const user = useAuthStore((s) => s.user);
  const editable = can(user, 'directory.manage');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<CustomerSummary | null>(null);
  const [creating, setCreating] = useState(false);

  const pageSize = 25;
  const { data, isLoading } = useQuery({
    queryKey: ['customers', search, includeInactive, page],
    queryFn: () =>
      api<PaginatedResult<CustomerSummary>>(
        `/api/v1/customers${queryString({ q: search, includeInactive, page, pageSize })}`,
      ),
  });

  const close = () => {
    setEditing(null);
    setCreating(false);
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['customers'] });
    close();
  };

  const deactivate = useMutation({
    mutationFn: (id: string) => api(`/api/v1/customers/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customer directory"
        description="Buyer profiles used by the invoice builder and the Excel importer."
        actions={
          editable && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add customer
            </Button>
          )
        }
      />

      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <input
            className={inputClass}
            placeholder="Name, TRN or customer code…"
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
            Show deactivated customers
          </label>
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-6">
            <Spinner label="Loading customers…" />
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            title="No customers yet"
            description="Add the buyers you invoice so the builder can fill their details for you."
            action={
              editable && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  Add your first customer
                </Button>
              )
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">TRN</th>
                <th className="px-4 py-2 font-medium">Emirate</th>
                <th className="px-4 py-2 text-right font-medium">Invoices</th>
                <th className="px-4 py-2 text-right font-medium">Open disputes</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((customer) => (
                <tr key={customer.id} className={customer.isActive ? '' : 'bg-slate-50/60'}>
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-800">{customer.customerNameEn}</div>
                    {customer.customerNameAr && (
                      <div className="text-xs text-slate-500" dir="rtl">
                        {customer.customerNameAr}
                      </div>
                    )}
                    {!customer.isActive && (
                      <span className="text-xs text-slate-400">Deactivated</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{customer.customerType}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">
                    {customer.trn ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{customer.emirate}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                    {customer.invoiceCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {customer.openDisputes > 0 ? (
                      <span className="font-medium text-danger-700">{customer.openDisputes}</span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      {can(user, 'invoice.edit') && customer.isActive && (
                        <Button
                          size="sm"
                          onClick={() =>
                            navigate(`/ar/new-invoice?customerId=${customer.id}`)
                          }
                        >
                          Invoice
                        </Button>
                      )}
                      {editable && (
                        <Button size="sm" onClick={() => setEditing(customer)}>
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

        {data && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={data.total}
            onPage={setPage}
          />
        )}
      </div>

      {(creating || editing) && (
        <CustomerForm
          customer={editing}
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

function CustomerForm({
  customer,
  onClose,
  onSaved,
  onDeactivate,
}: {
  customer: CustomerSummary | null;
  onClose: () => void;
  onSaved: () => void;
  onDeactivate?: () => void;
}) {
  const [form, setForm] = useState<FormState>(customer ? toForm(customer) : EMPTY);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: () =>
      api(customer ? `/api/v1/customers/${customer.id}` : '/api/v1/customers', {
        method: customer ? 'PUT' : 'POST',
        body: toRequest(form),
      }),
    onSuccess: onSaved,
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'The customer could not be saved.'),
  });

  const trnRequired = form.customerType === 'B2B';
  const trnValid = !trnRequired || isValidTrn(form.trn);
  const canSave = form.customerNameEn.trim().length > 0 && trnValid;

  return (
    <Modal
      title={customer ? `Edit ${customer.customerNameEn}` : 'Add customer'}
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
            {save.isPending ? 'Saving…' : 'Save customer'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert kind="danger">{error}</Alert>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Legal name (English)" required>
            <input
              className={inputClass}
              value={form.customerNameEn}
              onChange={(e) => set('customerNameEn', e.target.value)}
            />
          </Field>
          <Field label="Legal name (Arabic)">
            <input
              className={inputClass}
              dir="rtl"
              value={form.customerNameAr}
              onChange={(e) => set('customerNameAr', e.target.value)}
            />
          </Field>

          <Field
            label="Customer type"
            hint="B2B issues a full tax invoice (380); B2C a simplified one (388)."
          >
            <select
              className={inputClass}
              value={form.customerType}
              onChange={(e) => set('customerType', e.target.value as 'B2B' | 'B2C')}
            >
              <option value="B2B">B2B — registered business</option>
              <option value="B2C">B2C — individual</option>
            </select>
          </Field>

          <Field
            label="Tax registration number"
            required={trnRequired}
            error={
              trnRequired && form.trn && !trnValid
                ? 'A TRN is 15 digits beginning with 1.'
                : undefined
            }
            hint={trnRequired ? undefined : 'Not applicable to an individual buyer.'}
          >
            <input
              className={inputClass}
              value={form.trn}
              disabled={!trnRequired}
              maxLength={15}
              inputMode="numeric"
              onChange={(e) => set('trn', e.target.value.replace(/\D/g, ''))}
            />
          </Field>

          <Field label="Customer code" hint="Your own reference, if you use one.">
            <input
              className={inputClass}
              value={form.customerCode}
              onChange={(e) => set('customerCode', e.target.value)}
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
          <Field label="Building">
            <input
              className={inputClass}
              value={form.building}
              onChange={(e) => set('building', e.target.value)}
            />
          </Field>
          <Field label="PO box / postal code">
            <input
              className={inputClass}
              value={form.postalCode}
              onChange={(e) => set('postalCode', e.target.value)}
            />
          </Field>

          <Field label="Default payment means">
            <select
              className={inputClass}
              value={form.defaultPaymentMeans}
              onChange={(e) => set('defaultPaymentMeans', e.target.value)}
            >
              {Object.entries(PAYMENT_MEANS).map(([code, label]) => (
                <option key={code} value={code}>
                  {code} — {label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Contact name">
            <input
              className={inputClass}
              value={form.contactName}
              onChange={(e) => set('contactName', e.target.value)}
            />
          </Field>
          <Field label="Contact email" hint="Used for invoice dispatch and dispute alerts.">
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
