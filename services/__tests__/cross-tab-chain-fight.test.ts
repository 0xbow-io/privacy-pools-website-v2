import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A pool page picks its route's chain once per visit. It used to re-select it
 * whenever the active chain differed, so any other pick (the header, or the
 * wallet moving because another tab of the site switched MetaMask) snapped
 * back and switched the wallet with it (Mike, 2026-09-28: "OP keeps flipping
 * back to Mainnet"). Source guard: the effect is small and lives in a
 * component bun cannot render.
 */
const SRC = readFileSync(join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'pools', 'pool-page-content.tsx'), 'utf8');

describe('pool page chain pick', () => {
  test('the route chain is selected once per visit, not on every chain change', () => {
    expect(SRC).not.toContain('if (focused && poolRouteKnown && poolChainId !== activeChainId) void selectChain(poolChainId);');
    const start = SRC.indexOf('const chainPickedForRef = useRef');
    expect(start).toBeGreaterThan(0);
    const effect = SRC.slice(start, SRC.indexOf('}, [focused, poolRouteKnown, poolChainId, activeChainId, walletStatus, isConnected, selectChain]);', start));
    expect(effect).toContain('chainPickedForRef.current === pickKey) return;');
    // A wallet connecting later re-arms the pick.
    expect(effect).toContain('const pickKey = `${poolChainId}:${isConnected}`;');
    expect(effect).toContain('chainPickedForRef.current = pickKey;');
    // Spent only once wagmi has settled, or a reconnect strands the page on the wallet's chain.
    const gate = effect.indexOf("walletStatus === 'reconnecting'");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(effect.indexOf('chainPickedForRef.current = pickKey;'));
    // Leaving the page re-arms it, so coming back picks the chain again.
    expect(effect).toContain('if (!focused) { chainPickedForRef.current = null; return; }');
  });
});

const GUARD = readFileSync(join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'supported-chain-guard.tsx'), 'utf8');

describe('supported-chain guard across tabs', () => {
  test('a hidden tab never moves the wallet', () => {
    // MetaMask keeps one network per site: a background prod tab (no OP) or a
    // plain staging tab (OP hidden) switched the wallet back to its default.
    const effect = GUARD.slice(GUARD.indexOf('if (isSupportedEvmChainId(chainId))'), GUARD.indexOf('switchChainAsync({ chainId: defaultChainId })'));
    expect(effect).toMatch(/if \(!tabVisible\) \{\s*return;\s*\}/);
    // Visible is not enough: two windows side by side are both visible.
    expect(GUARD).toContain("document.visibilityState !== 'hidden' && document.hasFocus()");
    expect(GUARD).toContain("window.addEventListener('blur'");
    expect(GUARD).toContain("document.addEventListener('visibilitychange'");
    expect(GUARD).toContain('}, [chainId, isConnected, switchInFlight, switchChainAsync, tabVisible]);');
  });
});
