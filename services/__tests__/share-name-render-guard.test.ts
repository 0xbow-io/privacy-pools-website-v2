/**
 * DEV-591 (regression of DEV-428): a share's own name (ppETH, ppUSDC, ppUSDT,
 * whatever the config ships next) must never reach a screen. Shares read as
 * their underlying coin. It was fixed one string at a time at least five times,
 * so this guard is wider than any one string:
 *
 *  1. The share list comes from CONFIG (every environment's token registry),
 *     not a hand-written list, and every share there must have a display rule.
 *  2. The copy builders the Swap tab renders are RUN for every configured share,
 *     with and without a live rate, and their output must not name a share.
 *  3. Swap surfaces must not call the helpers that, by design, fall back to the
 *     share's own symbol when no rate is known (approxUnderlyingText,
 *     tokenAmountLabel, shareAmountText, shareReviewHeadline, or a bare
 *     balanceDisplay view): they go through underlyingOnlyView / shareCountLabel.
 *  4. No string literal or JSX text in components/, app/ or hooks/ names a
 *     configured share.
 *
 * services/__tests__/share-symbol-render-guard.test.ts is the companion that
 * fails on a raw `.symbol` interpolated or rendered anywhere.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ENVIRONMENTS } from '@/config/environments';
import { displayTokenSymbol, isShareSymbol, shareCountLabel, underlyingOnlyView } from '@/services/share-display';
import { shareBalanceDisplay } from '@/services/share-balance-display';
import type { ShareRate } from '@/services/share-rates';
import { noteShortfall, noteShortfallMessage } from '@/services/swap-note-shortfall';
import { friendlySwapError } from '@/services/swap-error-copy';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Every share any environment ships, read from the token registries. */
const CONFIG_SHARES: { symbol: string; decimals: number }[] = (() => {
  const seen = new Map<string, { symbol: string; decimals: number }>();
  for (const env of Object.values(ENVIRONMENTS)) {
    for (const tokens of Object.values(env.tokensByChain)) {
      for (const meta of Object.values(tokens)) {
        if (meta.yieldShare) seen.set(meta.symbol, { symbol: meta.symbol, decimals: meta.decimals });
      }
    }
  }
  return [...seen.values()];
})();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SHARE_NAME = new RegExp(`\\b(?:${CONFIG_SHARES.map((s) => escape(s.symbol)).join('|')})\\b`, 'i');

function rateFor(share: { symbol: string; decimals: number }): ShareRate {
  const underlying = displayTokenSymbol(share.symbol);
  const underlyingDecimals = underlying === 'ETH' ? 18 : 6;
  return {
    chainId: 1,
    share: '0x0000000000000000000000000000000000000001',
    underlying: '0x0000000000000000000000000000000000000002',
    shareSymbol: share.symbol,
    shareDecimals: share.decimals,
    // 1 share = 1.0007 underlying.
    assetsPerShare: 10_007n * 10n ** BigInt(underlyingDecimals) / 10_000n,
    underlyingSymbol: underlying === 'ETH' ? 'WETH' : underlying,
    underlyingDecimals,
  };
}

describe('the share list comes from config', () => {
  test('config ships shares, and every one has a display rule to its coin', () => {
    expect(CONFIG_SHARES.length).toBeGreaterThan(0);
    for (const { symbol } of CONFIG_SHARES) {
      expect(isShareSymbol(symbol)).toBe(true);
      const coin = displayTokenSymbol(symbol);
      expect(coin).not.toBe(symbol);
      expect(coin).not.toMatch(SHARE_NAME);
    }
  });
});

describe('what the Swap tab renders never names a share', () => {
  for (const share of CONFIG_SHARES) {
    const wei = 9_990_000_000_000_000n;
    test(`${share.symbol}: the note shortfall copy, every reason`, () => {
      const cases = [
        noteShortfall({ totalWei: wei, approvedWei: 0n, selectableWei: 0n }),
        noteShortfall({ totalWei: wei * 2n, approvedWei: wei, selectableWei: wei }),
        noteShortfall({ totalWei: wei * 2n, approvedWei: wei * 2n, selectableWei: wei }),
        noteShortfall({ totalWei: wei, approvedWei: wei, selectableWei: wei }),
        noteShortfall({ totalWei: 0n, approvedWei: 0n, selectableWei: 0n }),
      ];
      for (const s of cases) {
        const text = noteShortfallMessage(s, share);
        expect(text).not.toMatch(SHARE_NAME);
        expect(text).toContain(displayTokenSymbol(share.symbol));
      }
    });

    test(`${share.symbol}: the DEV-590 message names the coin`, () => {
      const text = noteShortfallMessage(noteShortfall({ totalWei: wei, approvedWei: 0n, selectableWei: 0n }), share);
      expect(text).toBe(`None of your ${displayTokenSymbol(share.symbol)} notes are approved yet. 0.00999 ${displayTokenSymbol(share.symbol)} shares is waiting.`);
    });

    test(`${share.symbol}: a swap error with amounts`, () => {
      const text = friendlySwapError('Invalid transact params: LiFi needs 1000000000000000000 input but only 900000000000000000 available after fee.', share);
      expect(text).not.toBeNull();
      expect(text!).not.toMatch(SHARE_NAME);
    });

    test(`${share.symbol}: a balance view, with and without a rate`, () => {
      for (const rate of [undefined, rateFor(share)]) {
        for (const sharesExact of ['0', '0.00999', '12.5']) {
          const view = underlyingOnlyView(shareBalanceDisplay({ sharesExact, shareSymbol: share.symbol, rate, priceMap: {}, fallbackPrice: 0 }), share.symbol);
          expect(view.text).not.toMatch(SHARE_NAME);
          expect(view.symbol).not.toMatch(SHARE_NAME);
          expect(view.hint ?? '').not.toMatch(SHARE_NAME);
          // Not converted: plainly a share count, never a bare coin figure.
          if (!rate && sharesExact !== '0') expect(view.text.endsWith(`${displayTokenSymbol(share.symbol)} shares`)).toBe(true);
        }
      }
    });

    test(`${share.symbol}: a count without a rate`, () => {
      expect(shareCountLabel('1.5', share.symbol)).toBe(`1.5 ${displayTokenSymbol(share.symbol)} shares`);
    });
  }

  test('a plain token passes through untouched', () => {
    expect(shareCountLabel('1.5', 'USDC')).toBe('1.5 USDC');
    expect(shareCountLabel('1.5', 'WETH')).toBe('1.5 ETH');
    const view = shareBalanceDisplay({ sharesExact: '1.5', shareSymbol: 'USDC', rate: undefined, priceMap: {}, fallbackPrice: 1 });
    expect(underlyingOnlyView(view, 'USDC')).toBe(view);
  });
});

/** Files that make up the Swap tab, the swap modal, swap-send and the swap review/success screens. */
const SWAP_SURFACES = [
  'components/swap-modal-provider.tsx',
  'components/ui/swap-pair-card.tsx',
  'components/ui/token-select-sheet.tsx',
  'services/swap-note-shortfall.ts',
  'services/swap-error-copy.ts',
  'services/swap-flows.ts',
  'services/swap-outcome-copy.ts',
];
/** These keep the share's own symbol when no rate is known, by design (Pat, 2026-10-21). */
const SHARE_FALLBACK_HELPERS = /\b(?:approxUnderlyingText|tokenAmountLabel|shareAmountText|shareReviewHeadline)\(/;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

describe('swap surfaces only use the share-free display rules', () => {
  test('no helper that falls back to the share symbol', () => {
    const offenders: string[] = [];
    for (const file of SWAP_SURFACES) {
      stripComments(read(file)).split('\n').forEach((line, i) => {
        if (SHARE_FALLBACK_HELPERS.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('every balance view in the swap modal goes through underlyingOnlyView', () => {
    const src = stripComments(read('components/swap-modal-provider.tsx'));
    // The one call is inside swapView itself.
    expect(src.match(/\bbalanceDisplay\(/g) ?? []).toHaveLength(1);
    expect(src).toContain('underlyingOnlyView(balanceDisplay(exact, symbol, cid, tokenAddress), symbol)');
    const sheet = stripComments(read('components/ui/token-select-sheet.tsx'));
    for (const m of sheet.match(/\bbalanceDisplay\([^\n]*/g) ?? []) {
      expect(m.startsWith('balanceDisplay(pool.balanceTokenExact')).toBe(true);
    }
    expect(sheet).toContain('underlyingOnlyView(balanceDisplay(pool.balanceTokenExact');
  });

  test('the hub balance headline is share-free on every tab', () => {
    const hub = read('components/home/action-hub.tsx');
    expect(hub).toContain('const pageBalanceView = underlyingOnlyView(');
    expect(hub).toContain('const pagePendingView = underlyingOnlyView(');
  });
});

describe('no literal share name in UI source', () => {
  const DIRS = ['components', 'app', 'hooks'];
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === '__tests__' || name === 'node_modules') continue;
      if (statSync(p).isDirectory()) out.push(...sources(p));
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  const JSX_TEXT = />([^<>{}]+)</g;
  const LITERAL_SHARE_NAME = new RegExp(`(?<![.\\w$])(?:${CONFIG_SHARES.map((s) => escape(s.symbol)).join('|')})\\b`);

  test('the literal rule catches copy and skips identifiers', () => {
    expect(LITERAL_SHARE_NAME.test('0.5 ppETH is waiting')).toBe(true);
    expect(LITERAL_SHARE_NAME.test('d.ppUSDC.toLowerCase()')).toBe(false);
    expect(LITERAL_SHARE_NAME.test('ppusdc-net-realized')).toBe(false);
  });

  test('string literals and JSX text never carry a configured share name', () => {
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of sources(join(ROOT, dir))) {
        const src = stripComments(readFileSync(file, 'utf8'));
        const hits = [...(src.match(STRING) ?? []), ...[...src.matchAll(JSX_TEXT)].map((m) => m[1]!)];
        for (const raw of hits) {
          // Interpolations are code, not copy (the raw-.symbol guard covers them),
          // and a property access (`deployment.ppUSDC`) is an identifier.
          const h = raw.replace(/\$\{[^{}]*\}/g, '');
          if (LITERAL_SHARE_NAME.test(h)) offenders.push(`${relative(ROOT, file)}: ${h.trim().slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
