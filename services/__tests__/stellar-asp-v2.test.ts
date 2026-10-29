// Stellar testnet against asp-v2: ASP data from the pool-scoped association-set routes, label
// status classified locally from bulk sets, every event read (and the sync head) from
// GET /202/public/events with nothing sent to Soroban RPC, and the relayer on its own URL.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import { createStellarRelayer } from '@/services/stellar/stellar-relayer';
import { createIndexedRpcInteractor, StellarTestnetAspProvider, type StellarSdk } from '@/services/stellar/stellar-runtime';

const ASP = 'https://asp.test';
const POOL = STELLAR_TESTNET_CONTRACTS.poolContractId;
const REGISTRY = STELLAR_TESTNET_CONTRACTS.aspRegistryContractId;

class ASPUnavailable extends Error {}
class RelayerRequestFailed extends Error {}
class RelayerRejected extends Error {}
const rpcCalls: string[] = [];
// The SDK pieces the runtime touches; every RPC method throws so a Soroban call fails the test.
const sdk = {
  ASPUnavailable,
  RelayerRequestFailed,
  RelayerRejected,
  assertFeeCommitmentLive: (expiration: number) => {
    if (expiration <= Date.now()) throw new Error('expired');
  },
  bigintToHex: (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`,
  SorobanRPCInteractor: class {
    async getEvents(): Promise<never> {
      rpcCalls.push('getEvents');
      throw new Error('RPC getEvents must not be called');
    }
    async getLatestLedger(): Promise<never> {
      rpcCalls.push('getLatestLedger');
      throw new Error('RPC getLatestLedger must not be called');
    }
  },
} as unknown as StellarSdk;

type Route = (url: URL) => { status?: number; body: unknown };
let route: Route;
const requested: string[] = [];
const bodies: unknown[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  requested.length = 0;
  bodies.length = 0;
  rpcCalls.length = 0;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    const { status = 200, body } = route(url);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const event = (id: string) => ({ id, type: 'deposited', ledger: '0x1', ledgerClosedAt: '', contractId: POOL, topics: [], data: '', transactionHash: '0x' });

describe('StellarTestnetAspProvider over asp-v2', () => {
  const provider = new StellarTestnetAspProvider(sdk, ASP);

  test('reads root and leaves from the pool-scoped routes, as padded hex', async () => {
    route = (url) =>
      url.pathname === '/association-set/root' ? { body: { root: '255' } } : { body: { leaves: ['1', '16'] } };

    expect(await provider.getRoot()).toBe(sdk.bigintToHex(255n));
    expect(await provider.getLeaves()).toEqual([sdk.bigintToHex(1n), sdk.bigintToHex(16n)]);
    for (const url of requested) {
      expect(new URL(url).searchParams.get('chainId')).toBe('202');
      expect(new URL(url).searchParams.get('entrypoint')).toBe(POOL);
    }
  });

  test('treats the "0" root of a pool with no published tree as unavailable', async () => {
    route = () => ({ body: { root: '0' } });
    await expect(provider.getRoot()).rejects.toBeInstanceOf(ASPUnavailable);
  });

  test('wraps an unreachable or failing ASP as ASPUnavailable', async () => {
    route = () => ({ status: 404, body: { message: 'unknown pool' } });
    await expect(provider.getLeaves()).rejects.toBeInstanceOf(ASPUnavailable);
  });

  const cases: [string, { rejected: string[]; poi: string[]; leaves: string[] }][] = [
    ['rejected', { rejected: ['7'], poi: ['7'], leaves: ['7'] }],
    ['poi_required', { rejected: [], poi: ['7'], leaves: ['7'] }],
    ['approved', { rejected: [], poi: [], leaves: ['7'] }],
    ['pending', { rejected: [], poi: [], leaves: ['8'] }],
  ];
  for (const [status, sets] of cases) {
    test(`classifies a label as ${status} from the bulk sets, never naming it in a request`, async () => {
      const bodies: Record<string, unknown> = {
        '/labels/rejected': { labels: sets.rejected },
        '/labels/poi-required': { labels: sets.poi },
        '/association-set/leaves': { leaves: sets.leaves },
      };
      // Any other path is a 404, so a renamed or unscoped route fails instead of falling through.
      route = (url) => (url.pathname in bodies ? { body: bodies[url.pathname] } : { status: 404, body: {} });

      expect(await provider.getLabelStatus(sdk.bigintToHex(7n))).toEqual({ status } as never);
      expect(requested.map((url) => new URL(url).pathname).sort()).toEqual(Object.keys(bodies).sort());
      for (const url of requested) {
        expect(new URL(url).searchParams.get('chainId')).toBe('202');
        expect(new URL(url).searchParams.get('entrypoint')).toBe(POOL);
      }
      expect(requested.every((url) => !url.includes('/7') && !url.includes(sdk.bigintToHex(7n)))).toBe(true);
    });
  }
});

describe('createIndexedRpcInteractor: asp-v2 as the single events source', () => {
  const rpc = createIndexedRpcInteractor(sdk, ASP);

  test('reads a contract history from /202/public/events', async () => {
    route = () => ({ body: { events: [event('0021263867686522880-0000000003')], latestLedger: '0x4ba513' } });

    const result = await rpc.getEvents({ contractId: REGISTRY, startLedger: '0x4b8a0b' as never });

    const url = new URL(requested[0]);
    expect(url.pathname).toBe('/202/public/events');
    expect(url.searchParams.get('contractId')).toBe(REGISTRY);
    expect(url.searchParams.get('fromLedger')).toBe(String(0x4b8a0b));
    expect(result).toEqual({
      events: [event('0021263867686522880-0000000003')],
      latestLedger: '0x4ba513',
      cursor: '0021263867686522880-0000000003',
    } as never);
    expect(rpcCalls).toEqual([]);
  });

  test('serves a pool cursor read from the whole history, dropping events at or before the cursor', async () => {
    const cursor = '0021263867686522880-0000000002';
    route = () => ({
      body: {
        events: [event('0021263867686522880-0000000001'), event(cursor), event('0021263867686522880-0000000003')],
        latestLedger: '0x4ba513',
      },
    });

    const result = await rpc.getEvents({ contractId: POOL, cursor });

    // The cursor never reaches the ASP: a dated read would tie this client to the spend it waits for.
    expect(new URL(requested[0]).searchParams.get('fromLedger')).toBe('0');
    expect(result.events.map((e) => e.id)).toEqual(['0021263867686522880-0000000003']);
    expect(result.cursor).toBe('0021263867686522880-0000000003');
  });

  test('serves a keystore sync from the whole history too, so it never names where this client left off', async () => {
    const atLedger = (ledger: bigint, i: number) => `${(ledger << 32n).toString().padStart(19, '0')}-${String(i).padStart(10, '0')}`;
    route = () => ({ body: { events: [event(atLedger(100n, 1)), event(atLedger(300n, 1))], latestLedger: '0x12c' } });

    const result = await rpc.getEvents({ contractId: STELLAR_TESTNET_CONTRACTS.keystoreContractId, startLedger: '200' } as never);

    expect(new URL(requested[0]).searchParams.get('fromLedger')).toBe('0');
    expect(result.events.map((e) => e.id)).toEqual([atLedger(300n, 1)]);
  });

  test("serves a pool start-ledger read (a relayed spend's confirmation poll) from the whole history", async () => {
    const atLedger = (ledger: bigint, i: number) => `${(ledger << 32n).toString().padStart(19, '0')}-${String(i).padStart(10, '0')}`;
    route = () => ({ body: { events: [event(atLedger(100n, 1)), event(atLedger(200n, 1)), event(atLedger(201n, 1))], latestLedger: '0xc9' } });

    const result = await rpc.getEvents({ contractId: POOL, startLedger: '200' } as never);

    expect(new URL(requested[0]).searchParams.get('fromLedger')).toBe('0');
    expect(result.events.map((e) => e.id)).toEqual([atLedger(200n, 1), atLedger(201n, 1)]);
  });

  test('keeps the cursor when nothing new is indexed', async () => {
    route = () => ({ body: { events: [], latestLedger: '0x4ba513' } });
    const cursor = '0021263867686522880-0000000003';

    expect((await rpc.getEvents({ contractId: POOL, cursor })).cursor).toBe(cursor);
  });

  test('reports asp-v2 coverage as the head, so a sync never passes what it indexed', async () => {
    route = () => ({ body: { events: [], latestLedger: '0x4ba513' } });

    expect(await rpc.getLatestLedger()).toBe('0x4ba513' as never);
    const url = new URL(requested[0]);
    expect(url.pathname).toBe('/202/public/events');
    expect(url.searchParams.get('contractId')).toBe(POOL);
    expect(BigInt(url.searchParams.get('fromLedger')!)).toBeGreaterThan(10n ** 8n);
    expect(rpcCalls).toEqual([]);
  });

  test('fails on a 503 (gap or not backfilled) instead of falling back to RPC', async () => {
    route = () => ({ status: 503, body: { message: 'not indexed yet' } });

    await expect(rpc.getEvents({ contractId: POOL, startLedger: '0x1' as never })).rejects.toBeInstanceOf(ASPUnavailable);
    await expect(rpc.getLatestLedger()).rejects.toBeInstanceOf(ASPUnavailable);
    expect(rpcCalls).toEqual([]);
  });
});

describe('Stellar relayer (v2 relayer routes)', () => {
  const RELAYER = 'https://relayer.test';
  const G = `G${'A'.repeat(55)}`;
  const ASSET = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;
  const relayer = createStellarRelayer(sdk, { url: RELAYER, relayerAddress: G });
  const commitment = {
    data: '0xabcd',
    asset: ASSET,
    expiration: Date.now() + 60_000,
    feeAmount: '50000',
    recipient: G,
    amountSent: '10050000',
    amountReceived: '10000000',
    signedRelayerCommitment: '0x99',
  };

  test('reports itself with the relay contract as processor, on the relayer chain id', async () => {
    const [info] = await relayer.getRelayers();
    expect(info).toMatchObject({ url: RELAYER, chainId: 1, chainType: 'stellar', address: G, processorAddress: STELLAR_TESTNET_CONTRACTS.relayContractId });
    expect(requested).toEqual([]);
  });

  test('asks for a committed receive quote and keeps the relayer commitment as signed', async () => {
    route = () => ({ status: 201, body: { feeAmount: '50000', amountSent: '10050000', amountReceived: '10000000', feeCommitment: commitment } });
    const [info] = await relayer.getRelayers();
    const quote = await relayer.getWithdrawalQuote(info, { amount: '0x989680', asset: ASSET, recipient: G } as never);

    expect(requested).toEqual([`${RELAYER}/v1/quote/stellar/1/receive`]);
    expect(bodies[0]).toEqual({ amount: '10000000', asset: ASSET, recipient: G, commit: true });
    expect(quote).toMatchObject({ txCost: '0', gasPrice: '0', feeAmount: '50000', amountSent: '10050000', amountReceived: '10000000' });
    expect(quote.feeCommitment).toEqual({ ...commitment, extraGas: false });

    await relayer.getWithdrawalQuote(info, { amount: '0x989680', asset: ASSET, recipient: G, shape: { n: 2, m: 2 } } as never);
    expect(bodies.at(-1)).toEqual({ amount: '10000000', asset: ASSET, recipient: G, commit: true, shape: { n: 2, m: 2 } });
  });

  test('relays the proof with the signed commitment unchanged, and surfaces a refusal', async () => {
    route = () => ({ status: 201, body: { txHash: '0xfeed' } });
    const [info] = await relayer.getRelayers();
    const p = (v: number) => `0x${v.toString(16)}`;
    const params = {
      proof: { proof: { pi_a: [p(1), p(2)], pi_b: [[p(3), p(4)], [p(5), p(6)]], pi_c: [p(7), p(8)] }, publicSignals: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] },
      inputNullifierNumber: 1,
      outputCommitmentNumber: 1,
      noteData: [{ hint: '0x01', data: '0x02' }],
      signedFeeCommitment: commitment,
    } as never;

    expect(await relayer.relayWithdrawal(info, params)).toBe('0xfeed');
    expect(requested).toEqual([`${RELAYER}/v1/relay/stellar/1/withdrawal`]);
    const body = bodies[0] as { proof: { publicSignals: string[]; b: string }; signedFeeCommitment: unknown };
    expect(body.signedFeeCommitment).toEqual(commitment);
    expect(body.proof.publicSignals).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(body.proof.b.slice(2, 66)).toBe('4'.padStart(64, '0'));

    route = () => ({ status: 400, body: { message: 'The provided fee commitment couldn\'t be verified', statusCode: 400 } });
    await expect(relayer.relayWithdrawal(info, params)).rejects.toThrow(/couldn't be verified/);
    await expect(relayer.relayWithdrawal(info, params)).rejects.toBeInstanceOf(RelayerRejected);
  });

  // Routes and bodies of v2-monorepo v2.0's StellarRelayerInteractor.getTransferQuote/relayTransfer (8abfc67f).
  const transferCommitment = { data: '0xabcd', asset: ASSET, expiration: Date.now() + 60_000, feeAmount: '200000', signedRelayerCommitment: '0x99' };
  const transferParams = () => {
    const p = (v: number) => `0x${v.toString(16)}`;
    return {
      proof: { proof: { pi_a: [p(1), p(2)], pi_b: [[p(3), p(4)], [p(5), p(6)]], pi_c: [p(7), p(8)] }, publicSignals: ['17', '18', '3', '4', '5', '6', '7', '8', '9', '10'] },
      inputNullifierNumber: 2,
      outputCommitmentNumber: 2,
      noteData: [{ hint: '0x01', data: '0x02' }],
      signedFeeCommitment: transferCommitment,
    } as never;
  };

  test('asks for a committed transfer quote naming only the asset', async () => {
    route = () => ({ status: 201, body: { feeAmount: '200000', txCost: '0', gasPrice: '0', feeCommitment: transferCommitment } });
    const [info] = await relayer.getRelayers();
    const quote = await relayer.getTransferQuote(info, { asset: ASSET, commit: true });

    expect(requested).toEqual([`${RELAYER}/v1/quote/stellar/1/transfer`]);
    expect(bodies[0]).toEqual({ asset: ASSET, commit: true });
    expect(quote).toEqual({ txCost: '0', gasPrice: '0', feeAmount: '200000', feeCommitment: transferCommitment });
  });

  test('a relayer without the transfer route fails the quote, it does not fall back', async () => {
    // What the relayer deployed 2026-09-30 (fde65488) answers.
    route = () => ({ status: 400, body: { message: 'Stellar private transfer quotes are not supported (see Scope in the Stellar plan)', statusCode: 400 } });
    const [info] = await relayer.getRelayers();
    await expect(relayer.getTransferQuote(info, { asset: ASSET, commit: true })).rejects.toBeInstanceOf(RelayerRequestFailed);
  });

  test('relays a transfer with the signed commitment unchanged', async () => {
    route = () => ({ status: 201, body: { txHash: '0xbeef' } });
    const [info] = await relayer.getRelayers();
    expect(await relayer.relayTransfer(info, transferParams())).toBe('0xbeef');
    expect(requested).toEqual([`${RELAYER}/v1/relay/stellar/1/transfer`]);
    const body = bodies[0] as Record<string, unknown> & { proof: { publicSignals: string[] } };
    expect(Object.keys(body).sort()).toEqual(['inputNullifierNumber', 'noteData', 'outputCommitmentNumber', 'proof', 'signedFeeCommitment']);
    expect(body.signedFeeCommitment).toEqual(transferCommitment);
    expect(body.proof.publicSignals).toEqual(['17', '18', '3', '4', '5', '6', '7', '8', '9', '10']);

    route = () => ({ status: 501, body: { message: 'Stellar private transfer relaying is not supported', statusCode: 501 } });
    await expect(relayer.relayTransfer(info, transferParams())).rejects.toBeInstanceOf(RelayerRejected);
  });

  test('forwards the proof shape the SDK prices a quote by', async () => {
    route = () => ({ status: 200, body: { feeAmount: '317289', txCost: '117289', gasPrice: '0', feeCommitment: transferCommitment } });
    const [info] = await relayer.getRelayers();
    await relayer.getTransferQuote(info, { asset: ASSET, commit: true, shape: { n: 1, m: 2 } } as never);
    expect(bodies.at(-1)).toEqual({ asset: ASSET, commit: true, shape: { n: 1, m: 2 } });
    await relayer.getTransferQuote(info, { asset: ASSET, commit: true });
    expect(bodies.at(-1)).toEqual({ asset: ASSET, commit: true });
  });

  test('swaps and announcements stay unsupported', async () => {
    const [info] = await relayer.getRelayers();
    expect(() => relayer.getSwapQuote(info, {} as never)).toThrow(/Not supported/);
  });
});
