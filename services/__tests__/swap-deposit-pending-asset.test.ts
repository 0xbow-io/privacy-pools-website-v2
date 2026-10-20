import { describe, expect, test } from 'bun:test';

import { swapDepositPendingAsset } from '../feed-reconciliation';

const ETH = { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', symbol: 'ETH', decimals: 18, amountRaw: '1000000000000000000' };
const PPETH = '0x1111111111111111111111111111111111111111';
const lookup = (addr: string) => (addr.toLowerCase() === PPETH ? { symbol: 'ppETH', decimals: 18 } : undefined);

describe('swapDepositPendingAsset', () => {
  test('a swap into ppETH is filed under the share, at the share value', () => {
    expect(swapDepositPendingAsset({ tokenId: PPETH, value: '0x0de0b6b3a7640000' }, ETH, lookup)).toEqual({
      tokenAddress: PPETH, tokenSymbol: 'ppETH', denomination: 18, amountRaw: '1000000000000000000',
    });
  });

  test('no note, the same asset, or an unknown token keeps the chosen asset', () => {
    const kept = { tokenAddress: ETH.address, tokenSymbol: 'ETH', denomination: 18, amountRaw: ETH.amountRaw };
    expect(swapDepositPendingAsset(undefined, ETH, lookup)).toEqual(kept);
    expect(swapDepositPendingAsset({ tokenId: ETH.address.toLowerCase(), value: '0x1' }, ETH, lookup)).toEqual(kept);
    expect(swapDepositPendingAsset({ tokenId: '0x2222222222222222222222222222222222222222', value: '0x1' }, ETH, lookup)).toEqual(kept);
    expect(swapDepositPendingAsset({ tokenId: PPETH }, ETH, lookup)).toEqual(kept);
    expect(swapDepositPendingAsset({ tokenId: PPETH, value: '0x0' }, ETH, lookup)).toEqual(kept);
  });
});
