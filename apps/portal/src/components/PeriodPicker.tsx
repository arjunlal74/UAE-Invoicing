import { cx, inputBase } from './ui';

/**
 * The window a report or a monitor covers.
 *
 * Presets for the questions people ask most, and an explicit pair of dates for
 * the one they ask when a preset will not do — a quarter that has closed, or
 * the range an auditor named. Shared rather than reimplemented per screen, so
 * "last 3 months" means the same thing everywhere it is offered.
 */
export const PERIOD_PRESETS = [
  { value: 'month', label: 'This month' },
  { value: '1', label: 'Last month' },
  { value: '3', label: 'Last 3 months' },
  { value: '6', label: 'Last 6 months' },
  { value: '12', label: 'Last 12 months' },
  { value: '24', label: 'Last 24 months' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom period…' },
];

export interface PeriodChoice {
  preset: string;
  from: string;
  to: string;
}

export const DEFAULT_PERIOD: PeriodChoice = { preset: '12', from: '', to: '' };
export const ALL_TIME: PeriodChoice = { preset: 'all', from: '', to: '' };

/**
 * The query string for an endpoint that resolves presets itself.
 *
 * Only the windows the API has a word for are sent as words. Anything else —
 * a calendar month, an explicit range — is resolved here and sent as dates, so
 * adding a preset to this list never needs a matching change on the server.
 */
export function periodQuery(choice: PeriodChoice): string {
  if (choice.preset === 'all' || /^d+$/.test(choice.preset)) return `period=${choice.preset}`;
  const { from, to } = periodDates(choice);
  const parts: string[] = [];
  if (from) parts.push(`from=${from}`);
  if (to) parts.push(`to=${to}`);
  return parts.join('&');
}

/**
 * The same window as two dates, for an endpoint that takes a plain range.
 * A preset is resolved here rather than being sent as a word, so a filter and
 * a report asked for "last 3 months" cover the same three months.
 */
export function periodDates(choice: PeriodChoice): { from?: string; to?: string } {
  if (choice.preset === 'all') return {};
  if (choice.preset === 'custom') {
    return { from: choice.from || undefined, to: choice.to || undefined };
  }
  if (choice.preset === 'month') {
    // The calendar month, not the last thirty days: "this month" is a question
    // about the period being filed for.
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from: first.toISOString().slice(0, 10) };
  }
  const months = Number(choice.preset);
  if (!Number.isFinite(months)) return {};
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - months);
  return { from: start.toISOString().slice(0, 10) };
}

/** A custom window with neither end typed yet would silently mean "the default". */
export function periodReady(choice: PeriodChoice): boolean {
  return choice.preset !== 'custom' || Boolean(choice.from || choice.to);
}

export function PeriodPicker({
  label = 'Movements over',
  value,
  onChange,
  disabled,
}: {
  label?: string;
  value: PeriodChoice;
  onChange: (choice: PeriodChoice) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-nowrap items-center gap-2">
      <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm text-slate-600">
        {label}
        <select
          className={cx(inputBase, 'w-36')}
          value={value.preset}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, preset: event.target.value })}
        >
          {PERIOD_PRESETS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {value.preset === 'custom' && (
        <div className="flex shrink-0 flex-nowrap items-center gap-2 text-sm text-slate-600">
          <span>from</span>
          <input
            type="date"
            className={cx(inputBase, 'w-40')}
            value={value.from}
            disabled={disabled}
            max={value.to || undefined}
            onChange={(event) => onChange({ ...value, from: event.target.value })}
          />
          <span>to</span>
          <input
            type="date"
            className={cx(inputBase, 'w-40')}
            value={value.to}
            disabled={disabled}
            min={value.from || undefined}
            onChange={(event) => onChange({ ...value, to: event.target.value })}
          />
        </div>
      )}
    </div>
  );
}
