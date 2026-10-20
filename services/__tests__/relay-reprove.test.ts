import { describe, expect, test } from 'bun:test';
import { FeeCommitmentExpired, RelayerRejected } from '@privacy-pools-v2/sdk';
import { isReprovableRelayRefusal, MAX_REPROVES, relayWithReprove } from '@/services/relayed-transfer';
import {
  BatchPartiallyWithdrawnError,
  classifyBatchRelayError,
  noteManagerLimitedTo,
  subBatchSize,
  withdrawGroupsWithinWindow,
  type BatchGroup,
} from '@/services/batch-withdrawals';
import { feeWithinReviewed } from '@/services/relayer-fee-jitter';
import { isKnownRejection } from '@/services/transfer-outcome';
import { isFeeCommitmentExpired } from '@/services/fee-commitment';
import { NoteStatus, type Note } from '@/services/sdk-types';

// The exact text the staging relayer returned in run 37814573628.
const staleRoot = () => new RelayerRejected('HTTP 400: {"message":"PoolVault transact failed: The contract function \\"transact\\" reverted (PoolVault_InvalidASPRoot).","error":"Bad Request","statusCode":400}');
const expired = () => new FeeCommitmentExpired('Fee commitment expired at 1791483008789, current time 1791483009992');

describe('isReprovableRelayRefusal', () => {
  test('a moved root and an expired quote are re-provable, other refusals are not', () => {
    expect(isReprovableRelayRefusal(staleRoot())).toBe(true);
    expect(isReprovableRelayRefusal(expired())).toBe(true);
    expect(isReprovableRelayRefusal(new RelayerRejected('HTTP 400: {"message":"PoolVault transact failed: PoolVault_UnknownStateRoot"}'))).toBe(false);
    expect(isReprovableRelayRefusal(new Error('PoolVault_InvalidASPRoot'))).toBe(false);
  });
});

describe('relayWithReprove', () => {
  const base = { shouldContinue: () => true, onReprove: () => {} };

  test('re-proves with a fresh option after a moved root and returns the option that landed', async () => {
    const tried: number[] = [];
    let fresh = 1;
    const out = await relayWithReprove({
      ...base,
      option: 0,
      relay: async (o: number) => { tried.push(o); if (o < 2) throw staleRoot(); return 'ok'; },
      refresh: async () => fresh++,
    });
    expect(out).toEqual({ result: 'ok', option: 2 });
    expect(tried).toEqual([0, 1, 2]);
  });

  test('is bounded', async () => {
    let relays = 0;
    await expect(relayWithReprove({
      ...base, option: 0, relay: async () => { relays++; throw expired(); }, refresh: async () => 0,
    })).rejects.toBeInstanceOf(FeeCommitmentExpired);
    expect(relays).toBe(MAX_REPROVES + 1);
  });

  test('never re-proves once something was sent, or for another refusal', async () => {
    let relays = 0;
    await expect(relayWithReprove({
      ...base, option: 0, sent: () => true, relay: async () => { relays++; throw staleRoot(); }, refresh: async () => 0,
    })).rejects.toBeInstanceOf(RelayerRejected);
    await expect(relayWithReprove({
      ...base, option: 0, relay: async () => { relays++; throw new Error('timeout'); }, refresh: async () => 0,
    })).rejects.toThrow('timeout');
    expect(relays).toBe(2);
  });

  test('a fresh quote that fails is a known refusal, never an unknown outcome', async () => {
    const error = await relayWithReprove({
      ...base, option: 0, relay: async () => { throw staleRoot(); }, refresh: async () => { throw new Error('relayer unreachable'); },
    }).catch((e) => e) as Error;
    expect(error.message).toContain('relayer unreachable');
    expect(isKnownRejection(error.message)).toBe(true);
  });

  test('a run the user left asks for nothing more', async () => {
    let refreshes = 0;
    await expect(relayWithReprove({
      ...base, shouldContinue: () => false, option: 0, relay: async () => { throw staleRoot(); }, refresh: async () => refreshes++,
    })).rejects.toBeInstanceOf(RelayerRejected);
    expect(refreshes).toBe(0);
  });
});

describe('batch: a moved root is a pre-submit refusal', () => {
  test('classifyBatchRelayError', () => {
    expect(classifyBatchRelayError(staleRoot().message)).toBe('pre-submit');
  });
});

describe('subBatchSize', () => {
  test('six proofs in 62 s split to three per batch', () => {
    expect(subBatchSize({ groups: 6, provingMs: 62_000 })).toBe(3);
  });
  test('always splits a batch that ran out of time, never below one', () => {
    expect(subBatchSize({ groups: 6, provingMs: 1_000 })).toBe(5);
    expect(subBatchSize({ groups: 2, provingMs: 600_000 })).toBe(1);
    expect(subBatchSize({ groups: 1, provingMs: 90_000 })).toBe(1);
  });
});

const group = (i: number, amount = 1000n): BatchGroup => ({ label: `L${i}`, inputCommitments: [`c${i}`], amountOut: amount });
// The relayer prices per item, so a batch of n groups costs n * PER.
const PER = 1_650_008_450_000n; // the staging per-item fee, 2026-10-08

function harness(opts: { slowFrom?: number; staleOnce?: boolean; feePer?: (n: number) => bigint; failAt?: number; failWith?: string } = {}) {
  let clock = 0;
  let staleLeft = opts.staleOnce ? 1 : 0;
  const prepared: number[] = [];
  const relayed: number[] = [];
  return {
    prepared, relayed,
    run: (groups: BatchGroup[]) => withdrawGroupsWithinWindow({
      groups,
      reviewedTotalFeeWei: PER * BigInt(groups.length),
      feeOk: feeWithinReviewed,
      now: () => clock,
      prepare: async (chunk) => {
        prepared.push(chunk.length);
        clock += chunk.length * 10_000; // 10 s per proof
        return {
          totalAmountOut: chunk.reduce((s, g) => s + g.amountOut, 0n),
          totalFee: opts.feePer ? opts.feePer(chunk.length) : PER * BigInt(chunk.length),
          size: chunk.length,
        };
      },
      relay: async (p) => {
        if (staleLeft > 0) { staleLeft--; throw staleRoot(); }
        // The quote outlives at most 5 proofs.
        if (p.size * 10_000 > 50_000) throw expired();
        if (opts.failAt !== undefined && relayed.length === opts.failAt) throw new Error(opts.failWith ?? 'relayer down');
        relayed.push(p.size);
        return { txHash: `0x${relayed.length}` as `0x${string}` };
      },
      isReprovable: isReprovableRelayRefusal,
      outcomeKnown: (e) => !(e instanceof Error && e.message === 'receipt timeout'),
      isQuoteExpiry: isFeeCommitmentExpired,
      shouldContinue: () => true,
      onReprove: () => {},
      onConfirmed: () => {},
    }),
  };
}

describe('withdrawGroupsWithinWindow', () => {
  test('a batch that proves in time goes as one', async () => {
    const h = harness();
    const out = await h.run([1, 2, 3].map((i) => group(i)));
    expect(h.relayed).toEqual([3]);
    expect(out?.amountOutWei).toBe(3000n);
    expect(out?.feeWei).toBe(3n * PER);
  });

  test('six proofs that outlast the quote are split, at the same total fee', async () => {
    const h = harness();
    const out = await h.run([1, 2, 3, 4, 5, 6].map((i) => group(i)));
    expect(h.prepared[0]).toBe(6);
    expect(h.relayed).toEqual([3, 3]);
    expect(out?.amountOutWei).toBe(6000n);
    expect(out?.feeWei).toBe(6n * PER);
  });

  test('a moved root is proved again at the same size', async () => {
    const h = harness({ staleOnce: true });
    await h.run([1, 2].map((i) => group(i)));
    expect(h.prepared).toEqual([2, 2]);
    expect(h.relayed).toEqual([2]);
  });

  test('sub-batches that together cost more than reviewed stop before sending', async () => {
    const h = harness({ feePer: (n) => n === 6 ? PER * 6n : (PER * BigInt(n) * 103n) / 100n });
    await expect(h.run([1, 2, 3, 4, 5, 6].map((i) => group(i)))).rejects.toBeInstanceOf(BatchPartiallyWithdrawnError);
    // The first sub-batch (3% over its share) still fits the reviewed total;
    // the second would not, so it is never sent.
    expect(h.relayed).toEqual([3]);
  });

  test('a later failure reports what already moved', async () => {
    const h = harness({ failAt: 1 });
    const error = await h.run([1, 2, 3, 4, 5, 6].map((i) => group(i))).catch((e) => e);
    expect(error).toBeInstanceOf(BatchPartiallyWithdrawnError);
    expect((error as BatchPartiallyWithdrawnError).confirmed.map((c) => c.amountOutWei)).toEqual([3000n]);
  });

  test('a later failure whose outcome is unknown never claims the rest is shielded', async () => {
    const h = harness({ failAt: 1, failWith: 'receipt timeout' });
    const error = await h.run([1, 2, 3, 4, 5, 6].map((i) => group(i))).catch((e) => e) as BatchPartiallyWithdrawnError;
    expect(error.lastOutcomeUnknown).toBe(true);
    expect(error.message).toContain('may still have been sent');
    expect(error.message).not.toContain('still shielded');
  });

  test('a prepared batch releasing a different amount is never sent', async () => {
    const out = withdrawGroupsWithinWindow({
      groups: [group(1)], reviewedTotalFeeWei: PER, feeOk: feeWithinReviewed,
      prepare: async () => ({ totalAmountOut: 999n, totalFee: PER }),
      relay: async () => { throw new Error('must not relay'); },
      isReprovable: () => false, outcomeKnown: () => true, isQuoteExpiry: () => false, shouldContinue: () => true,
      onReprove: () => {}, onConfirmed: () => {},
    });
    await expect(out).rejects.toThrow('balance changed');
  });
});

describe('noteManagerLimitedTo', () => {
  const note = (commitment: string, status: NoteStatus) => ({ commitment, status } as unknown as Note);
  class Store {
    notes = [note('a', NoteStatus.ACTIVE), note('b', NoteStatus.ACTIVE), note('c', NoteStatus.SPENT)];
    writes: string[] = [];
    getNotes() { return this.notes; }
    markSpent(c: string) { this.writes.push(c); }
  }
  test('limits ACTIVE notes, keeps the rest, and writes to the real store', () => {
    const store = new Store();
    const view = noteManagerLimitedTo(store, new Set(['b']));
    expect(view.getNotes().map((n) => n.commitment)).toEqual(['b', 'c']);
    view.markSpent('b');
    expect(store.writes).toEqual(['b']);
    expect(view instanceof Store).toBe(true);
  });
});
