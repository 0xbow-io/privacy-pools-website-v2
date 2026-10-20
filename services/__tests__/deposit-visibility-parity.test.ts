/**
 * Both deposit paths must make the deposit VISIBLE the same way, and from what
 * this client already knows.
 *
 * `components/deposit-modal-provider.tsx` runs two flows. The ordinary deposit
 * adds an optimistic row the moment it broadcasts and writes its note at
 * confirmation. The swap-funded deposit did neither: it re-read local state and
 * invalidated caches, so a deposit that was already final on chain waited for
 * whatever background trigger came next.
 *
 * Measured on prod, 2026-09-22. Mike's swap-deposit 0x99c6b191 mined at
 * 13:18:47 with the Entrypoint, the PoolVault, ppUSDC and its zap all logged in
 * that single transaction, and the row appeared 190 seconds later. Nothing was
 * pending on LiFi; the whole delay was this asymmetry.
 *
 * It was first closed with discovery passes 5 and 15 seconds after the
 * confirmation. Those told the ASP and the RPC provider which deposit was this
 * client's, so both paths now write the prepared note locally instead, and
 * neither scans: the feed grid's own discovery confirms the rest.
 *
 * A source check rather than a behavioural one, deliberately: the gap was not a
 * wrong value anywhere, it was one branch of a component not doing what the
 * other branch does, and a bun test cannot mount this provider. What can be
 * asserted cheaply is that neither half loses its visibility work again.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const SOURCE = readFileSync(join(ROOT, 'components/deposit-modal-provider.tsx'), 'utf8');

/** The optimistic row: shown from local state, costing no request at all. */
const OPTIMISTIC_ROW = /addPendingOwnRow\(pendingDepositRow\(/g;

describe('both deposit paths show the deposit without waiting for a sync', () => {
  test('each path adds its own optimistic row', () => {
    // One for the ordinary deposit, one for the swap-funded deposit. If this
    // drops to 1, a path went back to waiting.
    expect(SOURCE.match(OPTIMISTIC_ROW)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('the swap path writes its note locally, as the ordinary path does', () => {
    const swap = SOURCE.slice(SOURCE.indexOf("log('info', 'Deposit', 'Swap-and-deposit confirmed'"));
    expect(swap.slice(0, swap.indexOf('setStep(\'success\')'))).toContain('await recordOwnDepositNote(prepared.pendingNote, swapHash as Hex, swapReceipt.blockNumber)');
  });

  test('the ordinary path writes its note locally too', () => {
    expect(SOURCE).toContain('if (persistOwnNote) await recordOwnDepositNote(result.pendingNote, hash as Hex, receipt.blockNumber)');
  });

  test('neither path runs discovery after its own confirmation', () => {
    expect(SOURCE).not.toMatch(/\.discoverNotes\(|syncFromSnapshot|syncAllChains/);
    expect(SOURCE).not.toContain('scheduleDepositResync');
  });

  test('a depositFor adds no row for the payer, on either path', () => {
    // The row would read as the payer's own pending balance for a deposit that
    // is the recipient's. Both guards are spelled the same way.
    expect(SOURCE.match(/if \(!recipientMode\) \{\s*\n\s*addPendingOwnRow/g)?.length ?? 0).toBe(1);
    // The swap path's row builder (DEV-433: added at broadcast and at receipt).
    expect(SOURCE).toContain('if (recipientMode) return;\n            addPendingOwnRow(pendingDepositRow({');
  });
});
