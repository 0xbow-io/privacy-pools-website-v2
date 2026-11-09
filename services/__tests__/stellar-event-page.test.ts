// The Stellar SDK answers "when was this commitment inserted / was this
// nullifier spent" with a whole-history event scan per note. Through the
// indexed interactor, a sync pass must make ONE such read however many notes
// it asks about, so the request count never follows what discovery found.
// Driven through the REAL vendored pool adapter, only fetch is stubbed.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import { createIndexedRpcInteractor } from '@/services/stellar/stellar-runtime';

const ASP = 'https://asp.test';
const POOL = STELLAR_TESTNET_CONTRACTS.poolContractId;
const KEYSTORE = STELLAR_TESTNET_CONTRACTS.keystoreContractId;
const realFetch = globalThis.fetch;
let requested: URL[] = [];
let latest = 100;

beforeEach(() => {
  requested = [];
  latest = 100;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    requested.push(url);
    return new Response(JSON.stringify({ events: [], latestLedger: `0x${latest.toString(16)}` }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const wholePoolReads = () => requested.filter((u) => u.searchParams.get('contractId') === POOL && u.searchParams.get('fromLedger') === '0');
const hashes = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `0x${(seed + i).toString(16).padStart(64, '0')}`);

async function setup() {
  const sdk = await import('@privacy-pools-v2/stellar-sdk');
  const rpc = createIndexedRpcInteractor(sdk, ASP);
  const adapter = new sdk.StellarPoolVaultChainAdapter({ rpcInteractor: rpc, contractId: POOL, readSourcePublicKey: '' } as never);
  return { rpc, adapter };
}

describe('whole-history pool reads in a sync pass', () => {
  test('one read for any number of per-note lookups inside a pass, none for later lookups', async () => {
    const { rpc, adapter } = await setup();

    for (const count of [1, 7]) {
      requested = [];
      await rpc.withEventPage(async () => {
        await Promise.all(hashes(count, 1).map((c) => adapter.getCommitmentValue(c as never)));
        await Promise.all(hashes(count, 50).map((n) => adapter.getNullifierValue(n as never)));
        // The activity index's read in the same pass.
        await rpc.getEvents({ contractId: POOL });
      });
      expect(wholePoolReads()).toHaveLength(1);
    }

    // Outside a pass the SDK's own note index (built from those whole-pool reads) answers.
    requested = [];
    await Promise.all(hashes(3, 1).map((c) => adapter.getCommitmentValue(c as never)));
    expect(wholePoolReads()).toHaveLength(0);
  });

  test('no request carries a note-derived value', async () => {
    const { rpc, adapter } = await setup();
    const asked = hashes(4, 0xabcdef);
    await rpc.withEventPage(async () => {
      for (const c of asked) await adapter.getCommitmentValue(c as never);
    });
    for (const url of requested) {
      for (const c of asked) {
        expect(url.toString()).not.toContain(c.slice(2));
        expect(url.toString()).not.toContain(BigInt(c).toString());
      }
    }
  });

  test('a page older than a ledger the pass already saw is read again, so it covers that read', async () => {
    const { rpc } = await setup();
    await rpc.withEventPage(async () => {
      await rpc.getEvents({ contractId: POOL });
      latest = 120;
      // A cursor read (discovery's) reports a newer ledger...
      await rpc.getEvents({ contractId: POOL, startLedger: '0x64' as never });
      // ...so the next whole-history read does not reuse the older page.
      const page = await rpc.getEvents({ contractId: POOL });
      expect(page.latestLedger).toBe('0x78' as never);
      await rpc.getEvents({ contractId: POOL });
    });
    expect(wholePoolReads()).toHaveLength(2);
  });

  test('one head per pass, the pool only, and nothing kept after the pass', async () => {
    const { rpc } = await setup();
    await rpc.withEventPage(async () => {
      await Promise.all([rpc.getLatestLedger(), rpc.getLatestLedger(), rpc.getLatestLedger()]);
      await rpc.getEvents({ contractId: KEYSTORE });
      await rpc.getEvents({ contractId: KEYSTORE });
    });
    const heads = requested.filter((u) => BigInt(u.searchParams.get('fromLedger') ?? '0') > 10n ** 8n);
    expect(heads).toHaveLength(1);
    expect(requested.filter((u) => u.searchParams.get('contractId') === KEYSTORE)).toHaveLength(2);

    requested = [];
    await rpc.getEvents({ contractId: POOL });
    await rpc.getLatestLedger();
    await rpc.getLatestLedger();
    expect(wholePoolReads()).toHaveLength(1);
    expect(requested).toHaveLength(3);
  });
});

describe('a page fetched while a newer ledger was reported', () => {
  test('is not returned stale', async () => {
    const { rpc } = await setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      requested.push(url);
      if (first && url.searchParams.get('fromLedger') === '0') {
        first = false;
        await gate;
        return new Response(JSON.stringify({ events: [], latestLedger: '0x64' }), { status: 200 });
      }
      return new Response(JSON.stringify({ events: [], latestLedger: '0x78' }), { status: 200 });
    }) as typeof fetch;
    await rpc.withEventPage(async () => {
      const pending = rpc.getEvents({ contractId: POOL });
      await rpc.getEvents({ contractId: POOL, startLedger: '0x64' as never });
      release();
      expect((await pending).latestLedger).toBe('0x78' as never);
    });
  });
});
