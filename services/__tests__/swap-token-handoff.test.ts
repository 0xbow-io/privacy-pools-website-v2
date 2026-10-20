/**
 * Prod, 2026-09-22. Mike on ETH and Pat on USDC, minutes apart, both holding a
 * SHARE and both told:
 *
 *   "Swapping USDC is not available on this network. Withdraw or send it instead."
 *
 * Nothing was unavailable. The hub handed the form `tokenSymbol: 'ppUSDC'`, the
 * form uppercased it and compared with `===` against the token's own symbol, and
 * 'PPUSDC' matches nothing. Every share symbol is mixed case, so it refused all
 * three and only them, on open AND on re-pick, which is why re-selecting the
 * token could not clear it.
 *
 * Reachable only once shares became swap sources (#94) the same morning: before
 * that, no unmatchable symbol was ever in the list.
 */
import { describe, expect, test } from 'bun:test';
import { handoffRefused, resolveHandoffToken } from '@/services/swap-token-handoff';

// Mainnet's real input list after #94, symbols exactly as the registry spells
// them. The mixed case is the point of this file.
const PP_ETH = { symbol: 'ppETH', address: '0x66051920D25af4E3596A8a46309F4D045F9D83B7' };
const PP_USDC = { symbol: 'ppUSDC', address: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6' };
const PP_USDT = { symbol: 'ppUSDT', address: '0xA4cF419558Ef36CC6FfB666195684dC963910426' };
const LEGACY_ETH = { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' };
const INPUTS = [LEGACY_ETH, PP_USDC, PP_USDT, PP_ETH];

describe('the refusal Mike and Pat saw', () => {
  test('every share resolves by its own symbol, whatever the case', () => {
    for (const share of [PP_ETH, PP_USDC, PP_USDT]) {
      expect(resolveHandoffToken({ tokenSymbol: share.symbol }, INPUTS)).toBe(share);
      expect(resolveHandoffToken({ tokenSymbol: share.symbol.toUpperCase() }, INPUTS)).toBe(share);
      expect(resolveHandoffToken({ tokenSymbol: share.symbol.toLowerCase() }, INPUTS)).toBe(share);
      expect(handoffRefused({ tokenSymbol: share.symbol }, INPUTS)).toBe(false);
    }
  });

  test('the exact comparison that failed', () => {
    // What the form used to do, kept as a number the reader can check.
    expect(INPUTS.some((t) => t.symbol === 'ppUSDC'.toUpperCase())).toBe(false);
    // What it does now.
    expect(handoffRefused({ tokenSymbol: 'ppUSDC' }, INPUTS)).toBe(false);
  });
});

describe('a symbol is no longer a unique key', () => {
  // displayTokenSymbol renders ppETH as "ETH", and the legacy plain ETH pool is
  // also "ETH". Resolving by name can land on the pool the user does not hold.
  test('the address decides which ETH is meant', () => {
    expect(resolveHandoffToken({ tokenAddress: PP_ETH.address, tokenSymbol: 'ETH' }, INPUTS)).toBe(PP_ETH);
    expect(resolveHandoffToken({ tokenAddress: LEGACY_ETH.address, tokenSymbol: 'ETH' }, INPUTS)).toBe(LEGACY_ETH);
  });

  test('case does not matter on the address either', () => {
    expect(resolveHandoffToken({ tokenAddress: PP_USDC.address.toLowerCase() }, INPUTS)).toBe(PP_USDC);
  });

  test('an address that names nothing does NOT fall back to the symbol', () => {
    // Falling back would quietly turn "the share at this address" into the
    // legacy pool of the same display name, which is the failure the address
    // exists to prevent.
    const request = { tokenAddress: '0x0000000000000000000000000000000000000dead', tokenSymbol: 'ETH' };
    expect(resolveHandoffToken(request, INPUTS)).toBeUndefined();
    expect(handoffRefused(request, INPUTS)).toBe(true);
  });
});

describe('a genuine refusal is still a refusal', () => {
  test('an asset with no route here is reported, not silently swapped', () => {
    // Prod plain USDC is withdraw-only: not in the RelaySwaps input list.
    const request = { tokenSymbol: 'USDC' };
    expect(resolveHandoffToken(request, INPUTS)).toBeUndefined();
    expect(handoffRefused(request, INPUTS)).toBe(true);
  });

  test('naming nothing is not a refusal, it is the ordinary open', () => {
    expect(handoffRefused({}, INPUTS)).toBe(false);
    expect(handoffRefused({ tokenSymbol: '' }, INPUTS)).toBe(false);
    expect(handoffRefused({ tokenSymbol: '   ' }, INPUTS)).toBe(false);
    expect(handoffRefused({ tokenAddress: '' }, INPUTS)).toBe(false);
  });

  test('an empty list refuses everything named', () => {
    expect(handoffRefused({ tokenSymbol: 'ETH' }, [])).toBe(true);
    expect(resolveHandoffToken({ tokenSymbol: 'ETH' }, [])).toBeUndefined();
  });
});
