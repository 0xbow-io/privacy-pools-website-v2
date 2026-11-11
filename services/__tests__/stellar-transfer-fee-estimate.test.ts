import { describe, expect, test, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { rpc, xdr } from '@stellar/stellar-sdk';
import * as sdk from '@privacy-pools-v2/stellar-sdk';
import * as fees from '@/vendor/stellar-fees';
import { fetchStellarTransferFees } from '@/services/stellar/stellar-fee-feed';
import { readStellarTransferFee, stellarTransferFeeFromResourceFee, STELLAR_FEE_INTERVAL_MS } from '@/services/stellar-transfer-fee-estimate';
import { stellarTransferRelayFee, maxStellarTransferForInputs } from '@/config/stellar-deployment';
import fixture from './fixtures/stellar-fee-settings.json';

const settings = Object.fromEntries(Object.entries(fixture).map(([key, value]) =>
  [key, typeof value === 'string' ? BigInt(value) : value])) as unknown as sdk.StellarFeeSettings;
const root = new URL('../../', import.meta.url);
const source = (name: string) => readFileSync(new URL(name, root), 'utf8');

describe('Stellar display fee', () => {
  test('rounds the resource margin up without rounding the flat fee or inclusion fee', () => {
    for (const [resource, expected] of [[0n, 200100n], [1n, 200102n], [3n, 200104n], [4n, 200105n], [100001n, 325102n]]) {
      expect(stellarTransferFeeFromResourceFee(resource)).toBe(expected);
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
      expect(stellarTransferFeeFromResourceFee(fee.resourceFee)).toBe(expected[n - 1]);
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

  test('missing, failed, stale and invalid-shape cache reads are unavailable', () => {
    const ready = { status: 'ready' as const, data: [317289n, 390145n, 437862n, 460439n, 483015n], at: 1000 };
    expect(readStellarTransferFee(ready, 1, 1000)).toBe(317289n);
    expect(readStellarTransferFee(ready, 5, 1000 + 2 * STELLAR_FEE_INTERVAL_MS - 1)).toBe(483015n);
    expect(readStellarTransferFee(ready, 1, 1000 + 2 * STELLAR_FEE_INTERVAL_MS)).toBeNull();
    expect(readStellarTransferFee({ status: 'empty' }, 1)).toBeNull();
    expect(readStellarTransferFee({ ...ready, status: 'error', error: new Error('offline'), dataAt: 1000 }, 1, 1001)).toBeNull();
    for (const n of [0, 6, 1.5, NaN]) expect(readStellarTransferFee(ready, n, 1000)).toBeNull();
    expect(readStellarTransferFee({ ...ready, data: [] }, 1, 1000)).toBeNull();
    expect(readStellarTransferFee({ ...ready, data: [-1n] }, 1, 1000)).toBeNull();
    // The estimate can exceed the limit: do not misrepresent it as an accepted quote.
    expect(readStellarTransferFee({ ...ready, data: [900000n] }, 1, 1000)).toBe(900000n);
    expect(stellarTransferRelayFee()).toBe(750000n);
    expect(maxStellarTransferForInputs(10000000n, stellarTransferRelayFee())).toBe(9250000n);
  });

  test('the feed calculates every shape locally from one settings read', async () => {
    const spy = spyOn(fees, 'readStellarFeeSettings').mockResolvedValue(settings);
    try {
      expect(await fetchStellarTransferFees()).toEqual([317289n, 390145n, 437862n, 460439n, 483015n]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('the scheduled fetch sends only the SDK public configuration keys and propagates failure', async () => {
    const failure = new Error('offline');
    const calls: string[][] = [];
    const spy = spyOn(rpc.Server.prototype, 'getLedgerEntries').mockImplementation(async (...keys: xdr.LedgerKey[]) => {
      calls.push(keys.map(key => key.toXDR('base64')));
      throw failure;
    });
    try {
      await expect(fetchStellarTransferFees()).rejects.toBe(failure);
      expect(calls).toEqual([sdk.stellarFeeSettingKeys().map(key => key.toXDR('base64'))]);
    } finally {
      spy.mockRestore();
    }
  });

  test('the UI only reads the cache and the build-wide feed list owns scheduling', () => {
    const hook = source('hooks/use-stellar-transfer-fee-estimate.ts');
    expect(hook).toContain('usePublicFeed<StellarTransferFees>(FEED_STELLAR_TRANSFER_FEES)');
    expect(hook).not.toMatch(/fetch|useEffect|useQuery|setInterval|setTimeout/);
    const feeds = source('services/public-feeds.ts');
    expect(feeds).toMatch(/if \(getChainConfig\(STELLAR_TESTNET_ID\)\) \{\s*publicFeeds.register\(\{\s*key: FEED_STELLAR_TRANSFER_FEES,\s*intervalMs: STELLAR_FEE_INTERVAL_MS,\s*fetch: fetchStellarTransferFees,/);
    const fetcher = source('services/stellar/stellar-fee-feed.ts');
    expect(fetcher).toContain('fetchStellarTransferFees()');
    expect(fetcher).not.toMatch(/\.simulateTransaction\(|fetch\(|apiClient/);
  });
});
