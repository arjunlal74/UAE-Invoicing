import { TENANT_TYPE_LABELS, type InventoryConsole, type ProviderSummary } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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

  // Buying and selling have screens of their own; the buffer is one field and
  // stays a dialog over the console it governs. Which is open is a route rather
  // than state, because the ribbon above owns the action and a NavLink can only
  // point at a URL.
  const { action } = useParams<{ action?: string }>();
  const navigate = useNavigate();
  const close = () => navigate('/admin/inventory');
  const done = () => {
    close();
    queryClient.invalidateQueries({ queryKey: ['admin-inventory'] });
  };

  const { data, isLoading } = useQuery({
    queryKey: ['admin-inventory'],
    queryFn: () => api<InventoryConsole>('/api/v1/admin/inventory'),
  });

  // Only to answer "is there anyone to buy from" below. Retired providers are
  // included and filtered here, because that question is about the active ones.
  const { data: providers } = useQuery({
    queryKey: ['asp-providers', 'picker'],
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
            description="Register a provider purchase from Buy data above, then sell bundles to tenants and partners."
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

      {action === 'buffer' && (
        <BufferModal current={host.minimumBufferUnits} onClose={close} onDone={done} />
      )}
    </div>
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
