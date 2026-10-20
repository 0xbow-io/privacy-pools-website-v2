/**
 * DEV-530: Send, same chain, "Recipient receives" left on the sent asset must
 * be the plain private transfer. On a yield pool the note is the share
 * (ppUSDC) and the delivery list carries the plain token (USDC); both read
 * "USDC", and a raw address compare routed USDC-to-USDC into the swap-send
 * handoff ("Continue in Withdraw").
 *
 * Deployment shapes come from the real prod table, not a hand-written pair.
 */
import { describe, expect, test } from 'bun:test';
import { PROD_YIELD_DEPLOYMENTS } from '@/config/prod-deployments';
import { isSwapSendSelection, sameAssetAddressesFor } from '@/services/intent-swaps';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const MAINNET_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

// Mirrors the provider's sameAssetAddresses: the pool token plus its
// configured share/underlying pair (getConfiguredYieldDeploymentForAsset
// matches either side).
function sameAssetAddresses(chainId: number, poolToken: string): string[] {
  const key = poolToken.toLowerCase();
  const d = (PROD_YIELD_DEPLOYMENTS[chainId] ?? []).find(
    (x) => x.ppUSDC.toLowerCase() === key || x.underlying.toLowerCase() === key,
  );
  return sameAssetAddressesFor(poolToken, d);
}

const usdc = PROD_YIELD_DEPLOYMENTS[1].find((d) => d.underlyingSymbol === 'USDC')!;
const usdt = PROD_YIELD_DEPLOYMENTS[1].find((d) => d.underlyingSymbol === 'USDT')!;
const ppeth = PROD_YIELD_DEPLOYMENTS[1].find((d) => d.nativeMode === true)!;

describe('Send same-asset routing (DEV-530)', () => {
  test('the prod table has the Ethereum ppUSDC/ppUSDT pairs this relies on', () => {
    expect(usdc).toBeDefined();
    expect(usdt).toBeDefined();
  });

  test('yield pool: ppUSDC note, recipient receives plain USDC = plain transfer', () => {
    const pool = usdc.ppUSDC.toLowerCase();
    expect(isSwapSendSelection(usdc.underlying, pool, sameAssetAddresses(1, pool))).toBe(false);
    expect(isSwapSendSelection(usdc.ppUSDC, pool, sameAssetAddresses(1, pool))).toBe(false);
    expect(isSwapSendSelection(null, pool, sameAssetAddresses(1, pool))).toBe(false);
  });

  test('yield pool picked as the plain token: receiving the share is the same asset', () => {
    const pool = usdc.underlying.toLowerCase();
    expect(isSwapSendSelection(usdc.ppUSDC, pool, sameAssetAddresses(1, pool))).toBe(false);
  });

  test('plain pool: receiving the pool asset is a plain transfer', () => {
    expect(isSwapSendSelection(NATIVE, NATIVE, sameAssetAddresses(1, NATIVE))).toBe(false);
    expect(isSwapSendSelection(NATIVE.toUpperCase().replace('0X', '0x'), NATIVE, sameAssetAddresses(1, NATIVE))).toBe(false);
  });

  test('a genuinely different token stays the swap-send path', () => {
    const pool = usdc.ppUSDC.toLowerCase();
    expect(isSwapSendSelection(usdt.underlying, pool, sameAssetAddresses(1, pool))).toBe(true);
    expect(isSwapSendSelection(usdt.ppUSDC, pool, sameAssetAddresses(1, pool))).toBe(true);
    expect(isSwapSendSelection(NATIVE, pool, sameAssetAddresses(1, pool))).toBe(true);
    expect(isSwapSendSelection(usdc.underlying, NATIVE, sameAssetAddresses(1, NATIVE))).toBe(true);
    expect(isSwapSendSelection(MAINNET_WETH, NATIVE, sameAssetAddresses(1, NATIVE))).toBe(true);
  });

  test('ppETH (nativeMode): recipient receives native ETH or WETH = plain transfer', () => {
    expect(ppeth).toBeDefined();
    const pool = ppeth.ppUSDC.toLowerCase();
    const same = sameAssetAddresses(1, pool);
    expect(isSwapSendSelection(NATIVE, pool, same)).toBe(false);
    expect(isSwapSendSelection(ppeth.underlying, pool, same)).toBe(false);
    expect(isSwapSendSelection(usdc.underlying, pool, same)).toBe(true);
  });

  test('a non-native share never treats native ETH as itself', () => {
    const pool = usdc.ppUSDC.toLowerCase();
    expect(sameAssetAddresses(1, pool)).not.toContain(NATIVE);
  });
});
