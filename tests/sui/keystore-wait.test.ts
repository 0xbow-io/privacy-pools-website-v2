/**
 * waitForKeystoreLeaf — the post-registration wait the spend paths rely on.
 *
 * QA regression (2026-07-10): a transfer from an account that only ever
 * RECEIVED a note (OOB import) died with "spender keystore leaf not found
 * on-chain" because the spend paths never registered the keystore auth policy.
 * The fix registers in prepareSpendInputs/ragequit and then waits for the leaf
 * via this helper — covering queryEvents indexing lag after set_auth_policy.
 *
 * The full hook wiring (prepareSpendInputs/ragequit calling
 * ensureKeystoreRegistered) has no unit harness here — the repo has no React
 * hook-testing setup — and is covered by the live browser e2e instead
 * (.pwcheck/keystore-qa-repro.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  waitForKeystoreLeaf,
  computeExpectedKeystoreLeaf,
  reconstructKeystoreProof,
} from '@/services/sui-witness/reconstruct';
import {
  calculateKeystoreLeaf,
  calculateNullifyingKeyHash,
  computeAuthDigestDirectKey,
} from '@/services/sui-witness/crypto';
import type { SuiChainReader } from '@/services/sui-witness/chain-reader';

const LEAF = 42n;

// The keystore tree is append-only (chain-reader enforces monotonically
// increasing LeafInserted indices), so a leaf registered after [7n, 9n] can
// only ever appear at the END.
function readerWithLeafAppendedAt(appearAtCall: number) {
  let calls = 0;
  return {
    calls: () => calls,
    reader: {
      reconstructKeystoreLeaves: async () => {
        calls++;
        return calls >= appearAtCall ? [7n, 9n, LEAF] : [7n, 9n];
      },
    } as unknown as SuiChainReader,
  };
}

describe('waitForKeystoreLeaf', () => {
  it('resolves with the appended leaf index once the leaf is indexed', async () => {
    const { reader, calls } = readerWithLeafAppendedAt(3);
    const index = await waitForKeystoreLeaf(reader, LEAF, { tries: 5, delayMs: 1 });
    expect(index).toBe(2);
    expect(calls()).toBe(3);
  });

  it('resolves immediately when the leaf is already there (single poll)', async () => {
    const { reader, calls } = readerWithLeafAppendedAt(1);
    const index = await waitForKeystoreLeaf(reader, LEAF, { tries: 5, delayMs: 1 });
    expect(index).toBe(2);
    expect(calls()).toBe(1);
  });

  it('throws a clear error when the leaf never appears, after exactly `tries` polls', async () => {
    const { reader, calls } = readerWithLeafAppendedAt(Number.MAX_SAFE_INTEGER);
    await expect(
      waitForKeystoreLeaf(reader, LEAF, { tries: 3, delayMs: 1 }),
    ).rejects.toThrow(/registration has not appeared on-chain/i);
    expect(calls()).toBe(3);
  });

  it('stops at the wall-clock deadline even with polls remaining', async () => {
    const { reader, calls } = readerWithLeafAppendedAt(Number.MAX_SAFE_INTEGER);
    await expect(
      waitForKeystoreLeaf(reader, LEAF, { tries: 1000, delayMs: 30, deadlineMs: 100 }),
    ).rejects.toThrow(/registration has not appeared on-chain/i);
    // ~100ms / 30ms-per-cycle => a handful of polls, nowhere near 1000.
    expect(calls()).toBeLessThan(10);
  });

  it('treats transient read failures as misses and preserves the last as cause', async () => {
    let calls = 0;
    const reader = {
      reconstructKeystoreLeaves: async () => {
        calls++;
        throw new Error(`rpc blip ${calls}`);
      },
    } as unknown as SuiChainReader;
    const failure = await waitForKeystoreLeaf(reader, LEAF, { tries: 3, delayMs: 1 }).then(
      () => null,
      (e: Error) => e,
    );
    expect(failure).not.toBeNull();
    expect((failure as Error & { cause?: Error }).cause?.message).toBe('rpc blip 3');
  });

  it('recovers when a failing reader starts answering', async () => {
    let calls = 0;
    const reader = {
      reconstructKeystoreLeaves: async () => {
        calls++;
        if (calls < 3) throw new Error('rpc blip');
        return [LEAF];
      },
    } as unknown as SuiChainReader;
    const index = await waitForKeystoreLeaf(reader, LEAF, { tries: 5, delayMs: 1 });
    expect(index).toBe(0);
    expect(calls).toBe(3);
  });
});

describe('computeExpectedKeystoreLeaf', () => {
  it('matches the leaf reconstructKeystoreProof looks for (same crypto path)', async () => {
    const owner = 123456789n;
    const nk = 111n;
    const rk = 222n;
    const expected = await calculateKeystoreLeaf(
      owner,
      await calculateNullifyingKeyHash(nk),
      await computeAuthDigestDirectKey(rk),
    );
    expect(await computeExpectedKeystoreLeaf(owner, nk, rk)).toBe(expected);

    // And reconstructKeystoreProof finds exactly that leaf: a reader exposing it
    // must NOT throw leaf-not-found (it may fail later on the root cross-check,
    // which this mock satisfies by returning the reconstructed root).
    const { createTreeWithLeaves, getRoot } = await import('@/services/sui-witness/merkle');
    const tree = await createTreeWithLeaves([expected]);
    const reader = {
      reconstructKeystoreLeaves: async () => [expected],
      getKeystoreCurrentRoot: async () => getRoot(tree),
    } as unknown as SuiChainReader;
    const result = await reconstructKeystoreProof(reader, owner, nk, rk);
    expect(result.leafIndex).toBe(0);
  });
});
