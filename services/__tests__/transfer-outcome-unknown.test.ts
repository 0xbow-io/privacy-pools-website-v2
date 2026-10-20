import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/**
 * DEV-412: copying the one-time receipt secured it and unlocked retries, and
 * the same flag drove the header, so "Transfer outcome unknown" flipped to
 * "Transfer Successful" with nothing verified. The header now has its own
 * flag, cleared only by an on-chain observation (or a fresh open).
 */
describe('unknown transfer outcome stays unknown until the chain says otherwise', () => {
  const src = readFileSync(join(ROOT, 'components/transfer-modal-provider.tsx'), 'utf8');

  test('the header and subtitle read outcomeUnknown, not the retry latch', () => {
    expect(src).toContain('{outcomeUnknown ? (');
    // A relay still pending (DEV-458) is not "sent" either.
    expect(src).toContain("{outcomeUnknown || relayPending ? 'addressed privately to' : 'sent privately to'}");
    expect(src).not.toContain('{indeterminateAttempt ? (');
  });

  test('nothing but a resolved outcome and a fresh open clears it', () => {
    const clears = src.split('setOutcomeUnknown(false)').length - 1;
    // Observed spend, a settled revert, a settled competing spend, and the
    // open reset — every one a resolved outcome, never a bare retry/copy.
    expect(clears).toBe(4);
    const observed = src.indexOf("'Unresolved transfer observed on-chain'");
    const clear = src.indexOf('setOutcomeUnknown(false)');
    expect(observed).toBeGreaterThan(-1);
    // The first clear is the observed-spend one; the last is the open reset.
    expect(clear).toBeGreaterThan(observed);
    expect(src.indexOf('setOutcomeUnknown(false);\n    setTxHash(null);')).toBeGreaterThan(-1);
    // The pending-relay settlement's own clears: a revert releases the retry
    // latch (indeterminateAttempt), a competing spend is shown as spent.
    const settledOurs = src.indexOf('const settledOurs = (resolution: PendingRelayResolution) => {');
    expect(settledOurs).toBeGreaterThan(-1);
    const settledOursEnd = src.indexOf('void relayRun.settled?.then(settledOurs);', settledOurs);
    expect(settledOursEnd).toBeGreaterThan(settledOurs);
    const settledOursBody = src.slice(settledOurs, settledOursEnd);
    expect(settledOursBody.split('setOutcomeUnknown(false)').length - 1).toBe(2);
    expect(settledOursBody).toContain('setIndeterminateAttempt(false);');
    expect(settledOursBody).toContain("setRelayPending('other-spend');");
  });

  test('a late-found send gets the success path\'s own-action stamp, its inputs marked spent, and onSent', () => {
    // One helper stamps a send found late, whether by the bulk index or by
    // its pending-relay record settling (DEV-458); the background look calls it.
    const start = src.indexOf("'Unresolved transfer observed on-chain'");
    const end = src.indexOf('})().catch(() => { /* stays unknown */ });', start);
    // A lost anchor must fail, not widen the window to the end of the file.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const bg = src.slice(start, end);
    expect(bg).toContain("recordOwnAction({ kind: forcedInputs ? 'consolidate' : 'send'");
    expect(bg).toContain('recordSentTransfer({');
    // Marked locally, so the next send cannot reselect them; no discovery
    // pass timed to the spend landing.
    expect(bg).toContain('manager.updateNoteStatus(commitment, NoteStatus.SPENT)');
    expect(bg).not.toContain('syncFromSnapshot');
    expect(bg).not.toContain('discoverNotes');
    expect(bg).toContain('onSent?.(landedHash');
    expect(bg).toContain('await stampLanded(observed.txHash, run, pendingAuditKey);');
    // The relayer fee the relayed branch quoted is stamped under the found hash.
    expect(bg).toContain('recordWithdrawFee({');
    expect(src).toContain('if (bgRun) bgRun.feeWei = quotedRelayFee;');
  });

  test('the relayed hash moves the stepper on while the SDK still waits', () => {
    const hear = src.indexOf('onRelayedTxHash((relayedHash, method) => {');
    expect(src).toContain("if (method !== 'relayTransfer' || !live()) return;");
    expect(hear).toBeGreaterThan(-1);
    expect(hear).toBeLessThan(src.indexOf('relay: (option) => session.relayTransfer(option)'));
    expect(src).toContain('stopHearingRelay();');
  });
});
