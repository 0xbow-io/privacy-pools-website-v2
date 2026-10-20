import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A relay call that fails after the relayer broadcast used to end on "outcome
// unknown" with the placeholder receipt, for a transfer that had landed (Mike,
// 2026-09-24). The Send flow now looks for its own spend in the bulk index
// before giving up, and never by asking about a transaction hash.
const src = readFileSync(fileURLToPath(new URL('../../components/transfer-modal-provider.tsx', import.meta.url)), 'utf8');
const block = src.slice(src.indexOf('} catch (relayErr) {'), src.indexOf("hash = transferResult.txReceipt.txHash as Hash;"));

describe('Send: a relay error after broadcast checks whether the transfer landed', () => {
  test('the fallback exists and uses the bulk confirmation', () => {
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("await import('@/services/onchain-note-index')");
    expect(block).toContain('inputCommitments: verifiedInputCommitments');
  });

  test('known non-sends are rethrown untouched', () => {
    for (const guard of ['isKnownRejection(relayMessage)', 'isConfirmedRevert(relayMessage)', 'isRelayerRefusal(relayMessage)', 'isRelayerOutOfGas(relayMessage)', 'isPendingRelayBlocked(relayMessage)', 'isRelayerNullifierInFlight(relayMessage)']) {
      expect(block).toContain(guard);
    }
  });

  test('only a spend with our own outputs or the relayer\'s own hash is adopted, and the wait is short', () => {
    expect(block).toContain('(landed.outputsMatch === false && !landedIsOurs)) throw relayErr');
    // Any other spend of the inputs is an earlier attempt (DEV-458), named as such.
    expect(block).toContain('relayRun.otherSpendHash = landed.txHash');
    expect(block).toContain('budgetMs: 40_000');
  });

  test('no request names the transaction', () => {
    expect(block).not.toContain('waitForTransactionReceipt');
    expect(block).not.toContain('getTransaction');
  });
});
