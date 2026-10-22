/**
 * The swap review never prints the share's own name.
 *
 * "The share is named nowhere" (Pat relaying Ameen, 2026-09-12) was applied to
 * the side you RECEIVE and missed the side you PAY, so a review of a ppUSDC
 * note read "5 ppUSDC", "0.152397 ppUSDC", "4.847602 ppUSDC" and
 * "1 ppUSDC ~ 0.985932 USDT" (QA, 2026-09-22).
 *
 * The renamed figure must also stay honest. A share count is not the same
 * number as the underlying, so it carries the approximate marker; the gap is
 * the accrued rate and it understates rather than overstates. That is
 * `approxUnderlyingText`, which this asserts rather than restates.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approxUnderlyingText, displayTokenSymbol, isShareSymbol } from '@/services/share-display';

const SOURCE = readFileSync(
  join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'swap-modal-provider.tsx'),
  'utf8',
);

/** The rows of the payout review, by the label that precedes them. */
const PAID_ROWS = ['You swap', 'Relayer fee', 'Swapped after fee'] as const;

describe('the review renders no raw share symbol', () => {
  test('every fromToken.symbol in the rendered tree goes through a display rule', () => {
    // A bare `{x.fromToken.symbol}` in JSX is the defect. The lookbehind skips
    // `${x.fromToken.symbol}`, which is a template interpolation INSIDE an
    // argument to one of the display rules and is exactly what we want.
    const raw = SOURCE.match(/(?<!\$)\{\s*(?:snapshot|reshieldSnapshot)?\.?fromToken\.symbol\s*\}/g) ?? [];
    expect(raw).toEqual([]);
  });

  /**
   * Both reviews use these labels. The reshield one renders pre-shaped strings
   * (`display.grossText`), which carry their own units; the payout one composes
   * the figure and the symbol inline, and is the one this pins. It is
   * identified by reading `snapshot.` rather than `reshieldSnapshot.`.
   */
  const payoutRow = (label: string): string | null => {
    let from = 0;
    for (;;) {
      const at = SOURCE.indexOf(`>${label}</Text>`, from);
      if (at === -1) return null;
      const row = SOURCE.slice(at, at + 400);
      if (!row.includes('reshieldSnapshot.') && row.includes('snapshot.')) return row;
      from = at + 1;
    }
  };

  for (const label of PAID_ROWS) {
    test(`"${label}" is renamed and marked approximate`, () => {
      const row = payoutRow(label);
      expect(row).not.toBeNull();
      expect(row).toContain('balanceDisplay(');
    });
  }

  test('the rate row names the underlying on both sides', () => {
    expect(SOURCE).toContain("balanceDisplay('1', snapshot.fromToken.symbol, chainId).symbol");
    expect(SOURCE).toContain("balanceDisplay('1', snapshot.outputToken.symbol, snapshot.destinationChainId).symbol");
  });
});

describe('the rename is honest about what a share count is', () => {
  const cases: readonly [string, string][] = [
    ['ppUSDC', 'USDC'],
    ['ppUSDT', 'USDT'],
    ['ppETH', 'ETH'],
  ];

  for (const [share, underlying] of cases) {
    test(`${share} reads as ${underlying}, approximately`, () => {
      expect(isShareSymbol(share)).toBe(true);
      expect(displayTokenSymbol(share)).toBe(underlying);
      const text = approxUnderlyingText(`5 ${share}`, share);
      expect(text).toBe(`5 ${share}`);
      expect(text).toContain(share);
    });
  }

  test('a plain asset is left exactly as it was', () => {
    for (const plain of ['USDC', 'cBTC', 'BNB']) {
      expect(approxUnderlyingText(`5 ${plain}`, plain)).toBe(`5 ${plain}`);
    }
  });
});
