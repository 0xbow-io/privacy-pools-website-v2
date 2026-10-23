import { afterAll, describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

// A browser history with real entries and popstate, before the module loads:
// it registers its popstate listener on import, ahead of the router's.
type Entry = { state: unknown; url: URL };
const target = new EventTarget();
const entries: Entry[] = [{ state: { id: 'home' }, url: new URL('https://app.test/') }];
let at = 0;
const location = {
  get href() { return entries[at].url.href; },
  get pathname() { return entries[at].url.pathname; },
  get search() { return entries[at].url.search; },
  get hash() { return entries[at].url.hash; },
  origin: 'https://app.test',
};
const history = {
  get state() { return entries[at].state; },
  pushState(state: unknown, _title: string, url?: string | URL | null) {
    entries.splice(at + 1);
    entries.push({ state, url: new URL(String(url ?? location.href), location.href) });
    at += 1;
  },
  replaceState(state: unknown, _title: string, url?: string | URL | null) {
    entries[at] = { state, url: new URL(String(url ?? location.href), location.href) };
  },
  go(delta: number) {
    at += delta;
    target.dispatchEvent(new Event('popstate'));
  },
};
const previousWindow = globalThis.window;
afterAll(() => { (globalThis as unknown as { window: unknown }).window = previousWindow; });
(globalThis as unknown as { window: unknown }).window = {
  location,
  history,
  addEventListener: target.addEventListener.bind(target),
};

// A fresh instance: other suites in this process may already have loaded the
// module without a window, and its popstate listener registers on load.
const urlEvents: typeof import('@/components/ui-url-events') = await import(
  `${new URL('../../components/ui-url-events.ts', import.meta.url).pathname}?router-hold`
);

describe('browser Back onto an open home panel', () => {
  test('the router sees the path it recorded, and the panel survives its write', () => {
    urlEvents.installUiUrlGuard();
    urlEvents.pushUiParamEntry('panel', 'balances');
    // The router pushes the pool page with its own record id.
    history.pushState({ id: 'pool' }, '', '/chains/ethereum/usdc');

    let seenByRouter = '';
    const routerListener = () => { seenByRouter = location.pathname + location.search; };
    target.addEventListener('popstate', routerListener);
    history.go(-1);
    target.removeEventListener('popstate', routerListener);

    // The panel entry shares the home record's id; the router must see "/".
    expect(seenByRouter).toBe('/');
    expect(urlEvents.getUiParam('panel')).toBe('balances');

    // The router then rewrites the entry with its own state and path.
    history.replaceState({ id: 'home' }, '', '/');
    expect(location.pathname + location.search).toBe('/?panel=balances');
    expect((history.state as Record<string, unknown>).__ppv2UiParamEntry).toBe(true);
  });

  test('a route change with no managed params is left to the router', () => {
    history.pushState({ id: 'explore' }, '', '/explore');
    history.pushState({ id: 'pool2' }, '', '/chains/base/usdc');
    let seenByRouter = '';
    const routerListener = () => { seenByRouter = location.pathname + location.search; };
    target.addEventListener('popstate', routerListener);
    history.go(-1);
    target.removeEventListener('popstate', routerListener);
    expect(seenByRouter).toBe('/explore');
  });
});


test('a quick Forward does not erase the panel entry before a router write', async () => {
  history.pushState({ id: 'quick-home' }, '', '/');
  urlEvents.pushUiParamEntry('panel', 'activity');
  history.pushState({ id: 'quick-pool' }, '', '/chains/base/usdc');
  history.go(-1);
  expect(location.search).toBe('');
  await Promise.resolve();
  expect(location.search).toBe('?panel=activity');
  history.go(1);
  await Promise.resolve();
  history.go(-1);
  expect(urlEvents.getUiParam('panel')).toBe('activity');
  await Promise.resolve();
  // Closing before a late router write must not resurrect the panel.
  history.go(-1);
  history.replaceState({ id: 'quick-home' }, '', '/');
  expect(urlEvents.getUiParam('panel')).toBeNull();
});

test('an explicit panel update wins over a pending router merge', async () => {
  urlEvents.pushUiParamEntry('panel', 'balances');
  history.pushState({ id: 'next-pool' }, '', '/chains/base/usdc');
  history.go(-1);
  await Promise.resolve();
  urlEvents.setUiParamEntry('panel', 'activity');
  expect(urlEvents.getUiParam('panel')).toBe('activity');
});
