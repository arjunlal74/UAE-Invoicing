import {
  TENANT_TYPE_LABELS,
  type InventoryConsole,
  type PaginatedResult,
  type TenantSummary,
} from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Field,
  PageHeader,
  Spinner,
  StatTile,
  inputClass,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';

/**
 * Selling units downstream — §15.2, on its own screen.
 *
 * Direct tenants and channel partners only. A managed sub-tenant is not on the
 * list because its units come from its partner's master pool, not from the
 * host's shelf; putting it here would let the host allocate around the partner
 * and leave the partner's pool figures describing something that never happened.
 *
 * The shelf figure is on screen throughout, because the server will refuse a
 * sale it cannot cover and finding that out after typing the whole form is a
 * poor way to learn how much stock is left.
 */
export function AdminSellDataPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Same key the console reads, so arriving from it costs no round trip and
  // the shelf figure here is the one shown there.
  const { data: inventory, isLoading } = useQuery({
    queryKey: ['admin-inventory'],
    queryFn: () => api<InventoryConsole>('/api/v1/admin/inventory'),
  });

  const { data: tenants } = useQuery({
    queryKey: ['admin-tenants-for-sale'],
    queryFn: () => api<PaginatedResult<TenantSummary>>('/api/v1/admin/tenants?pageSize=200'),
  });

  const [form, setForm] = useState({
    tenantId: '',
    reference: '',
    purchasedUnits: '',
    aspProcurementId: '',
    minimumBufferUnits: '',
    expiresAt: '',
    allowOverage: false,
    notes: '',
  });

  const create = useMutation({
    mutationFn: () =>
      api('/api/v1/billing/bundles', {
        method: 'POST',
        body: {
          tenantId: form.tenantId,
          reference: form.reference.trim(),
          purchasedUnits: Number(form.purchasedUnits) || 0,
          allowOverage: form.allowOverage,
          aspProcurementId: form.aspProcurementId || null,
          minimumBufferUnits: Number(form.minimumBufferUnits) || 0,
          expiresAt: form.expiresAt || null,
          notes: form.notes.trim() || null,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-inventory'] });
      navigate('/admin/inventory');
    },
  });

  if (isLoading || !inventory) return <Spinner label="Loading inventory…" />;

  const stockUnits = inventory.host.currentStockUnits;
  const sellable = (tenants?.items ?? []).filter(
    (t) => t.tenantType === 'ENTERPRISE_TENANT' || t.tenantType === 'CHANNEL_PARTNER',
  );

  const units = Number(form.purchasedUnits) || 0;
  const tenant = sellable.find((t) => t.id === form.tenantId);
  const overStock = units > stockUnits;

  // Contracts with nothing left cannot cover a sale, so they are not offered.
  const openContracts = inventory.procurements.filter((p) => p.remainingUnits > 0);

  const chooseTenant = (id: string) => {
    const picked = sellable.find((t) => t.id === id);
    setForm((f) => ({
      ...f,
      tenantId: id,
      // A reference has to be unique per tenant and nobody enjoys inventing one,
      // so it is suggested from the company code and the month. Still editable —
      // a merchant with their own numbering will want to use it.
      reference:
        f.reference ||
        (picked ? `BNDL-${picked.companyCode}-${new Date().toISOString().slice(0, 7)}` : ''),
    }));
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sell data units"
        description="Issue a bundle to a tenant or a channel partner out of the platform's unsold stock."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Unsold stock"
          value={stockUnits.toLocaleString()}
          hint="What is left to sell"
          tone={stockUnits <= 0 ? 'danger' : 'neutral'}
        />
        <StatTile
          label="Being sold"
          value={units > 0 ? units.toLocaleString() : '—'}
          hint="This bundle"
          tone={overStock ? 'danger' : 'neutral'}
        />
        <StatTile
          label="Left afterwards"
          value={units > 0 && !overStock ? (stockUnits - units).toLocaleString() : '—'}
          hint="Shelf once this bundle is issued"
        />
      </div>

      {stockUnits <= 0 && (
        <Alert kind="warn" title="Nothing left to sell">
          Every procured unit has been sold or allocated. Register a provider purchase under{' '}
          <strong>Buy data</strong> before issuing another bundle.
        </Alert>
      )}

      <Card>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Buyer">
              <select
                className={inputClass}
                value={form.tenantId}
                onChange={(e) => chooseTenant(e.target.value)}
              >
                <option value="">Select a tenant or partner…</option>
                {sellable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.legalNameEn} · {TENANT_TYPE_LABELS[t.tenantType]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reference" hint="Unique for this account. Suggested from its code.">
              <input
                className={inputClass}
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
                placeholder="BNDL-ALBAHAR-2026-08"
              />
            </Field>
            <Field label="Units">
              <input
                className={inputClass}
                inputMode="numeric"
                value={form.purchasedUnits}
                onChange={(e) => setForm({ ...form, purchasedUnits: e.target.value })}
                placeholder="25000"
              />
            </Field>
            <Field
              label="Low-balance alert at"
              hint="Units remaining before they are emailed. Blank for none."
            >
              <input
                className={inputClass}
                inputMode="numeric"
                value={form.minimumBufferUnits}
                onChange={(e) => setForm({ ...form, minimumBufferUnits: e.target.value })}
                placeholder="2000"
              />
            </Field>
            <Field label="From contract" hint="Which purchase these units come out of.">
              <select
                className={inputClass}
                value={form.aspProcurementId}
                onChange={(e) => setForm({ ...form, aspProcurementId: e.target.value })}
              >
                <option value="">Not attributed</option>
                {openContracts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.contractReference} · {p.remainingUnits.toLocaleString()} left
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Expires" hint="Leave blank if the units do not lapse.">
              <input
                className={inputClass}
                type="date"
                value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
              />
            </Field>
          </div>

          <label className="flex items-start gap-2.5 rounded-md border border-slate-200 p-2.5">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.allowOverage}
              onChange={(e) => setForm({ ...form, allowOverage: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium text-slate-800">Allow overage</span>
              <span className="block text-xs text-slate-500">
                Filing continues past the purchased figure and the excess is invoiced. Off means
                filing stops when the bundle runs dry.
              </span>
            </span>
          </label>

          <Field label="Notes">
            <input
              className={inputClass}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
        </div>
      </Card>

      {overStock && (
        <Alert kind="danger" title="More than the shelf holds">
          {units.toLocaleString()} units against {stockUnits.toLocaleString()} unsold. Register the
          provider purchase that covers it first.
        </Alert>
      )}

      {tenant?.tenantType === 'CHANNEL_PARTNER' && units > 0 && !overStock && (
        <Alert kind="info">
          This becomes {tenant.legalNameEn}&rsquo;s master pool. They allocate slices to their own
          sub-tenants from their portal, and each sub-tenant filing draws down both.
        </Alert>
      )}

      {create.error && (
        <Alert kind="danger">
          {create.error instanceof ApiError
            ? create.error.message
            : 'That bundle could not be created.'}
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={() => navigate('/admin/inventory')}>Cancel</Button>
        <Button
          variant="primary"
          disabled={
            !form.tenantId ||
            form.reference.trim().length < 2 ||
            units < 1 ||
            overStock ||
            create.isPending
          }
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Selling…' : 'Sell bundle'}
        </Button>
      </div>
    </div>
  );
}
