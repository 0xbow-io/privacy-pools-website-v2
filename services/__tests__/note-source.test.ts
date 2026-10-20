import { describe, expect, test } from 'bun:test';
import { managerOwnsAccount, resolveNotePersistTarget } from '../note-source';

const A = '0xd3f927692168c7912189d95B1fB073eB0394dB15';
const B = '0x6A7DafCB5483Da70F5eDee1481A29C2004Cc3c81';
const target = (address: string, chainId = 11155111) => ({ address, chainId });

describe('managerOwnsAccount', () => {
  test('mine: the manager was built for the account on screen', () => {
    expect(managerOwnsAccount({
      hasManager: true, isInitialized: true, accountAddress: A, sessionTarget: target(A),
    })).toBe(true);
  });

  test('address casing does not matter', () => {
    expect(managerOwnsAccount({
      hasManager: true, isInitialized: true,
      accountAddress: A.toLowerCase(), sessionTarget: target(A.toUpperCase()),
    })).toBe(true);
  });

  test('the switch window: manager built for A, account is now B → NOT mine', () => {
    // This is the exact frame the fix exists for: sessionAddress has flipped to
    // B in render, the A manager is not yet torn down. Reporting A's notes here
    // leaked A's balance into B's hero (Pat, 2026-08-27).
    expect(managerOwnsAccount({
      hasManager: true, isInitialized: true, accountAddress: B, sessionTarget: target(A),
    })).toBe(false);
  });

  test('signed out: an account with no session target owns no manager', () => {
    expect(managerOwnsAccount({
      hasManager: true, isInitialized: true, accountAddress: null, sessionTarget: null,
    })).toBe(false);
  });

  test('a live manager with a target but no current account is not owned', () => {
    expect(managerOwnsAccount({
      hasManager: true, isInitialized: true, accountAddress: null, sessionTarget: target(A),
    })).toBe(false);
  });

  test('an account present but the session torn down (target null) is not owned', () => {
    expect(managerOwnsAccount({
      hasManager: true, isInitialized: true, accountAddress: A, sessionTarget: null,
    })).toBe(false);
  });

  test('no manager, or not yet initialized, is never owned', () => {
    expect(managerOwnsAccount({
      hasManager: false, isInitialized: true, accountAddress: A, sessionTarget: target(A),
    })).toBe(false);
    expect(managerOwnsAccount({
      hasManager: true, isInitialized: false, accountAddress: A, sessionTarget: target(A),
    })).toBe(false);
  });

  test('a different chain for the same address still counts as owned (address is the identity)', () => {
    // The stored-note fallback is per (address, chainId); the LIVE manager is
    // the active session, keyed by address here. A chain switch rebuilds the
    // session, so a mismatched chainId simply will not occur with hasManager.
    expect(managerOwnsAccount({
      hasManager: true, isInitialized: true, accountAddress: A, sessionTarget: target(A, 1),
    })).toBe(true);
  });
});

describe('resolveNotePersistTarget', () => {
  const SEPOLIA = 11155111;
  const OPTIMISM = 10;

  test('agreeing identities persist under that identity, undrifted', () => {
    expect(resolveNotePersistTarget({
      committed: target(A), renderAddress: A, renderChainId: SEPOLIA,
    })).toEqual({ action: 'persist', address: A, chainId: SEPOLIA, drifted: false });
  });

  test('casing alone is not drift', () => {
    const decision = resolveNotePersistTarget({
      committed: target(A), renderAddress: A.toLowerCase(), renderChainId: SEPOLIA,
    });
    expect(decision).toEqual({ action: 'persist', address: A, chainId: SEPOLIA, drifted: false });
  });

  test('the in-wallet switch: notes go to A even though the render already says B', () => {
    // Pat switched accounts inside MetaMask without disconnecting (2026-08-28).
    // wagmi reports B one render before the A session is torn down; a write
    // keyed on the render put A's notes in B's bucket, where they outlived the
    // reload and rendered as B's balance and B's Transfer In rows.
    const decision = resolveNotePersistTarget({
      committed: target(A), renderAddress: B, renderChainId: SEPOLIA,
    });
    expect(decision).toEqual({ action: 'persist', address: A, chainId: SEPOLIA, drifted: true });
  });

  test('the chain half drifts the same way, and is corrected the same way', () => {
    expect(resolveNotePersistTarget({
      committed: target(A, SEPOLIA), renderAddress: A, renderChainId: OPTIMISM,
    })).toEqual({ action: 'persist', address: A, chainId: SEPOLIA, drifted: true });
  });

  test('no render address is drift, not a reason to guess', () => {
    expect(resolveNotePersistTarget({
      committed: target(A), renderAddress: null, renderChainId: SEPOLIA,
    })).toEqual({ action: 'persist', address: A, chainId: SEPOLIA, drifted: true });
  });

  test('no committed session: skip the write rather than pick a bucket', () => {
    // Losing one sync's persistence is recoverable — the next sync rewrites it.
    // Writing the wrong account's bucket is not.
    for (const committed of [null, undefined]) {
      expect(resolveNotePersistTarget({
        committed, renderAddress: A, renderChainId: SEPOLIA,
      })).toEqual({ action: 'skip', reason: 'no-committed-session' });
    }
  });
});
