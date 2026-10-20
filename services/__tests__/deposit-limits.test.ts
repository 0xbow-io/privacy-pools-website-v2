// The deposit-minimum figures every surface shows (services/deposit-limits.ts).
//
// Prod, 2026-09-05: a 10 USDT deposit into the ppUSDT pool minted ~9.95 shares
// against a 10-share minimum and the SDK's raw BelowMinimumAmount reached the
// toast; the modal's own check printed "10.050251256281407036 USDT (10
// ppUSDT)". These pin the conversion, the rounding direction and the copy.
import { describe, expect, test } from 'bun:test';
import { parseUnits } from 'viem';

import {
  ceilToDisplayUnits,
  formatDepositMinimum,
  friendlyDepositError,
  MIN_DEPOSIT_BUFFER_BPS,
  requiredUnderlyingForMinShares,
  scaleUnits,
  SDK_YIELD_SHARE_DISCOUNT_BPS,
} from '@/services/deposit-limits';

const USDT_DECIMALS = 6;
const SHARE_DECIMALS = 18;
const TEN_SHARES = 10n * 10n ** 18n; // 0x8ac7230489e80000, the prod ppUSDT minimum

describe('rounding is always UP, to what the user can type', () => {
  test('a stablecoin rounds up to the cent, a non-stable to five places', () => {
    expect(ceilToDisplayUnits(parseUnits('10.050251', USDT_DECIMALS), USDT_DECIMALS, 2)).toBe(parseUnits('10.06', USDT_DECIMALS));
    expect(ceilToDisplayUnits(parseUnits('10.06', USDT_DECIMALS), USDT_DECIMALS, 2)).toBe(parseUnits('10.06', USDT_DECIMALS));
    expect(ceilToDisplayUnits(parseUnits('0.0040001', 18), 18, 5)).toBe(parseUnits('0.00401', 18));
    expect(ceilToDisplayUnits(0n, 6, 2)).toBe(0n);
  });

  test('scaleUnits moves between share and underlying decimals', () => {
    expect(scaleUnits(TEN_SHARES, SHARE_DECIMALS, USDT_DECIMALS)).toBe(parseUnits('10', USDT_DECIMALS));
    expect(scaleUnits(parseUnits('10', USDT_DECIMALS), USDT_DECIMALS, SHARE_DECIMALS)).toBe(TEN_SHARES);
  });
});

describe('the share minimum in the pay asset', () => {
  test('previewMint(10 shares) at a live rate, plus the buffer, rounded up to a cent', () => {
    // previewMint(10e18) at exchange rate 1.000026 → 10.00026 USDT.
    const assets = parseUnits('10.00026', USDT_DECIMALS);
    const required = requiredUnderlyingForMinShares({ assetsForMinShares: assets, underlyingDecimals: USDT_DECIMALS, underlyingSymbol: 'USDT' });
    // Exact: 10.00026 × (1 + 10bps) = 10.01026…, so 10.02 (no share discount any more).
    const exactNum = Number(assets) * (10_000 + Number(MIN_DEPOSIT_BUFFER_BPS)) / (10_000 - Number(SDK_YIELD_SHARE_DISCOUNT_BPS));
    const expectedCents = BigInt(Math.ceil(exactNum / 10_000)) * 10_000n;
    expect(required).toBe(expectedCents);
    expect(required).toBeGreaterThan(assets);
    expect(formatDepositMinimum(required, USDT_DECIMALS, 'USDT')).toBe('Minimum deposit is 10.02 USDT');
  });

  test('the figure shown is a figure that passes (never below the raw requirement)', () => {
    for (const assets of ['10', '10.000001', '10.004999', '10.005', '10.999999']) {
      const raw = parseUnits(assets, USDT_DECIMALS);
      const required = requiredUnderlyingForMinShares({ assetsForMinShares: raw, underlyingDecimals: USDT_DECIMALS, underlyingSymbol: 'USDT' });
      expect(required).toBeGreaterThanOrEqual(raw);
      expect(required % 10_000n).toBe(0n); // whole cents
    }
  });
});

describe('the copy', () => {
  test('a share is named as its underlying, no 18-decimal tail, no parenthetical', () => {
    expect(formatDepositMinimum(TEN_SHARES, SHARE_DECIMALS, 'ppUSDT')).toBe('Minimum deposit is 10 USDT');
    expect(formatDepositMinimum(parseUnits('10.050251256281407036', 18), 18, 'USDT')).toBe('Minimum deposit is 10.06 USDT');
    expect(formatDepositMinimum(parseUnits('0.004', 18), 18, 'ETH')).toBe('Minimum deposit is 0.004 ETH');
  });
});

describe('the SDK error, as a last line of defence', () => {
  const raw = 'Below minimum amount: value 0x8a12f83c06580671 is below minimum 0x0000000000000000000000000000000000000000000000008ac7230489e80000';

  test('prefers the pay-side minimum the surface already computed', () => {
    expect(friendlyDepositError(raw, { payMinWei: parseUnits('10.02', USDT_DECIMALS), payDecimals: USDT_DECIMALS, paySymbol: 'USDT' }))
      .toBe('Minimum deposit is 10.02 USDT');
  });

  test('otherwise parses the hex minimum and converts share units to the pay asset, flagged as an estimate', () => {
    const text = friendlyDepositError(raw, { payDecimals: USDT_DECIMALS, paySymbol: 'USDT', poolDecimals: SHARE_DECIMALS, poolIsShare: true });
    // 10 shares ≈ 10 USDT at rate 1, plus the buffer, rounded up to a cent:
    // 10 × 1.001 = 10.01 (the app takes exact shares; no 0.5% discount).
    // Rate 1 is a guess here, and the sentence says so (codex P2).
    // (toStartWith exists at runtime but not in the repo's bun:test typings.)
    expect(text?.startsWith('Minimum deposit is 10.01 USDT')).toBe(true);
    expect(text).toContain('estimate');
  });

  test('an estimated pay-side minimum is labelled as one, a live one is not', () => {
    expect(friendlyDepositError(raw, { payMinWei: parseUnits('10.07', USDT_DECIMALS), payMinIsEstimate: true, payDecimals: USDT_DECIMALS, paySymbol: 'USDT' }))
      .toContain('estimate');
    expect(friendlyDepositError(raw, { payMinWei: parseUnits('10.07', USDT_DECIMALS), payDecimals: USDT_DECIMALS, paySymbol: 'USDT' }))
      .toBe('Minimum deposit is 10.07 USDT');
  });

  test('a plain-asset minimum converts 1:1, exactly', () => {
    // 0xe35fa931a000 = 250_000_000_000_000 wei = 0.00025 ETH.
    const eth = 'Below minimum amount: value 0x2386f26fc10000 is below minimum 0xe35fa931a000';
    expect(friendlyDepositError(eth, { payDecimals: 18, paySymbol: 'ETH', poolDecimals: 18 })).toBe('Minimum deposit is 0.00025 ETH');
  });

  test('symbol casing and 18→18 decimals do not change the answer', () => {
    const eighteen = 'Below minimum amount: value 0x1 is below minimum 0x8ac7230489e80000';
    for (const symbol of ['ppUSDT', 'PPUSDT', 'USDT']) {
      const text = friendlyDepositError(eighteen, { payDecimals: 18, paySymbol: symbol, poolDecimals: 18 });
      expect(text).toBe('Minimum deposit is 10 USDT');
    }
  });

  test('the SDK error NAME alone is enough when the message shape is unfamiliar', () => {
    expect(friendlyDepositError('something new', { payMinWei: parseUnits('10.07', USDT_DECIMALS), payDecimals: USDT_DECIMALS, paySymbol: 'USDT' }, 'BelowMinimumAmount'))
      .toBe('Minimum deposit is 10.07 USDT');
  });

  test('leaves every other error alone, including unrelated "below minimum" phrases', () => {
    expect(friendlyDepositError('User rejected the request.', { payDecimals: 6, paySymbol: 'USDT' })).toBeNull();
    expect(friendlyDepositError('AssetNotEnabled: 0xabc', { payDecimals: 6, paySymbol: 'USDT' })).toBeNull();
    // codex P3: a quote complaining about its OUTPUT is not a deposit minimum.
    expect(friendlyDepositError('Quote output is below minimum received', { payMinWei: parseUnits('10.07', 6), payDecimals: 6, paySymbol: 'USDT' })).toBeNull();
  });
});

/**
 * Nat, prod, 2026-09-22, verbatim on screen:
 *
 *   "Deposit value 8174139739742221932 is below the Entrypoint minimum
 *    10000000000000000000"
 *
 * 8.17 against a minimum of 10, in an asset the sentence never names. The
 * translator only knew the SDK's `BelowMinimumAmount` wording, so the deposit
 * and reshield prepares, which throw `DepositBelowMinimum` with a different
 * sentence, passed straight through.
 */
describe('the Entrypoint-minimum wording is translated too', () => {
  const NAT = 'Deposit value 8174139739742221932 is below the Entrypoint minimum 10000000000000000000';

  test("Nat's message becomes a figure a person can act on", () => {
    const friendly = friendlyDepositError(NAT, { payDecimals: 6, paySymbol: 'USDC', poolDecimals: 18, poolIsShare: true });
    expect(friendly).not.toBeNull();
    // Never the raw base units that were on screen.
    expect(friendly).not.toContain('10000000000000000000');
    expect(friendly).not.toContain('8174139739742221932');
    expect(friendly).toContain('USDC');
  });

  test('the caller’s own computed minimum still wins, as with the other wording', () => {
    const friendly = friendlyDepositError(NAT, {
      payMinWei: parseUnits('10.02', 6),
      payDecimals: 6,
      paySymbol: 'USDC',
    });
    expect(friendly).toBe('Minimum deposit is 10.02 USDC');
  });

  test('recognised by error NAME as well, for a message we have not seen', () => {
    const friendly = friendlyDepositError('something else entirely', {
      payMinWei: parseUnits('10', 6),
      payDecimals: 6,
      paySymbol: 'USDC',
    }, 'DepositBelowMinimum');
    expect(friendly).toBe('Minimum deposit is 10 USDC');
  });

  test('an unrelated error is still passed through untouched', () => {
    expect(friendlyDepositError('The relayer refused to redeem USDC to USDC', { payDecimals: 6, paySymbol: 'USDC' })).toBeNull();
  });
});
