import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import * as viem from 'viem';
import * as policy from '../egress-policy';
import * as settings from '../../config/tor';
import { AnonRpcWorker } from '@0xbow/anon-rpc-rs-browser-harness';

const MAINNET = 'https://mainnet.example/';
const ENV_MAINNET = 'https://env-mainnet.example/';
const ENV_SEPOLIA = 'https://env-sepolia.example/';
const GATEWAY = `127.0.0.1:12298:u${Buffer.from([0x12, 0x20, ...new Array(32).fill(0)]).toString('base64url')}`;
const root = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), 'utf8');
function load(path: string, env: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(source(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('exports', ...Object.keys(env), code)(exports, ...Object.values(env));
  return exports;
}
function storage() {
  const entries = new Map<string, string>();
  return { entries, getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); } };
}
function config(gateway: string, store = storage()) {
  return load('config/tor.ts', { process: { env: { EXPO_PUBLIC_TOR_GATEWAY: gateway } }, window: { localStorage: store } }) as typeof settings;
}

for (const phase of ['download', 'body'] as const) test(`the bundled harness cannot resume after close during a ${phase}`, async () => {
  const bundle = new TextEncoder().encode('/* cancellation fixture */');
  const hash = viem.keccak256(bundle);
  const resolvers = viem.encodeAbiParameters([{ type: 'string[]' }], [['https://first.example/worker', 'https://second.example/worker']]);
  let started!: () => void;
  const downloading = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  let signal: AbortSignal | null | undefined;
  const calls: string[] = [];
  let frames = 0;
  const realFetch = globalThis.fetch;
  const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement() { frames++; throw new Error('A closed worker must not create an iframe'); },
  } });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    signal = init?.signal;
    if (phase === 'download') return new Promise<Response>(resolve => {
      finish = () => resolve(new Response(bundle));
      started();
    });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      finish = () => { controller.enqueue(bundle); controller.close(); };
      started();
    } }));
  }) as typeof fetch;
  const worker = new AnonRpcWorker({ address: settings.TOR_PROVIDERS[0].specifier, preExisting: { rpcProvider: {
    request: async ({ params }) => (params?.[0] as { data: string }).data === '0x3898587d' ? hash : resolvers,
  } } });
  try {
    await downloading;
    worker.close();
    await expect(worker.ready).rejects.toThrow('worker closed');
    // Even a fetch implementation that ignores abort may resolve later.
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(frames).toBe(0);
    expect(calls).toEqual(['https://first.example/worker']);
    expect(signal?.aborted).toBe(true);
  } finally {
    worker.close();
    globalThis.fetch = realFetch;
    if (realDocument) Object.defineProperty(globalThis, 'document', realDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});


test('the bundled harness releases its bootstrap when closed while the iframe has not said ready', async () => {
  const bundle = new TextEncoder().encode('/* ready-wait fixture */');
  const hash = viem.keccak256(bundle);
  const resolvers = viem.encodeAbiParameters([{ type: 'string[]' }], [['https://first.example/worker']]);
  let appended!: () => void;
  const waitingForReady = new Promise<void>(resolve => { appended = resolve; });
  const posted: unknown[] = [];
  // Record the bootstrap's own signal, and whether anything waiting on it runs.
  const RealAbortController = globalThis.AbortController;
  let fired = 0;
  class SpyAbortController extends RealAbortController {
    constructor() {
      super();
      const signal = this.signal;
      const add = signal.addEventListener.bind(signal);
      signal.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) =>
        add(type, (event: Event) => { if (type === 'abort') fired++; listener(event); }, options)) as typeof signal.addEventListener;
    }
  }
  const realFetch = globalThis.fetch;
  const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const iframe = { style: {}, setAttribute() {}, remove() {}, contentWindow: { postMessage: (message: unknown) => { posted.push(message); } } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => iframe,
    body: { appendChild: () => { appended(); } },
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  globalThis.fetch = (async () => new Response(bundle)) as typeof fetch;
  globalThis.AbortController = SpyAbortController as typeof AbortController;
  let worker: InstanceType<typeof AnonRpcWorker> | undefined;
  try {
    worker = new AnonRpcWorker({ address: settings.TOR_PROVIDERS[0].specifier, preExisting: { rpcProvider: {
      request: async ({ params }) => (params?.[0] as { data: string }).data === '0x3898587d' ? hash : resolvers,
    } } });
    globalThis.AbortController = RealAbortController;
    await waitingForReady;
    const before = fired;
    worker.close();
    await expect(worker.ready).rejects.toThrow('worker closed');
    await new Promise(resolve => setTimeout(resolve, 0));
    // The wait for iframe-ready listens on the bootstrap signal, so close() ends it.
    expect(fired).toBeGreaterThan(before);
    expect(posted).toEqual([]);
  } finally {
    globalThis.AbortController = RealAbortController;
    worker?.close();
    globalThis.fetch = realFetch;
    if (realDocument) Object.defineProperty(globalThis, 'document', realDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (realWindow) Object.defineProperty(globalThis, 'window', realWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
test('canceling a KPS bundle download closes the stream and its connection', async () => {
  const controller = new AbortController();
  let reading!: () => void;
  const waiting = new Promise<void>(resolve => { reading = resolve; });
  let reader!: ReadableStreamDefaultController<Uint8Array>;
  let closed = 0;
  let dialSignal: AbortSignal | undefined;
  const stream = {
    writable: new WritableStream<Uint8Array>(),
    readable: new ReadableStream<Uint8Array>({ start(value) { reader = value; }, pull() { reading(); } }),
    close: async () => { closed++; reader.error(new Error('stream closed')); },
  };
  const { fetchBundleOverKps } = load('node_modules/@0xbow/anon-rpc-rs-browser-harness/src/host/kps-http.ts', {
    require: (name: string) => {
      if (name !== '@kpstreams/webrtc-client') throw new Error(`Unexpected dependency ${name}`);
      return { openStream: async (_address: string, options: { signal?: AbortSignal }) => {
        dialSignal = options.signal;
        return stream;
      } };
    },
  }) as { fetchBundleOverKps: (address: string, path: string, cap: number, signal: AbortSignal) => Promise<Uint8Array> };
  const pending = fetchBundleOverKps(GATEWAY, '/worker', 1024, controller.signal);
  await waiting;
  // Allow the dial and request writer to settle before aborting the read.
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await expect(pending).rejects.toThrow('stream closed');
  expect(dialSignal).toBe(controller.signal);
  expect(closed).toBeGreaterThan(0);
});

// Compile isolated modules so neither browser globals nor module mocks leak into other tests.
function transport(active: boolean, importer: () => unknown, options: {
  mainnetInChainList?: boolean;
  chainUrls?: Record<number, string>;
  customRpcUrls?: Record<number, string>;
} = {}) {
  let imports = 0;
  const tor = load('services/tor-fetch.ts', { require(name: string) {
    if (name === '@/config/tor') return { ...settings, TOR_IN_FORCE: active, ACTIVE_TOR_SETTINGS: { enabled: active, gatewayUrl: GATEWAY, provider: 'tor-js' } };
    if (name === '@/services/egress-policy') return policy;
    if (name === '@/config/chains') return { getChainConfig: (id: number) => options.chainUrls?.[id] ? { rpcUrl: options.chainUrls[id] }
      : id === 1 && options.mainnetInChainList !== false ? { rpcUrl: MAINNET } : undefined };
    if (name === '@/config/custom-rpc') return { activeCustomRpcUrl: (id: number) => options.customRpcUrls?.[id] };
    if (name === '@/config/env') return { MAINNET_RPC_URL: ENV_MAINNET, SEPOLIA_RPC_URL: ENV_SEPOLIA };
    if (name === '@0xbow/anon-rpc-rs-browser-harness') { imports++; return importer(); }
    throw new Error(`Unexpected dependency ${name}`);
  } }) as typeof import('../tor-fetch');
  const { policedHttp } = load('services/egress-transport.ts', { require(name: string) {
    if (name === 'viem') return viem;
    if (name === '@/services/egress-policy') return policy;
    if (name === '@/services/tor-fetch') return tor;
    throw new Error(`Unexpected dependency ${name}`);
  } }) as typeof import('../egress-transport');
  return { tor, policedHttp, imports: () => imports };
}

describe('Tor configuration', () => {
  test('suggestion initializes after validation dependencies, even for invalid deployment values', () => {
    expect(config('').SUGGESTED_TOR_GATEWAY).toBe('');
    expect(config('bad').SUGGESTED_TOR_GATEWAY).toBe('');
    expect(config(` ${GATEWAY} `).SUGGESTED_TOR_GATEWAY).toBe(GATEWAY);
  });

  test('invalid stored gateways cannot activate Tor or be written as enabled', () => {
    for (const gatewayUrl of ['', 'https://example.com', GATEWAY.replace('12298', '65536'), GATEWAY.replace('127.0.0.1', '999.0.0.1'), GATEWAY.replace('uEi', 'uAA')]) {
      const store = storage();
      store.setItem(settings.TOR_STORAGE_KEY, JSON.stringify({ enabled: true, gatewayUrl, provider: 'tor-js' as const }));
      const loaded = config('', store);
      expect(loaded.ACTIVE_TOR_SETTINGS).toEqual(settings.TOR_OFF);
      expect(loaded.TOR_IN_FORCE).toBe(false);
      expect(settings.torActive({ enabled: true, gatewayUrl, provider: 'tor-js' as const })).toBe(false);
      expect(settings.writeTorSettings(store, { enabled: true, gatewayUrl, provider: 'tor-js' as const })).toBe(false);
    }
    for (const raw of [null, 'bad', '[]', 'null', '{"enabled":true}']) expect(settings.parseTorSettings(raw)).toEqual(settings.TOR_OFF);
  });

  test('valid KPS settings round-trip and disabled settings remove the key', () => {
    const store = storage();
    expect(settings.validateTorGateway(GATEWAY.replace('127.0.0.1', '[::1]')).ok).toBe(true);
    expect(settings.writeTorSettings(store, { enabled: true, gatewayUrl: GATEWAY, provider: 'tor-js' })).toBe(true);
    expect(config('', store).TOR_IN_FORCE).toBe(true);
    expect(settings.readTorSettings(store)).toEqual({ enabled: true, gatewayUrl: GATEWAY, provider: 'tor-js' });
    expect(settings.writeTorSettings(store, settings.TOR_OFF)).toBe(true);
    expect(store.entries.size).toBe(0);
    expect(settings.writeTorSettings(null, settings.TOR_OFF)).toBe(false);
    const refusing = { getItem: () => null, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    expect(settings.writeTorSettings(refusing, { enabled: true, gatewayUrl: GATEWAY, provider: 'tor-js' })).toBe(false);
    expect(settings.writeTorSettings(refusing, settings.TOR_OFF)).toBe(false);
  });

  test('an entry saved before providers existed keeps running tor-js; an unknown provider turns Tor off', () => {
    const legacy = storage();
    legacy.setItem(settings.TOR_STORAGE_KEY, JSON.stringify({ enabled: true, gatewayUrl: GATEWAY }));
    expect(config('', legacy).ACTIVE_TOR_SETTINGS).toEqual({ enabled: true, gatewayUrl: GATEWAY, provider: 'tor-js' });
    expect(config('', legacy).TOR_IN_FORCE).toBe(true);
    for (const provider of ['i2p', 1, null, '']) {
      const store = storage();
      store.setItem(settings.TOR_STORAGE_KEY, JSON.stringify({ enabled: true, gatewayUrl: GATEWAY, provider }));
      expect(config('', store).TOR_IN_FORCE).toBe(false);
    }
    expect(settings.torActive({ enabled: true, gatewayUrl: GATEWAY, provider: 'i2p' as never })).toBe(false);
  });

  test('saving Tor off removes an entry this build cannot read, so a later build cannot revive it', () => {
    const store = storage();
    store.setItem(settings.TOR_STORAGE_KEY, JSON.stringify({ enabled: true, gatewayUrl: GATEWAY, provider: 'i2p' }));
    const loaded = config('', store);
    expect(loaded.ACTIVE_TOR_SETTINGS).toEqual(settings.TOR_OFF);
    expect(loaded.saveTorSettings(settings.TOR_OFF)).toBe(true);
    expect(store.entries.size).toBe(0);
    // Nothing stored and nothing active: still no write needed.
    const empty = storage();
    const refusing = { ...empty, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    expect(config('', refusing).saveTorSettings(settings.TOR_OFF)).toBe(true);
  });

  test('the tor-js provider is the published anon-rpc specifier and takes the gateway as its config', () => {
    const provider = settings.torProvider('tor-js')!;
    expect(provider.specifier).toBe('0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e');
    expect(provider.specifierChainId).toBe(1);
    expect(provider.workerConfig(GATEWAY)).toEqual({ gateways: [GATEWAY] });
    // The passthrough reference worker sends with a plain fetch.
    expect(settings.TOR_PROVIDERS.map(p => p.specifier.toLowerCase())).not.toContain('0x4fd77be300f31c5fe6ab266d35d27750a3478d27');
  });

  test('the provider list is tor-js, Nym and Nox, each pinned to its published specifier', () => {
    expect(settings.TOR_PROVIDERS.map(p => [p.id, p.specifier, p.specifierChainId, p.needsGateway])).toEqual([
      ['tor-js', '0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e', 1, true],
      ['nym', '0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0', 1, false],
      ['nox', '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A', 11155111, false],
    ]);
    expect(settings.TOR_PROVIDERS.map(p => [p.id, p.workerHash])).toEqual([
      ['tor-js', '0xe39f8c42ed72b7f580a73c46c3300f6d3ad3954bbc26e5fe075b18c48fedc8b5'],
      ['nym', '0xf13a448a8721b9d0b20da3d5b80ffe00bf4c5bb3aae812a38d3d1e3bc81fceb8'],
      ['nox', '0xd8bef626ec8511d7a468bca5137880680ca2da20d2ea4d9c981a2a3d0c86ba1e'],
    ]);
    for (const p of settings.TOR_PROVIDERS) {
      expect(p.hint).not.toContain('\u2014');
    }
    expect(settings.torProvider('nym')!.workerConfig(GATEWAY)).toBeUndefined();
    expect(settings.torProvider('nox')!.workerConfig('')).toBeUndefined();
    expect(settings.DEFAULT_TOR_PROVIDER).toBe('tor-js');
    expect(settings.TOR_OFF.enabled).toBe(false);
  });

  test('Nym and Nox need no gateway; a stray gateway on them is dropped, not required', () => {
    for (const provider of ['nym', 'nox'] as const) {
      expect(settings.torNeedsGateway(provider)).toBe(false);
      expect(settings.validateTorGatewayFor(provider, '')).toEqual({ ok: true, url: '' });
      expect(settings.torActive({ enabled: true, gatewayUrl: '', provider })).toBe(true);
      const store = storage();
      expect(settings.writeTorSettings(store, { enabled: true, gatewayUrl: '', provider })).toBe(true);
      expect(config('', store).ACTIVE_TOR_SETTINGS).toEqual({ enabled: true, gatewayUrl: '', provider });
      expect(config('', store).TOR_IN_FORCE).toBe(true);
      expect(settings.parseTorSettings(JSON.stringify({ enabled: true, gatewayUrl: 'junk', provider })))
        .toEqual({ enabled: true, gatewayUrl: '', provider });
    }
    // tor-js still requires one.
    expect(settings.torNeedsGateway('tor-js')).toBe(true);
    expect(settings.validateTorGatewayFor('tor-js', '').ok).toBe(false);
    expect(settings.parseTorSettings(JSON.stringify({ enabled: true, gatewayUrl: '', provider: 'tor-js' }))).toEqual(settings.TOR_OFF);
    // Unknown ids take the strict side.
    expect(settings.torNeedsGateway('i2p')).toBe(true);
  });

  test('retry after an RPC storage failure can undo the already-written Tor choice', () => {
    const store = storage();
    const loaded = config('', store);
    expect(loaded.saveTorSettings({ enabled: true, gatewayUrl: GATEWAY, provider: 'tor-js' })).toBe(true);
    expect(loaded.ACTIVE_TOR_SETTINGS.enabled).toBe(false); // no reload yet
    expect(loaded.saveTorSettings(settings.TOR_OFF)).toBe(true);
    expect(config('', store).TOR_IN_FORCE).toBe(false);
  });
});

describe('Tor sender under the egress policy', () => {
  const RPC = 'https://rpc.example';
  test('inactive Tor preserves the supplied sender and never loads the client', async () => {
    const loaded = transport(false, () => { throw new Error('must stay lazy'); });
    let direct = 0;
    const client = viem.createPublicClient({ transport: loaded.policedHttp(RPC, { retryCount: 0,
      fetchFn: async () => { direct++; return Response.json({ result: '0x1' }); } }) });
    expect(await client.getChainId()).toBe(1);
    expect(direct).toBe(1);
    expect(loaded.imports()).toBe(0);
  });

  test('both policy checks precede lazy loading and Tor sending, including hook mutations', async () => {
    policy.setEgressMode('enforce');
    let sent = 0;
    const loaded = transport(true, () => ({ AnonRpcWorker: class {
      ready = Promise.resolve();
      close() {}
      fetch = async () => { sent++; return Response.json({ result: '0x1' }); };
    } }));
    const forbidden = { method: 'eth_call', params: [{ data: `0x811608fd${'1'.repeat(64)}` }] };
    const client = viem.createPublicClient({ transport: loaded.policedHttp(RPC, { retryCount: 0 }) });
    await expect(client.request(forbidden as never)).rejects.toBeInstanceOf(policy.EgressRefusedError);
    const mutated = viem.createPublicClient({ transport: loaded.policedHttp(RPC, { retryCount: 0,
      onFetchRequest: (_req, init) => ({ ...init, body: JSON.stringify(forbidden) }) }) });
    await expect(mutated.getChainId()).rejects.toThrow();
    expect(loaded.imports()).toBe(0);
    expect(sent).toBe(0);
    expect(await client.getChainId()).toBe(1);
    expect(sent).toBe(1);
    expect(loaded.imports()).toBe(1);
  });

  for (const failure of ['import', 'ready', 'fetch']) test(`${failure} failure rejects without a direct fallback`, async () => {
    let direct = 0;
    const loaded = transport(true, () => {
      if (failure === 'import') throw new Error('load failed');
      return { AnonRpcWorker: class {
        ready = failure === 'ready' ? Promise.reject(new Error('gateway offline')) : Promise.resolve();
        close() {}
        fetch = async () => { throw new Error('circuit failed'); };
      } };
    });
    const client = viem.createPublicClient({ transport: loaded.policedHttp(RPC, { retryCount: 0,
      fetchFn: async () => { direct++; return Response.json({ result: '0x1' }); } }) });
    await expect(client.getChainId()).rejects.toThrow();
    expect(direct).toBe(0);
  });

  test('aborting during bootstrap cannot send the canceled RPC later', async () => {
    let ready!: () => void;
    let sent = 0;
    const loaded = transport(true, () => ({ AnonRpcWorker: class {
      ready = new Promise<void>(resolve => { ready = resolve; });
      close() {}
      fetch = async () => { sent++; return Response.json({}); };
    } }));
    const abort = new AbortController();
    const pending = loaded.tor.torFetchIfActive()!(RPC, { signal: abort.signal });
    // Wait for bootstrap with a bounded macrotask, leaving test timeouts runnable.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(typeof ready).toBe('function');
    abort.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    ready();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toBe(0);
  });
});

test('an RPC body still arrives when Request has no .body (React Native whatwg-fetch)', async () => {
  const RealRequest = globalThis.Request;
  class PolyfillRequest extends RealRequest {
    // whatwg-fetch keeps the body in _bodyInit and never defines `.body`.
    override get body() { return null; }
  }
  globalThis.Request = PolyfillRequest as typeof Request;
  try {
    const received: (string | null)[] = [];
    const loaded = transport(true, () => ({ AnonRpcWorker: class {
      ready = Promise.resolve();
      close() {}
      fetch = async (_url: string, init?: RequestInit) => {
        received.push(init?.body ? new TextDecoder().decode(init.body as Uint8Array) : null);
        return Response.json({ result: '0x1' });
      };
    } }));
    const send = loaded.tor.torFetchIfActive()!;
    await send(MAINNET, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' });
    await send(MAINNET, { method: 'GET' });
    expect(received).toEqual(['{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}', null]);
  } finally {
    globalThis.Request = RealRequest;
  }
});

test('the worker gets the specifier, the gateway config, and a direct bootstrap read that passes the allowlist', async () => {
  policy.setEgressMode('enforce');
  let init!: { address: string; config: unknown; preExisting: { rpcProvider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } } };
  const loaded = transport(true, () => ({ AnonRpcWorker: class {
    ready = Promise.resolve();
    constructor(value: typeof init) { init = value; }
    close() {}
    fetch = async (_url: string, request?: RequestInit) => Response.json({ result: new TextDecoder().decode(request?.body as Uint8Array) });
  } }));
  const reply = await loaded.tor.torFetchIfActive()!(MAINNET, { method: 'POST', body: '{"id":1}' });
  expect(await reply.json()).toEqual({ result: '{"id":1}' });
  expect(init.address).toBe('0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e');
  expect(init.config).toEqual({ gateways: [GATEWAY] });

  const realFetch = globalThis.fetch;
  const sent: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, request?: RequestInit) => {
    sent.push({ url, init: request });
    return Response.json({ jsonrpc: '2.0', id: 1, result: '0xabc' });
  }) as typeof fetch;
  try {
    const call = { method: 'eth_call', params: [{ to: init.address, data: '0x9a1a3c5e' }, 'latest'] };
    expect(await init.preExisting.rpcProvider.request(call)).toBe('0xabc');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(MAINNET);
    expect(sent[0].init?.credentials).toBe('omit');
    // A note-keyed read is refused before anything leaves.
    await expect(init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ data: `0x811608fd${'1'.repeat(64)}` }, 'latest'] }))
      .rejects.toBeInstanceOf(policy.EgressRefusedError);
    expect(sent).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a chain list without mainnet (plain staging) still reads the specifier from mainnet', async () => {
  let init!: { preExisting: { rpcProvider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } } };
  const loaded = transport(true, () => ({ AnonRpcWorker: class {
    ready = Promise.resolve();
    constructor(value: typeof init) { init = value; }
    close() {}
    fetch = async () => Response.json({});
  } }), { mainnetInChainList: false });
  await loaded.tor.torFetchIfActive()!(MAINNET, { method: 'POST', body: '{}' });
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => { urls.push(url); return Response.json({ result: '0x' }); }) as typeof fetch;
  try {
    await init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ data: '0x9a1a3c5e' }, 'latest'] });
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(urls).toEqual([ENV_MAINNET]);
});

test('Nox: no gateway, no config, specifier read on Sepolia, and the Test is an eth_chainId over the mixnet', async () => {
  let init!: { address: string; config: unknown; preExisting: { rpcProvider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } } };
  const sent: { url: string; body: unknown }[] = [];
  const loaded = transport(false, () => ({ AnonRpcWorker: class {
    ready = Promise.resolve();
    constructor(value: typeof init) { init = value; }
    close() {}
    fetch = async (url: string, req?: RequestInit) => { sent.push({ url, body: req?.body }); return Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' }); };
  } }), { mainnetInChainList: false });
  expect(await loaded.tor.probeTorGateway('', 5_000, 'nox')).toEqual({ ok: true });
  expect(init.address).toBe('0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A');
  expect(init.config).toBeUndefined();
  expect(sent).toEqual([{ url: loaded.tor.MIXNET_PROBE_URL, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }]);
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => { urls.push(url); return Response.json({ result: '0x' }); }) as typeof fetch;
  try {
    await init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ data: '0x9a1a3c5e' }, 'latest'] }).catch(() => {});
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(urls).toEqual([ENV_SEPOLIA]);
});

test('a mixnet Test fails when the answer is not mainnet', async () => {
  const loaded = transport(false, () => ({ AnonRpcWorker: class {
    ready = Promise.resolve();
    close() {}
    fetch = async () => Response.json({ IsTor: true });
  } }));
  const result = await loaded.tor.probeTorGateway('', 5_000, 'nym');
  expect(result.ok).toBe(false);
});

test('closing during bootstrap fails the specifier reads, so the harness stops before the bundle', async () => {
  let init!: { preExisting: { rpcProvider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } } };
  let release!: () => void;
  const loaded = transport(false, () => ({ AnonRpcWorker: class {
    ready = new Promise<void>(resolve => { release = resolve; });
    constructor(value: typeof init) { init = value; }
    close() {}
    fetch = async () => Response.json({});
  } }));
  const realFetch = globalThis.fetch;
  const signals: AbortSignal[] = [];
  // A read that is still in flight when the form closes, the way the harness
  // issues it right after construction.
  globalThis.fetch = ((_url: string, request?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signals.push(request!.signal!);
    request!.signal!.addEventListener('abort', () => reject(request!.signal!.reason), { once: true });
  })) as typeof fetch;
  try {
    const sender = loaded.tor.createTorFetch(GATEWAY);
    const pending = sender(MAINNET).then(() => null, (error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(typeof release).toBe('function');
    const inFlight = init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ data: '0x9a1a3c5e' }, 'latest'] }).then(() => null, (error: unknown) => error);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    sender.close();
    expect(await pending).toBeInstanceOf(Error);
    expect(await inFlight).toBeInstanceOf(Error);
    expect(signals[0].aborted).toBe(true);
    // And nothing new starts after the close.
    await expect(init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ data: '0x9a1a3c5e' }, 'latest'] })).rejects.toThrow();
    expect(signals).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

for (const provider of settings.TOR_PROVIDERS) test(`${provider.id}: specifier reads enforce the exact pinned hash`, async () => {
  let init!: { address: string; preExisting: { rpcProvider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } } };
  const loaded = transport(true, () => ({ AnonRpcWorker: class {
    ready = Promise.resolve();
    constructor(value: typeof init) { init = value; }
    close() {}
    fetch = async () => Response.json({});
  } }));
  const send = loaded.tor.createTorFetch(GATEWAY, provider.id);
  await send(MAINNET, { method: 'POST', body: '{}' });
  const pinned = provider.workerHash;
  const realFetch = globalThis.fetch;
  let answer: unknown = pinned;
  globalThis.fetch = (async () => Response.json({ result: answer })) as typeof fetch;
  try {
    const read = () => init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ to: init.address.toLowerCase(), data: '0x3898587d' }, 'latest'] });
    expect(await read()).toBe(pinned);
    answer = pinned.toUpperCase();
    expect(await read()).toBe(answer);
    for (const invalid of [`0x${'ab'.repeat(32)}`, pinned.slice(0, -2), `${pinned}00`, null, 1]) {
      answer = invalid;
      await expect(read()).rejects.toThrow('not the one this build accepts');
      await expect(init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ to: init.address, input: '0x3898587d' }, 'latest'] }))
        .rejects.toThrow('not the one this build accepts');
    }
    // Other specifier reads (the resolver list) pass through untouched.
    expect(await init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ to: init.address, data: '0x4e2f8a45' }, 'latest'] })).toBe(answer);
  } finally {
    globalThis.fetch = realFetch;
    send.close();
  }
});

for (const provider of settings.TOR_PROVIDERS) test(`${provider.id}: a rejected pin fails startup without sending the RPC and explains why`, async () => {
  const calls: string[] = [];
  let closed = 0;
  let relayed = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return Response.json({ result: `0x${'ab'.repeat(32)}` });
  }) as typeof fetch;
  try {
    const loaded = transport(false, () => ({ AnonRpcWorker: class {
      ready: Promise<void>;
      constructor(init: { address: string; preExisting: { rpcProvider: { request: (args: unknown) => Promise<unknown> } } }) {
        this.ready = init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ to: init.address, data: '0x3898587d' }, 'latest'] }).then(() => {});
      }
      close() { closed++; }
      fetch = async () => { relayed++; return Response.json({}); };
    } }));
    const result = await loaded.tor.probeTorGateway(GATEWAY, 5_000, provider.id);
    expect(result).toEqual({ ok: false, message: 'The anon-rpc client named on-chain is not the one this build accepts.' });
    expect(calls).toEqual([provider.specifierChainId === 1 ? MAINNET : ENV_SEPOLIA]);
    expect(relayed).toBe(0);
    expect(closed).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

for (const from of ['registry', 'override'] as const) test(`Nox bootstraps from the Sepolia ${from}`, async () => {
  const url = 'https://sepolia.example/';
  const options = from === 'registry' ? { chainUrls: { 11155111: url } } : { customRpcUrls: { 11155111: url } };
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (endpoint: string) => { calls.push(endpoint); return Response.json({ result: settings.torProvider('nox')!.workerHash }); }) as typeof fetch;
  try {
    const loaded = transport(false, () => ({ AnonRpcWorker: class {
      ready: Promise<void>;
      constructor(init: { address: string; preExisting: { rpcProvider: { request: (args: unknown) => Promise<unknown> } } }) {
        this.ready = init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ to: init.address, data: '0x3898587d' }, 'latest'] }).then(() => {});
      }
      close() {}
      fetch = async () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' });
    } }), options);
    expect(await loaded.tor.probeTorGateway('', 5_000, 'nox')).toEqual({ ok: true });
    expect(calls).toEqual([url]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

for (const provider of ['nym', 'nox'] as const) {
  test(`${provider}: a failed probe does not ask for a gateway`, async () => {
    let closed = 0;
    const loaded = transport(false, () => ({ AnonRpcWorker: class {
      ready = Promise.resolve();
      close() { closed++; }
      fetch = async () => { throw new Error('offline'); };
    } }));
    expect(await loaded.tor.probeTorGateway('', 5_000, provider)).toEqual({ ok: false, message: 'Could not reach the anon-rpc network.' });
    expect(closed).toBe(1);
  });

  test(`${provider}: only a valid JSON-RPC probe response succeeds in enforce mode`, async () => {
    const previous = policy.getEgressMode();
    policy.setEgressMode('enforce');
    let answer: unknown;
    const loaded = transport(false, () => ({ AnonRpcWorker: class {
      ready = Promise.resolve();
      close() {}
      fetch = async () => Response.json(answer);
    } }));
    try {
      for (const invalid of [null, { result: '0x1' }, { jsonrpc: '2.0', id: 2, result: '0x1' }, { jsonrpc: '2.0', id: 1, result: '0x1', error: { code: -1 } }]) {
        answer = invalid;
        expect((await loaded.tor.probeTorGateway('', 5_000, provider)).ok).toBe(false);
      }
      answer = { jsonrpc: '2.0', id: 1, result: '0x1' };
      expect(await loaded.tor.probeTorGateway('', 5_000, provider)).toEqual({ ok: true });
    } finally {
      policy.setEgressMode(previous);
    }
  });
}

test('canceling a connection Test during startup closes its worker and sends no late probe', async () => {
  let ready!: () => void;
  let started!: () => void;
  const startup = new Promise<void>(resolve => { started = resolve; });
  let closed = 0;
  let sent = 0;
  const loaded = transport(false, () => ({ AnonRpcWorker: class {
    ready = new Promise<void>(resolve => { ready = resolve; });
    constructor() { started(); }
    close() { closed++; }
    fetch = async () => { sent++; return Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' }); };
  } }));
  const controller = new AbortController();
  const pending = loaded.tor.probeTorGateway('', 5_000, 'nym', undefined, controller.signal);
  await startup;
  controller.abort();
  expect((await pending).ok).toBe(false);
  ready();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sent).toBe(0);
  expect(closed).toBe(1);
});

test('canceling a Test when ready cannot start its outbound probe', async () => {
  let sent = 0;
  const loaded = transport(false, () => ({ AnonRpcWorker: class {
    ready = Promise.resolve();
    close() {}
    fetch = async () => { sent++; return Response.json({}); };
  } }));
  const controller = new AbortController();
  const result = await loaded.tor.probeTorGateway('', 5_000, 'nox', (step) => {
    if (step === 'checking') controller.abort();
  }, controller.signal);
  expect(result.ok).toBe(false);
  expect(sent).toBe(0);
});

test('a specifier response that finishes after cancellation cannot continue bootstrap', async () => {
  let init!: { address: string; preExisting: { rpcProvider: { request: (args: unknown) => Promise<unknown> } } };
  const loaded = transport(false, () => ({ AnonRpcWorker: class {
    ready = Promise.resolve();
    constructor(value: typeof init) { init = value; }
    close() {}
    fetch = async () => Response.json({});
  } }));
  const send = loaded.tor.createTorFetch('', 'nym');
  await send(MAINNET);
  const realFetch = globalThis.fetch;
  let finishBody!: (reply: unknown) => void;
  let reading!: () => void;
  const readingBody = new Promise<void>(resolve => { reading = resolve; });
  // A response body already delivered by a fetch implementation can settle
  // even after its abort signal fires.
  globalThis.fetch = (async () => Object.assign(new Response('{}'), { json: () => {
    reading();
    return new Promise(resolve => { finishBody = resolve; });
  } })) as typeof fetch;
  try {
    const pending = init.preExisting.rpcProvider.request({ method: 'eth_call', params: [{ to: init.address, data: '0x4e2f8a45' }, 'latest'] });
    await readingBody;
    send.close();
    finishBody({ result: '0x' });
    await expect(pending).rejects.toThrow('closed');
  } finally {
    globalThis.fetch = realFetch;
    send.close();
  }
});

test('an abort after the headers still ends the body, and a pending request body cannot block it', async () => {
  let upstreamCancelled = false;
  const loaded = transport(true, () => ({ AnonRpcWorker: class {
    ready = Promise.resolve();
    close() {}
    fetch = async () => new Response(new ReadableStream<Uint8Array>({ cancel() { upstreamCancelled = true; } }));
  } }));
  const send = loaded.tor.torFetchIfActive()!;
  const abort = new AbortController();
  const response = await send(MAINNET, { method: 'POST', body: '{}', signal: abort.signal });
  const text = response.text();
  abort.abort(new Error('timed out'));
  await expect(text).rejects.toThrow('timed out');
  expect(upstreamCancelled).toBe(true);

  const stalled = new AbortController();
  const neverEnds = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); } });
  const blocked = send(MAINNET, { method: 'POST', body: neverEnds, signal: stalled.signal, duplex: 'half' } as RequestInit);
  await new Promise(resolve => setTimeout(resolve, 0));
  stalled.abort(new Error('closed'));
  await expect(blocked).rejects.toThrow('closed');
});

// A worker whose acceptLog() hands over `lines` in order, then waits for the
// caller's signal; `ready` resolves once every line has been taken.
function loggingWorker(lines: string[], reads = { calls: 0, stopped: 0 }) {
  return class {
    #queue = [...lines];
    #drained!: () => void;
    ready = new Promise<void>((resolve) => { this.#drained = resolve; });
    close() {}
    fetch = async () => Response.json({ IsTor: true });
    acceptLog({ signal }: { signal: AbortSignal }): Promise<{ args: unknown[] }> {
      reads.calls++;
      const line = this.#queue.shift();
      if (line !== undefined) return Promise.resolve({ args: [line] });
      this.#drained();
      return new Promise((_, reject) => signal.addEventListener('abort', () => { reads.stopped++; reject(signal.reason); }, { once: true }));
    }
  };
}

test('a Test reports its steps in order, from our phases and the worker log, and stops reading it after', async () => {
  const reads = { calls: 0, stopped: 0 };
  const loaded = transport(false, () => ({ AnonRpcWorker: loggingWorker([
    '[00.086] [tor_js::fast_bootstrap] Fast bootstrap: fetching bootstrap.zip...',
    '[00.821] [tor_dirmgr::bootstrap] 1: Downloading microdescriptors (we are missing 9421)., attempt = 1',
    '[00.300] Fast bootstrap: fetching bootstrap.zip.zst...', // late: must not rewind
    '[09.288] [tor_dirmgr] We have enough information to build circuits.',
  ], reads) }));
  const steps: string[] = [];
  const result = await loaded.tor.probeTorGateway(GATEWAY, 5_000, 'tor-js', (step) => steps.push(step));
  expect(result).toEqual({ ok: true });
  expect(steps).toEqual(['loading', 'specifier', 'starting', 'directory', 'relays', 'circuit', 'checking']);
  expect(reads.stopped).toBe(1);
  for (const step of steps) expect(loaded.tor.TOR_PROBE_STEP_TEXT[step as keyof typeof loaded.tor.TOR_PROBE_STEP_TEXT]).toBeTruthy();
});

test('on a device the provider and the Test name Tor, not tor-js', () => {
  const device = load('config/tor.ts', {
    process: { env: {} },
    navigator: { product: 'ReactNative' },
    require(name: string) {
      if (name === 'react-native') return { Platform: { OS: 'ios' } };
      throw new Error(`Unexpected dependency ${name}`);
    },
  }) as typeof settings;
  expect(device.TOR_ON_DEVICE).toBe(true);
  expect(device.TOR_PROVIDERS.map(p => [p.id, p.label])).toEqual([['tor-js', 'Tor']]);
  expect(settings.TOR_PROVIDERS.map(p => [p.id, p.label])).toEqual([['tor-js', 'tor-js'], ['nym', 'Nym'], ['nox', 'Nox (demo)']]);
  // Nym and Nox are anon-rpc workers; a device runs Arti, so a saved choice
  // naming either reads as off there rather than running something else.
  for (const provider of ['nym', 'nox']) {
    expect(device.torProvider(provider)).toBeUndefined();
    expect(device.parseTorSettings(JSON.stringify({ enabled: true, gatewayUrl: '', provider }))).toEqual(device.TOR_OFF);
  }
  const deviceTor = load('services/tor-fetch.ts', { require(name: string) {
    if (name === '@/config/tor') return device;
    if (name === '@/services/egress-policy') return policy;
    throw new Error(`Unexpected dependency ${name}`);
  } }) as typeof import('../tor-fetch');
  expect(deviceTor.TOR_PROBE_STEP_TEXT.starting).toBe('Starting Tor');
  expect(transport(false, () => ({})).tor.TOR_PROBE_STEP_TEXT.starting).toBe('Starting the client');
});

test('overlapping Tests each follow only their own worker log', async () => {
  const workers = [
    loggingWorker(['Downloading microdescriptors (we are missing 1)']),
    loggingWorker(['We have enough information to build circuits.']),
  ];
  const loaded = transport(false, () => ({ AnonRpcWorker: workers.shift() }));
  const a: string[] = [];
  const b: string[] = [];
  await Promise.all([
    loaded.tor.probeTorGateway(GATEWAY, 5_000, 'tor-js', (s) => a.push(s)),
    loaded.tor.probeTorGateway(GATEWAY, 5_000, 'tor-js', (s) => b.push(s)),
  ]);
  expect({ a, b }).toEqual({
    a: ['loading', 'specifier', 'starting', 'relays', 'checking'],
    b: ['loading', 'specifier', 'starting', 'circuit', 'checking'],
  });
});

test('the app client (no Test) never reads the worker log', async () => {
  const reads = { calls: 0, stopped: 0 };
  const Worker = loggingWorker([], reads);
  const loaded = transport(true, () => ({ AnonRpcWorker: class extends Worker {
    ready = Promise.resolve();
    fetch = async () => Response.json({ result: '0x1' });
  } }));
  await loaded.tor.torFetchIfActive()!(MAINNET, { method: 'POST', body: '{}' });
  expect(reads.calls).toBe(0);
});

test('the tor-js package is gone; anon-rpc fetches the client by hash instead', () => {
  const pkg = JSON.parse(source('package.json')) as { dependencies: Record<string, string> };
  expect(pkg.dependencies['tor-js']).toBeUndefined();
  expect(pkg.dependencies['@0xbow/anon-rpc-rs-browser-harness']).toBeDefined();
});

test('the anon-rpc harness is reachable only through the transport dynamic import', () => {
  const references: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(new URL(`${dir}/`, root), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (!entry.name.startsWith('__')) walk(path); continue; }
      if (!/\.[jt]sx?$/.test(entry.name)) continue;
      const ast = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, path.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      function visit(node: ts.Node) {
        if (ts.isStringLiteral(node) && /^(?:@0xbow\/anon-rpc-rs-browser-harness|@0xbow\/anon-rpc-rs-react-native)(?:\/|$)/.test(node.text)) {
          references.push(path);
          expect(ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword).toBe(true);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  for (const dir of ['app', 'components', 'config', 'hooks', 'services']) walk(dir);
  expect(references).toEqual(['services/tor-fetch.ts', 'services/tor-fetch.ts']);
});

test('closing a draft sender cancels bootstrap, releases the client, and never sends later', async () => {
  let ready!: () => void;
  let sent = 0;
  let closed = 0;
  const loaded = transport(false, () => ({ AnonRpcWorker: class {
    ready = new Promise<void>(resolve => { ready = resolve; });
    close() { closed++; }
    fetch = async () => { sent++; return Response.json({}); };
  } }));
  const sender = loaded.tor.createTorFetch(GATEWAY);
  const pending = sender('https://rpc.example');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(typeof ready).toBe('function');
  sender.close();
  await expect(pending).rejects.toThrow();
  ready();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sent).toBe(0);
  expect(closed).toBe(1);
  await expect(sender('https://rpc.example')).rejects.toThrow('closed');
});

describe('a proxy address is refused with its own reason', () => {
  test('socks5h, the one Arti prints, says why rather than complaining about format', () => {
    // A browser cannot dial SOCKS from a page: fetch, WebSocket and WebRTC are
    // all it has. That gap is why a gateway exists at all, so the message has
    // to explain it rather than just reject the shape.
    const result = settings.validateTorGateway('socks5h://127.0.0.1:9150');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('proxy');
    expect(result.ok === false && result.message).toContain('a web page cannot open');
  });

  test('every scheme is caught, not just socks', () => {
    for (const value of ['socks5://127.0.0.1:9050', 'http://localhost:8545', 'https://my-gateway.example', 'ws://127.0.0.1:12298']) {
      const result = settings.validateTorGateway(value);
      expect({ value, reason: result.ok === false && result.reason }).toEqual({ value, reason: 'proxy' });
    }
  });

  test('a real KPS address is still accepted', () => {
    // The guard must not swallow the thing it is meant to let through. A KPS
    // address carries no scheme, so the two cannot be confused.
    const gateway = `127.0.0.1:12298:u${Buffer.from([0x12, 0x20, ...new Array(32).fill(0)]).toString('base64url')}`;
    expect(settings.validateTorGateway(gateway)).toEqual({ ok: true, url: gateway });
  });
});
