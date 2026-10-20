// The ops lever for the mainnet ETH pool: EXPO_PUBLIC_MAINNET_ETH_DEPOSITS=true
// opens deposits again with no code change (config/environments.ts). Module
// constants freeze at first import, so this cannot be asserted in the process
// that already imported the registry with the flag unset - the parent suite
// (environments.test.ts) spawns this file with the flag on, and the describe
// below skips otherwise.
import { describe, test, expect, mock } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_PAY_URL_BASE = 'https://pay.example.test';

// A plain conditional rather than describe.skipIf (the app's bun:test typings do
// not model it); the else branch keeps this file visible in the parent suite.
const flagOn = process.env.EXPO_PUBLIC_MAINNET_ETH_DEPOSITS === 'true';
const describeOpen = flagOn ? describe : (_name: string, _fn: () => void) => {
  test('the reopen case runs as a child bun test of environments.test.ts (skipped here: flag off)', () => {
    expect(process.env.EXPO_PUBLIC_MAINNET_ETH_DEPOSITS).not.toBe('true');
  });
};

describeOpen('EXPO_PUBLIC_MAINNET_ETH_DEPOSITS=true reopens the mainnet ETH pool', () => {
  test('the flag clears depositComingSoon and ETH is depositable on chain 1 again', async () => {
    const { ENVIRONMENTS } = await import('@/config/environments');
    for (const env of ['prod', 'staging'] as const) {
      const eth = ENVIRONMENTS[env].tokensByChain[1]['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'];
      expect(eth?.symbol).toBe('ETH');
      expect(eth?.depositComingSoon).toBeUndefined();
    }
    const tokens = await import('@/config/tokens');
    expect(tokens.isDepositComingSoon(tokens.NATIVE_ASSET_ADDRESS, 1)).toBe(false);
    expect(tokens.getDepositComingSoonTokens(1)).toEqual([]);
    expect(tokens.getDepositableTokens(1).map((t) => t.symbol)).toContain('ETH');
    expect(tokens.getEntrypointDepositableTokens(1).map((t) => t.symbol)).toContain('ETH');
    const { listShieldPools } = await import('@/services/shield-pools');
    expect(listShieldPools().some((p) => p.chainId === 1 && p.symbol === 'ETH')).toBe(true);
  });
});
