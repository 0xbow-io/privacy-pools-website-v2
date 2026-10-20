import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import { shouldAutoSignAfterConnect } from '../services/auto-sign-after-connect';

// Execute the actual hook with controlled React state and connector promises.
// No wallet, RPC, or React Native runtime is needed to reproduce late callbacks.
const source = ts.createSourceFile('picker.tsx', readFileSync('components/wallet-connect-modal-provider.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hook = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'useWalletPicker')!;
const js = ts.transpileModule(hook.getText(source).replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(platform = 'ios') {
  const state: unknown[] = [];
  const timers: (() => void)[] = [];
  const effects: (() => void | (() => void))[] = [];
  // Pre-created on read: connectAsync runs after an awaited stale-session drop,
  // so a test can settle request N before the hook has asked for it.
  const made: ReturnType<typeof deferred>[] = [];
  const at = (i: number) => { while (made.length <= i) made.push(deferred()); return made[i]; };
  const requests = new Proxy(made, { get: (t, k) => (typeof k === 'string' && /^\d+$/.test(k) ? at(Number(k)) : Reflect.get(t, k)) });
  let asked = 0;
  const links: ReturnType<typeof deferred>[] = [];
  let connected = 0;
  const armed: (string | null)[] = [];
  const context = {
    useConnect: () => ({ connectors: [], connectAsync: () => at(asked++).promise }),
    useAccount: () => ({ isConnected: false }),
    useWindowDimensions: () => ({ width: 390 }),
    useRef: (current: unknown) => ({ current }),
    useState: (initial: unknown) => { const index = state.length; state.push(initial); return [initial, (value: unknown) => { state[index] = value; }]; },
    useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
    pickWalletOptions: () => [],
    Linking: { openURL: () => { const link = deferred(); links.push(link); return link.promise; } },
    Platform: { OS: platform },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: (id: number) => { timers[id - 1] = () => {}; },
    WC_URI_TIMEOUT_MS: 30_000,
    dropStaleWcSession: async () => {},
    PREPARE_UID: 'wc:prepare',
    WALLET_OPEN_CHECK_MS: 2_000,
    shareablePageUrl: () => '',
    openWalletLink: () => {},
    console: { info: () => {} },
    armAutoSignAfterConnect: (address: string | null) => { armed.push(address); },
    document: { visibilityState: 'visible' },
  };
  const picker = new Function(...Object.keys(context), `${js}; return useWalletPicker;`)(...Object.values(context))(() => { connected++; });
  const cleanups = effects.map((effect) => effect());
  function option(uid: string, kind = 'wc-qr') {
    const handlers = new Set<(event: unknown) => void>();
    return {
      uid, kind,
      connector: { type: 'walletConnect', emitter: {
        on: (_: string, handler: (event: unknown) => void) => handlers.add(handler),
        off: (_: string, handler: (event: unknown) => void) => handlers.delete(handler),
      } },
      handlers,
      emit: (uri: string) => handlers.forEach((handler) => handler({ type: 'display_uri', data: uri })),
    };
  }
  return { picker, state, requests, links, timers, option, armed, connected: () => connected, unmount: () => cleanups.forEach((cleanup) => cleanup?.()) };
}

describe('wallet picker attempt ownership', () => {
  for (const result of ['reject', 'resolve'] as const) {
    test(`a cancelled attempt's late ${result} cannot alter a newer attempt`, async () => {
      const f = fixture();
      const a = f.picker.pick(f.option('A'));
      await Promise.resolve();
      f.picker.reset();
      const optionB = f.option('B');
      const b = f.picker.pick(optionB);
      await Promise.resolve();
      optionB.emit('wc:B');
      if (result === 'reject') f.requests[0].reject(new Error('old failure'));
      else f.requests[0].resolve();
      await a;
      expect(f.state.slice(0, 4)).toEqual([null, 'B', 'wc:B', 'qr']);
      expect(optionB.handlers.size).toBe(1);
      expect(f.connected()).toBe(0);
      f.requests[1].resolve();
      await b;
      expect(f.connected()).toBe(1);
      expect(optionB.handlers.size).toBe(0);
    });
  }

  test('the installed-wallet tile lists wallets instead of opening a link from the event', async () => {
    const f = fixture('web');
    const option = f.option('A', 'wc-deeplink');
    const pending = f.picker.pick(option);
    option.emit('wc:A');
    expect(f.state[2]).toBe('wc:A');
    expect(f.state[3]).toBe('wallets');
    expect(f.links).toHaveLength(0);
    f.requests[0].resolve();
    await pending;
  });

  test('a stale deep-link attempt cannot change a newer QR attempt', async () => {
    const f = fixture('web');
    const optionA = f.option('A', 'wc-deeplink');
    const a = f.picker.pick(optionA);
    optionA.emit('wc:A');
    f.picker.reset();
    const optionB = f.option('B');
    const b = f.picker.pick(optionB);
    optionB.emit('wc:B');
    optionA.emit('wc:A2');
    f.timers.forEach((fn) => fn());
    expect(f.state.slice(1, 4)).toEqual(['B', 'wc:B', 'qr']);
    f.requests[0].resolve();
    f.requests[1].resolve();
    await Promise.all([a, b]);
  });

  test('no URI in time releases the tile with an error and ignores a late success', async () => {
    const f = fixture('web');
    const option = f.option('A', 'wc-deeplink');
    const pending = f.picker.pick(option);
    f.timers.forEach((fn) => fn());
    expect(f.state[0]).toMatch(/Couldn’t reach WalletConnect/);
    expect(f.state[1]).toBeNull();
    expect(option.handlers.size).toBe(0);
    f.requests[0].resolve();
    await pending;
    expect(f.connected()).toBe(0);
  });

  test('a URI that arrives in time cancels the timeout', async () => {
    const f = fixture('web');
    const option = f.option('A');
    const pending = f.picker.pick(option);
    option.emit('wc:A');
    f.timers.forEach((fn) => fn());
    expect(f.state.slice(0, 4)).toEqual([null, 'A', 'wc:A', 'qr']);
    f.requests[0].resolve();
    await pending;
    expect(f.connected()).toBe(1);
  });

  test('unmount detaches the listener and ignores a late success', async () => {
    const f = fixture();
    const option = f.option('A');
    const pending = f.picker.pick(option);
    f.unmount();
    expect(option.handlers.size).toBe(0);
    const before = [...f.state];
    f.requests[0].resolve();
    await pending;
    expect(f.state).toEqual(before);
    expect(f.connected()).toBe(0);
  });

  test('a current rejection remains visible and releases pending state', async () => {
    const f = fixture();
    const pending = f.picker.pick(f.option('A'));
    f.requests[0].reject(new Error('User rejected request'));
    await pending;
    expect(f.state.slice(0, 4)).toEqual(['Connection cancelled.', null, null, 'qr']);
  });
});

const ACCOUNT = '0x00000000000000000000000000000000000000aa';

describe('auto sign-in arm (DEV-522)', () => {
  test('a connect whose picker was closed by the connection event still arms the sign-in', async () => {
    const f = fixture();
    const a = f.picker.pick(f.option('A'));
    await Promise.resolve(); // past the stale-session drop: connectAsync is in flight
    // useConnectionEffect onConnect -> close() -> reset() runs before connectAsync's continuation.
    f.picker.reset();
    f.requests[0].resolve({ accounts: [ACCOUNT], chainId: 1 });
    await a;
    expect(f.armed).toEqual([ACCOUNT]);
    expect(f.connected()).toBe(0);
  });

  test('the current attempt arms for the approved account and closes the picker', async () => {
    const f = fixture();
    const a = f.picker.pick(f.option('A'));
    f.requests[0].resolve({ accounts: [ACCOUNT], chainId: 1 });
    await a;
    expect(f.armed).toEqual([ACCOUNT]);
    expect(f.connected()).toBe(1);
  });

  test('a connect result with no account arms with null, which the decision drops', async () => {
    const f = fixture();
    const a = f.picker.pick(f.option('A'));
    f.requests[0].resolve({ accounts: [], chainId: 1 });
    await a;
    expect(f.armed).toEqual([null]);
    expect(shouldAutoSignAfterConnect({
      arm: { address: null, armedAt: 0 }, now: 1, status: 'connected', address: ACCOUNT,
      identityMode: 'wallet', nonEvmChain: false, keysReady: false, isInitializing: false,
      passkeyActive: false, smartWalletProbeSettled: true, isSmartWallet: false, pageVisible: true,
    })).toBe('drop');
  });

  test('a rejected connect never arms', async () => {
    const f = fixture();
    const a = f.picker.pick(f.option('A'));
    f.requests[0].reject(new Error('User rejected the request.'));
    await a;
    expect(f.armed.length).toBe(0);
  });
});

describe('mobile pre-created pairing', () => {
  function withLinks() {
    const f = fixture('web');
    return f;
  }
  test('the prepare attempt stores the URI without leaving the tile list', async () => {
    const f = withLinks();
    const option = { ...f.option('wc:prepare', 'wc-link') };
    const pending = f.picker.pick(option);
    option.emit('wc:P');
    // [error, pendingId, wcUri, wcView, preparedUri, notOpened]
    expect(f.state.slice(1, 5)).toEqual([null, null, 'qr', 'wc:P']);
    expect(f.links).toHaveLength(0);
    f.requests[0].resolve();
    await pending;
    expect(f.connected()).toBe(1);
  });
  test('an expired pairing clears the URI so a tap re-prepares', async () => {
    const f = withLinks();
    const option = f.option('wc:prepare', 'wc-link');
    const pending = f.picker.pick(option);
    option.emit('wc:P');
    f.requests[0].reject(new Error('Proposal expired'));
    await pending;
    expect(f.state[4]).toBeNull();
  });
  test("reset collapses an expanded wallet list", () => {
    const f = withLinks();
    // [error, pendingId, wcUri, wcView, preparedUri, notOpened, waitingUid, showMore]
    f.state[6] = "tile";
    f.state[7] = true;
    f.picker.reset();
    expect(f.state.slice(6, 8)).toEqual([null, false]);
  });
});
