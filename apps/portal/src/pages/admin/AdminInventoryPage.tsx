import {
  TENANT_TYPE_LABELS,
  type InventoryConsole,
  type ProviderSummary,
} from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Spinner,
  StatTile,
  cx,
  formatDate,
  inputClass,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';

/**
 * The data bundle inventory console (SRS v2.8 §15).
 *
 * Ordered around the question an operator arrives with, which is not "what did
 * we buy" but "can we keep filing". So the net platform balance leads, the
 * shelf and the run-rate sit beside it, and the purchase contracts that explain
 * the number are underneath.
 *
 * The tier table is the §15.5 matrix made visible: every account that holds a
 * bundle, what it has left, and whether it is under the floor it asked to be
 * warned at — because the alert mail goes to the account holder, and the host
 * needs to know it went out before the phone rings.
 */
export function AdminInventoryPage() {
  const queryClient = useQueryClient();
  const [registering, setRegistering] = useState(false);
  const [editingBuffer, setEditingBuffer] = useState(false);
  const [managingProviders, setManagingProviders] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-inventory'],
    queryFn: () => api<InventoryConsole>('/api/v1/admin/inventory'),
  });

  // Retired providers are included so the management list can show them and
  // offer reactivation; the purchase form filters to the active ones.
  const { data: providers } = useQuery({
    queryKey: ['asp-providers'],
    queryFn: () =>
      api<{ items: ProviderSummary[] }>('/api/v1/admin/providers?includeInactive=true'),
  });

  const activeProviders = (providers?.items ?? []).filter((p) => p.isActive);

  if (isLoading || !data) return <Spinner label="Loading inventory…" />;

  const { host } = data;
  const breached = data.tiers.filter((tier) => tier.belowBuffer);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data bundle inventory"
        description="Wholesale procurement, platform stock and every account's remaining balance."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setManagingProviders(true)}>Providers</Button>
            <Button onClick={() => setEditingBuffer(true)}>Minimum buffer</Button>
            <Button
              variant="primary"
              disabled={activeProviders.length === 0}
              title={
                activeProviders.length === 0
                  ? 'Add an accredited provider before registering a purchase'
                  : undefined
              }
              onClick={() => setRegistering(true)}
            >
              Register purchase
            </Button>
          </div>
        }
      />

      {host.belowBuffer && (
        <Alert kind="danger" title="Platform inventory below the minimum buffer">
          {host.netAvailableUnits.toLocaleString()} units remain against a floor of{' '}
          {host.minimumBufferUnits.toLocaleString()}
          {host.daysRemaining !== null && ` — about ${host.daysRemaining} days at the current rate`}.
          Register a further provider purchase before it runs out.
        </Alert>
      )}

      {activeProviders.length === 0 && (
        <Alert kind="info" title="No accredited provider on file">
          A purchase is registered against a provider, so add the one you buy from before
          registering a contract. The Ministry of Finance publishes the accredited list.
        </Alert>
      )}

      {host.currentStockUnits <= 0 && host.totalProcuredUnits > 0 && (
        <Alert kind="warn" title="Nothing left to sell">
          Every procured unit has been sold or allocated. New tenant bundles will be refused until
          another purchase is registered.
        </Alert>
      )}

      {/* --- §15.1 the host's position ----------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Net available"
          value={host.netAvailableUnits.toLocaleString()}
          hint="Procured − consumed platform-wide"
          tone={host.belowBuffer ? 'danger' : 'ok'}
        />
        <StatTile
          label="Unsold stock"
          value={host.currentStockUnits.toLocaleString()}
          hint="Procured − sold to tenants and partners"
          tone={host.currentStockUnits <= 0 ? 'danger' : 'neutral'}
        />
        <StatTile
          label="Consumption"
          value={host.dailyRunRate.toLocaleString()}
          hint={
            host.daysRemaining === null
              ? 'units/day over 30 days — no recent usage'
              : `units/day — about ${host.daysRemaining} days left`
          }
          tone={host.daysRemaining !== null && host.daysRemaining < 30 ? 'warn' : 'neutral'}
        />
        <StatTile
          label="Procured to date"
          value={host.totalProcuredUnits.toLocaleString()}
          hint={`AED ${Number(host.totalCostAed).toLocaleString()} committed`}
        />
      </div>

      {breached.length > 0 && (
        <Alert kind="warn" title={`${breached.length} account${breached.length === 1 ? '' : 's'} below their buffer`}>
          {breached.map((tier) => tier.tenantName).join(', ')} — each has been sent a Template G
          alert and is shown in red below.
        </Alert>
      )}

      {/* --- §15.5 the tier matrix --------------------------------------- */}
      <Card title={`Account balances (${data.tiers.length})`}>
        {data.tiers.length === 0 ? (
          <EmptyState
            title="No bundles issued"
            description="Register a provider purchase, then sell bundles to tenants and partners."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-2 font-medium">Account</th>
                  <th className="pb-2 font-medium">Tier</th>
                  <th className="pb-2 text-right font-medium">Purchased</th>
                  <th className="pb-2 text-right font-medium">Allocated</th>
                  <th className="pb-2 text-right font-medium">Consumed</th>
                  <th className="pb-2 text-right font-medium">Available</th>
                  <th className="pb-2 text-right font-medium">Floor</th>
                  <th className="pb-2 text-right font-medium">Days left</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.tiers.map((tier) => (
                  <tr key={tier.bundleId} className={cx(tier.belowBuffer && 'bg-danger-50')}>
                    <td className="py-2 text-slate-800">{tier.tenantName}</td>
                    <td className="py-2 text-xs text-slate-500">
                      {TENANT_TYPE_LABELS[tier.tier]}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {tier.purchasedUnits.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-500">
                      {/* Only a partner carves slices; for everyone else this is
                          structurally zero and a dash reads better than 0. */}
                      {tier.allocatedUnits > 0 ? tier.allocatedUnits.toLocaleString() : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {tier.consumedUnits.toLocaleString()}
                    </td>
                    <td
                      className={cx(
                        'py-2 text-right font-medium tabular-nums',
                        tier.belowBuffer ? 'text-danger-700' : 'text-slate-900',
                      )}
                    >
                      {tier.availableUnits.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-500">
                      {tier.minimumBufferUnits > 0 ? tier.minimumBufferUnits.toLocaleString() : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-500">
                      {tier.daysRemaining ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* --- §15.1 the contracts behind the stock ------------------------ */}
      <Card title={`Provider purchases (${data.procurements.length})`}>
        {data.procurements.length === 0 ? (
          <EmptyState
            title="No purchases registered"
            description="The platform cannot sell units it has not bought. Register the provider contract first."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-2 font-medium">Contract</th>
                  <th className="pb-2 font-medium">Provider</th>
                  <th className="pb-2 font-medium">Purchased</th>
                  <th className="pb-2 text-right font-medium">Units</th>
                  <th className="pb-2 text-right font-medium">Allocated</th>
                  <th className="pb-2 text-right font-medium">Unsold</th>
                  <th className="pb-2 text-right font-medium">Cost (AED)</th>
                  <th className="pb-2 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.procurements.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 font-mono text-xs text-slate-700">
                      {row.contractReference}
                    </td>
                    <td className="py-2 text-slate-700">{row.aspProviderName}</td>
                    <td className="py-2 text-xs text-slate-500">{formatDate(row.purchaseDate)}</td>
                    <td className="py-2 text-right tabular-nums text-slate-800">
                      {row.totalUnits.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-500">
                      {row.allocatedUnits.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {row.remainingUnits.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {Number(row.totalCostAed).toLocaleString()}
                    </td>
                    <td className="py-2 text-xs text-slate-500">
                      {row.expiryDate ? formatDate(row.expiryDate) : 'no expiry'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {registering && (
        <RegisterPurchaseModal
          providers={activeProviders}
          onClose={() => setRegistering(false)}
          onDone={() => {
            setRegistering(false);
            queryClient.invalidateQueries({ queryKey: ['admin-inventory'] });
          }}
        />
      )}

      {managingProviders && (
        <ProvidersModal
          providers={providers?.items ?? []}
          onClose={() => setManagingProviders(false)}
          onChanged={() => {
            queryClient.invalidateQueries({ queryKey: ['asp-providers'] });
            queryClient.invalidateQueries({ queryKey: ['admin-inventory'] });
          }}
        />
      )}

      {editingBuffer && (
        <BufferModal
          current={host.minimumBufferUnits}
          onClose={() => setEditingBuffer(false)}
          onDone={() => {
            setEditingBuffer(false);
            queryClient.invalidateQueries({ queryKey: ['admin-inventory'] });
          }}
        />
      )}
    </div>
  );
}

/**
 * Registering a contract.
 *
 * Units and total cost are what the provider's invoice actually says, so those
 * are the inputs and the per-unit rate is derived beside them. Typing into the
 * rate works too and back-fills the total — some contracts are quoted that way
 * round — but the total is what the server stores as authoritative, because
 * multiplying a four-decimal rate back out loses fils on odd unit counts.
 */
function RegisterPurchaseModal({
  providers,
  onClose,
  onDone,
}: {
  providers: ProviderSummary[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    // One provider on file is not a choice, so it is made for them.
    aspProviderId: providers.length === 1 ? providers[0]!.id : '',
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
    onSuccess: onDone,
  });

  return (
    <Modal title="Register a provider purchase" onClose={onClose}>
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
            label="Total cost (AED)"
            hint="What the provider invoiced. This is the figure that is stored."
          >
            <input
              className={inputClass}
              inputMode="decimal"
              value={form.totalCostAed}
              onChange={(e) => setTotal(e.target.value)}
              placeholder="85000.00"
            />
          </Field>
          <Field
            label="Cost per unit (AED)"
            hint="Derived from the total. Type here instead and the total is filled in."
          >
            <input
              className={inputClass}
              inputMode="decimal"
              value={form.costPerUnitAed}
              onChange={(e) => setPerUnit(e.target.value)}
              placeholder="0.0850"
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
                That rate does not divide the total exactly, so {(total / units).toFixed(4)} is what
                will be stored.
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

        {create.error && (
          <Alert kind="danger">
            {create.error instanceof ApiError
              ? create.error.message
              : 'That purchase could not be registered.'}
          </Alert>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
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
    </Modal>
  );
}

function BufferModal({
  current,
  onClose,
  onDone,
}: {
  current: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(String(current));

  const save = useMutation({
    mutationFn: () =>
      api('/api/v1/admin/inventory/buffer', {
        method: 'PATCH',
        body: { minimumBufferUnits: Number(value) || 0 },
      }),
    onSuccess: onDone,
  });

  return (
    <Modal title="Platform minimum buffer" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          When the platform&rsquo;s net available units fall below this figure, every global
          administrator is emailed and a reorder prompt appears here. Set it to zero to switch the
          alert off.
        </p>

        <Field label="Minimum units" hint="An absolute number, not a percentage.">
          <input
            className={inputClass}
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>

        {save.error && (
          <Alert kind="danger">
            {save.error instanceof ApiError ? save.error.message : 'That could not be saved.'}
          </Alert>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The accredited provider master.
 *
 * Small by nature â€” a platform buys from one or two accredited providers â€” so
 * it lives in a modal on the page that uses it rather than a nav entry of its
 * own. Nothing is deleted: a provider that has sold the platform units is part
 * of the record of where its capacity came from, so retiring one takes it out
 * of the picker and leaves its contracts legible.
 */
function ProvidersModal({
  providers,
  onClose,
  onChanged,
}: {
  providers: ProviderSummary[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(providers.length === 0);
  const [form, setForm] = useState({
    name: '',
    accreditationReference: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    defaultCostPerUnitAed: '',
  });

  const create = useMutation({
    mutationFn: () =>
      api('/api/v1/admin/providers', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          accreditationReference: form.accreditationReference.trim() || null,
          contactName: form.contactName.trim() || null,
          contactEmail: form.contactEmail.trim() || null,
          contactPhone: form.contactPhone.trim() || null,
          defaultCostPerUnitAed: form.defaultCostPerUnitAed
            ? Number(form.defaultCostPerUnitAed)
            : null,
        },
      }),
    onSuccess: () => {
      setForm({
        name: '',
        accreditationReference: '',
        contactName: '',
        contactEmail: '',
        contactPhone: '',
        defaultCostPerUnitAed: '',
      });
      setAdding(false);
      onChanged();
    },
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api(`/api/v1/admin/providers/${id}`, { method: 'PATCH', body: { isActive } }),
    onSuccess: onChanged,
  });

  return (
    <Modal title="Accredited providers" onClose={onClose} width="lg">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          The providers this platform buys data units from. Purchases are registered against one of
          these rather than a typed-in name, so cost reporting per provider adds up.
        </p>

        {providers.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-2 font-medium">Provider</th>
                  <th className="pb-2 font-medium">Accreditation</th>
                  <th className="pb-2 text-right font-medium">Contracts</th>
                  <th className="pb-2 text-right font-medium">Units</th>
                  <th className="pb-2 text-right font-medium">Spend (AED)</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {providers.map((provider) => (
                  <tr key={provider.id} className={cx(!provider.isActive && 'text-slate-400')}>
                    <td className="py-2">
                      <span className="font-medium text-slate-800">{provider.name}</span>
                      {!provider.isActive && (
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                          retired
                        </span>
                      )}
                      {provider.contactEmail && (
                        <p className="text-xs text-slate-500">{provider.contactEmail}</p>
                      )}
                    </td>
                    <td className="py-2 font-mono text-xs text-slate-500">
                      {provider.accreditationReference ?? 'â€”'}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {provider.contractCount}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {provider.totalUnitsPurchased.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700">
                      {Number(provider.totalSpendAed).toLocaleString()}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        disabled={setActive.isPending}
                        onClick={() =>
                          setActive.mutate({ id: provider.id, isActive: !provider.isActive })
                        }
                      >
                        {provider.isActive ? 'Retire' : 'Reactivate'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {setActive.error && (
          <Alert kind="danger">
            {setActive.error instanceof ApiError
              ? setActive.error.message
              : 'That provider could not be updated.'}
          </Alert>
        )}

        {adding ? (
          <div className="space-y-3 rounded-md border border-slate-200 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input
                  className={inputClass}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Accredited ASP UAE"
                />
              </Field>
              <Field
                label="Accreditation reference"
                hint="Their entry on the Ministry of Finance list."
              >
                <input
                  className={inputClass}
                  value={form.accreditationReference}
                  onChange={(e) => setForm({ ...form, accreditationReference: e.target.value })}
                />
              </Field>
              <Field label="Billing contact">
                <input
                  className={inputClass}
                  value={form.contactName}
                  onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                />
              </Field>
              <Field label="Contact email">
                <input
                  className={inputClass}
                  type="email"
                  value={form.contactEmail}
                  onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                />
              </Field>
              <Field label="Contact phone">
                <input
                  className={inputClass}
                  value={form.contactPhone}
                  onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
                />
              </Field>
              <Field
                label="Usual rate (AED/unit)"
                hint="Optional. Pre-fills a new contract; the contract's own figure wins."
              >
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={form.defaultCostPerUnitAed}
                  onChange={(e) => setForm({ ...form, defaultCostPerUnitAed: e.target.value })}
                  placeholder="0.0850"
                />
              </Field>
            </div>

            {create.error && (
              <Alert kind="danger">
                {create.error instanceof ApiError
                  ? create.error.message
                  : 'That provider could not be added.'}
              </Alert>
            )}

            <div className="flex justify-end gap-2">
              {providers.length > 0 && <Button onClick={() => setAdding(false)}>Cancel</Button>}
              <Button
                variant="primary"
                disabled={form.name.trim().length < 2 || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? 'Addingâ€¦' : 'Add provider'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-between">
            <Button onClick={() => setAdding(true)}>Add a provider</Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

