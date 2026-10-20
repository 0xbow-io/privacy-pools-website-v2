import { describe, expect, test } from 'bun:test';
import { depositRowChainPolicy } from '../deposit-row-chain';

const SEPOLIA = 11155111;
const OPTIMISM = 10;

describe('depositRowChainPolicy', () => {
  test('the active chain is leaf-gated, because it is the set we loaded', () => {
    expect(depositRowChainPolicy({
      txChainId: SEPOLIA, activeChainId: SEPOLIA, balanceCountsPending: false,
    })).toEqual({ leafGated: true, showAsMissing: false });
  });

  test('another chain is NOT leaf-gated — its labels are absent from this set by construction', () => {
    // Gating an Optimism note on Sepolia's leaves is guaranteed to miss, which
    // is half of why every OP row read pending (Pat, 2026-08-28).
    expect(depositRowChainPolicy({
      txChainId: OPTIMISM, activeChainId: SEPOLIA, balanceCountsPending: false,
    }).leafGated).toBe(false);
  });

  test('the row follows the balance, on any chain — never its own re-derivation', () => {
    // Pat's shot: the balance read "9.0000 USDC pending" beside three ticked
    // Optimism deposit rows. One verdict, one source (#213).
    for (const txChainId of [SEPOLIA, OPTIMISM]) {
      expect(depositRowChainPolicy({
        txChainId, activeChainId: SEPOLIA, balanceCountsPending: true,
      }).showAsMissing).toBe(true);
      expect(depositRowChainPolicy({
        txChainId, activeChainId: SEPOLIA, balanceCountsPending: false,
      }).showAsMissing).toBe(false);
    }
  });
});
