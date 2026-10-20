// The withdrawal input-selection rules, now that they live outside the modal.
//
// These pin behaviour that was previously only reachable by driving 4,000 lines
// of UI: the 5-input circuit cap, dust being skipped unless nothing else can
// fund the withdrawal, the largest-first fallback that keeps big withdrawals
// from stranding funds, mixed labels being valid for plain withdrawals, and the
// SDK's exact-token-id invariant. The single-label helper is retained
// specifically for the withdraw+swap route.
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DUST_THRESHOLD,
  DUST_THRESHOLD,
  WITHDRAW_MAX_INPUTS,
  roundBlendCandidatesWei,
  selectWithdrawInputs,
} from '@/services/withdraw-note-selection';
import type { Note } from '@/services/sdk-types';

/** Minimal note: only value, label, and raw tokenId are read by these rules. */
const note = (
  value: bigint,
  label = '0xaa',
  commitment = `0x${value.toString(16)}`,
  tokenId = '0xToken',
): Note => ({
  value: `0x${value.toString(16)}`,
  label,
  commitment,
  tokenId,
} as unknown as Note);

const ETH = (whole: string) => BigInt(Math.round(Number(whole) * 1e18));

describe('selectWithdrawInputs', () => {
  test('spends the SMALLEST non-dust notes first, to consolidate', () => {
    const notes = [note(ETH('5')), note(ETH('1')), note(ETH('2'))];
    const picked = selectWithdrawInputs(notes, ETH('2.5'), ETH('0.01'));
    expect(picked.notes.map((n) => n.value)).toEqual([
      `0x${ETH('1').toString(16)}`,
      `0x${ETH('2').toString(16)}`,
    ]);
    expect(picked.total).toBe(ETH('3'));
  });

  test('skips dust while something else can fund it', () => {
    const dust = note(ETH('0.001'));
    const picked = selectWithdrawInputs([dust, note(ETH('1'))], ETH('0.5'), ETH('0.01'));
    expect(picked.notes).toHaveLength(1);
    expect(picked.notes[0]!.value).toBe(`0x${ETH('1').toString(16)}`);
  });

  test('but spends dust rather than stranding funds when it is all there is', () => {
    // nonDust is empty, so the whole set is considered instead of refusing.
    const picked = selectWithdrawInputs([note(ETH('0.002')), note(ETH('0.003'))], ETH('0.004'), ETH('0.01'));
    expect(picked.total).toBe(ETH('0.005'));
  });

  test('never exceeds the circuit input cap', () => {
    const many = Array.from({ length: 12 }, (_, i) => note(ETH('1'), '0xaa', `0xc${i}`));
    const picked = selectWithdrawInputs(many, ETH('100'), ETH('0.01'));
    expect(picked.notes.length).toBe(WITHDRAW_MAX_INPUTS);
    // Under-covers the target, and says so via total rather than throwing.
    expect(picked.total).toBeLessThan(ETH('100'));
  });

  test('falls back to largest-first when smallest-first cannot cover within the cap', () => {
    // Six 1-ETH notes plus one 50: smallest-first caps out at 5 ETH, so the
    // largest-first pass must win — otherwise a big withdrawal fails with funds
    // sitting right there.
    const notes = [...Array.from({ length: 6 }, (_, i) => note(ETH('1'), '0xaa', `0xs${i}`)), note(ETH('50'), '0xaa', '0xb16')];
    const picked = selectWithdrawInputs(notes, ETH('20'), ETH('0.01'));
    expect(picked.total).toBeGreaterThanOrEqual(ETH('20'));
    expect(picked.notes.some((n) => n.commitment === '0xb16')).toBe(true);
  });

  test('an empty set selects nothing rather than throwing', () => {
    expect(selectWithdrawInputs([], ETH('1'), ETH('0.01'))).toEqual({ notes: [], total: 0n });
  });

  test("Artem's case selects two 0.01 notes across different labels in one proof", () => {
    const notes = [
      note(ETH('0.01'), '0xaaa', '0xa1'),
      note(ETH('0.01'), '0xbbb', '0xb1'),
    ];
    const picked = selectWithdrawInputs(notes, ETH('0.02'), ETH('0.01'));
    expect(picked.total).toBe(ETH('0.02'));
    expect(new Set(picked.notes.map((n) => n.label)).size).toBe(2);
  });

  test('five inputs may span five labels without exceeding the circuit dimensions', () => {
    const notes = Array.from({ length: 5 }, (_, i) => note(ETH('1'), `0x${i + 1}`, `0xc${i}`));
    const picked = selectWithdrawInputs(notes, ETH('5'), 0n);
    expect(picked.notes).toHaveLength(5);
    expect(new Set(picked.notes.map((n) => n.label)).size).toBe(5);
    expect(picked.total).toBe(ETH('5'));
  });

  // One token however it is spelled (services/note-token-id.ts, v2-monorepo#436).
  test('combines token ids that differ only by address casing', () => {
    const picked = selectWithdrawInputs([
      note(60n, '0xa', '0xa1', '0xAbCd'),
      note(50n, '0xb', '0xb1', '0xabcd'),
    ], 100n, 0n);
    expect(picked.total).toBe(110n);
    expect(picked.notes).toHaveLength(2);
  });

  test('still never combines two different tokens', () => {
    const picked = selectWithdrawInputs([
      note(60n, '0xa', '0xa1', '0x1111111111111111111111111111111111111111'),
      note(50n, '0xb', '0xb1', '0x2222222222222222222222222222222222222222'),
    ], 100n, 0n);
    expect(picked.notes).toHaveLength(1);
  });

  test('prefers an exact-token group that covers over a richer partial group', () => {
    const coveringToken = '0x1111111111111111111111111111111111111111';
    const partialToken = '0x2222222222222222222222222222222222222222';
    const picked = selectWithdrawInputs([
      note(100n, '0xa', '0xa1', coveringToken),
      // Six-note raw total is 114, but its top five reach only 95.
      ...Array.from({ length: 6 }, (_, i) => note(19n, `0xb${i}`, `0xb${i}`, partialToken)),
    ], 100n, 0n);
    expect(picked.total).toBe(100n);
    expect(picked.notes.every((n) => n.tokenId === coveringToken)).toBe(true);
  });
});

describe('roundBlendCandidatesWei', () => {
  test('offers the one-significant-digit amount below the entry', () => {
    // 1.234 -> 1 (and nothing else, since 0.5 is not "nearby").
    expect(roundBlendCandidatesWei(ETH('1.234'))).toEqual([ETH('1')]);
  });

  test('offers a second, closer step when the leading digit allows', () => {
    // 7.5 -> 7 is not a step here; the rule steps to 5 (lead > 5n).
    expect(roundBlendCandidatesWei(ETH('7.5'))).toEqual([ETH('7'), ETH('5')]);
  });

  test('an already-round amount has no suggestions', () => {
    expect(roundBlendCandidatesWei(ETH('1'))).toEqual([]);
    expect(roundBlendCandidatesWei(ETH('500'))).toEqual([]);
  });

  test('a candidate less than half the entry is dropped as not nearby', () => {
    // Suggesting 1 for an entry of 9.9 would be a 90% cut, not a round-off.
    expect(roundBlendCandidatesWei(ETH('9.9'))).toEqual([ETH('9'), ETH('5')]);
    expect(roundBlendCandidatesWei(ETH('1.9'))).toEqual([ETH('1')]);
  });

  test('zero and negative amounts yield nothing', () => {
    expect(roundBlendCandidatesWei(0n)).toEqual([]);
    expect(roundBlendCandidatesWei(-5n)).toEqual([]);
  });

  test('never suggests zero or the amount itself', () => {
    for (const wei of [1n, 2n, 9n, 10n, 11n, 999n, 1000n]) {
      for (const c of roundBlendCandidatesWei(wei)) {
        expect(c).toBeGreaterThan(0n);
        expect(c).toBeLessThan(wei);
      }
    }
  });
});

describe('dust thresholds', () => {
  test('stablecoins use a dollar-ish floor, ETH a fraction of a coin', () => {
    expect(DUST_THRESHOLD.ETH).toBe(0.01);
    expect(DUST_THRESHOLD.USDC).toBe(1);
    expect(DUST_THRESHOLD.USDT).toBe(1);
  });

  test('the table has no entry for an unlisted asset, and the default is 0.01', () => {
    // Deliberately NOT `DUST_THRESHOLD.X ?? DEFAULT` — that evaluates the
    // fallback in the test rather than in the code, and would pass whatever the
    // implementation did (kimi). The `??` itself lives in the modal, which this
    // service does not own, so all that is pinnable here is the data.
    expect(DUST_THRESHOLD.SOMETHING_NEW).toBeUndefined();
    expect(DEFAULT_DUST_THRESHOLD).toBe(0.01);
  });
});
