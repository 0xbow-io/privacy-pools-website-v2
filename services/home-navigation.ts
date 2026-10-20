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
