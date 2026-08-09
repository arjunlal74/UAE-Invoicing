import Decimal from 'decimal.js';

/**
 * Money handling.
 *
 * Every amount in this system is a string in transit and a Decimal in
 * arithmetic. Never a JavaScript number: 0.1 + 0.2 !== 0.3, and an invoice
 * whose lines miss the header total by a hundredth of a dirham is rejected by
 * the FTA arithmetic rule, not quietly rounded away.
 *
 * Decimal.js is configured to round half-up, which is what the Excel template's
 * ROUND() calls do. If these two disagree the grid shows the user one number
 * while the XML carries another.
 */
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

/** Amounts on the wire and in the DB use 2 decimal places. */
export const AMOUNT_DP = 2;
/** Quantities allow 4, per the template spec. */
export const QUANTITY_DP = 4;
/** Unit prices allow 4 — sub-fils pricing is common in telecom/utilities. */
export const UNIT_PRICE_DP = 4;
/** FX rates carry 6, matching NUMERIC(12,6) in the schema. */
export const FX_RATE_DP = 6;

export type NumericInput = string | number | Decimal | null | undefined;

/**
 * Parse a spreadsheet cell into a Decimal.
 * Returns null for anything that isn't a number — the caller decides whether
 * that is a validation error or a legitimately empty optional field.
 */
export function toDecimal(value: NumericInput): Decimal | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Decimal) return value;

  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (raw === '') return null;

  // Tolerate thousands separators and a leading currency symbol; users paste
  // formatted values out of their own spreadsheets constantly.
  const cleaned = raw.replace(/[,\s]/g, '').replace(/^(AED|USD|EUR|GBP|SAR)/i, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  try {
    const d = new Decimal(cleaned);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** Round to `dp` places, half-up, returning a fixed-precision string. */
export function round(value: NumericInput, dp = AMOUNT_DP): string {
  const d = toDecimal(value);
  return (d ?? new Decimal(0)).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp);
}

/** Round an amount to 2dp. Shorthand for the overwhelmingly common case. */
export function money(value: NumericInput): string {
  return round(value, AMOUNT_DP);
}

/** True when two amounts are equal once both are rounded to `dp`. */
export function amountsEqual(a: NumericInput, b: NumericInput, dp = AMOUNT_DP): boolean {
  const da = toDecimal(a);
  const db = toDecimal(b);
  if (da === null || db === null) return false;
  return da.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).equals(db.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP));
}

export function sum(values: NumericInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v) ?? 0), new Decimal(0));
}

/** Format for display in the portal: 1,250.00 */
export function formatAmount(value: NumericInput, dp = AMOUNT_DP): string {
  const d = toDecimal(value);
  if (d === null) return '';
  const fixed = d.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp);
  const [whole = '0', frac] = fixed.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}
