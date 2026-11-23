import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Portfolio Withdraw on a row from another chain used to open the modal on the
// ACTIVE chain, which only takes a token that exists there, so every row on
// another chain opened the same default token (user report, 2026-11-22).
describe('portfolio Withdraw opens on the row\'s chain', () => {
  const src = readFileSync(fileURLToPath(new URL('../../components/portfolio/all-positions.tsx', import.meta.url)), 'utf8');

  test('a row on another chain goes through its pool page with ?action=withdraw', () => {
    expect(src).toContain('position.chainId !== activeChainId');
    expect(src).toContain('${getPoolPath(tokenSymbol, position.chainId)}?action=withdraw');
  });

  test('both Withdraw buttons use the chain-aware handler', () => {
    expect(src.match(/handleWithdraw\(position\)/g)?.length).toBe(2);
    expect(src).not.toMatch(/onPress=\{\(\) => openWithdrawModal\(/);
    expect(src).not.toMatch(/closeMenu\(\); openWithdrawModal\(/);
  });
});

// Explore -> pool page: the shield card beside a USDC pool opened on ETH because
// nothing told it which pool it sat on (user report, 2026-11-22).
describe('pool page shield card starts on the pool asset', () => {
  const page = readFileSync(fileURLToPath(new URL('../../components/pools/pool-page-content.tsx', import.meta.url)), 'utf8');
  const hub = readFileSync(fileURLToPath(new URL('../../components/home/action-hub.tsx', import.meta.url)), 'utf8');

  test('the pool page hands its pool to the card', () => {
    expect(page).toContain('<ActionHub pool={hubPool} />');
    expect(page).toContain('symbol: currentPoolToken, chainId: poolChainId');
  });

  test('the card seeds once, on the pool chain, matching symbols case-insensitively', () => {
    expect(hub).toContain('pool.chainId !== activeChainId');
    expect(hub).toContain('seededPoolRef.current === key');
    // Case-insensitive, and a share pool falls back to its underlying (the
    // Shield list carries no yield shares, so ppUSDC must seed USDC).
    expect(hub).toContain('[pool.symbol, displayTokenSymbol(pool.symbol)].map((s) => s.toUpperCase())');
    expect(hub).toContain('t.symbol.toUpperCase() === s');
  });

  test('the seed is armed once per pool, so a failed match never fires later on another tab', () => {
    const effect = hub.slice(hub.indexOf('seededPoolRef.current === key'), hub.indexOf('if (match) setToken(match.symbol)'));
    expect(effect).toContain('seededPoolRef.current = key;');
    expect(effect.indexOf('seededPoolRef.current = key;')).toBeLessThan(effect.indexOf('const match'));
  });
});

// The My transactions card cut its own filter dropdowns off at its bottom edge.
describe('My transactions card lets its filter dropdowns out', () => {
  const panel = readFileSync(fileURLToPath(new URL('../../components/home/explore-panel.tsx', import.meta.url)), 'utf8');
  test('no overflow-hidden on the card, overflow visible by style', () => {
    expect(panel).not.toContain('<Card noPadding className="overflow-hidden">');
    expect(panel).toContain("style={{ overflow: 'visible' }}");
  });
});
