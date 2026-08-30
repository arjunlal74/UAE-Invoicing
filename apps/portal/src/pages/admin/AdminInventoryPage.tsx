import {
  TENANT_TYPE_LABELS,
  type InventoryAccountRow,
  type InventoryConsole,
  type ProviderSummary,
} from '@uae/contracts';
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
  inputBase,
  inputClass,
} from '../../components/ui';
import { ApiError, api, queryString } from '../../lib/api';

/** Thirty days back to today, the window the shelf is reconciled over. */
function defaultWindow(): { from: string; to: string } {
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 30);
  return { from: start.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

/**
 * The data bundle inventory console (SRS v2.8 §15).
 *
 * Ordered around the question an operator arrives with, which is not "what did
 * we buy" but "what moved". So the shelf leads as a statement over a window —
 * opening, bought, sold, closing — and the purchase contracts that explain
 * those numbers are underneath.
 *
 * "Can we keep filing" is a different question, and a cumulative one: a date
 * range cannot answer it. It is not a tile for that reason, and lives in the
 * buffer alert above, which fires on the net position regardless of the window
 * the reader happens to have chosen.
 *
 * The tier table is the §15.5 matrix made visible: every account that holds a
 * bundle, what it has left, and whether it is under the floor it asked to be
 * warned at — because the alert mail goes to the account holder, and the host
 * needs to know it went out before the phone rings.
 */
export function AdminInventoryPage() {
  const queryClient = useQueryClient();

  // The movement window. Held here rather than in the URL because it is a
  // reading preference, not a place — nobody links a colleague to a date range
  // on this console, and the buy and sell dialogs above it are the routes.
  const [period, setPeriod] = useState(defaultWindow);

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

  // An inverted range is refused by the API, so it is not sent: the console
  // keeps showing the last good window while a date is half-typed.
  const valid = Boolean(period.from && period.to && period.from <= period.to);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-inventory', period.from, period.to],
    queryFn: () =>
      api<InventoryConsole>(
        `/api/v1/admin/inventory${queryString({ from: period.from, to: period.to })}`,
      ),
    enabled: valid,
    placeholderData: (previous) => previous,
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

  const { host, movement } = data;

  // Grouped once here rather than filtered three times in the markup, so the
  // three tables cannot disagree about which tier an account belongs to.
  const forBlock = (tier: InventoryAccountRow['tier']): BlockRow[] =>
    data.accounts
      .filter((row) => row.tier === tier)
      .map((row) => ({
        key: row.tenantId,
        name: row.tenantName,
        tierLabel: TENANT_TYPE_LABELS[row.tier],
        ...row,
      }));

  const accounts = {
    partners: forBlock('CHANNEL_PARTNER'),
    enterprise: forBlock('ENTERPRISE_TENANT'),
    managed: forBlock('MANAGED_SUB_TENANT'),
  };
  const breached = data.tiers.filter((tier) => tier.belowBuffer);

  // Runway at the rate this period actually ran at, rather than the rolling
  // 30-day rate on `host`: the tile is answering "at this rate", and this is
  // the rate it just showed.
  const runwayDays =
    movement.dailyAverageUnits > 0
      ? Math.floor(movement.unusedUnits / movement.dailyAverageUnits)
      : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data bundle inventory"
        description="Wholesale procurement, platform stock and every account's remaining balance."
        actions={
          <div className="flex flex-nowrap items-center gap-2 text-sm text-slate-600">
            <span>From</span>
            <input
              type="date"
              className={cx(inputBase, 'w-40')}
              value={period.from}
              max={period.to || undefined}
              onChange={(event) => setPeriod({ ...period, from: event.target.value })}
            />
            <span>to</span>
            <input
              type="date"
              className={cx(inputBase, 'w-40')}
              value={period.to}
              min={period.from || undefined}
              onChange={(event) => setPeriod({ ...period, to: event.target.value })}
            />
          </div>
        }
      />

      {!valid && (
        <Alert kind="warn">That period ends before it starts, so the figures below still
          cover {movement.from} to {movement.to}.</Alert>
      )}

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

      {/* --- §15.1 the shelf as a movement over the window ---------------
          Colour is assigned by what the figure is, not decoratively: the
          statement line reads as one blue set, the two figures that can be
          in trouble carry the verdict tones, and money out is deliberately
          not green. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Opening"
          value={movement.openingUnits.toLocaleString()}
          hint={`Unsold before ${formatDate(movement.from)}`}
          tone="info"
        />
        <StatTile
          label="Purchase"
          value={movement.purchasedUnits.toLocaleString()}
          hint={`AED ${Number(movement.purchasedCostAed).toLocaleString()} committed`}
          tone="info"
        />
        <StatTile
          label="Sold"
          value={movement.soldUnits.toLocaleString()}
          hint="To tenants and partners in this period"
          tone="info"
        />
        <StatTile
          label="Unsold"
          value={movement.closingUnits.toLocaleString()}
          hint="Opening + purchase − sold"
          tone={movement.closingUnits <= 0 ? 'danger' : 'ok'}
        />
        <StatTile
          label="Total transactions"
          value={movement.transactionCount.toLocaleString()}
          hint={
            movement.transactionCount === movement.consumedUnits
              ? 'Billable events — every one charged a unit'
              : `Billable events — ${(movement.transactionCount - movement.consumedUnits).toLocaleString()} zero-rated`
          }
          tone="info"
        />
        <StatTile
          label="Total consumption"
          value={movement.consumedUnits.toLocaleString()}
          hint={`Filed over ${movement.windowDays} day${movement.windowDays === 1 ? '' : 's'}`}
          tone="info"
        />
        <StatTile
          label="Average consumption / day"
          value={movement.dailyAverageUnits.toLocaleString()}
          hint={
            runwayDays === null
              ? 'No filing in this period — no runway to project'
              : `about ${runwayDays.toLocaleString()} days of unused capacity left`
          }
          tone={runwayDays !== null && runwayDays < 30 ? 'warn' : 'info'}
        />
        <StatTile
          label="Total unused"
          value={movement.unusedUnits.toLocaleString()}
          hint="Procured − consumed, unsold stock included"
          tone={
            movement.unusedUnits <= 0
              ? 'danger'
              : host.minimumBufferUnits > 0 && movement.unusedUnits < host.minimumBufferUnits
                ? 'warn'
                : 'ok'
          }
        />
      </div>

      {breached.length > 0 && (
        <Alert kind="warn" title={`${breached.length} account${breached.length === 1 ? '' : 's'} below their buffer`}>
          {breached.map((tier) => tier.tenantName).join(', ')} — each has been sent a Template G
          alert and is shown in red below.
        </Alert>
      )}

      {/* --- §15.5 the tier matrix, one table per tier ------------------
          Split rather than filtered in one grid: the columns genuinely differ
          — only a partner has an allocation axis — and a single table would
          have to leave a third of its cells blank for two thirds of its rows. */}
      <AccountBlock
        title="Platform"
        rows={[
          {
            ...data.platform,
            key: 'platform',
            tierLabel: 'Host',
          },
        ]}
        allocates
        accent="graphite"
        empty="The platform holds no stock."
      />
      <AccountBlock
        title="Channel partners"
        rows={accounts.partners}
        allocates
        accent="ok"
        empty="No partner holds a master pool. Sell one from Sell data above."
      />
      <AccountBlock
        title="Enterprise tenants"
        rows={accounts.enterprise}
        allocates={false}
        accent="brand"
        empty="No direct tenant holds a bundle yet."
      />
      <AccountBlock
        title="Managed tenants"
        rows={accounts.managed}
        allocates={false}
        accent="warn"
        empty="No sub-tenant has been allocated a slice by its partner."
      />

      {action === 'buffer' && (
        <BufferModal current={host.minimumBufferUnits} onClose={close} onDone={done} />
      )}
    </div>
  );
}

/**
 * One tier's accounts, as a statement with a total.
 *
 * The three tiers differ only in which columns apply — a partner allocates and
 * so has a sold/unsold axis, a filing tenant does not — so they are one
 * component told which columns to draw rather than three near-identical tables
 * that would drift apart the first time a column was renamed in two of them.
 *
 * The total row is the point of the table as much as the rows are: an operator
 * reconciling a tier is adding it up, and a column footed by hand is a column
 * footed differently by each person who does it.
 */
/**
 * A row as the table needs it, rather than as the API happens to shape it.
 *
 * The host is not a tenant and carries no tenant id, so the block takes this
 * instead of `InventoryAccountRow` — otherwise the platform would have to be
 * given a fake id to sit in a list of real ones.
 */
interface BlockRow {
  key: string;
  name: string;
  tierLabel: string;
  openingUnits: number;
  purchasedUnits: number;
  soldUnits: number;
  unsoldUnits: number;
  consumedUnits: number;
  unusedUnits: number;
}

function AccountBlock({
  title,
  rows,
  allocates,
  accent,
  empty,
}: {
  title: string;
  rows: BlockRow[];
  allocates: boolean;
  accent: 'graphite' | 'brand' | 'ok' | 'warn';
  empty: string;
}) {
  const total = rows.reduce(
    (sum, row) => ({
      openingUnits: sum.openingUnits + row.openingUnits,
      purchasedUnits: sum.purchasedUnits + row.purchasedUnits,
      soldUnits: sum.soldUnits + row.soldUnits,
      unsoldUnits: sum.unsoldUnits + row.unsoldUnits,
      consumedUnits: sum.consumedUnits + row.consumedUnits,
      unusedUnits: sum.unusedUnits + row.unusedUnits,
    }),
    { openingUnits: 0, purchasedUnits: 0, soldUnits: 0, unsoldUnits: 0, consumedUnits: 0, unusedUnits: 0 },
  );

  const num = 'py-2 text-right tabular-nums';

  return (
    <Card title={`${title} (${rows.length})`} accent={accent}>
      {rows.length === 0 ? (
        <EmptyState title="No accounts at this tier" description={empty} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-10 pb-2 pr-6 text-right font-medium">#</th>
                <th className="pb-2 font-medium">Account</th>
                <th className="pb-2 font-medium">Tier</th>
                <th className="pb-2 text-right font-medium">Opening</th>
                <th className="pb-2 text-right font-medium">Purchased</th>
                {allocates && <th className="pb-2 text-right font-medium">Sold</th>}
                {allocates && <th className="pb-2 text-right font-medium">Unsold</th>}
                <th className="pb-2 text-right font-medium">Consumed</th>
                <th className="pb-2 text-right font-medium">
                  {allocates ? 'Unused' : 'Available'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, index) => (
                <tr key={row.key}>
                  <td className="py-2 pr-6 text-right tabular-nums text-slate-400">{index + 1}</td>
                  {/* Every tier reads the same here. A partner's own ledger is
                      reached from Report, which has a tenant picker of its own,
                      so a link on the name would be a second route to one page
                      and a column that behaves differently in one of three
                      otherwise identical tables. */}
                  <td className="py-2 text-slate-800">{row.name}</td>
                  <td className="py-2 text-xs text-slate-500">{row.tierLabel}</td>
                  <td className={cx(num, 'text-slate-700')}>
                    {row.openingUnits.toLocaleString()}
                  </td>
                  <td className={cx(num, 'text-slate-700')}>
                    {row.purchasedUnits.toLocaleString()}
                  </td>
                  {allocates && (
                    <td className={cx(num, 'text-slate-700')}>{row.soldUnits.toLocaleString()}</td>
                  )}
                  {allocates && (
                    <td className={cx(num, 'text-slate-700')}>{row.unsoldUnits.toLocaleString()}</td>
                  )}
                  <td className={cx(num, 'text-slate-700')}>
                    {row.consumedUnits.toLocaleString()}
                  </td>
                  <td
                    className={cx(
                      num,
                      'font-medium',
                      row.unusedUnits <= 0 ? 'text-danger-700' : 'text-slate-900',
                    )}
                  >
                    {row.unusedUnits.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-slate-300">
              <tr className="font-semibold text-slate-900">
                <td className="py-2 pr-6" />
                <td className="py-2">Total</td>
                <td className="py-2" />
                <td className={num}>{total.openingUnits.toLocaleString()}</td>
                <td className={num}>{total.purchasedUnits.toLocaleString()}</td>
                {allocates && <td className={num}>{total.soldUnits.toLocaleString()}</td>}
                {allocates && <td className={num}>{total.unsoldUnits.toLocaleString()}</td>}
                <td className={num}>{total.consumedUnits.toLocaleString()}</td>
                <td className={num}>{total.unusedUnits.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
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
