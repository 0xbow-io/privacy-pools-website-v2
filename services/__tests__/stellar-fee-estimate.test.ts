import { describe, expect, test, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { rpc, xdr } from '@stellar/stellar-sdk';
import * as sdk from '@privacy-pools-v2/stellar-sdk';
import * as fees from '@/vendor/stellar-fees';
import * as routing from '@/services/tor-fetch';
import { fetchStellarFees } from '@/services/stellar/stellar-fee-feed';
import { readStellarTransferFee, readStellarWithdrawalFee, stellarRelayFeeFromResourceFee, STELLAR_FEE_INTERVAL_MS } from '@/services/stellar-fee-estimate';
import { stellarTransferRelayFee, maxStellarTransferForInputs } from '@/config/stellar-deployment';
import fixture from './fixtures/stellar-fee-settings.json';

const settings = Object.fromEntries(Object.entries(fixture).map(([key, value]) =>
  [key, typeof value === 'string' ? BigInt(value) : value])) as unknown as sdk.StellarFeeSettings;
const root = new URL('../../', import.meta.url);
const source = (name: string) => readFileSync(new URL(name, root), 'utf8');

describe('Stellar display fee', () => {
  test('rounds the resource margin up without rounding the flat fee or inclusion fee', () => {
    for (const [resource, expected] of [[0n, 200100n], [1n, 200102n], [3n, 200104n], [4n, 200105n], [100001n, 325102n]]) {
      expect(stellarRelayFeeFromResourceFee(resource)).toBe(expected);
    }
  });

  test('all five transfer shapes reproduce the pinned SDK and captured public quote amounts', () => {
    const expected = [317289n, 390145n, 437862n, 460439n, 483015n];
    for (let n = 1; n <= 5; n++) {
      const shape = { n, m: Math.min(2 * n, 5) };
      const options = { keystoreRecord: true, contractRecipient: false };
      const resources = fees.stellarRelayResources(fees.STELLAR_RELAY_RESOURCE_TABLE, 'transfer', shape, options);
      expect(resources).toEqual(sdk.stellarRelayResources(sdk.STELLAR_RELAY_RESOURCE_TABLE, 'transfer', shape, options));
      const fee = fees.stellarRelayResourceFee(resources, settings);
      expect(fee).toEqual(sdk.stellarRelayResourceFee(resources, settings));
      expect(stellarRelayFeeFromResourceFee(fee.resourceFee)).toBe(expected[n - 1]);
      // Rates and state-size rent must remain dynamic, not a cached quote table.
      for (const changed of [
        { ...settings, feeRatePerInstructionsIncrement: 50n },
        { ...settings, averageSorobanStateSize: settings.sorobanStateTargetSizeBytes * 2n },
      ]) {
        const updated = fees.stellarRelayResourceFee(resources, changed);
        expect(updated).toEqual(sdk.stellarRelayResourceFee(resources, changed));
        expect(updated.resourceFee).toBeGreaterThan(fee.resourceFee);
      }
    }
  });

  test('withdrawals match public quotes for all five shapes, with the amount fee floored and the total capped', () => {
    const expected = [445273n, 492989n, 540703n, 588420n, 636137n];
    const withdrawal = Array.from({ length: 5 }, (_, i) => {
      const shape = { n: i + 1, m: i + 1 };
      const costs = (['relay', 'register_and_relay'] as const).map(action => {
        const resources = fees.stellarRelayResources(fees.STELLAR_RELAY_RESOURCE_TABLE, action, shape, { keystoreRecord: true, contractRecipient: false });
        const parts = fees.stellarRelayResourceFee(resources, settings);
        expect(parts).toEqual(sdk.stellarRelayResourceFee(resources, settings));
        return parts.resourceFee;
      });
      return stellarRelayFeeFromResourceFee(costs[0] > costs[1] ? costs[0] : costs[1]);
    });
    const ready = { status: 'ready' as const, data: { transfer: [], withdrawal }, at: 1000 };
    for (let n = 1; n <= 5; n++) expect(readStellarWithdrawalFee(ready, n, 10000000n, 1000)).toBe(expected[n - 1]);
    expect(readStellarWithdrawalFee(ready, 1, 199n, 1000)).toBe(withdrawal[0]);
    expect(readStellarWithdrawalFee(ready, 1, 200n, 1000)).toBe(withdrawal[0] + 1n);
    expect(readStellarWithdrawalFee(ready, 1, 10000000000n, 1000)).toBe(5000000n);
    expect(readStellarWithdrawalFee(ready, 1, 0n, 1000)).toBeNull();
    expect(readStellarWithdrawalFee(ready, 1, -1n, 1000)).toBeNull();
    expect(readStellarWithdrawalFee(ready, 0, 10000000n, 1000)).toBeNull();
    expect(readStellarWithdrawalFee(ready, 1, 10000000n, 1000 + 2 * STELLAR_FEE_INTERVAL_MS)).toBeNull();
    expect(readStellarWithdrawalFee({ status: 'empty' }, 1, 10000000n, 1000)).toBeNull();
    expect(readStellarWithdrawalFee({ ...ready, status: 'error', error: new Error('offline') }, 1, 10000000n, 1000)).toBeNull();
  });

  test('fresh cached fees survive a failed refresh; missing, stale and invalid-shape reads are unavailable', () => {
    const ready = { status: 'ready' as const, data: { transfer: [317289n, 390145n, 437862n, 460439n, 483015n], withdrawal: [395273n, 442989n, 490703n, 538420n, 586137n] }, at: 1000 };
    expect(readStellarTransferFee(ready, 1, 1000)).toBe(317289n);
    expect(readStellarTransferFee(ready, 5, 1000 + 2 * STELLAR_FEE_INTERVAL_MS - 1)).toBe(483015n);
    expect(readStellarTransferFee(ready, 1, 1000 + 2 * STELLAR_FEE_INTERVAL_MS)).toBeNull();
    expect(readStellarTransferFee({ status: 'empty' }, 1)).toBeNull();
    const failedRefresh = { ...ready, status: 'error' as const, error: new Error('offline'), dataAt: 1000, at: 61000 };
    expect(readStellarTransferFee(failedRefresh, 1, 61000)).toBe(317289n);
    expect(readStellarWithdrawalFee(failedRefresh, 1, 10000000n, 61000)).toBe(445273n);
    expect(readStellarTransferFee(failedRefresh, 1, 121000)).toBeNull();
    expect(readStellarWithdrawalFee(failedRefresh, 1, 10000000n, 121000)).toBeNull();
    expect(readStellarTransferFee({ status: 'error', error: new Error('offline'), at: 1000 }, 1, 1001)).toBeNull();
    for (const n of [0, 6, 1.5, NaN]) expect(readStellarTransferFee(ready, n, 1000)).toBeNull();
    expect(readStellarTransferFee({ ...ready, data: { transfer: [], withdrawal: [] } }, 1, 1000)).toBeNull();
    expect(readStellarTransferFee({ ...ready, data: { transfer: [-1n], withdrawal: [-1n] } }, 1, 1000)).toBeNull();
    // The estimate can exceed the limit: do not misrepresent it as an accepted quote.
    expect(readStellarTransferFee({ ...ready, data: { transfer: [900000n], withdrawal: [900000n] } }, 1, 1000)).toBe(900000n);
    expect(stellarTransferRelayFee()).toBe(750000n);
    expect(maxStellarTransferForInputs(10000000n, stellarTransferRelayFee())).toBe(9250000n);
  });

  test('the feed calculates every shape locally from one settings read', async () => {
    const spy = spyOn(fees, 'readStellarFeeSettings').mockResolvedValue(settings);
    try {
      expect(await fetchStellarFees()).toEqual({
        transfer: [317289n, 390145n, 437862n, 460439n, 483015n],
        withdrawal: [395273n, 442989n, 490703n, 538420n, 586137n],
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('the scheduled fetch sends only the SDK public configuration keys and propagates failure', async () => {
    const route = spyOn(routing, 'torFetchIfActive').mockImplementation(() => null);
    const failure = new Error('offline');
    const calls: string[][] = [];
    const spy = spyOn(rpc.Server.prototype, 'getLedgerEntries').mockImplementation(async (...keys: xdr.LedgerKey[]) => {
      calls.push(keys.map(key => key.toXDR('base64')));
      throw failure;
    });
    try {
      await expect(fetchStellarFees()).rejects.toBe(failure);
      expect(calls).toEqual([sdk.stellarFeeSettingKeys().map(key => key.toXDR('base64'))]);
      expect(route).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      route.mockRestore();
    }
  });

  test('the UI only reads the cache and the page-load feed list owns scheduling', () => {
    const hook = source('hooks/use-stellar-fee-estimate.ts');
    expect(hook).toContain('usePublicFeed<StellarFeeEstimates>(FEED_STELLAR_FEES)');
    expect(hook).not.toMatch(/fetch|useEffect|useQuery|setInterval|setTimeout/);
    const feeds = source('services/public-feeds.ts');
    expect(feeds).toMatch(/if \(STELLAR_FEED_ENABLED\) \{\s*publicFeeds.register\(\{\s*key: FEED_STELLAR_FEES,\s*intervalMs: STELLAR_FEE_INTERVAL_MS,\s*maxAgeMs: 2 \* STELLAR_FEE_INTERVAL_MS,\s*fetch: fetchStellarFees,/);
    const fetcher = source('services/stellar/stellar-fee-feed.ts');
    expect(fetcher).toContain('fetchStellarFees()');
    expect(fetcher).not.toMatch(/\.simulateTransaction\(|fetch\(|apiClient/);
  });
});

test('public fee settings use anonymous RPC when active, without a direct fallback', async () => {
  const calls: { url: string; body: unknown }[] = [];
  let failure: Error | null = null;
  let status = 200;
  const route = spyOn(routing, 'torFetchIfActive').mockImplementation(() => async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (failure) throw failure;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { entries: [], latestLedger: 1 } }), { status });
  });
  const direct = spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected direct request'); });
  const reader = spyOn(fees, 'readStellarFeeSettings').mockImplementation(async server => {
    await server.getLedgerEntries(...sdk.stellarFeeSettingKeys());
    return settings;
  });
  try {
    await fetchStellarFees();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys: sdk.stellarFeeSettingKeys().map(k => k.toXDR('base64')) } });
    failure = new Error('anonymous route unavailable');
    await expect(fetchStellarFees()).rejects.toBe(failure);
    expect(calls).toHaveLength(2);
    failure = null;
    status = 503;
    await expect(fetchStellarFees()).rejects.toThrow('Soroban RPC HTTP 503');
    expect(calls).toHaveLength(3);
    expect(direct).toHaveBeenCalledTimes(0);
  } finally {
    reader.mockRestore(); route.mockRestore(); direct.mockRestore();
  }
});

for (const anonymous of [false, true]) {
  for (const stage of ['headers', 'body'] as const) {
    test(`fee feed aborts stalled ${stage} over ${anonymous ? 'Tor' : 'direct RPC'} and can recover`, async () => {
      let stalled = true;
      const signals: AbortSignal[] = [];
      const send = async (_url: unknown, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal;
        if (!signal) throw new Error('Missing request deadline');
        signals.push(signal);
        const reply = { jsonrpc: '2.0', id: 1, result: { entries: [], latestLedger: 1 } };
        if (!stalled) return new Response(JSON.stringify(reply));
        if (stage === 'headers') return new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        });
        return new Response(new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(new Error('request aborted')), { once: true });
          },
        }));
      };
      const route = spyOn(routing, 'torFetchIfActive').mockImplementation(() => anonymous ? send : null);
      const direct = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (anonymous) throw new Error('Unexpected direct fallback');
        return send(url, init);
      });
      const reader = spyOn(fees, 'readStellarFeeSettings').mockImplementation(async server => {
        await server.getLedgerEntries(...sdk.stellarFeeSettingKeys());
        return settings;
      });
      try {
        await expect(fetchStellarFees()).rejects.toThrow('request aborted');
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(true);
        stalled = false;
        expect((await fetchStellarFees()).transfer[0]).toBe(317289n);
        expect(signals).toHaveLength(2);
        expect(signals[1].aborted).toBe(false);
        expect(direct).toHaveBeenCalledTimes(anonymous ? 0 : 2);
      } finally {
        reader.mockRestore(); route.mockRestore(); direct.mockRestore();
      }
    }, 10_000);
  }
}
