/**
 * Dates and times for list rows (Activity, Payment Requests, payroll). The
 * month is spelled out ("Oct 6") because a numeric date reads differently in
 * MM.DD and DD.MM locales. PURE, so it is bun-testable.
 */

/**
 * Interpret a numeric unix timestamp that may be seconds or milliseconds as
 * milliseconds. Any ms value before ~Nov 1970 is indistinguishable from a
 * seconds value and is treated as seconds — fine here, since every timestamp
 * these rows render is decades past that.
 */
export function timestampToMs(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function validDate(value: number): Date | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(timestampToMs(value));
  // Past JavaScript's date range (±8.64e15 ms) the Date is invalid, and would
  // print "Invalid Date" and "NaN:NaN".
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A short human date: "Jul 12", gaining the year once it is not the current
 * one ("Jul 12, 2025"). Returns "—" for a missing/invalid timestamp, and
 * accepts seconds or milliseconds (see timestampToMs).
 */
export function formatShortDate(value: number, now: number = Date.now()): string {
  const d = validDate(value);
  if (!d) return '—';
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** The 24-hour local time, "00:16". Empty for a missing/invalid timestamp. */
export function formatShortTime(value: number): string {
  const d = validDate(value);
  if (!d) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
