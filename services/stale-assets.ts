// A tab left open across a circuit change still asks for the old
// /artifacts/<version>/ files, which the artifacts project no longer serves.
// That is a 404 on a versioned URL, and the fix is a reload (the new page knows
// the new version). The loader reports it here, one headless notifier shows it.
//
// Only a versioned build can be stale: locally a 404 on the flat /artifacts is a
// missing file, not an old tab.

export const STALE_ASSETS_TITLE = 'The app was updated';
export const STALE_ASSETS_TEXT = 'Reload the page to continue.';
/** What the failed proof says too, since the SDK wraps this message into its own. */
export const STALE_ASSETS_ERROR = `The app was updated. ${STALE_ASSETS_TEXT}`;

/** Pure: does this response mean the page is out of date? */
export function isStaleAssetResponse(args: { versioned: boolean; status: number }): boolean {
  return args.versioned && args.status === 404;
}

let stale = false;
const listeners = new Set<() => void>();

export function reportStaleAssets(): void {
  if (stale) return;
  stale = true;
  for (const listener of listeners) listener();
}

export function subscribeStaleAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function staleAssetsReported(): boolean {
  return stale;
}

/** Test seam. */
export function resetStaleAssetsForTest(): void {
  stale = false;
  listeners.clear();
}
