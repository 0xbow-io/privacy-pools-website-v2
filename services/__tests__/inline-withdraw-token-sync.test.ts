// DEV-531: Withdraw USDT on BNB Chain received as ETH on Ethereum checked,
// routed and quoted BNB, because the inline flow kept the native asset it was
// opened under while the hub card moved to the held USDT. Fed from the real
// prod registry, never a hand-written token list.
import { describe, expect, test } from 'bun:test';
import { ENVIRONMENTS, NATIVE_ASSET_ADDRESS } from '@/config/environments';
import { inlineWithdrawTokenToPush } from '@/services/inline-withdraw-token-sync';

const BSC = Object.values(ENVIRONMENTS.prod.tokensByChain[56] ?? {});
const base = {
  focused: true,
  action: 'withdraw',
  inline: true,
  step: 'withdraw',
  isSui: false,
  chainTokens: BSC,
};

describe('inline withdraw token sync (DEV-531)', () => {
  test('the prod BSC registry has the native asset and both USDT pools', () => {
    const native = BSC.find((t) => t.address.toLowerCase() === NATIVE_ASSET_ADDRESS);
    expect(native?.symbol).toBe('BNB');
    expect(BSC.some((t) => t.symbol === 'USDT')).toBe(true);
    expect(BSC.some((t) => t.symbol === 'ppUSDT' && t.yieldShare)).toBe(true);
  });

  for (const symbol of ['USDT', 'ppUSDT']) {
    test(`a flow stuck on BNB is moved to the selected ${symbol}, a non-native source`, () => {
      const pushed = inlineWithdrawTokenToPush({ ...base, hubSymbol: symbol, flowSymbol: 'BNB' });
      expect(pushed).toBe(symbol);
      const meta = BSC.find((t) => t.symbol === pushed)!;
      // The source the balance check and the LiFi quote read is the selected
      // pool asset, not the chain's native sentinel, and in its own 18 decimals.
      expect(meta.address.toLowerCase()).not.toBe(NATIVE_ASSET_ADDRESS);
      expect(meta.decimals).toBe(18);
    });
  }

  test('the push does not depend on the receive-as destination: it runs on the form step', () => {
    // A cross-chain receive pick (ETH on Ethereum) leaves the step at 'withdraw'.
    expect(inlineWithdrawTokenToPush({ ...base, hubSymbol: 'USDT', flowSymbol: 'BNB' })).toBe('USDT');
    for (const step of ['review', 'loading', 'success', 'error']) {
      expect(inlineWithdrawTokenToPush({ ...base, step, hubSymbol: 'USDT', flowSymbol: 'BNB' })).toBeNull();
    }
  });

  test('registry spelling is returned and an in-sync flow is left alone', () => {
    expect(inlineWithdrawTokenToPush({ ...base, hubSymbol: 'PPUSDT', flowSymbol: 'BNB' })).toBe('ppUSDT');
    expect(inlineWithdrawTokenToPush({ ...base, hubSymbol: 'USDT', flowSymbol: 'USDT' })).toBeNull();
  });

  test('nothing moves off the withdraw tab, unfocused, not inline, on Sui, or for an unknown symbol', () => {
    const go = { hubSymbol: 'USDT', flowSymbol: 'BNB' };
    expect(inlineWithdrawTokenToPush({ ...base, ...go, action: 'send' })).toBeNull();
    expect(inlineWithdrawTokenToPush({ ...base, ...go, focused: false })).toBeNull();
    expect(inlineWithdrawTokenToPush({ ...base, ...go, inline: false })).toBeNull();
    expect(inlineWithdrawTokenToPush({ ...base, ...go, isSui: true })).toBeNull();
    expect(inlineWithdrawTokenToPush({ ...base, hubSymbol: 'DAI', flowSymbol: 'BNB' })).toBeNull();
  });
});
