import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the provider with controlled hooks and wallet promises, without React Native.
const source = ts.createSourceFile('provider.tsx', readFileSync('components/stellar-wallet-provider.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = source.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'StellarWalletProvider')!;
const js = ts.transpileModule(declaration.getText(source).replace('export ', ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText.replace(/const \[([A-Za-z]+), ([A-Za-z]+)\] = useState\(/g, 'const [$1, $2] = useState("$1", ');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}
function fixture() {
  const state: Record<string, unknown> = {};
  const effects: (() => void | (() => void))[] = [];
  let flag = false;
  let requests = 0;
  let passiveReads = 0;
  let watchCallbacks: { change: (next: { address: string; passphrase: string }) => void; revoked: () => void };
  const replies: Promise<{ address: string }>[] = [];
  const api = {
    isAllowed: async () => ({ isAllowed: true }),
    requestAccess: async () => { requests++; return replies.shift() ?? { address: 'G-account' }; },
    getAddress: async () => { passiveReads++; return replies.shift() ?? { address: 'G-account' }; },
    getNetworkDetails: async () => ({ networkPassphrase: 'testnet' }),
  };
  const context = {
    React: { createElement: (_type: unknown, props: { value: unknown }) => props.value },
    StellarWalletContext: { Provider: {} },
    useRef: (current: unknown) => ({ current }),
    useState: (name: string, initial: unknown) => { state[name] = initial; return [initial, (v: unknown) => { state[name] = v; }]; },
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useEffect: (fn: () => void | (() => void)) => effects.push(fn),
    DEV_SECRET: '', isLocalHost: () => false, Platform: { OS: 'web' },
    STELLAR_TESTNET_NETWORK: { networkPassphrase: 'testnet' }, WATCH_INTERVAL_MS: 3000,
    loadVarial: async () => api,
    isVarialInstalled: async () => true,
    readFlag: () => flag, writeFlag: (value: boolean) => { flag = value; },
    watchVarial: (_api: unknown, _current: unknown, callbacks: typeof watchCallbacks) => { watchCallbacks = callbacks; return { stop() {} }; },
    varialSigner: () => ({}),
  };
  const value = new Function(...Object.keys(context), `${js}; return StellarWalletProvider({children:null});`)(...Object.values(context)) as {
    connect(): Promise<string | null>; disconnect(): void; cancelConnect(): void;
  };
  return { value, state, effects, replies, requests: () => requests, passiveReads: () => passiveReads,
    flag: () => flag, setFlag: () => { flag = true; }, change: () => watchCallbacks.change({ address: 'G-next', passphrase: 'other-network' }) };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
describe('Stellar provider lifecycle', () => {
  test('fresh mount never asks a wallet for access', async () => {
    const f = fixture(); f.effects.forEach((effect) => effect()); await flush();
    expect(f.requests()).toBe(0);
  });
  test('legacy Varial flag reconnects without requesting access', async () => {
    const f = fixture(); f.setFlag(); f.effects.forEach((effect) => effect()); await flush();
    expect(f.requests()).toBe(0); expect(f.passiveReads()).toBe(1);
    expect(f.state.status).toBe('connected');
  });
  test('disconnect cancels a pending reply and allows a new connection', async () => {
    const f = fixture(); const pending = deferred<{ address: string }>(); f.replies.push(pending.promise);
    const first = f.value.connect(); await flush();
    f.value.disconnect();
    expect(await f.value.connect()).toBe('G-account');
    pending.resolve({ address: 'G-old' }); await first;
    expect(f.state.address).toBe('G-account');
    expect(f.flag()).toBe(true);
  });
  test('duplicate clicks do not prompt twice', async () => {
    const f = fixture(); const pending = deferred<{ address: string }>(); f.replies.push(pending.promise);
    const first = f.value.connect(); await flush();
    expect(await f.value.connect()).toBeNull(); expect(f.requests()).toBe(1);
    pending.resolve({ address: 'G-account' }); await first;
  });
  test('passive reconnect recovers after unlock and follows account/network changes', async () => {
    const f = fixture(); f.setFlag(); f.replies.push(Promise.resolve({ address: '' }));
    f.effects.forEach((effect) => effect()); await flush();
    expect(f.state.status).toBe('disconnected');
    f.change(); expect(f.state.address).toBe('G-next'); expect(f.state.networkPassphrase).toBe('other-network');
    expect(f.requests()).toBe(0);
    f.value.disconnect(); f.change(); expect(f.state.status).toBe('disconnected');
  });
  test('unmount discards a late connection result', async () => {
    const f = fixture(); const pending = deferred<{ address: string }>(); f.replies.push(pending.promise);
    const cleanups = f.effects.map((effect) => effect());
    const connection = f.value.connect(); await flush(); cleanups.forEach((cleanup) => cleanup?.());
    pending.resolve({ address: 'G-old' }); expect(await connection).toBeNull(); expect(f.flag()).toBe(false);
  });
});

test('cancelling preserves a prior reconnect preference and discards the late reply', async () => {
  const f = fixture(); f.setFlag();
  const pending = deferred<{ address: string }>(); f.replies.push(pending.promise);
  const connection = f.value.connect(); await flush();
  f.value.cancelConnect();
  expect(f.flag()).toBe(true);
  pending.resolve({ address: 'G-late' });
  expect(await connection).toBeNull(); expect(f.state.status).toBe('disconnected');
  expect(await f.value.connect()).toBe('G-account');
  f.value.cancelConnect(); expect(f.state.status).toBe('connected');
  f.value.disconnect(); expect(f.flag()).toBe(false);
});

test('cancelling a first connection does not enable reconnect', async () => {
  const f = fixture(); const pending = deferred<{ address: string }>(); f.replies.push(pending.promise);
  const connection = f.value.connect(); await flush(); f.value.cancelConnect();
  pending.resolve({ address: 'G-late' }); await connection;
  expect(f.flag()).toBe(false); expect(f.state.address).toBeNull();
});
