// Isolated prod process, spawned and count-pinned by environments.test.ts.
// The Swap tab's recipient route (DEV-510) against the real prod registry.
import { describe, expect, mock, test } from 'bun:test';

const prod = process.env.EXPO_PUBLIC_APP_ENV === 'prod';
if (prod) mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const describeProd = prod ? describe : (_name: string, _fn: () => void) => {};
describeProd('Swap tab recipient route (prod registry)', () => {
  const OWN = '0x1111111111111111111111111111111111111111';
  const OTHER = '0x2222222222222222222222222222222222222222';
  const load = async () => {
    const { ACTIVE_ENVIRONMENT } = await import('@/config/environments');
    const { getSwapOutputTokens } = await import('@/config/intent-swaps');
    const route = await import('@/services/swap-tab-recipient');
    const bySymbol = (chainId: number, symbol: string) =>
      Object.values(ACTIVE_ENVIRONMENT.tokensByChain[chainId]).find((t) => t.symbol === symbol)!;
    return { ...route, getSwapOutputTokens, bySymbol };
  };

  test('no recipient, or your own address, is the plain reshield', async () => {
    const { swapTabRecipientRoute, bySymbol } = await load();
    const out = bySymbol(1, 'ppUSDT').address;
    const base = { poolChainId: 1, destinationChainId: 1, outputTokenAddress: out, ownAddresses: [OWN] };
    expect(swapTabRecipientRoute({ ...base, recipient: '' })).toEqual({ kind: 'self' });
    expect(swapTabRecipientRoute({ ...base, recipient: OWN.toUpperCase().replace('0X', '0x') })).toEqual({ kind: 'self' });
    expect(swapTabRecipientRoute({ ...base, recipient: '0x12' })).toEqual({ kind: 'invalid' });
    expect(swapTabRecipientRoute({ ...base, recipient: `0x${'0'.repeat(40)}` })).toEqual({ kind: 'invalid' });
  });

  test('another address on a deposit target routes to reshield-transfer', async () => {
    const { swapTabRecipientRoute, getSwapOutputTokens } = await load();
    for (const chainId of [1, 56]) {
      for (const t of getSwapOutputTokens(chainId, chainId)) {
        expect(swapTabRecipientRoute({
          poolChainId: chainId, destinationChainId: chainId, outputTokenAddress: t.address,
          outputIsNative: t.isNative, recipient: OTHER, ownAddresses: [OWN],
        })).toEqual({ kind: 'reshield-transfer', recipient: OTHER, outputTokenAddress: t.address });
      }
    }
  });

  test('a plain pick is mapped to its pool share before the check', async () => {
    const { swapTabRecipientRoute, bySymbol } = await load();
    // Mainnet USDT is withdraw-only; its pool is ppUSDT. BSC USDT likewise.
    for (const chainId of [1, 56]) {
      const plain = bySymbol(chainId, 'USDT');
      const share = bySymbol(chainId, 'ppUSDT');
      expect(swapTabRecipientRoute({
        poolChainId: chainId, destinationChainId: chainId, outputTokenAddress: plain.address,
        recipient: OTHER, ownAddresses: [OWN],
      })).toEqual({ kind: 'reshield-transfer', recipient: OTHER, outputTokenAddress: share.address });
    }
  });

  test('across chains only a configured share reaches someone else', async () => {
    const { swapTabRecipientRoute, bySymbol, SWAP_TAB_RECIPIENT_REFUSED } = await load();
    const share = bySymbol(56, 'ppUSDT');
    expect(swapTabRecipientRoute({
      poolChainId: 1, destinationChainId: 56, outputTokenAddress: share.address, recipient: OTHER, ownAddresses: [OWN],
    })).toEqual({ kind: 'reshield-transfer', recipient: OTHER, outputTokenAddress: share.address });
    expect(swapTabRecipientRoute({
      poolChainId: 1, destinationChainId: 56, outputTokenAddress: bySymbol(56, 'FDUSD').address, recipient: OTHER, ownAddresses: [OWN],
    })).toEqual({ kind: 'refused', reason: SWAP_TAB_RECIPIENT_REFUSED });
    // No output picked yet: refused, never a quiet reshield to yourself.
    expect(swapTabRecipientRoute({
      poolChainId: 1, destinationChainId: 1, outputTokenAddress: null, recipient: OTHER, ownAddresses: [OWN],
    }).kind).toBe('refused');
  });
});
