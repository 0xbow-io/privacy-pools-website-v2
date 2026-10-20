/**
 * How to drop a UI param (`?tx=`) from the URL. PURE: the caller owns
 * `window.history`.
 *
 * A marked entry (we pushed it) is normally retired with history.back(), so
 * browser back never revisits it. That back is ASYNC, so when something opens
 * right after in the same tap (a detail-sheet action opening the withdraw
 * modal, which pushes `?modal=withdraw`), the queued back lands on an entry
 * without that modal and the URL bridge closes it again (DEV-553, #285).
 * `followedByAction` retires synchronously with replaceState instead, which
 * keeps the action inside the user's tap (popups, clipboard).
 */
export type RetirePlan =
  | { kind: 'none' }
  | { kind: 'back' }
  | { kind: 'replace'; state: unknown };

export function planUiParamRetire(input: {
  hasKey: boolean;
  state: unknown;
  marker: string;
  followedByAction?: boolean;
}): RetirePlan {
  if (!input.hasKey) return { kind: 'none' };
  const { state, marker } = input;
  const isObject = typeof state === 'object' && state !== null && !Array.isArray(state);
  const marked = isObject && (state as Record<string, unknown>)[marker] === true;
  if (marked && !input.followedByAction) return { kind: 'back' };
  if (!marked) return { kind: 'replace', state };
  // The entry stays, without the param and without the marker, so a later
  // retire never treats it as ours to pop.
  const { [marker]: _dropped, ...rest } = state as Record<string, unknown>;
  return { kind: 'replace', state: rest };
}
