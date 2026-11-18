import { describe, expect, test } from 'bun:test';
import { reshieldHeldBack } from '@/services/reshield-held-back';

// DEV-822: Review printed the swap minimum, then a note ~1% smaller, with
// nothing between them. The SDK sizes the deposit from minOutput * 99% and the
// router sweeps the rest to the relayer, so that remainder gets its own line.
describe('reshieldHeldBack', () => {
  const USDC = (n: number) => BigInt(Math.round(n * 1e6));
  // 1 ppUSDC = 1.00685 USDC, 18-decimals shares.
  const share = { assetsPerShare: 1_006_850n, shareDecimals: 18 };

  test('share target: the note is priced to the underlying before the gap is taken', () => {
    const minOutput = USDC(990);
    // The SDK's sizing: 99% of the minimum, expressed in shares.
    const budget = (minOutput * 99n) / 100n;
    const noteShares = (budget * 10n ** 18n) / share.assetsPerShare;
    const held = reshieldHeldBack({ minOutputWei: minOutput, noteValueWei: noteShares, vettingFeeWei: 0n, share });
    // 1% of 990 is 9.90, within a unit of share rounding.
    expect(Number(held)).toBeGreaterThanOrEqual(9_899_990);
    expect(Number(held)).toBeLessThanOrEqual(9_900_010);
  });

  test('the displayed lines add up: minimum - dust = note, in the same units', () => {
    const minOutput = USDC(999.4);
    const budget = (minOutput * 99n) / 100n;
    const noteShares = (budget * 10n ** 18n) / share.assetsPerShare;
    const held = reshieldHeldBack({ minOutputWei: minOutput, noteValueWei: noteShares, vettingFeeWei: 0n, share });
    const noteUnderlying = (noteShares * share.assetsPerShare) / 10n ** 18n;
    expect(minOutput - held).toBe(noteUnderlying);
  });

  test('plain asset: note and swap output are the same token, the vetting fee is its own line', () => {
    // 1000 out, 10 bps vetting: the deposit is 999 and the fee rides on top.
    const held = reshieldHeldBack({ minOutputWei: USDC(1000), noteValueWei: USDC(989), vettingFeeWei: USDC(0.989) });
    expect(held).toBe(USDC(1000) - USDC(989) - USDC(0.989));
  });

  test('never negative', () => {
    expect(reshieldHeldBack({ minOutputWei: 5n, noteValueWei: 9n, vettingFeeWei: 0n })).toBe(0n);
  });
});
