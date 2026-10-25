/** One navigation's form selection, held in memory so private form data never enters a URL. */
export type PoolHubHandoff = {
  pathname: string;
  chainId: number;
  selection:
    | { kind: 'pay'; symbol: string; address: string; decimals: number; name: string; external: boolean; amount: string }
    | { kind: 'request'; address: string };
};

let pending: (PoolHubHandoff & { id: string; expiresAt: number }) | null = null;

/** Pool-page hub tabs use a distinct param from the page's modal deep links. */
export function poolHubTabPath(pathname: string, action: string, handoffId?: string): string {
  const params = new URLSearchParams();
  if (action !== 'shield') params.set('hubAction', action);
  // An opaque navigation id distinguishes this entry from a later visit to
  // the same pool. The token, amount and request asset stay only in memory.
  if (handoffId) params.set('hubHandoff', handoffId);
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}

export function registerPoolHubHandoff(handoff: PoolHubHandoff): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  pending = { ...handoff, id, expiresAt: Date.now() + 30_000 };
  return id;
}

export function takePoolHubHandoff(pathname: string, chainId: number, id: string | null): PoolHubHandoff['selection'] | null {
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) { pending = null; return null; }
  if (!id || pending.id !== id || pending.pathname !== pathname || pending.chainId !== chainId) return null;
  const selection = pending.selection;
  pending = null;
  return selection;
}
