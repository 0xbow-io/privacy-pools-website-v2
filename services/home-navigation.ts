// Session-local workspace location. Only the home action and panel survive
// top-level navigation; transient signing/picker overlays must never reopen.
let homeDestination = '/';

export function rememberHomeLocation(location: { pathname: string; search: string }): void {
  if (location.pathname !== '/') return;
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  const action = source.get('action');
  if (action) params.set('action', action);
  const panel = source.get('panel');
  if (panel === 'balances' || panel === 'activity') params.set('panel', panel);
  homeDestination = params.size ? `/?${params}` : '/';
}

export function getHomeDestination(): string {
  return homeDestination;
}

export function clearHomePanel(): void {
  const url = new URL(homeDestination, 'https://home.invalid');
  url.searchParams.delete('panel');
  rememberHomeLocation(url);
}

/**
 * Where a phone sends a balances/activity surface now that the bar has no tab
 * for either (Ameen, QA 2026-10-25): Portfolio carries both. null keeps the
 * legacy surface, for the cases Portfolio cannot serve:
 *   non-EVM chains (Sui, Stellar), where Portfolio redirects home;
 *   signed-out activity, the public feed Portfolio does not show.
 */
export function phonePanelTarget(
  panel: 'balances' | 'activity' | null,
  { nonEvm, signedIn }: { nonEvm: boolean; signedIn: boolean },
): '/portfolio' | null {
  if (!panel || nonEvm) return null;
  if (panel === 'activity' && !signedIn) return null;
  return '/portfolio';
}

/**
 * Redirect a phone `/?panel=` link. The remembered home destination drops the
 * panel FIRST, or the Shield tab would resolve to `/?panel=…` and bounce
 * straight back to Portfolio for the rest of the session.
 */
export function redirectPhonePanel(
  panel: 'balances' | 'activity' | null,
  ctx: { nonEvm: boolean; signedIn: boolean },
): '/portfolio' | null {
  const target = phonePanelTarget(panel, ctx);
  if (target) clearHomePanel();
  return target;
}
