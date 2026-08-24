import { cx } from './ui';

/**
 * A 30-day stacked bar, generalised over the two module overviews.
 *
 * No charting library, for the same reason the AR dashboard's chart has never
 * had one: three series of thirty values does not justify the dependency, and a
 * hand-rolled version can be made accessible and printable without fighting a
 * framework. What changed in v2.7 is that two screens now want it, so it moved
 * here rather than being copied.
 */

export interface TrendPoint {
  date: string;
  /** The total for the day; the other two are subsets of it. */
  primary: number;
  secondary: number;
  tertiary: number;
}

export function TrendChart({
  series,
  labels,
  height = 120,
}: {
  series: TrendPoint[];
  labels: { primary: string; secondary: string; tertiary: string };
  height?: number;
}) {
  const max = Math.max(1, ...series.map((point) => point.primary));

  return (
    <div>
      <div className="flex items-end gap-1" style={{ height }}>
        {series.map((point) => {
          const total = (point.primary / max) * 100;
          const share = (value: number) =>
            point.primary > 0 ? (value / point.primary) * total : 0;

          const good = share(point.secondary);
          const bad = share(point.tertiary);
          // Whatever is neither settled nor disputed is still in flight.
          const pending = Math.max(0, total - good - bad);

          return (
            <div
              key={point.date}
              className="flex flex-1 flex-col justify-end"
              style={{ height: '100%' }}
              title={`${point.date}: ${point.primary} ${labels.primary.toLowerCase()}, ${point.secondary} ${labels.secondary.toLowerCase()}, ${point.tertiary} ${labels.tertiary.toLowerCase()}`}
            >
              {bad > 0 && <div className="bg-danger-500" style={{ height: `${bad}%` }} />}
              {pending > 0.5 && <div className="bg-warn-500" style={{ height: `${pending}%` }} />}
              {good > 0 && <div className="bg-ok-500" style={{ height: `${good}%` }} />}
              {point.primary === 0 && <div className="h-px bg-slate-200" />}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600">
        <Legend colour="bg-ok-500" label={labels.secondary} />
        <Legend colour="bg-warn-500" label="In progress" />
        <Legend colour="bg-danger-500" label={labels.tertiary} />
      </div>
    </div>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx('inline-block h-2.5 w-2.5 rounded-sm', colour)} />
      {label}
    </span>
  );
}
