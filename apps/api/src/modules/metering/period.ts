import type { ReportingPeriod } from '@uae/contracts';
import { badRequest } from '../../lib/errors.js';

/**
 * The window a spend or volume figure covers.
 *
 * Only reporting takes a period. Stock and net available are cumulative by
 * definition — what is on the shelf today is every purchase ever made minus
 * every sale ever made — so scoping them would produce something that looks
 * like a balance and is not one. What does need a window is everything that
 * would otherwise only grow: contracts registered, units bought, money spent.
 *
 * Twelve months by default rather than all time, because a lifetime total stops
 * being informative the moment it is bigger than a year's worth: it cannot tell
 * you whether a provider is still in use or what a renewal ought to cost.
 */

const DEFAULT_MONTHS = 12;
const MOVEMENT_DEFAULT_DAYS = 30;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ParsedPeriod {
  from: string | null;
  to: string | null;
  label: string;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parsePeriod(query: unknown): ParsedPeriod {
  const { from, to, period } = (query ?? {}) as {
    from?: string;
    to?: string;
    period?: string;
  };

  // An explicit range wins, and is validated rather than silently ignored: a
  // mistyped date that quietly widens to all time is a spend report that reads
  // as a quarter and is not one.
  if (from || to) {
    if (from && !DATE.test(from)) throw badRequest('`from` must be a date as YYYY-MM-DD.');
    if (to && !DATE.test(to)) throw badRequest('`to` must be a date as YYYY-MM-DD.');
    if (from && to && from > to) {
      throw badRequest('That period ends before it starts.');
    }
    return {
      from: from ?? null,
      to: to ?? null,
      label: from && to ? `${from} to ${to}` : from ? `from ${from}` : `up to ${to}`,
    };
  }

  if (period === 'all') return { from: null, to: null, label: 'All time' };

  const months = Number(period);
  if (period !== undefined && (!Number.isInteger(months) || months < 1 || months > 120)) {
    throw badRequest('`period` must be a whole number of months from 1 to 120, or "all".');
  }

  const span = Number.isInteger(months) && months >= 1 ? months : DEFAULT_MONTHS;
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - span);

  return {
    from: isoDay(start),
    to: null,
    label: span === 1 ? 'Last month' : `Last ${span} months`,
  };
}

/**
 * The window a movement statement covers — both ends resolved, always.
 *
 * A spend report can leave an end open and still mean something; an opening and
 * closing balance cannot. "Up to whenever" has no closing figure, so both dates
 * are filled in here rather than being left null for the query to interpret.
 *
 * Thirty days by default: the shelf moves on the timescale of a purchase order,
 * and a month is the window an operator reconciles.
 */
export function parseMovementWindow(query: unknown): { from: string; to: string } {
  const { from, to } = (query ?? {}) as { from?: string; to?: string };

  if (from && !DATE.test(from)) throw badRequest('`from` must be a date as YYYY-MM-DD.');
  if (to && !DATE.test(to)) throw badRequest('`to` must be a date as YYYY-MM-DD.');

  const end = to ?? isoDay(new Date());
  const startDefault = new Date();
  startDefault.setUTCDate(startDefault.getUTCDate() - MOVEMENT_DEFAULT_DAYS);
  const start = from ?? isoDay(startDefault);

  if (start > end) throw badRequest('That period ends before it starts.');

  return { from: start, to: end };
}

export function toReportingPeriod(parsed: ParsedPeriod): ReportingPeriod {
  return { from: parsed.from, to: parsed.to, label: parsed.label };
}
