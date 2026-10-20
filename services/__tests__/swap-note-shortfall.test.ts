/**
 * Three limits, three sentences. The one message that used to cover all of
 * them read as "a swap cannot spend two notes" (Mike, 2026-09-23), which is
 * not what any of them say: a swap spends up to five, the same as a withdraw.
 * The five is the SWAP's proof limit and nothing wider; a batch withdraw
 * exists precisely because a withdrawal is not bound by it.
 */
import { describe, expect, test } from 'bun:test';

import { noteShortfall, noteShortfallMessage } from '../swap-note-shortfall';

const USDC = { symbol: 'USDC', decimals: 6 };
const u = (n: string) => BigInt(n);

describe('which limit the swap actually hit', () => {
  test('value the ASP has not approved yet is named as a wait', () => {
    const s = noteShortfall({ totalWei: u('27380000'), approvedWei: u('18827507'), selectableWei: u('18827507') });
    expect(s.reason).toBe('unapproved');
    expect(s.withheldWei).toBe(u('8552493'));
    const text = noteShortfallMessage(s, USDC);
    expect(text).toContain('Spendable now: 18.827507 USDC');
    expect(text).toContain('waiting for approval');
    // The cap is not the reason here, so it must not be quoted as one.
    expect(text).not.toContain('5 notes');
  });

  test('the input cap is named when approved value cannot fit in one proof', () => {
    // Everything is approved; the selector simply could not fit it all.
    const s = noteShortfall({ totalWei: u('30000000'), approvedWei: u('30000000'), selectableWei: u('25000000') });
    expect(s.reason).toBe('input-cap');
    const text = noteShortfallMessage(s, USDC);
    expect(text).toContain('up to 5 notes in one proof');
    expect(text).toContain('25 USDC');
    expect(text).not.toContain('approval');
  });

  test('the cap wins over approval, because it is the one the user can act on now', () => {
    const s = noteShortfall({ totalWei: u('40000000'), approvedWei: u('30000000'), selectableWei: u('25000000') });
    expect(s.reason).toBe('input-cap');
  });

  test('simply not enough says so without blaming a limit', () => {
    const s = noteShortfall({ totalWei: u('5000000'), approvedWei: u('5000000'), selectableWei: u('5000000') });
    expect(s.reason).toBe('insufficient');
    const text = noteShortfallMessage(s, USDC);
    expect(text).toBe('Your approved USDC notes come to 5 USDC.');
  });

  test('nothing approved yet still says how much is waiting', () => {
    const s = noteShortfall({ totalWei: u('12000000'), approvedWei: 0n, selectableWei: 0n });
    expect(s.reason).toBe('unapproved');
    expect(noteShortfallMessage(s, USDC)).toBe('None of your USDC notes are approved yet. 12 USDC is waiting.');
  });

  test('nothing held at all keeps the old sentence', () => {
    const s = noteShortfall({ totalWei: 0n, approvedWei: 0n, selectableWei: 0n });
    expect(noteShortfallMessage(s, USDC)).toBe('No approved, spendable USDC notes are available yet.');
  });

  test('the figures take their decimals from the asset they are about', () => {
    // 18-decimal share: the same integers must not print as a 6-decimal amount,
    // and a share count reads as its coin, approximately (DEV-408).
    const s = noteShortfall({ totalWei: u('2000000000000000000'), approvedWei: u('1000000000000000000'), selectableWei: u('1000000000000000000') });
    expect(noteShortfallMessage(s, { symbol: 'ppUSDT', decimals: 18 })).toContain('Spendable now: ≈ 1 USDT');
  });

  test('no message uses an em dash', () => {
    for (const s of [
      noteShortfall({ totalWei: u('3'), approvedWei: u('2'), selectableWei: u('1') }),
      noteShortfall({ totalWei: u('3'), approvedWei: u('3'), selectableWei: u('3') }),
      noteShortfall({ totalWei: u('3'), approvedWei: 0n, selectableWei: 0n }),
    ]) {
      expect(noteShortfallMessage(s, USDC)).not.toContain('—');
    }
  });
});
