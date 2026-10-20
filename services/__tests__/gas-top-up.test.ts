import { describe, expect, test } from 'bun:test';
import { encodeAbiParameters } from 'viem';
import { PAYOUT_ROUTING_ABI } from '@privacy-pools-v2/sdk';
import { decodeGasTopUpWei, formatGasTopUp } from '../gas-top-up';

// Fixtures come from the real encoder (the SDK's own PAYOUT_ROUTING_ABI via
// viem), not hand-typed hex, so a schema change here fails loudly.
const encode = (nativeGas: bigint) => encodeAbiParameters(PAYOUT_ROUTING_ABI, [{
  recipient: '0xd3581763f41fc0763a49e9ab53f2d3d425870a3d',
  feeRecipient: '0x4ba5ff376865b370790a56276c63e7984dcff1f7',
  feeAmount: 2651216n,
  nativeGas,
}]);

describe('decodeGasTopUpWei', () => {
  test('reads nativeGas from the signed routing, two differing values', () => {
    // The Sepolia top-up that landed on 2026-09-03 (tx 0xdce04c91…63dd).
    expect(decodeGasTopUpWei(encode(587102001600000n))).toBe(587102001600000n);
    expect(decodeGasTopUpWei(encode(0n))).toBe(0n);
  });

  test('refuses bytes that are not a PayoutRouting', () => {
    expect(decodeGasTopUpWei('0x')).toBeNull();
    expect(decodeGasTopUpWei('0xdeadbeef')).toBeNull();
    expect(decodeGasTopUpWei(null)).toBeNull();
  });
});

describe('formatGasTopUp', () => {
  test('zero and missing render nothing', () => {
    expect(formatGasTopUp({ wei: 0n, symbol: 'ETH', decimals: 18 })).toBeNull();
    expect(formatGasTopUp({ wei: null, symbol: 'ETH', decimals: 18 })).toBeNull();
  });

  test('uses the chain native symbol, the shared floor, and the price when known', () => {
    const eth = formatGasTopUp({ wei: 587102001600000n, symbol: 'ETH', decimals: 18, priceUsd: 2100 });
    expect(eth?.amountText).toBe('0.00059 ETH');
    expect(eth?.usdText).toBe('$1.23');

    const bnb = formatGasTopUp({ wei: 600_000n * 1_000_000_000n, symbol: 'BNB', decimals: 18, priceUsd: null });
    expect(bnb?.amountText).toBe('0.0006 BNB');
    expect(bnb?.usdText).toBeNull();

    const tiny = formatGasTopUp({ wei: 1_000_000_000_000n, symbol: 'cBTC', decimals: 18, priceUsd: 60_000 });
    expect(tiny?.amountText).toBe('0.000001 cBTC');
    expect(tiny?.usdText).toBe('$0.06');
  });
});
