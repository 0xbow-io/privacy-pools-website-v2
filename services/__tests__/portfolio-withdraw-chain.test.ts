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
