import type { AspProviderType, ProviderSummary, ReportingPeriod } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Modal,
  PageHeader,
  Spinner,
  cx,
  formatDate,
  inputClass,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';

/** How a provider is reached, in the words the forms use. */
const CONNECTION_LABELS: Record<AspProviderType, string> = {
  MOCK: 'Simulator',
  GENERIC_REST: 'Third-party',
  NATIVE_AS4: 'Native',
};

/**
 * The simulator is the one connection that goes nowhere, so it is the one that
 * needs no address. Anything else is a real network call, and recording such a
 * provider without an endpoint leaves a record that looks configured and fails
 * at the first submission.
 */
function needsEndpoint(type: AspProviderType): boolean {
  return type !== 'MOCK';
}

/**
 * The accredited provider master (SRS v2.8 §15.1).
 *
 * Reached from the Data inventory ribbon. Nothing here is ever deleted: a
 * provider that has sold the platform units is part of the record of where its
 * capacity came from, so retiring one takes it out of the purchase picker and
 * leaves its contracts legible.
 *
 * Retiring and locking answer different questions and are kept apart. Retired
 * is "we no longer buy from them"; locked is "these details are confirmed and
 * are not to drift" — a checked accreditation reference on a provider with
 * contracts against it is a due-diligence trail, and a stray edit breaks it.
 * Either, both or neither is a valid state.
 */
const PERIODS = [
  { value: '3', label: 'Last 3 months' },
  { value: '6', label: 'Last 6 months' },
  { value: '12', label: 'Last 12 months' },
  { value: '24', label: 'Last 24 months' },
  { value: 'all', label: 'All time' },
];

const LOCKED_HINT = 'Locked. Unlock this provider before editing or retiring it.';

/**
 * How long before an accreditation lapses it starts reading as a warning.
 *
 * Two months, because renewing one is paperwork with a lead time and the point
 * of the warning is to be early enough to act on. A contract signed with a
 * provider whose accreditation has run out buys units that may not be filable.
 */
const EXPIRY_WARNING_DAYS = 60;

type AccreditationState = 'none' | 'valid' | 'expiring' | 'expired';

function accreditationState(validUntil: string | null): AccreditationState {
  if (!validUntil) return 'none';
  const days = Math.ceil(
    (new Date(`${validUntil}T00:00:00`).getTime() - Date.now()) / 86_400_000,
  );
  if (days < 0) return 'expired';
  return days <= EXPIRY_WARNING_DAYS ? 'expiring' : 'valid';
}

function daysUntil(validUntil: string): number {
  return Math.ceil((new Date(`${validUntil}T00:00:00`).getTime() - Date.now()) / 86_400_000);
}

/** The date as the table and the detail sheet both draw it. */
function Accreditation({ validUntil }: { validUntil: string | null }) {
  const state = accreditationState(validUntil);
  if (!validUntil || state === 'none') return <span className="text-slate-400">not recorded</span>;

  const days = daysUntil(validUntil);
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        state === 'expired' && 'font-medium text-danger-700',
        state === 'expiring' && 'font-medium text-warn-700',
        state === 'valid' && 'text-slate-700',
      )}
      title={
        state === 'expired'
          ? `Accreditation lapsed ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
          : `Accreditation valid for another ${days} day${days === 1 ? '' : 's'}`
      }
    >
      {formatDate(validUntil)}
      {state === 'expired' && (
        <span className="rounded-full bg-danger-50 px-2 py-0.5 text-xs">expired</span>
      )}
      {state === 'expiring' && (
        <span className="rounded-full bg-warn-50 px-2 py-0.5 text-xs">
          {days === 0 ? 'today' : `${days}d`}
        </span>
      )}
    </span>
  );
}

export function AdminProvidersPage() {
  const queryClient = useQueryClient();

  /**
   * The window the roll-up columns cover. Twelve months rather than all time: a
   * lifetime total only grows, and once it is larger than a year's worth it can
   * no longer say whether a provider is still in use or what a renewal ought to
   * cost.
   */
  const [period, setPeriod] = useState('12');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<ProviderSummary | null>(null);
  const [editing, setEditing] = useState<ProviderSummary | null>(null);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['asp-providers', period],
    queryFn: () =>
      api<{ items: ProviderSummary[]; period: ReportingPeriod }>(
        `/api/v1/admin/providers?includeInactive=true&period=${period}`,
      ),
    // Keep the previous window's rows on screen while the next one loads, so
    // changing the period re-labels a table rather than emptying it.
    placeholderData: (previous) => previous,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['asp-providers'] });
    queryClient.invalidateQueries({ queryKey: ['admin-inventory'] });
  };

  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string; isActive?: boolean; isLocked?: boolean }) =>
      api(`/api/v1/admin/providers/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
  });

  const providers = data?.items ?? [];

  // Filtered in the browser rather than by the server: the endpoint returns the
  // whole master unpaginated — a platform deals with a handful of accredited
  // providers — so a round trip per keystroke would buy nothing.
  const term = search.trim().toLowerCase();
  const visible = providers.filter((provider) => {
    if (status === 'active' && !provider.isActive) return false;
    if (status === 'retired' && provider.isActive) return false;
    if (status === 'locked' && !provider.isLocked) return false;
    if (!term) return true;
    return [
      provider.name,
      provider.accreditationReference,
      provider.contactName,
      provider.contactEmail,
    ].some((field) => field?.toLowerCase().includes(term));
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Accredited providers"
        description="The providers this platform buys data units from. Purchases are registered against one of these rather than a typed-in name, so cost reporting per provider adds up."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add a provider
          </Button>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <input
            className={cx(inputClass, 'max-w-xs')}
            placeholder="Search by name, accreditation or contact"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            className={cx(inputClass, 'max-w-[12rem]')}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">Active and retired</option>
            <option value="active">Active only</option>
            <option value="retired">Retired only</option>
            <option value="locked">Locked only</option>
          </select>
          <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
            Contracts and units cover
            <select
              className={cx(inputClass, 'w-auto')}
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
            >
              {PERIODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          {isFetching && <span className="text-xs text-slate-400">updating…</span>}
        </div>
      </Card>

      {patch.error && (
        <Alert kind="danger">
          {patch.error instanceof ApiError
            ? patch.error.message
            : 'That provider could not be updated.'}
        </Alert>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8">
            <Spinner label="Loading providers…" />
          </div>
        ) : providers.length === 0 ? (
          <EmptyState
            title="No providers on file"
            description="A purchase is registered against a provider, so add the one you buy from before registering a contract. The Ministry of Finance publishes the accredited list."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="No providers match"
            description="Nothing on the accredited list answers to that search and filter."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Connection</th>
                  <th className="px-4 py-2 font-medium">Accreditation</th>
                  <th className="px-4 py-2 font-medium">Accredited from</th>
                  <th className="px-4 py-2 font-medium">Valid until</th>
                  <th className="px-4 py-2 text-right font-medium">Contracts</th>
                  <th className="px-4 py-2 text-right font-medium">Units</th>
                  <th className="px-4 py-2 font-medium">Last purchase</th>
                  <th className="px-4 py-2 text-right font-medium">Last rate (AED)</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((provider) => (
                  <tr
                    key={provider.id}
                    className={cx('hover:bg-slate-50', !provider.isActive && 'text-slate-400')}
                  >
                    <td className="px-4 py-2">
                      <span className="text-slate-800">{provider.name}</span>
                      {!provider.isActive && <Chip>retired</Chip>}
                      {provider.isLocked && <Chip>locked</Chip>}
                      {provider.contactEmail && (
                        <p className="text-xs text-slate-500">{provider.contactEmail}</p>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {CONNECTION_LABELS[provider.providerType]}
                      {provider.providerType !== 'MOCK' && provider.apiEndpoint && (
                        <p className="break-all text-slate-400">{provider.apiEndpoint}</p>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">
                      {provider.accreditationReference ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-600">
                      {provider.accreditationFrom ? (
                        formatDate(provider.accreditationFrom)
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <Accreditation validUntil={provider.accreditationValidUntil} />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                      {provider.contractCount}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                      {provider.totalUnitsPurchased.toLocaleString()}
                    </td>
                    {/* Both unscoped, so a period that excludes the last
                        contract still says when it was and what it cost. */}
                    <td className="px-4 py-2 text-slate-700">
                      {provider.lastPurchaseDate ? (
                        formatDate(provider.lastPurchaseDate)
                      ) : (
                        <span className="text-slate-400">never</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                      {provider.lastCostPerUnitAed ? (
                        Number(provider.lastCostPerUnitAed).toFixed(4)
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {/* Icons rather than words, so eight columns of figures
                          keep the width. Every one carries its verb as an
                          accessible name and a tooltip: a glyph is shorthand
                          for someone who already knows what it means, and must
                          not be the only way to find out. */}
                      <div className="flex justify-end gap-1 [&>button]:w-9 [&>button]:justify-center">
                        <Button size="sm" label="View" onClick={() => setViewing(provider)}>
                          <Icon name="view" />
                        </Button>
                        <Button
                          size="sm"
                          label="Edit"
                          disabled={provider.isLocked}
                          title={provider.isLocked ? LOCKED_HINT : 'Edit'}
                          onClick={() => setEditing(provider)}
                        >
                          <Icon name="edit" />
                        </Button>
                        <Button
                          size="sm"
                          label={provider.isLocked ? 'Unlock' : 'Lock'}
                          disabled={patch.isPending}
                          title={
                            provider.isLocked
                              ? 'Unlock — reopen this record for editing.'
                              : 'Lock — freeze these details. Retirement is unaffected.'
                          }
                          onClick={() =>
                            patch.mutate({ id: provider.id, isLocked: !provider.isLocked })
                          }
                        >
                          <Icon name={provider.isLocked ? 'unlock' : 'lock'} />
                        </Button>
                        <Button
                          size="sm"
                          label={provider.isActive ? 'Retire' : 'Reactivate'}
                          disabled={patch.isPending || provider.isLocked}
                          title={
                            provider.isLocked
                              ? LOCKED_HINT
                              : provider.isActive
                                ? `Retire${
                                    provider.lifetimeContractCount > 0
                                      ? ` — ${provider.lifetimeContractCount} contract(s) stay on file; only the picker loses this provider`
                                      : ''
                                  }`
                                : 'Reactivate'
                          }
                          onClick={() =>
                            patch.mutate({ id: provider.id, isActive: !provider.isActive })
                          }
                        >
                          <Icon name={provider.isActive ? 'retire' : 'restore'} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* The count is the whole list, not the filtered view: a search that hides
          six of eight providers should not read as though two exist. */}
      {providers.length > 0 && (
        <p className="text-xs text-slate-500">
          {visible.length === providers.length
            ? `${providers.length} provider${providers.length === 1 ? '' : 's'} on file.`
            : `${visible.length} of ${providers.length} providers shown.`}
        </p>
      )}

      {viewing && (
        <ViewProviderModal
          provider={viewing}
          period={PERIODS.find((p) => p.value === period)?.label ?? ''}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setEditing(viewing);
            setViewing(null);
          }}
        />
      )}

      {(adding || editing) && (
        <ProviderFormModal
          provider={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onDone={() => {
            setAdding(false);
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Chip({ children }: { children: string }) {
  return (
    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
      {children}
    </span>
  );
}

/** Everything on file about one provider, including the fields the table has no room for. */
function ViewProviderModal({
  provider,
  period,
  onClose,
  onEdit,
}: {
  provider: ProviderSummary;
  /** Which window the roll-up figures below were read through. */
  period: string;
  onClose: () => void;
  onEdit: () => void;
}) {
  return (
    <Modal
      title={provider.name}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={provider.isLocked}
            title={provider.isLocked ? LOCKED_HINT : undefined}
            onClick={onEdit}
          >
            Edit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cx(
              'rounded-full px-2 py-0.5',
              provider.isActive ? 'bg-ok-50 text-ok-700' : 'bg-slate-100 text-slate-600',
            )}
          >
            {provider.isActive ? 'Active — available when registering a purchase' : 'Retired'}
          </span>
          {provider.isLocked && (
            <span className="rounded-full bg-warn-50 px-2 py-0.5 text-warn-700">
              Locked against edits
            </span>
          )}
        </div>

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Accreditation reference" mono>
            {provider.accreditationReference}
          </Detail>
          <Detail label="Accredited from">
            {provider.accreditationFrom ? formatDate(provider.accreditationFrom) : null}
          </Detail>
          <div>
            <dt className="text-xs font-medium text-slate-700">Accreditation valid until</dt>
            <dd className="mt-0.5 text-sm">
              <Accreditation validUntil={provider.accreditationValidUntil} />
            </dd>
          </div>
          <Detail label="Usual rate (AED/unit)">
            {provider.defaultCostPerUnitAed
              ? Number(provider.defaultCostPerUnitAed).toFixed(4)
              : null}
          </Detail>
          <Detail label="Billing contact">{provider.contactName}</Detail>
          <Detail label="Contact email">{provider.contactEmail}</Detail>
          <Detail label="Contact phone">{provider.contactPhone}</Detail>
          <Detail label="Website">{provider.website}</Detail>
          <Detail label="On file since">{formatDate(provider.createdAt)}</Detail>
        </dl>

        {provider.notes && (
          <div>
            <p className="text-xs font-medium text-slate-700">Notes</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{provider.notes}</p>
          </div>
        )}

        <div className="rounded-md bg-slate-50 p-3">
          <p className="text-xs font-medium text-slate-700">{period}</p>
          <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
            <Figure label="Contracts" value={provider.contractCount.toLocaleString()} />
            <Figure label="Units" value={provider.totalUnitsPurchased.toLocaleString()} />
            <Figure
              label="Spend (AED)"
              value={Number(provider.totalSpendAed).toLocaleString(undefined, {
                minimumFractionDigits: 2,
              })}
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {provider.lifetimeContractCount} contract
            {provider.lifetimeContractCount === 1 ? '' : 's'} on file at any date — only a provider
            with none has never supplied this platform.
            {provider.lastPurchaseDate && (
              <>
                {' '}
                The last was {formatDate(provider.lastPurchaseDate)}
                {provider.lastCostPerUnitAed &&
                  ` at ${Number(provider.lastCostPerUnitAed).toFixed(4)} per unit`}
                .
              </>
            )}
          </p>
        </div>
      </div>
    </Modal>
  );
}

function Detail({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: string | null;
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-700">{label}</dt>
      <dd className={cx('mt-0.5 text-sm text-slate-600', mono && 'font-mono text-xs')}>
        {children || <span className="text-slate-400">—</span>}
      </dd>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="tabular-nums font-medium text-slate-800">{value}</p>
    </div>
  );
}

/**
 * Add and edit are the same form against the same fields; only the verb and the
 * request method differ, and keeping them one component is what stops the two
 * drifting apart a field at a time.
 */
function ProviderFormModal({
  provider,
  onClose,
  onDone,
}: {
  /** Null when adding. */
  provider: ProviderSummary | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    name: provider?.name ?? '',
    providerType: provider?.providerType ?? ('GENERIC_REST' as AspProviderType),
    apiEndpoint: provider?.apiEndpoint ?? '',
    accreditationReference: provider?.accreditationReference ?? '',
    accreditationFrom: provider?.accreditationFrom ?? '',
    accreditationValidUntil: provider?.accreditationValidUntil ?? '',
    contactName: provider?.contactName ?? '',
    contactEmail: provider?.contactEmail ?? '',
    contactPhone: provider?.contactPhone ?? '',
    website: provider?.website ?? '',
    defaultCostPerUnitAed: provider?.defaultCostPerUnitAed ?? '',
    notes: provider?.notes ?? '',
  });

  const save = useMutation({
    mutationFn: () => {
      // An emptied field is a cleared field, not an omitted one: the server
      // distinguishes the two, and null is what erases what was there before.
      const body = {
        name: form.name.trim(),
        providerType: form.providerType,
        // Empty is a legitimate value here, not a cleared one: the simulator
        // has no endpoint, and a provider can be recorded before their API
        // documentation arrives.
        apiEndpoint: form.apiEndpoint.trim(),
        accreditationReference: form.accreditationReference.trim() || null,
        accreditationFrom: form.accreditationFrom || null,
        accreditationValidUntil: form.accreditationValidUntil || null,
        contactName: form.contactName.trim() || null,
        contactEmail: form.contactEmail.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
        website: form.website.trim() || null,
        defaultCostPerUnitAed: form.defaultCostPerUnitAed
          ? Number(form.defaultCostPerUnitAed)
          : null,
        notes: form.notes.trim() || null,
      };
      return provider
        ? api(`/api/v1/admin/providers/${provider.id}`, { method: 'PATCH', body })
        : api('/api/v1/admin/providers', { method: 'POST', body });
    },
    onSuccess: onDone,
  });

  return (
    <Modal
      title={provider ? `Edit ${provider.name}` : 'Add an accredited provider'}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={form.name.trim().length < 2 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? provider
                ? 'Saving…'
                : 'Adding…'
              : provider
                ? 'Save changes'
                : 'Add provider'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Provider type"
            required
            hint="How this provider is talked to. The simulator files without leaving this system."
          >
            <select
              className={inputClass}
              value={form.providerType}
              onChange={(event) =>
                setForm({ ...form, providerType: event.target.value as AspProviderType })
              }
            >
              <option value="MOCK">Simulator (development)</option>
              <option value="GENERIC_REST">Third-party (REST)</option>
              {/* Native AS4 is Phase 2 and its driver throws on use, so it is
                  not offered. A provider already recorded as Native keeps the
                  value — the option is hidden, not removed from the enum. */}
              {form.providerType === 'NATIVE_AS4' && (
                <option value="NATIVE_AS4">Native (AS4 gateway)</option>
              )}
            </select>
          </Field>

          <Field
            label="API endpoint"
            required={needsEndpoint(form.providerType)}
            hint={
              needsEndpoint(form.providerType)
                ? "Base URL of the provider's API. The same for every merchant on them."
                : 'Not used by the simulator — it never leaves this system.'
            }
          >
            <input
              className={inputClass}
              placeholder="https://api.provider.ae"
              value={form.apiEndpoint}
              disabled={!needsEndpoint(form.providerType)}
              onChange={(event) => setForm({ ...form, apiEndpoint: event.target.value })}
            />
          </Field>

          <Field label="Name">
            <input
              className={inputClass}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Accredited ASP UAE"
            />
          </Field>
          <Field label="Accreditation reference" hint="Their entry on the Ministry of Finance list.">
            <input
              className={inputClass}
              value={form.accreditationReference}
              onChange={(e) => setForm({ ...form, accreditationReference: e.target.value })}
            />
          </Field>
          <Field label="Accredited from" hint="The day their entry took effect.">
            <input
              className={inputClass}
              type="date"
              value={form.accreditationFrom}
              max={form.accreditationValidUntil || undefined}
              onChange={(e) => setForm({ ...form, accreditationFrom: e.target.value })}
            />
          </Field>
          <Field
            label="Accreditation valid until"
            hint="The day their entry lapses. Flagged in the list two months ahead."
          >
            <input
              className={inputClass}
              type="date"
              value={form.accreditationValidUntil}
              min={form.accreditationFrom || undefined}
              onChange={(e) => setForm({ ...form, accreditationValidUntil: e.target.value })}
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
          <Field label="Website">
            <input
              className={inputClass}
              value={form.website}
              onChange={(e) => setForm({ ...form, website: e.target.value })}
              placeholder="https://"
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

        <Field label="Notes">
          <input
            className={inputClass}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </Field>

        {save.error && (
          <Alert kind="danger">
            {save.error instanceof ApiError
              ? save.error.message
              : provider
                ? 'That provider could not be saved.'
                : 'That provider could not be added.'}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
