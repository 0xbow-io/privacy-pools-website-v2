import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { payrollSentMatchesRow } from '@/components/payroll/io';
import { sharesForUnderlyingCeil, underlyingOfSent, type SentReadBack } from '@/services/underlying-amount-entry';
import type { ShareRate } from '@/services/share-rates';

// Review on #78 (P2): a relay whose outcome was unknown can be found on chain
// after the modal has moved on. Its paid-row check read the send back with the
// form's CURRENT symbol, rate and conversion record, so a correctly paid row A
// read as a mismatch once row B was opened (or the rate ticked, or a plain
// token was picked), stayed unpaid, and could be paid twice. The read-back now
// uses a snapshot taken when the send started.

const shareRate = (assetsPerShare: bigint): ShareRate => ({
  chainId: 1, share: '0xshare', underlying: '0xusdt', shareSymbol: 'ppUSDT', shareDecimals: 18,
  assetsPerShare, underlyingSymbol: 'USDT', underlyingDecimals: 6,
});
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const matchesRowA = (delivered: string | null) => payrollSentMatchesRow({
  details: { chainId: 1, tokenSymbol: 'ppUSDT', recipient: RECIPIENT, underlyingAmount: delivered },
  recipient: RECIPIENT, amount: '1018.40', tokenSymbol: 'USDT', decimals: 6, expectedChainId: 1,
});

describe('a late-landed payroll send is read back with its own run', () => {
  const openA = shareRate(1_005_420n);
  const sharesA = sharesForUnderlyingCeil('1018.40', openA)!;
  // What the modal held when A's send started.
  const runA: SentReadBack = { share: true, liveRate: openA, converted: { shares: sharesA, rate: openA } };

  test('row B opened meanwhile and the rate ticked: the form now would read A wrong, A\'s snapshot reads it right', () => {
    const tick = shareRate(1_005_421n);
    const sharesB = sharesForUnderlyingCeil('2500', tick)!;
    const formNow: SentReadBack = { share: true, liveRate: tick, converted: { shares: sharesB, rate: tick } };
    expect(matchesRowA(underlyingOfSent(formNow, sharesA))).toBe(false);
    expect(matchesRowA(underlyingOfSent(runA, sharesA))).toBe(true);
  });

  test('a plain token picked meanwhile: the share count would come back as the coin; the snapshot still converts', () => {
    const formNow: SentReadBack = { share: false, liveRate: null, converted: null };
    expect(underlyingOfSent(formNow, sharesA)).toBe(sharesA);
    expect(matchesRowA(underlyingOfSent(formNow, sharesA))).toBe(false);
    expect(matchesRowA(underlyingOfSent(runA, sharesA))).toBe(true);
  });

  test('the snapshot does not hide a wrong amount: an edited send still fails', () => {
    expect(matchesRowA(underlyingOfSent(runA, '1018.4'))).toBe(false);
  });

  test('a plain token is its own coin', () => {
    expect(underlyingOfSent({ share: false, liveRate: null, converted: null }, '12.5')).toBe('12.5');
  });
});

describe('transfer modal wiring (source guard)', () => {
  const modal = readFileSync(new URL('../../components/transfer-modal-provider.tsx', import.meta.url), 'utf8');
  const slice = (start: string, length: number) => {
    const at = modal.indexOf(start);
    expect(at).toBeGreaterThan(0);
    return modal.slice(at, at + length);
  };

  test('the read-back is snapshotted once when the send starts and kept on the run', () => {
    expect(modal).toContain('const sentReadBack = sentReadBackRef.current();');
    expect(slice('bgRun = {', 300)).toContain('readBack: sentReadBack');
    // No read of the form's current values at onSent time.
    expect(modal).not.toContain('underlyingOfSentRef');
  });

  test('every onSent reads with the run\'s snapshot, the late-landed path included', () => {
    const calls = [...modal.matchAll(/underlyingAmount: ([^\n]*?)\) \}\);/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c.startsWith('underlyingOfSent(sentReadBack,') || c.startsWith('underlyingOfSent(run.readBack,')).toBe(true);
    expect(slice('const stampLanded = async', 4000)).toContain('underlyingOfSent(run.readBack,');
  });

  test('a conversion record does not outlive the open that made it', () => {
    expect(slice('setPendingUnderlying(coinPrefill);', 200)).toContain('convertedAtRef.current = null;');
    expect(modal).toContain('setPendingUnderlying(null);\n    convertedAtRef.current = null;\n    setCallerAmount(null);\n    setIsOpen(false);');
  });
});
