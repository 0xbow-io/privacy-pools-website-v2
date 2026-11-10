/**
 * DEV-590: the first swap of a fresh session said "None of your ETH notes are
 * approved yet. 0.00999 ppETH is waiting" for notes approved days earlier, and
 * a retry worked.
 *
 * The swap resolved approval on its own, once per open: one
 * `aspClient.getMerkleProof()` per note, each of which downloads the whole
 * association set, and ANY failure (the ASP backoff window, a pacing refusal,
 * a root mismatch while the on-chain root moves) was caught as "this label is
 * not in the set". The answer was also taken from the notes held at the moment
 * of opening, so notes that synced after the Swap tab opened were never
 * checked at all. Both read as "not approved", and the shortfall copy named
 * every unchecked note as waiting.
 *
 * The fix reads the one shared gate (hooks/use-leaf-gate.ts, the session's
 * bulk association set), and only a verified answer for the notes being spent
 * can produce the "waiting" message.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOADING_GATE, failedLeafGate, type LeafGate } from '@/services/leaf-gate';
import { noteShortfall, noteShortfallMessage } from '@/services/swap-note-shortfall';
import {
  SWAP_APPROVAL_CHECKING,
  SWAP_APPROVAL_UNAVAILABLE,
  swapApprovalBlock,
  swapApprovalFromGate,
} from '@/services/swap-note-approval';

const notes = (...commitments: string[]) => commitments.map((commitment) => ({ commitment }));
const ready = (...confirmed: string[]): LeafGate => ({ status: 'ready', confirmed: new Set(confirmed) });

describe('first swap of a session: approval not loaded is not "not approved"', () => {
  test('before the association set answers, the swap is checking, not refusing', () => {
    const approval = swapApprovalFromGate(LOADING_GATE, notes('0xa'));
    expect(approval.status).toBe('checking');
    expect(swapApprovalBlock(approval, ['0xa'])).toEqual({ reason: 'unresolved', error: SWAP_APPROVAL_CHECKING });
  });

  test('a failed ASP read is a retryable state, never a wait for approval', () => {
    const approval = swapApprovalFromGate(failedLeafGate('Rate limit exceeded'), notes('0xa'));
    expect(approval.status).toBe('unavailable');
    const block = swapApprovalBlock(approval, ['0xa']);
    expect(block?.reason).toBe('unresolved');
    expect(block?.error).toBe(SWAP_APPROVAL_UNAVAILABLE);
    expect(block?.error).not.toMatch(/approved yet|waiting/i);
  });

  test('a note that synced after the check is re-checked, not reported as waiting', () => {
    // Opened with one note; the session then synced a second. The old answer
    // covered only the first, so the second read as unapproved.
    const approval = swapApprovalFromGate(ready('0xa'), notes('0xa'));
    expect(swapApprovalBlock(approval, ['0xa', '0xb'])).toEqual({ reason: 'unresolved', error: SWAP_APPROVAL_CHECKING });
  });

  test('a verified answer for every held note lets the selection decide', () => {
    const approval = swapApprovalFromGate(ready('0xa'), notes('0xa', '0xb'));
    expect(swapApprovalBlock(approval, ['0xa', '0xb'])).toBeNull();
    expect(approval.status === 'ready' && approval.approved.has('0xa')).toBe(true);
    expect(approval.status === 'ready' && approval.approved.has('0xb')).toBe(false);
  });

  test('only that verified answer can produce the waiting message, and it names the coin', () => {
    const approval = swapApprovalFromGate(ready(), notes('0xa'));
    expect(swapApprovalBlock(approval, ['0xa'])).toBeNull();
    const text = noteShortfallMessage(
      noteShortfall({ totalWei: 9_990_000_000_000_000n, approvedWei: 0n, selectableWei: 0n }),
      { symbol: 'ppETH', decimals: 18 },
    );
    expect(text).toContain('None of your ETH notes are approved yet.');
    expect(text).not.toMatch(/\bpp[A-Z]/);
  });

  test('the copy has no em dash', () => {
    expect(SWAP_APPROVAL_CHECKING).not.toContain('—');
    expect(SWAP_APPROVAL_UNAVAILABLE).not.toContain('—');
  });
});

describe('the swap provider reads the shared gate', () => {
  const src = readFileSync(join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'swap-modal-provider.tsx'), 'utf8');

  test('no per-note association-set download whose failure reads as "not approved"', () => {
    expect(src).not.toContain('getMerkleProof(');
    expect(src).not.toContain('setSpendableCommitments(');
  });

  test('approval comes from useLeafGate over the session notes, and gates every selection', () => {
    expect(src).toContain('useLeafGate(');
    expect(src).toContain('swapApprovalFromGate(');
    expect(src).toContain('swapApprovalBlock(');
  });
});
