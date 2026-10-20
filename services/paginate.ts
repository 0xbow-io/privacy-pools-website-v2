/**
 * Client-side paging arithmetic for lists that are already fully in memory.
 *
 * The whole point is the clamp. A page index is state that outlives the list
 * it indexes into: the viewer sits on page 3, the list shrinks underneath them
 * (a request gets fulfilled and the Open filter drops it, a sync prunes rows),
 * and a raw index past the end renders an empty page with no control that
 * gets them back. So the index is clamped on READ rather than only reset on
 * the changes we happened to think of.
 */
export type Page = {
  /** The raw index clamped into range. Always 0 <= page < pageCount. */
  page: number;
  /** At least 1, so "Page 1 of 1" is true of an empty list rather than "of 0". */
  pageCount: number;
  /** Slice bounds for the current page. */
  start: number;
  end: number;
};

export function paginate(total: number, pageSize: number, rawPage: number): Page {
  // A non-positive page size would divide by zero into Infinity pages.
  const size = Math.max(1, Math.floor(pageSize));
  const count = Math.max(1, Math.ceil(Math.max(0, total) / size));
  // Math.floor before clamping: a fractional or negative raw index (restored
  // state, a bad deep link) must not leak into the slice bounds.
  const page = Math.min(Math.max(0, Math.floor(rawPage) || 0), count - 1);
  const start = page * size;
  return { page, pageCount: count, start, end: Math.min(start + size, Math.max(0, total)) };
}
