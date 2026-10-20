import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { displayTokenSymbol } from '@/services/share-display';

/**
 * The not-found card is the one pool-page surface that renders a symbol the
 * user never chose. `/chains/<chain>/usdt` resolves to the SHARE (PPUSDT) on a
 * chain whose plain pool is legacy, so an unknown chain segment printed
 * "There is no PPUSDT pool on bnb" in prod: the share named to the user, which
 * is exactly what no pp asset may ever do (Ameen). Every other pool-page
 * symbol already goes through displayTokenSymbol; this one did not, and no
 * behaviour test could see it because the leak is the interpolation itself.
 */
const SOURCE = readFileSync(
  new URL('../../components/pools/pool-page-content.tsx', import.meta.url),
  'utf8',
);

test('the not-found card names the coin, never the share symbol behind it', () => {
  expect(SOURCE).toContain('There is no {displayTokenSymbol(currentPoolToken)} pool on {chainLabel}.');
  expect(SOURCE).not.toContain('There is no {currentPoolToken} pool');
});

test('displayTokenSymbol is what makes that copy safe for every prod share', () => {
  for (const [share, coin] of [['PPUSDT', 'USDT'], ['PPUSDC', 'USDC'], ['PPETH', 'ETH']] as const) {
    expect(displayTokenSymbol(share).toUpperCase()).toBe(coin);
  }
  // A plain symbol passes through untouched, so the card still reads correctly
  // for a genuinely unknown asset.
  expect(displayTokenSymbol('DOGE')).toBe('DOGE');
});
