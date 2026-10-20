import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PROD_DETAILS from './fixtures/relayer-details-prod-2026-09-18.json';
import {
  assertRelayerSwapProcessor,
  fetchRelayerChainDetails,
  parseRelayerChainDetails,
  relayerProcessors,
  relayerSwapProcessorVerdict,
  relayerYieldRouterFor,
  resetRelayerChainDetailsCacheForTests,
  SWAP_PROCESSOR_DRIFT_MESSAGE,
  SWAP_UNSUPPORTED_MESSAGE,
  type RelayerDetailsDeps,
} from '@/services/relayer-details';

// The production relayer's answer for chain 1 on 2026-09-18 13:27Z, as served
// (assets trimmed to two). A hand-written "realistic" body would only cover
// the shape we imagined; this is the shape the relayer actually emits.
const MAINNET_DETAILS = {
  id: 1,
  name: 'mainnet',
  type: 'evm',
  contracts: {
    entrypoint: '0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3',
    poolVault: '0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed',
    relay: '0x01a8Fa4dbb60187aD8d3c3d08E7Fb8C14198A461',
    relaySwaps: '0xd0395c08DD8eA7671a7A65bDca8E473e8E8260a8',
  },
  swapsSupported: true,
  assets: [
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', ticker: 'WETH', fixedFeeAmount: '21000' },
    { address: '0x66051920D25af4E3596A8a46309F4D045F9D83B7', ticker: 'ppETH', fixedFeeAmount: '21000' },
  ],
  relayerAddress: '0x9e2f1B234953F46c6091636290E9035618EA3C07',
  processors: [
    '0xe76E793d776c1e207aD7a7fa7C57d27420d85110',
    '0x13a0b86bac3e0C29bd64fED7BCD2EE84f371f41C',
    '0x77613D670BB9fD48A9898D0eac8ebf21B566F960',
  ],
  yield: [
    {
      ppToken: '0x66051920D25af4E3596A8a46309F4D045F9D83B7',
      underlying: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      router: '0x77613D670BB9fD48A9898D0eac8ebf21B566F960',
      zap: '0x33c1eEf370bBb447414156CFc4fDABD434776EAf',
      ppDecimals: 18,
      underlyingDecimals: 18,
      underlyingSymbol: 'WETH',
    },
  ],
};

// Citrea as served the same minute: no swaps, no processors, no yield.
const CITREA_DETAILS = {
  id: 4114,
  name: 'citrea',
  type: 'evm',
  contracts: {
    entrypoint: '0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3',
    poolVault: '0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed',
    relay: '0x01a8Fa4dbb60187aD8d3c3d08E7Fb8C14198A461',
  },
  swapsSupported: false,
  assets: [{ address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', ticker: 'CBTC', fixedFeeAmount: '21000', feeBPS: '10' }],
};

describe('relayer chain details', () => {
  test('all current production chains parse, but the all-chains envelope does not', () => {
    expect(PROD_DETAILS.chains.map((chain) => chain.id).sort((a, b) => a - b)).toEqual([1, 56, 4114]);
    for (const body of PROD_DETAILS.chains) {
      expect(parseRelayerChainDetails(body)).toEqual(body);
    }
    expect(parseRelayerChainDetails(PROD_DETAILS)).toBeNull();
  });

  test('yield decimals reject negative and fractional values, as the SDK does', () => {
    for (const key of ['ppDecimals', 'underlyingDecimals']) {
      for (const value of [-1, 1.5]) {
        expect(parseRelayerChainDetails({
          ...MAINNET_DETAILS,
          yield: [{ ...MAINNET_DETAILS.yield[0], [key]: value }],
        })).toBeNull();
      }
    }
  });

  test('the real mainnet body parses and exposes processors, routers and the swap contract', () => {
    const details = parseRelayerChainDetails(MAINNET_DETAILS);
    expect(details).not.toBeNull();
    expect(relayerProcessors(details).has('0x77613d670bb9fd48a9898d0eac8ebf21b566f960')).toBe(true);
    expect(relayerProcessors(details).size).toBe(3);
    expect(relayerYieldRouterFor(details, '0x66051920d25af4e3596a8a46309f4d045f9d83b7')).toBe('0x77613D670BB9fD48A9898D0eac8ebf21B566F960');
    expect(relayerYieldRouterFor(details, '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6')).toBeUndefined();
  });

  test('the swap processor verdict compares case-insensitively and knows when it cannot answer', () => {
    const details = parseRelayerChainDetails(MAINNET_DETAILS);
    expect(relayerSwapProcessorVerdict(details, '0xd0395c08dd8ea7671a7a65bdca8e473e8e8260a8')).toBe('matches');
    // The address the app carried before the 2026-09-18 relayer redeploy.
    expect(relayerSwapProcessorVerdict(details, '0x5f3927f24ec20f49b3850a5b78eb2015945e57f7')).toBe('differs');
    expect(relayerSwapProcessorVerdict(details, undefined)).toBe('unknown');
    expect(relayerSwapProcessorVerdict(null, '0xd0395c08DD8eA7671a7A65bDca8E473e8E8260a8')).toBe('unknown');
    // A relayer that relays no swaps on the chain contradicts an app that has a
    // processor there: that is a refusal, not missing data.
    expect(relayerSwapProcessorVerdict(parseRelayerChainDetails(CITREA_DETAILS), '0xd0395c08DD8eA7671a7A65bDca8E473e8E8260a8')).toBe('unsupported');
    expect(relayerSwapProcessorVerdict(parseRelayerChainDetails(CITREA_DETAILS), undefined)).toBe('unknown');
    // Swaps supported but no contract published (an older relayer): unknown.
    expect(relayerSwapProcessorVerdict(parseRelayerChainDetails({ ...MAINNET_DETAILS, contracts: { ...MAINNET_DETAILS.contracts, relaySwaps: undefined } }), '0xd0395c08DD8eA7671a7A65bDca8E473e8E8260a8')).toBe('unknown');
  });

  test('a body that is not chain details is null, and null answers nothing', () => {
    expect(parseRelayerChainDetails({ version: '1.0.0', chains: [] })).toBeNull();
    expect(parseRelayerChainDetails(undefined)).toBeNull();
    expect(relayerProcessors(null).size).toBe(0);
    expect(relayerYieldRouterFor(null, '0x66051920D25af4E3596A8a46309F4D045F9D83B7')).toBeUndefined();
  });
});

// The fetch with fakes for the clock, the chain lookup and the policed GET, so
// the cache and the fail-closed answers are exercised without react-native or
// a module mock leaking into the rest of the suite.
function fakeDeps(): RelayerDetailsDeps & { advance: (ms: number) => void; setResponse: (body: unknown) => void; calls: () => number; urls: string[] } {
  let now = 1_000_000;
  let response: unknown = MAINNET_DETAILS;
  let calls = 0;
  const urls: string[] = [];
  return {
    now: () => now,
    relayerFor: async () => ({ url: 'https://relayer.example/', chainType: 'evm' }),
    get: async (base, url) => {
      calls += 1;
      urls.push(url);
      expect(base).toBe('https://relayer.example/');
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    },
    advance: (ms) => { now += ms; },
    setResponse: (body) => { response = body; },
    calls: () => calls,
    urls,
  };
}

describe('relayer details fetching and cache', () => {
  beforeEach(() => resetRelayerChainDetailsCacheForTests());

  test('the GET names the chain only, and both a body and an outage are cached for a minute', async () => {
    const deps = fakeDeps();
    const first = await fetchRelayerChainDetails(1, deps);
    expect(first).not.toBeNull();
    expect(deps.urls).toEqual(['https://relayer.example/v1/details/evm/1']);
    deps.setResponse(new Error('offline'));
    deps.advance(59_999);
    expect(await fetchRelayerChainDetails(1, deps)).toBe(first);
    expect(deps.calls()).toBe(1);
    deps.advance(1);
    expect(await fetchRelayerChainDetails(1, deps)).toBeNull();
    expect(deps.calls()).toBe(2);
    // A cached outage is still "unknown", never a match, and is not re-fetched until it expires.
    deps.setResponse(MAINNET_DETAILS);
    deps.advance(59_999);
    const cachedNull = await fetchRelayerChainDetails(1, deps);
    expect(cachedNull).toBeNull();
    expect(relayerSwapProcessorVerdict(cachedNull, MAINNET_DETAILS.contracts.relaySwaps)).toBe('unknown');
    expect(deps.calls()).toBe(2);
    deps.advance(1);
    expect(await fetchRelayerChainDetails(1, deps)).not.toBeNull();
    expect(deps.calls()).toBe(3);
  });

  test('the fetch the app already makes records destinationCallsSupported, and an absent field falls back', async () => {
    const dc = await import('@/config/destination-calls');
    dc.resetRelayerDestinationCallsForTests();
    try {
      const deps = fakeDeps();
      deps.setResponse({ ...MAINNET_DETAILS, destinationCallsSupported: false });
      const details = await fetchRelayerChainDetails(1, deps);
      expect(details?.destinationCallsSupported).toBe(false);
      expect(dc.destinationCallsSupported(1)).toBe(false);
      deps.advance(60_000);
      deps.setResponse(MAINNET_DETAILS);
      await fetchRelayerChainDetails(1, deps);
      expect(dc.destinationCallsSupported(1)).toBe(true);
      expect(dc.destinationCallsSupported(4663)).toBe(false);
      expect(dc.destinationCallsSupported(4114)).toBe(false);
      // Subscribers (the Swap tab's network list) hear a change, and only a change.
      let heard = 0;
      const off = dc.subscribeDestinationCalls(() => { heard += 1; });
      const v = dc.destinationCallsVersion();
      dc.recordRelayerDestinationCalls(10, false);
      dc.recordRelayerDestinationCalls(10, false);
      expect(heard).toBe(1);
      expect(dc.destinationCallsVersion()).toBe(v + 1);
      off();
      // A selected reshield destination the gate stops approving is dropped.
      expect(dc.reshieldDestinationStillValid(true, 1, 56, false)).toBe(false);
      expect(dc.reshieldDestinationStillValid(true, 1, 56, true)).toBe(true);
      expect(dc.reshieldDestinationStillValid(true, 1, 1, false)).toBe(true);
      // A wallet swap needs no destination call, so it keeps its chain.
      expect(dc.reshieldDestinationStillValid(false, 1, 4663, false)).toBe(true);
    } finally {
      dc.resetRelayerDestinationCallsForTests();
    }
  });

  test('a body for another chain, a non-EVM body or the all-chains envelope cannot certify the processor', async () => {
    for (const body of [{ ...MAINNET_DETAILS, id: 56 }, { ...MAINNET_DETAILS, type: 'sui' }, PROD_DETAILS]) {
      resetRelayerChainDetailsCacheForTests();
      const deps = fakeDeps();
      deps.setResponse(body);
      expect(await fetchRelayerChainDetails(1, deps)).toBeNull();
      expect(relayerSwapProcessorVerdict(await fetchRelayerChainDetails(1, deps), MAINNET_DETAILS.contracts.relaySwaps)).toBe('unknown');
      expect(deps.calls()).toBe(1);
    }
  });

  test('a chain the app has no relayer for, or a non-EVM chain, asks nothing', async () => {
    const deps = fakeDeps();
    deps.relayerFor = async () => undefined;
    expect(await fetchRelayerChainDetails(1, deps)).toBeNull();
    const sui = fakeDeps();
    sui.relayerFor = async () => ({ url: 'https://relayer.example/', chainType: 'sui' });
    expect(await fetchRelayerChainDetails(102, sui)).toBeNull();
    expect(deps.calls() + sui.calls()).toBe(0);
  });
});

describe('the assertion every swap-shaped flow runs before binding a processor', () => {
  beforeEach(() => resetRelayerChainDetailsCacheForTests());

  test('a matching relayer and an unreadable relayer both let the flow proceed; a moved or withdrawn contract stops it', async () => {
    const deps = fakeDeps();
    expect(await assertRelayerSwapProcessor(1, MAINNET_DETAILS.contracts.relaySwaps, deps)).toBeUndefined();
    resetRelayerChainDetailsCacheForTests();
    await expect(assertRelayerSwapProcessor(1, '0x5f3927f24ec20f49b3850a5b78eb2015945e57f7', deps)).rejects.toThrow(SWAP_PROCESSOR_DRIFT_MESSAGE);
    resetRelayerChainDetailsCacheForTests();
    deps.setResponse({ ...MAINNET_DETAILS, swapsSupported: false, contracts: { ...MAINNET_DETAILS.contracts, relaySwaps: undefined } });
    await expect(assertRelayerSwapProcessor(1, MAINNET_DETAILS.contracts.relaySwaps, deps)).rejects.toThrow(SWAP_UNSUPPORTED_MESSAGE);
    resetRelayerChainDetailsCacheForTests();
    deps.setResponse(new Error('offline'));
    expect(await assertRelayerSwapProcessor(1, MAINNET_DETAILS.contracts.relaySwaps, deps)).toBeUndefined();
  });

  test('a relayer without the route (HTTP 404) is unknown, not a match', async () => {
    const deps = fakeDeps();
    deps.get = async () => ({ ok: false, json: async () => ({}) });
    expect(await fetchRelayerChainDetails(1, deps)).toBeNull();
    expect(await assertRelayerSwapProcessor(1, MAINNET_DETAILS.contracts.relaySwaps, deps)).toBeUndefined();
  });

  test('the cache is keyed by relayer URL too, so a different relayer is asked again', async () => {
    const deps = fakeDeps();
    await fetchRelayerChainDetails(1, deps);
    deps.relayerFor = async () => ({ url: 'https://other-relayer.example/', chainType: 'evm' });
    deps.get = async (_base, url) => { expect(url).toBe('https://other-relayer.example/v1/details/evm/1'); return { ok: true, json: async () => MAINNET_DETAILS }; };
    expect(await fetchRelayerChainDetails(1, deps)).not.toBeNull();
    expect(deps.calls()).toBe(1); // the first relayer's GET; the second went through the replaced get()
  });

  test('every component that binds a relayer interactor to the swap processor asserts it first (source guard)', () => {
    // The 2026-09-18 bypass: the swap modal checked, the withdraw modal's
    // "receive as" path and both confirm re-quotes did not. A LiFi preview that
    // only uses the processor as `fromAddress` binds nothing and is exempt.
    const binds = /createRelayerInteractor\(\s*[^,()]+,\s*(?:getSwapProcessorAddress\(|swapProcessor\b)/;
    const root = fileURLToPath(new URL('../../components', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const source = readFileSync(path, 'utf8');
        if (binds.test(source) && !source.includes('assertRelayerSwapProcessor(')) offenders.push(path.slice(root.length + 1));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
    // The guard sees the two files that do bind, so it is not trivially green.
    const bound = ['swap-modal-provider.tsx', 'withdraw-modal-provider.tsx']
      .filter((f) => binds.test(readFileSync(join(root, f), 'utf8')));
    expect(bound).toEqual(['swap-modal-provider.tsx', 'withdraw-modal-provider.tsx']);
  });
});
