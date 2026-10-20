import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hash, Hex } from 'viem';
import {
  RelayedReceiptTimeout,
  forgetRelayedTxHashes,
  isRelayedTxHash,
  markRelayedTxHash,
  onRelayedTxHash,
  receiptFromLogs,
  recordRelayedHashes,
  waitForRelayedReceipt,
  type RawLog,
} from '../relayed-receipt';

const H = ('0x' + 'ab'.repeat(32)) as Hash;
const OTHER = ('0x' + 'cd'.repeat(32)) as Hash;
const REG = ('0x' + 'ef'.repeat(32)) as Hash;
const POOL = ('0x' + '11'.repeat(20)) as Hex;
const KEYSTORE = ('0x' + '22'.repeat(20)) as Hex;

afterEach(() => forgetRelayedTxHashes());

function log(tx: Hash | null, block: bigint, index = 0, address: Hex = POOL): RawLog {
  return { address, topics: [('0x' + 'ee'.repeat(32)) as Hex], data: '0x1234' as Hex, blockNumber: block, transactionHash: tx, logIndex: index };
}

describe('relayed hash registry', () => {
  test('a marked hash is relayed, case-insensitively; an unknown one is not', () => {
    markRelayedTxHash(H.toUpperCase().replace('0X', '0x'));
    expect(isRelayedTxHash(H)).toBe(true);
    expect(isRelayedTxHash(OTHER)).toBe(false);
  });

  test('only 32-byte hashes are recorded', () => {
    markRelayedTxHash('0x1234');
    expect(isRelayedTxHash('0x1234')).toBe(false);
  });

  test('a recorded hash expires after the TTL', () => {
    markRelayedTxHash(H, 1_000);
    expect(isRelayedTxHash(H, 1_000 + 60 * 60 * 1000)).toBe(true);
    expect(isRelayedTxHash(H, 1_000 + 60 * 60 * 1000 + 1)).toBe(false);
  });
});

describe('recordRelayedHashes', () => {
  test('records the hash a relay* method resolves to and returns it unchanged', async () => {
    const relayer = recordRelayedHashes({
      relayTransfer: async () => H,
      relayWithdrawal: async () => ({ txHash: OTHER }),
      submitRelayedRegistration: async () => REG,
      getTransferQuote: async () => 'not-a-hash',
    });
    expect(await relayer.relayTransfer()).toBe(H);
    expect(await relayer.relayWithdrawal()).toEqual({ txHash: OTHER });
    expect(await relayer.getTransferQuote()).toBe('not-a-hash');
    expect(await relayer.submitRelayedRegistration()).toBe(REG);
    expect(isRelayedTxHash(H)).toBe(true);
    expect(isRelayedTxHash(OTHER)).toBe(true);
    expect(isRelayedTxHash(REG)).toBe(true);
  });

  test('keeps the interactor as `this` for methods that use their own state', async () => {
    class Relayer {
      readonly url = 'https://relayer.example';
      async relaySwap() {
        return `${this.url.length ? '' : 'x'}${H}` as Hash;
      }
    }
    const relayer = recordRelayedHashes(new Relayer());
    expect(await relayer.relaySwap()).toBe(H);
    expect(isRelayedTxHash(H)).toBe(true);
  });

  test('beforeRelay sees the request and can refuse it before anything is sent', async () => {
    let sent = 0;
    const seen: unknown[] = [];
    const relayer = recordRelayedHashes(
      { relayTransfer: async (_relayer: unknown, _params: unknown) => { sent++; return H; } },
      { beforeRelay: (_method, params) => { seen.push(params); throw new Error('still pending'); } },
    );
    await expect(relayer.relayTransfer({}, { proof: 1 })).rejects.toThrow('still pending');
    expect(sent).toBe(0);
    expect(seen).toEqual([{ proof: 1 }]);
    expect(isRelayedTxHash(H)).toBe(false);
  });

  test('afterRelay hears the method, request and hash before listeners do, and a throw in it is contained', async () => {
    const order: string[] = [];
    const stop = onRelayedTxHash(() => order.push('listener'));
    const relayer = recordRelayedHashes(
      { relayWithdrawal: async (_relayer: unknown, _params: unknown) => ({ txHash: OTHER }) },
      { afterRelay: (method, params, hash) => { order.push(`after:${method}:${JSON.stringify(params)}:${hash === OTHER}`); throw new Error('storage full'); } },
    );
    try {
      expect(await relayer.relayWithdrawal({}, { n: 2 })).toEqual({ txHash: OTHER });
    } finally {
      stop();
    }
    expect(order).toEqual(['after:relayWithdrawal:{"n":2}:true', 'listener']);
    expect(isRelayedTxHash(OTHER)).toBe(true);
  });

  test('a relay answered without a hash releases what beforeRelay set up', async () => {
    const calls: string[] = [];
    const relayer = recordRelayedHashes(
      { relayTransfer: async (_relayer: unknown, _params: unknown) => ({ ok: true }) },
      {
        beforeRelay: () => 'reservation-1',
        afterRelay: () => { calls.push('after'); },
        onRelayFailed: (_method, _params, _err, context) => { calls.push(`failed:${context}`); },
      },
    );
    expect(await relayer.relayTransfer({}, {})).toEqual({ ok: true });
    expect(calls).toEqual(['failed:reservation-1']);
  });
});

describe('receiptFromLogs', () => {
  test('null when no log belongs to the transaction', () => {
    expect(receiptFromLogs(H, [log(OTHER, 10n), log(null, 11n)])).toBeNull();
  });

  test('keeps only the transaction’s own logs, raw topics and data included, status true', () => {
    const r = receiptFromLogs(H, [log(OTHER, 9n), log(H, 10n, 3), log(H, 10n, 4, KEYSTORE), log(null, 10n)]);
    expect(r).not.toBeNull();
    expect(r!.txHash).toBe(H);
    expect(r!.status).toBe(true);
    expect(r!.blockNumber).toBe('0xa');
    expect(r!.logs.map((l) => [l.address, l.logIndex, l.blockNumber])).toEqual([[POOL, 3, '0xa'], [KEYSTORE, 4, '0xa']]);
    expect(r!.logs[0].topics).toEqual(['0x' + 'ee'.repeat(32)]);
    expect(r!.logs[0].data).toBe('0x1234');
  });
});

// A short budget on a fake clock: a regression times out at once instead of
// looping for the real 180s default.
const FAST = (() => { let t = 0; return { budgetMs: 1_000, now: () => (t += 1) }; })();

describe('waitForRelayedReceipt', () => {
  test('scans by address and range only, and resolves once the logs show the transaction', async () => {
    const logCalls: { address: readonly Hex[]; fromBlock: bigint; toBlock: bigint }[] = [];
    const blockCalls: bigint[] = [];
    const heads = [100n, 101n];
    const client = {
      getBlockNumber: async () => heads.shift() ?? 101n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        blockCalls.push(blockNumber);
        return { transactions: blockNumber === 101n ? [OTHER, H] : [OTHER] };
      },
      getLogs: async (args: { address: readonly Hex[]; fromBlock: bigint; toBlock: bigint }) => {
        logCalls.push(args);
        return args.fromBlock <= 101n && args.toBlock >= 101n ? [log(H, 101n), log(OTHER, 101n)] : [];
      },
    };
    const r = await waitForRelayedReceipt(H, client, { addresses: [POOL, KEYSTORE], intervalMs: 1, sleep: async () => {}, lookbackBlocks: 3n });
    expect(r.status).toBe(true);
    expect(r.blockNumber).toBe('0x65');
    expect(r.logs).toHaveLength(1);
    // Blocks 97..100 on the first pass, 101 on the second; logs only for the block that mined it.
    expect(blockCalls).toEqual([97n, 98n, 99n, 100n, 101n]);
    // One up-front range scan (it had not mined yet), then the mined block only.
    expect(logCalls).toEqual([
      { address: [POOL, KEYSTORE], fromBlock: 0n, toBlock: 100n },
      { address: [POOL, KEYSTORE], fromBlock: 101n, toBlock: 101n },
    ]);
    // The hash itself is never part of a request.
    const wire = JSON.stringify({ blockCalls, logCalls }, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(wire).not.toContain(H.slice(2, 20));
  });

  test('DEV-412: a failed range scan is retried on the next tick', async () => {
    let scans = 0;
    const client = {
      getBlockNumber: async () => 500n,
      getBlock: async () => ({ transactions: [] }),
      getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) => {
        if (args.fromBlock === args.toBlock) return [];
        scans += 1;
        if (scans === 1) throw new Error('rpc hiccup');
        return args.fromBlock <= 300n ? [log(H, 300n)] : [];
      },
    };
    const r = await waitForRelayedReceipt(H, client, { addresses: [POOL], intervalMs: 1, sleep: async () => {}, ...FAST });
    expect(r.blockNumber).toBe('0x12c');
    expect(scans).toBe(2);
  });

  test('DEV-412: a hash returned only after it mined, far below the head, is found by the up-front scan', async () => {
    const blockCalls: bigint[] = [];
    const client = {
      getBlockNumber: async () => 200n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => { blockCalls.push(blockNumber); return { transactions: [] }; },
      getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) =>
        (args.fromBlock <= 160n && args.toBlock >= 160n ? [log(H, 160n)] : []),
    };
    const r = await waitForRelayedReceipt(H, client, { addresses: [POOL], intervalMs: 1, sleep: async () => {}, ...FAST });
    expect(r.status).toBe(true);
    expect(r.blockNumber).toBe('0xa0');
    expect(blockCalls).toEqual([]);
  });

  test('DEV-412: the default scan reaches a hash mined 800 blocks below the head', async () => {
    const client = {
      getBlockNumber: async () => 10_000n,
      getBlock: async () => ({ transactions: [] }),
      getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) =>
        (args.fromBlock <= 9_200n && args.toBlock >= 9_200n ? [log(H, 9_200n)] : []),
    };
    const r = await waitForRelayedReceipt(H, client, { addresses: [POOL], intervalMs: 1, sleep: async () => {}, ...FAST });
    expect(r.status).toBe(true);
  });

  test('DEV-412: a failed block read resumes at that block instead of ending the wait', async () => {
    let failOnce = true;
    const heads = [100n, 100n];
    const client = {
      getBlockNumber: async () => heads.shift() ?? 100n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        if (blockNumber === 99n && failOnce) { failOnce = false; throw new Error('rpc hiccup'); }
        return { transactions: blockNumber === 99n ? [H] : [] };
      },
      getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) => (args.fromBlock === 99n ? [log(H, 99n)] : []),
    };
    const r = await waitForRelayedReceipt(H, client, { addresses: [POOL], intervalMs: 1, sleep: async () => {}, ...FAST, lookbackBlocks: 2n });
    expect(r.status).toBe(true);
    expect(r.blockNumber).toBe('0x63');
  });

  test('DEV-412: the relayed hash is announced with the method that returned it', async () => {
    const heardFrom: (string | null)[] = [];
    const offMethod = onRelayedTxHash((_h, m) => heardFrom.push(m));
    const relayer = recordRelayedHashes({
      relayTransfer: async () => ({ txHash: H }),
      relaySwap: async () => ({ txHash: OTHER }),
    });
    await relayer.relayTransfer();
    await relayer.relaySwap();
    offMethod();
    expect(heardFrom).toEqual(['relayTransfer', 'relaySwap']);
  });

  test('DEV-412: the relayed hash is announced the moment it is recorded', () => {
    const heard: string[] = [];
    const off = onRelayedTxHash((h) => heard.push(h));
    markRelayedTxHash(H);
    off();
    markRelayedTxHash(OTHER);
    expect(heard).toEqual([H]);
  });

  test('mined without a log on either contract reads as a reverted receipt, the way viem would', async () => {
    const client = {
      getBlockNumber: async () => 100n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ transactions: blockNumber === 99n ? [{ hash: H }] : [] }),
      getLogs: async () => [] as RawLog[],
    };
    const r = await waitForRelayedReceipt(H, client, { addresses: [POOL, KEYSTORE], intervalMs: 1, sleep: async () => {}, lookbackBlocks: 3n });
    expect(r).toEqual({ txHash: H, status: false, blockNumber: '0x63', logs: [] });
  });

  test('throws the timeout, without the hash in the message, when the budget runs out', async () => {
    let t = 0;
    const client = {
      getBlockNumber: async () => 50n,
      getBlock: async () => ({ transactions: [OTHER] }),
      getLogs: async () => [] as RawLog[],
    };
    const p = waitForRelayedReceipt(H, client, {
      addresses: [POOL],
      intervalMs: 10,
      budgetMs: 25,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    });
    await expect(p).rejects.toBeInstanceOf(RelayedReceiptTimeout);
    await expect(p).rejects.toThrow(/not observed/);
    await p.catch((e: Error) => expect(e.message).not.toContain('ab'.repeat(8)));
  });
});

describe('the RPC wrapper answers relayed receipt waits from bulk logs', () => {
  const source = readFileSync(fileURLToPath(new URL('../sdk-setup.ts', import.meta.url)), 'utf8');
  const start = source.indexOf('  waitForTransactionReceipt(');
  const end = source.indexOf('\n  }\n', start) + 4;
  const body = source.slice(start, end);

  test('a relayed hash is routed to waitForRelayedReceipt, anything else forwards once', () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toContain('isRelayedTxHash(');
    expect(body).toContain('waitForRelayedReceipt(');
    expect((body.match(/inner\.waitForTransactionReceipt\(/g) ?? []).length).toBe(1);
  });

  test('the relayer interactor the app builds records its hashes', () => {
    expect(source).toContain('recordRelayedHashes(new RelayerInteractor(');
  });
});
