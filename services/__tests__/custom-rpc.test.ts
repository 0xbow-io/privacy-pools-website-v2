// Custom RPC endpoints (config/custom-rpc.ts): the URL validator, the stored
// per-chain map and the resolution the config layer bakes in at module load.
// The module is PURE, so everything here runs without a DOM.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CUSTOM_RPC_STORAGE_KEY,
  customRpcUrlFor,
  parseCustomRpcOverrides,
  readCustomRpcOverrides,
  resolveChainRpcUrls,
  serializeCustomRpcOverrides,
  validateCustomRpcUrl,
  type StorageLike,
  withCustomRpc,
  writeCustomRpcOverrides,
  deriveSiblingRpcUrls,
  detectRpcProvider,
  probeRpcUrl,
  RPC_PROBE_MESSAGES,
  queryableChainIds,
  skippedChainIds,
  hasCustomRpcOverride,
} from '@/config/custom-rpc';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe('validateCustomRpcUrl: accepted', () => {
  const accepted: [string, string][] = [
    ['a plain https endpoint', 'https://rpc.example.com'],
    ['https with a path', 'https://rpc.example.com/v2/abcdef'],
    ['https with a port', 'https://rpc.example.com:8545'],
    ['https with a query (many providers key on one)', 'https://rpc.example.com/rpc?apikey=abc123'],
    ['http on localhost', 'http://localhost:8545'],
    ['http on 127.0.0.1', 'http://127.0.0.1:8545'],
    ['http on the IPv6 loopback', 'http://[::1]:8545'],
    ['http on a .localhost subdomain', 'http://anvil.localhost:8545'],
  ];
  for (const [label, url] of accepted) {
    test(label, () => {
      expect(validateCustomRpcUrl(url)).toEqual({ ok: true, url });
    });
  }

  test('surrounding whitespace is trimmed, not rejected', () => {
    expect(validateCustomRpcUrl('  https://rpc.example.com  ')).toEqual({
      ok: true,
      url: 'https://rpc.example.com',
    });
  });
});

describe('validateCustomRpcUrl: rejected', () => {
  const rejected: [string, string | null | undefined, string][] = [
    ['nothing at all', '', 'empty'],
    ['whitespace only', '   ', 'empty'],
    ['null', null, 'empty'],
    ['undefined', undefined, 'empty'],
    ['a bare hostname', 'rpc.example.com', 'unparseable'],
    ['a path with no scheme', '/rpc', 'unparseable'],
    ['a sentence', 'my node please', 'unparseable'],
    // `new URL` normalises both of these into a valid https URL, but the SDK's
    // own RpcUrlSchema requires "://", so they passed here and threw after the
    // reload. Refused in the canonical form check instead of normalised, so
    // what is stored is exactly what was checked.
    ['https: with no slashes', 'https:rpc.example.com', 'scheme'],
    ['https:/ with one slash', 'https:/rpc.example.com', 'scheme'],
    ['plain http off localhost', 'http://rpc.example.com', 'scheme'],
    ['http on a host merely NAMED like localhost', 'http://localhost.evil.example', 'scheme'],
    ['a websocket endpoint (viem http() cannot use it)', 'wss://rpc.example.com', 'scheme'],
    ['javascript:', 'javascript:alert(1)', 'scheme'],
    ['data:', 'data:text/plain,hi', 'scheme'],
    ['file:', 'file:///etc/hosts', 'scheme'],
    ['credentials in the URL', 'https://user:secret@rpc.example.com', 'credentials'],
    ['a username alone', 'https://user@rpc.example.com', 'credentials'],
  ];
  for (const [label, url, reason] of rejected) {
    test(`${label} is refused (${reason})`, () => {
      const result = validateCustomRpcUrl(url);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(reason as never);
      // Every refusal carries something to show the user.
      expect(result.message.length).toBeGreaterThan(0);
    });
  }

  test('no message uses an em dash (house rule for user-facing copy)', () => {
    for (const [, url] of rejected) {
      const result = validateCustomRpcUrl(url);
      if (result.ok) continue;
      expect(result.message).not.toContain('—');
    }
  });
});

describe('parseCustomRpcOverrides', () => {
  test('reads a per-chain map, keyed by number', () => {
    expect(parseCustomRpcOverrides('{"1":"https://a.example","11155111":"https://b.example"}')).toEqual({
      1: 'https://a.example',
      11155111: 'https://b.example',
    });
  });

  test('a missing, empty or malformed blob means no overrides', () => {
    expect(parseCustomRpcOverrides(null)).toEqual({});
    expect(parseCustomRpcOverrides(undefined)).toEqual({});
    expect(parseCustomRpcOverrides('')).toEqual({});
    expect(parseCustomRpcOverrides('not json')).toEqual({});
    expect(parseCustomRpcOverrides('[]')).toEqual({});
    expect(parseCustomRpcOverrides('"https://a.example"')).toEqual({});
    expect(parseCustomRpcOverrides('null')).toEqual({});
  });

  test('entries storage could hold but the form would never accept are dropped', () => {
    // Storage is writable by anything on the origin: a value that skipped the
    // validator must not become the endpoint every call goes to.
    const raw = JSON.stringify({
      1: 'http://rpc.evil.example',
      10: 'https://user:pw@rpc.example.com',
      56: 'not a url',
      137: 42,
      nan: 'https://ok.example',
      '-5': 'https://ok.example',
      11155111: 'https://good.example',
    });
    expect(parseCustomRpcOverrides(raw)).toEqual({ 11155111: 'https://good.example' });
  });

  test('round-trips through serialize', () => {
    const overrides = { 1: 'https://a.example', 4114: 'https://b.example/rpc' };
    expect(parseCustomRpcOverrides(serializeCustomRpcOverrides(overrides))).toEqual(overrides);
  });
});

describe('withCustomRpc', () => {
  test('sets one chain without touching the others', () => {
    const before = { 1: 'https://a.example' };
    const after = withCustomRpc(before, 11155111, 'https://b.example');
    expect(after).toEqual({ 1: 'https://a.example', 11155111: 'https://b.example' });
    expect(before).toEqual({ 1: 'https://a.example' }); // input untouched
  });

  test('null clears one chain and leaves the rest', () => {
    const after = withCustomRpc({ 1: 'https://a.example', 10: 'https://b.example' }, 1, null);
    expect(after).toEqual({ 10: 'https://b.example' });
  });

  test('trims on the way in', () => {
    expect(withCustomRpc({}, 1, '  https://a.example ')).toEqual({ 1: 'https://a.example' });
  });

  test('refuses an invalid URL rather than storing it', () => {
    const before = { 1: 'https://a.example' };
    expect(withCustomRpc(before, 10, 'http://rpc.evil.example')).toEqual(before);
    expect(withCustomRpc(before, 10, '')).toEqual(before);
  });
});

describe('resolution', () => {
  const overrides = { 11155111: 'https://mine.example/rpc' };
  const ours = ['https://alchemy.example/v2/key', 'https://public.example'];

  test('a chain with an override uses it, and ONLY it', () => {
    // Exclusive by design: keeping our endpoints behind it as fallbacks would
    // send a share of the traffic to the provider the user opted out of.
    expect(resolveChainRpcUrls(overrides, 11155111, ours)).toEqual(['https://mine.example/rpc']);
  });

  test('a chain without one keeps the configured order', () => {
    expect(resolveChainRpcUrls(overrides, 1, ours)).toEqual(ours);
    expect(customRpcUrlFor(overrides, 1)).toBeUndefined();
  });

  test('the returned list is a copy, so a consumer cannot mutate the config', () => {
    const resolved = resolveChainRpcUrls({}, 1, ours);
    resolved.push('https://sneaky.example');
    expect(ours).toHaveLength(2);
  });
});

/**
 * The pure core of config/chains.ts's `usesCustomRpc` — the privacy split
 * deciding whether a chain's wallet holdings are read through the user's own
 * RPC instead of being sent to Alchemy. `usesCustomRpc` cannot be exercised by
 * `bun test` itself (config/chains pulls react-native in), so the reasoning
 * lives here and that function only wraps it.
 */
describe('hasCustomRpcOverride', () => {
  const overrides = { 11155111: 'https://mine.example/rpc' };

  test('true for a chain the user pointed at their own endpoint', () => {
    expect(hasCustomRpcOverride(overrides, 11155111)).toBe(true);
  });

  test('false for a chain still on our endpoints', () => {
    expect(hasCustomRpcOverride(overrides, 1)).toBe(false);
  });

  test('false for every chain when nothing is overridden', () => {
    expect(hasCustomRpcOverride({}, 11155111)).toBe(false);
  });
});

describe('storage round trip', () => {
  test('write then read gives back the same map', () => {
    const storage = memoryStorage();
    expect(writeCustomRpcOverrides(storage, { 1: 'https://a.example' })).toBe(true);
    expect(storage.map.get(CUSTOM_RPC_STORAGE_KEY)).toBe('{"1":"https://a.example"}');
    expect(readCustomRpcOverrides(storage)).toEqual({ 1: 'https://a.example' });
  });

  test('clearing the last chain drops the key entirely', () => {
    const storage = memoryStorage({ [CUSTOM_RPC_STORAGE_KEY]: '{"1":"https://a.example"}' });
    const cleared = withCustomRpc(readCustomRpcOverrides(storage), 1, null);
    expect(writeCustomRpcOverrides(storage, cleared)).toBe(true);
    expect(storage.map.has(CUSTOM_RPC_STORAGE_KEY)).toBe(false);
    expect(readCustomRpcOverrides(storage)).toEqual({});
  });

  test('a second tab that saved another chain is not clobbered', () => {
    // The write must merge into what storage holds NOW, not into the page's
    // startup snapshot, or a save here deletes an override made elsewhere.
    const storage = memoryStorage();
    writeCustomRpcOverrides(storage, { 1: 'https://a.example' });
    const snapshotAtPageLoad = readCustomRpcOverrides(storage);
    // …another tab sets one for Sepolia…
    writeCustomRpcOverrides(storage, { ...snapshotAtPageLoad, 11155111: 'https://b.example' });
    // …and this tab now saves one for Citrea, re-reading first.
    writeCustomRpcOverrides(storage, withCustomRpc(readCustomRpcOverrides(storage), 4114, 'https://c.example'));
    expect(readCustomRpcOverrides(storage)).toEqual({
      1: 'https://a.example',
      11155111: 'https://b.example',
      4114: 'https://c.example',
    });
  });

  test('a refused write reports failure rather than looking saved', () => {
    // A silent failure plus the caller's reload would land the user back on
    // the endpoint they just tried to change, with no explanation.
    expect(readCustomRpcOverrides(null)).toEqual({});
    expect(readCustomRpcOverrides(undefined)).toEqual({});
    expect(writeCustomRpcOverrides(null, { 1: 'https://a.example' })).toBe(false);
    const throwing = {
      getItem: () => { throw new Error('site data disabled'); },
      setItem: () => { throw new Error('site data disabled'); },
      removeItem: () => { throw new Error('site data disabled'); },
    };
    expect(readCustomRpcOverrides(throwing)).toEqual({});
    expect(writeCustomRpcOverrides(throwing, { 1: 'https://a.example' })).toBe(false);
    expect(writeCustomRpcOverrides(throwing, {})).toBe(false);
  });
});

// ---- containment: where a user's endpoint is allowed to appear ----

// `import.meta.url` rather than Bun's `import.meta.dir`: the app's tsconfig
// does not model the Bun extension and the typecheck gate fails on it.
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const SCANNED_DIRS = ['config', 'services', 'components', 'hooks', 'app'];
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__fixtures__', 'dist']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('privacy: a custom endpoint stays between storage, the form and viem', () => {
  // The URL a user types names the provider they chose and often carries that
  // provider's API key. It must reach viem and nothing else: not the ASP, not
  // the relayer, not a query string. Keeping the consumer set small is what
  // makes that checkable, so this fails on a NEW importer rather than trying to
  // recognise every way a value could be exfiltrated.
  const ALLOWED = new Set([
    'config/chains.ts', // bakes it into the chain records the transports read
    'components/custom-rpc-modal-provider.tsx', // the form itself
    'components/ui/header.tsx', // the menu label ("in force" indicator)
  ]);

  test('only the config layer, the modal and the header read the override', () => {
    const importers: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === 'config/custom-rpc.ts') continue;
        if (/from '@\/config\/custom-rpc'/.test(readFileSync(file, 'utf8'))) importers.push(rel);
      }
    }
    expect(importers.filter((f) => !ALLOWED.has(f))).toEqual([]);
    // And the wiring is really there: a silently dropped import would leave
    // the setting stored but never applied.
    expect(importers.sort()).toEqual([...ALLOWED].sort());
  });

  test('config/chains.ts applies it to the chain records', () => {
    const source = readFileSync(join(ROOT, 'config', 'chains.ts'), 'utf8');
    expect(source).toContain('activeCustomRpcUrl');
    // Exclusive, and both fields move together: rpcUrls must keep starting
    // with rpcUrl (the ChainConfig invariant).
    expect(source).toContain('rpcUrl: custom, rpcUrls: [custom]');
  });

  test('the wallet add-chain parameters offer OUR endpoints, never the user\'s', () => {
    // wallet_addEthereumChain hands the list to an external wallet (and through
    // WalletConnect, its relay), which stores it. The custom endpoint is the
    // one thing in the chain record that must not go.
    const source = readFileSync(join(ROOT, 'components', 'chain-provider.tsx'), 'utf8');
    expect(source).toContain('configuredRpcUrls: getPresetRpcUrls(chainId)');
    expect(source).not.toContain('configuredRpcUrls: getChainConfig(chainId)?.rpcUrls');
  });

  test('the URL field is exempt from the debug clickstream, which records every other input', () => {
    const modal = readFileSync(join(ROOT, 'components', 'custom-rpc-modal-provider.tsx'), 'utf8');
    // Every row carries the prefix, and the form has exactly as many URL
    // inputs as it has exempted ids: a row added without the prefix would
    // start recording that endpoint into an exportable buffer.
    const inputs = modal.match(/<TextInput/g) ?? [];
    const exempt = modal.match(/nativeID=\{`\$\{SENSITIVE_INPUT_ID_PREFIX\}/g) ?? [];
    expect(inputs.length).toBeGreaterThan(0);
    expect(exempt.length).toBe(inputs.length);
    const debug = readFileSync(join(ROOT, 'components', 'debug-provider.tsx'), 'utf8');
    expect(debug).toContain('const sensitive = el.id.startsWith(SENSITIVE_INPUT_ID_PREFIX);');
    // The value must be replaced, not merely truncated: the ring buffer is
    // exportable and a short keyed URL fits well inside the 60-char slice.
    expect(debug).toContain("const value = sensitive ? '(hidden)'");
  });

  test('the endpoint never rides the APP\'s own URL', () => {
    const source = readFileSync(join(ROOT, 'config', 'custom-rpc.ts'), 'utf8');
    // config/app-environment.ts deliberately has a `?env=` escape hatch; this
    // module deliberately has none, because the value would land in history,
    // in a shared link and in the referrer of anything the page loads.
    //
    // Asserted as "never navigates anywhere but a plain reload" rather than
    // "never touches searchParams": the prefill rewrites a query parameter of
    // the USER'S OWN endpoint (dRPC keys its network that way), which is a
    // different thing entirely and a blanket ban on searchParams would have
    // banned it.
    for (const forbidden of [
      'location.href =',
      'location.search',
      'location.assign',
      'location.replace',
      'history.pushState',
      'history.replaceState',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('window.location.reload()');
  });
});

describe('provider prefill', () => {
  // An RPC endpoint answers for ONE chain, so the form asks per chain and the
  // tedium is real: one key, six near-identical URLs. Derivation removes the
  // tedium without guessing, which means it must refuse more often than it
  // helps.
  const CHAINS = [1, 11155111, 10, 42161, 8453, 56, 4114];

  test('recognises the providers whose per-chain form is a token swap', () => {
    expect(detectRpcProvider('https://eth-mainnet.g.alchemy.com/v2/KEY')).toBe('alchemy');
    expect(detectRpcProvider('https://rpc.ankr.com/eth/KEY')).toBe('ankr');
    expect(detectRpcProvider('https://lb.drpc.org/ogrpc?network=ethereum&dkey=KEY')).toBe('drpc');
    expect(detectRpcProvider('http://fullnode.dappnode:8545')).toBe('dappnode');
    expect(detectRpcProvider('https://my-node.example/rpc')).toBeUndefined();
    expect(detectRpcProvider('not a url')).toBeUndefined();
  });

  test('a lookalike host is not the provider', () => {
    // The check is on the parsed hostname, so a provider name appearing
    // elsewhere in the URL must not match.
    expect(detectRpcProvider('https://g.alchemy.com.evil.test/v2/KEY')).toBeUndefined();
    expect(detectRpcProvider('https://evil.test/rpc.ankr.com/eth')).toBeUndefined();
  });

  test('derives the siblings it can name, and omits the ones it cannot', () => {
    const derived = deriveSiblingRpcUrls('https://eth-mainnet.g.alchemy.com/v2/KEY', 1, CHAINS);
    expect(derived[10]).toBe('https://opt-mainnet.g.alchemy.com/v2/KEY');
    expect(derived[8453]).toBe('https://base-mainnet.g.alchemy.com/v2/KEY');
    expect(derived[11155111]).toBe('https://eth-sepolia.g.alchemy.com/v2/KEY');
    // Never itself, and never a chain the provider has no token for.
    expect(derived[1]).toBeUndefined();
    expect(derived[4114]).toBeUndefined();
  });

  test('rewrites the path for ankr and the query for drpc, leaving the key alone', () => {
    expect(deriveSiblingRpcUrls('https://rpc.ankr.com/eth/SECRET', 1, [10])[10])
      .toBe('https://rpc.ankr.com/optimism/SECRET');
    expect(deriveSiblingRpcUrls('https://lb.drpc.org/ogrpc?network=ethereum&dkey=SECRET', 1, [56])[56])
      .toBe('https://lb.drpc.org/ogrpc?network=bsc&dkey=SECRET');
  });

  test('derives nothing when the URL does not carry the source chain\'s own token', () => {
    // Pasting an Arbitrum URL into the Ethereum row is a mistake. Propagating
    // it to five more chains would turn one mistake into six.
    expect(deriveSiblingRpcUrls('https://arb-mainnet.g.alchemy.com/v2/KEY', 1, CHAINS)).toEqual({});
    expect(deriveSiblingRpcUrls('https://rpc.ankr.com/arbitrum/KEY', 1, CHAINS)).toEqual({});
  });

  test('derives nothing for a provider with no per-chain pattern, or none at all', () => {
    expect(deriveSiblingRpcUrls('http://fullnode.dappnode:8545', 1, CHAINS)).toEqual({});
    expect(deriveSiblingRpcUrls('https://my-node.example/rpc', 1, CHAINS)).toEqual({});
    // A chain the provider does not serve cannot be a source either.
    expect(deriveSiblingRpcUrls('https://eth-mainnet.g.alchemy.com/v2/K', 4114, CHAINS)).toEqual({});
  });

  test('every derived URL is put through the same validator a typed one is', () => {
    // Prefill must not be a way to introduce a value the form would refuse.
    const derived = deriveSiblingRpcUrls('https://eth-mainnet.g.alchemy.com/v2/KEY', 1, CHAINS);
    for (const url of Object.values(derived)) {
      expect(validateCustomRpcUrl(url).ok).toBe(true);
    }
  });
});

describe('the reachability probe', () => {
  const rpcResponse = (body: unknown, ok = true) =>
    ({ ok, json: async () => body }) as unknown as Response;

  test('accepts an endpoint that answers for the chain it was typed into', async () => {
    const fetchImpl = (async () => rpcResponse({ result: '0x1' })) as unknown as typeof fetch;
    expect(await probeRpcUrl('https://n.example', 1, { fetchImpl })).toEqual({ outcome: 'ok', chainId: 1 });
  });

  test('catches the mistake the form invites: the right URL in the wrong row', async () => {
    const fetchImpl = (async () => rpcResponse({ result: '0x1' })) as unknown as typeof fetch;
    expect(await probeRpcUrl('https://n.example', 8453, { fetchImpl }))
      .toEqual({ outcome: 'wrong-chain', chainId: 1 });
  });

  test('distinguishes unreachable, non-RPC and timed out', async () => {
    const dead = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    expect((await probeRpcUrl('https://n.example', 1, { fetchImpl: dead })).outcome).toBe('unreachable');

    const html = (async () => rpcResponse('<html>', true)) as unknown as typeof fetch;
    expect((await probeRpcUrl('https://n.example', 1, { fetchImpl: html })).outcome).toBe('bad-response');

    const notOk = (async () => rpcResponse({ result: '0x1' }, false)) as unknown as typeof fetch;
    expect((await probeRpcUrl('https://n.example', 1, { fetchImpl: notOk })).outcome).toBe('bad-response');

    const hang = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
    expect((await probeRpcUrl('https://n.example', 1, { fetchImpl: hang, timeoutMs: 5 })).outcome).toBe('timeout');
  });

  test('a malformed chain id is not coerced into a wrong answer', async () => {
    for (const result of ['1', '0x', '0xzz', '', null, 42, '0x0']) {
      const fetchImpl = (async () => rpcResponse({ result })) as unknown as typeof fetch;
      expect((await probeRpcUrl('https://n.example', 1, { fetchImpl })).outcome).toBe('bad-response');
    }
  });

  test('tells the endpoint nothing beyond the call it is about to receive', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return rpcResponse({ result: '0x1' });
    }) as unknown as typeof fetch;
    await probeRpcUrl('https://n.example', 1, { fetchImpl });
    expect(seen?.method).toBe('POST');
    expect(seen?.credentials).toBe('omit');
    expect(seen?.referrerPolicy).toBe('no-referrer');
    expect(JSON.parse(String(seen?.body)).method).toBe('eth_chainId');
  });

  test('every non-ok outcome has a message, so a warning can never render blank', () => {
    for (const outcome of ['wrong-chain', 'unreachable', 'bad-response', 'timeout'] as const) {
      expect(RPC_PROBE_MESSAGES[outcome].length).toBeGreaterThan(10);
      // House rule: no em dashes in user-facing copy.
      expect(RPC_PROBE_MESSAGES[outcome]).not.toContain('—');
    }
  });
});

describe('where the endpoint is kept', () => {
  // The option exists so a user on a shared machine can set an endpoint for
  // this tab and have it gone when the tab closes. The behaviour that matters
  // is not "session storage works" but "the OTHER store is emptied", because
  // leaving a persistent copy behind means the endpoint they asked to forget
  // comes back on the next visit.
  const KEY = CUSTOM_RPC_STORAGE_KEY;
  const store = (): StorageLike & { map: Map<string, string> } => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
    };
  };

  test('a value written to one store is readable from it', () => {
    const s = store();
    expect(writeCustomRpcOverrides(s, { 1: 'https://mine.example/' })).toBe(true);
    expect(readCustomRpcOverrides(s)).toEqual({ 1: 'https://mine.example/' });
    expect(s.map.has(KEY)).toBe(true);
  });

  test('clearing empties the key rather than leaving an empty object behind', () => {
    // A leftover "{}" would read as "a value is stored here", which is what
    // the two-store read order keys off.
    const s = store();
    writeCustomRpcOverrides(s, { 1: 'https://mine.example/' });
    expect(writeCustomRpcOverrides(s, {})).toBe(true);
    expect(s.map.has(KEY)).toBe(false);
    expect(readCustomRpcOverrides(s)).toEqual({});
  });

  test('a refused write is reported, so the form never claims a save it did not make', () => {
    const refusing: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => {},
    };
    expect(writeCustomRpcOverrides(refusing, { 1: 'https://mine.example/' })).toBe(false);
  });
});

/**
 * Which chains an account-key sweep is allowed to touch.
 *
 * The sweep visits every EVM chain, and the override is per chain, so setting
 * one endpoint used to leave every other chain going to the defaults. The rule
 * below is what stops that, and the form reads the same two functions to name
 * what it is about to skip.
 */
describe('queryableChainIds / skippedChainIds', () => {
  const ALL = [1, 10, 56, 8453];

  test('changes nothing when the user has set no endpoint of their own', () => {
    // The default for everyone who never opens the form.
    expect(queryableChainIds(ALL, {})).toEqual(ALL);
    expect(skippedChainIds(ALL, {})).toEqual([]);
  });

  test('drops every chain without an endpoint once ONE is set', () => {
    // The whole point: filling mainnet used to leave the other three on the
    // defaults, which is the opposite of what filling it asks for.
    const overrides = { 1: 'https://my-node/eth' };
    expect(queryableChainIds(ALL, overrides)).toEqual([1]);
    expect(skippedChainIds(ALL, overrides)).toEqual([10, 56, 8453]);
  });

  test('keeps every chain the user did configure', () => {
    const overrides = { 1: 'https://a', 56: 'https://b' };
    expect(queryableChainIds(ALL, overrides)).toEqual([1, 56]);
    expect(skippedChainIds(ALL, overrides)).toEqual([10, 8453]);
  });

  test('is the exact complement of itself, for any input', () => {
    // The form says what is skipped and the sweep decides what runs. If these
    // disagreed, the warning would be a lie.
    const cases: Record<number, string>[] = [{}, { 1: 'https://a' }, { 10: 'https://b', 56: 'https://c' }];
    for (const overrides of cases) {
      const queryable = queryableChainIds(ALL, overrides);
      const skipped = skippedChainIds(ALL, overrides);
      expect([...queryable, ...skipped].sort()).toEqual([...ALL].sort());
      expect(queryable.filter((id) => skipped.includes(id))).toEqual([]);
    }
  });
});

for (const ids of [[], [1, 10, 56, 8453], [1, 10, 1]]) {
  test(`the scan partition preserves input multiplicity and covers every override subset: ${ids}`, () => {
    const candidates = [1, 10, 56, 8453, 999];
    for (let mask = 0; mask < 1 << candidates.length; mask++) {
      const overrides = Object.fromEntries(candidates.filter((_id, index) => mask & (1 << index)).map(id => [id, `https://rpc.example/${id}`]));
      const queryable = queryableChainIds(ids, overrides);
      const skipped = skippedChainIds(ids, overrides);
      expect([...queryable, ...skipped].sort()).toEqual([...ids].sort());
      expect(queryable.some(id => skipped.includes(id))).toBe(false);
      expect(queryable).toEqual(ids.filter(id => mask === 0 || id in overrides));
    }
  });
}
