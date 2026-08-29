import type { ProviderSummary } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Field,
  PageHeader,
  Spinner,
  inputClass,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';

/**
 * Buying units from a provider — §15.1, on its own screen.
 *
 * Units and total cost are what the provider's invoice actually says, so those
 * are the inputs and the per-unit rate is derived beside them. Typing into the
 * rate works too and back-fills the total — some contracts are quoted that way
 * round — but the total is what the server stores as authoritative, because
 * multiplying a four-decimal rate back out loses fils on odd unit counts.
 */
export function AdminBuyDataPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Only the active list: a retired provider is one this platform no longer
  // buys from, which is precisely what this form does.
  const { data, isLoading } = useQuery({
    queryKey: ['asp-providers', 'active'],
    queryFn: () => api<{ items: ProviderSummary[] }>('/api/v1/admin/providers'),
  });
  const providers = data?.items ?? [];

  const [form, setForm] = useState({
    aspProviderId: '',
    contractReference: '',
    totalUnits: '',
    totalCostAed: '',
    costPerUnitAed: '',
    expiryDate: '',
    notes: '',
  });

  const units = Number(form.totalUnits) || 0;
  const total = Number(form.totalCostAed) || 0;
  const perUnit = Number(form.costPerUnitAed) || 0;

  /** Whichever of the money pair was not typed is recomputed from the other. */
  const setUnits = (value: string) => {
    const next = Number(value) || 0;
    setForm((f) => ({
      ...f,
      totalUnits: value,
      costPerUnitAed:
        next > 0 && Number(f.totalCostAed) > 0
          ? (Number(f.totalCostAed) / next).toFixed(4)
          : f.costPerUnitAed,
    }));
  };

  const setTotal = (value: string) => {
    const next = Number(value) || 0;
    setForm((f) => ({
      ...f,
      totalCostAed: value,
      costPerUnitAed:
        next > 0 && Number(f.totalUnits) > 0 ? (next / Number(f.totalUnits)).toFixed(4) : '',
    }));
  };

  const setPerUnit = (value: string) => {
    const next = Number(value) || 0;
    setForm((f) => ({
      ...f,
      costPerUnitAed: value,
      totalCostAed:
        next > 0 && Number(f.totalUnits) > 0 ? (next * Number(f.totalUnits)).toFixed(2) : '',
    }));
  };

  const chooseProvider = (id: string) => {
    const provider = providers.find((p) => p.id === id);
    const rate = provider?.defaultCostPerUnitAed;
    setForm((f) => ({
      ...f,
      aspProviderId: id,
      // Only pre-fill an untouched rate. Never overwrite a figure the operator
      // has already read off the contract in front of them.
      ...(rate && !f.costPerUnitAed
        ? {
            costPerUnitAed: rate,
            totalCostAed:
              Number(f.totalUnits) > 0 ? (Number(rate) * Number(f.totalUnits)).toFixed(2) : '',
          }
        : {}),
    }));
  };

  const create = useMutation({
    mutationFn: () =>
      api('/api/v1/admin/procurements', {
        method: 'POST',
        body: {
          aspProviderId: form.aspProviderId,
          contractReference: form.contractReference.trim(),
          totalUnits: units,
          totalCostAed: total,
          expiryDate: form.expiryDate || null,
          notes: form.notes.trim() || null,
        },
      }),
    // Back to the console, where the new contract is now one of the rows and
    // the stock figure has moved.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-inventory'] });
      queryClient.invalidateQueries({ queryKey: ['asp-providers'] });
      navigate('/admin/inventory');
    },
  });

  if (isLoading) return <Spinner label="Loading providers…" />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Buy data units"
        description="Register what a provider invoiced. The contract is the platform's evidence of where its capacity came from, so it is recorded before the units can be sold on."
      />

      {providers.length === 0 && (
        <Alert kind="info" title="No accredited provider on file">
          A purchase is registered against a provider, so add the one you buy from under{' '}
          <Link className="underline" to="/admin/inventory/providers">
            Providers
          </Link>{' '}
          before registering a contract.
        </Alert>
      )}

      <Card>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider" hint="From the accredited provider list.">
              <select
                className={inputClass}
                value={form.aspProviderId}
                onChange={(e) => chooseProvider(e.target.value)}
              >
                <option value="">Select a provider…</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Contract reference" hint="The provider's own number. Registered once.">
              <input
                className={inputClass}
                value={form.contractReference}
                onChange={(e) => setForm({ ...form, contractReference: e.target.value })}
                placeholder="e.g. ASP-2026-00412"
              />
            </Field>
            <Field label="Units purchased">
              <input
                className={inputClass}
                inputMode="numeric"
                value={form.totalUnits}
                onChange={(e) => setUnits(e.target.value)}
                placeholder="1000000"
              />
            </Field>
            <Field
              label="Cost per unit (AED)"
              hint="Type either this or the total — the other is filled in."
            >
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.costPerUnitAed}
                onChange={(e) => setPerUnit(e.target.value)}
                placeholder="0.0850"
              />
            </Field>
            <Field
              label="Total cost (AED)"
              hint="What the provider invoiced. This is what is stored."
            >
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.totalCostAed}
                onChange={(e) => setTotal(e.target.value)}
                placeholder="85000.00"
              />
            </Field>
            <Field label="Expiry" hint="Leave blank if the units do not lapse.">
              <input
                className={inputClass}
                type="date"
                value={form.expiryDate}
                onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
              />
            </Field>
          </div>

          {units > 0 && total > 0 && (
            <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
              <strong className="tabular-nums">{units.toLocaleString()}</strong> units for{' '}
              <strong className="tabular-nums">
                AED {total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </strong>{' '}
              — <span className="tabular-nums">{(total / units).toFixed(4)}</span> per unit.
              {perUnit > 0 && Math.abs(perUnit - total / units) > 0.00005 && (
                <span className="ml-1 font-medium text-warn-700">
                  That rate does not divide the total exactly, so {(total / units).toFixed(4)} is
                  what will be stored.
                </span>
              )}
            </div>
          )}

          <Field label="Notes">
            <input
              className={inputClass}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
        </div>
      </Card>

      {create.error && (
        <Alert kind="danger">
          {create.error instanceof ApiError
            ? create.error.message
            : 'That purchase could not be registered.'}
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={() => navigate('/admin/inventory')}>Cancel</Button>
        <Button
          variant="primary"
          disabled={
            !form.aspProviderId ||
            !form.contractReference.trim() ||
            units < 1 ||
            total <= 0 ||
            create.isPending
          }
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Registering…' : 'Register purchase'}
        </Button>
      </div>
    </div>
  );
}
