import { useState } from 'react';

/**
 * The previous `value` while its content key is unchanged, else the new one.
 *
 * For inputs rebuilt on every poll with the same content (a fresh array of the
 * same notes). Anything keyed on their identity (a `useMemo` dep, an
 * `===` readiness check) then treats a no-op refresh as new data, and the UI
 * visibly redoes work it had already done: My transactions hid and re-showed
 * its rows on every notes poll, because classification is pinned to the exact
 * notes array it ran on.
 *
 * React's documented "storing information from previous renders" pattern (a
 * state update during render), so it works with the React Compiler rather than
 * reading a ref during render.
 */
export function useContentStable<T>(value: T, key: string): T {
  const [held, setHeld] = useState({ key, value });
  if (held.key !== key) {
    setHeld({ key, value });
    return value;
  }
  return held.value;
}
