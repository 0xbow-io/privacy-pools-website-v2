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
 *  3. Swap balance views go through underlyingOnlyView. No helper falls back to
 *     the share's own symbol any more: without a rate a rendered figure is a
 *     shimmer and plain text reads the count under the coin, marked "≈".
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
import {
  approxUnderlyingText, displayTokenSymbol, isShareSymbol, shareAmountText, shareReviewHeadline, tokenAmountLabel, underlyingOnlyView,
} from '@/services/share-display';
import { shareBalanceDisplay } from '@/services/share-balance-display';
import type { ShareRate } from '@/services/share-rates';
import { noteShortfall, noteShortfallMessage } from '@/services/swap-note-shortfall';
import { friendlySwapError } from '@/services/swap-error-copy';
import { SWAP_APPROVAL_CHECKING, SWAP_APPROVAL_UNAVAILABLE } from '@/services/swap-note-approval';

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
      expect(text).toBe(`None of your ${displayTokenSymbol(share.symbol)} notes are approved yet. ≈ 0.00999 ${displayTokenSymbol(share.symbol)} is waiting.`);
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
          // Not converted: a loading figure (shimmer), never a share count label.
          expect(view.loading).toBe(!rate && sharesExact !== '0');
          expect(view.text).not.toMatch(/\bshares\b/i);
        }
      }
    });

    test(`${share.symbol}: nothing held and no rate reads as a plain zero, the coin named once`, () => {
      const coin = displayTokenSymbol(share.symbol);
      const view = underlyingOnlyView(shareBalanceDisplay({ sharesExact: '0', shareSymbol: share.symbol, rate: undefined, priceMap: {}, fallbackPrice: 0 }), share.symbol);
      expect(view.text).toMatch(new RegExp(`^0(?:\\.0+)? ${escape(coin)}$`));
      expect(view.text).not.toContain('shares');
      expect(view.symbol).toBe(coin);
      expect(view.hint).toBeNull();
    });

    test(`${share.symbol}: a count without a rate, in plain text`, () => {
      expect(tokenAmountLabel('1.5', share.symbol)).toBe(`≈ 1.5 ${displayTokenSymbol(share.symbol)}`);
    });
  }

  test('a plain token passes through untouched', () => {
    expect(tokenAmountLabel('1.5', 'USDC')).toBe('1.5 USDC');
    expect(tokenAmountLabel('1.5', 'WETH')).toBe('1.5 ETH');
    const view = shareBalanceDisplay({ sharesExact: '1.5', shareSymbol: 'USDC', rate: undefined, priceMap: {}, fallbackPrice: 1 });
    expect(underlyingOnlyView(view, 'USDC')).toBe(view);
  });

  test('the approval states name no share', () => {
    expect(SWAP_APPROVAL_CHECKING).not.toMatch(SHARE_NAME);
    expect(SWAP_APPROVAL_UNAVAILABLE).not.toMatch(SHARE_NAME);
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
  'services/swap-note-approval.ts',
];
/** Every display helper a swap surface may call, each RUN below for every share. */
const SHARE_DISPLAY_HELPERS = { approxUnderlyingText, tokenAmountLabel, shareAmountText, shareReviewHeadline };

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

describe('swap surfaces only use the share-free display rules', () => {
  test('no display helper falls back to the share symbol or the word "shares"', () => {
    const format = (n: number) => String(n);
    for (const { symbol } of CONFIG_SHARES) {
      const outputs = [
        SHARE_DISPLAY_HELPERS.approxUnderlyingText(`1.5 ${symbol}`, symbol),
        SHARE_DISPLAY_HELPERS.tokenAmountLabel('1.5', symbol),
        SHARE_DISPLAY_HELPERS.shareAmountText({ amount: 1.5, assetSymbol: symbol, underlyingAmount: null, format }),
        SHARE_DISPLAY_HELPERS.shareReviewHeadline({ isShare: true, shares: 1.5, shareSymbol: symbol, underlyingSymbol: displayTokenSymbol(symbol), underlying: null, pending: false, format }),
      ];
      for (const text of outputs) {
        expect(text).not.toMatch(SHARE_NAME);
        expect(text).not.toMatch(/\bshares\b/i);
      }
    }
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

/**
 * Pat's hard rule, QA on #29 and #26 (Mike): the screen shows USDC, USDT or
 * ETH, never a share's name and never the word "shares", in any state (rate
 * loading, no rate, errors, toasts, activity, notifications). A figure that
 * waits on the rate is a shimmer (components/ui/share-figure.tsx), not a share
 * count label.
 *
 * Part 1 RUNS every display helper for every share, with and without a rate.
 * Part 2 scans every string literal, template and JSX text in components/,
 * hooks/, app/ and services/ for the word "shares". Data that is not copy (an
 * ABI parameter name, a record key, a field lookup) and log lines are exempt.
 */
describe('the word "shares" never reaches a screen', () => {
  const SHARES_WORD = /\bshares\b/i;
  const SHARE_SYMBOLS = ['ppUSDC', 'ppUSDT', 'ppETH'];
  const NO_SHARE_NAME = /\bpp(?:USDC|USDT|ETH)\b/i;
  const RATE_OF = (share: string): ShareRate => {
    const coin = displayTokenSymbol(share);
    const underlyingDecimals = coin === 'ETH' ? 18 : 6;
    return {
      chainId: 1,
      share: '0x0000000000000000000000000000000000000001',
      underlying: '0x0000000000000000000000000000000000000002',
      shareSymbol: share,
      shareDecimals: 18,
      assetsPerShare: 10_007n * 10n ** BigInt(underlyingDecimals) / 10_000n,
      underlyingSymbol: coin === 'ETH' ? 'WETH' : coin,
      underlyingDecimals,
    };
  };
  const clean = (text: string | null | undefined) => {
    expect(text ?? '').not.toMatch(SHARES_WORD);
    expect(text ?? '').not.toMatch(NO_SHARE_NAME);
  };

  for (const share of SHARE_SYMBOLS) {
    const coin = displayTokenSymbol(share);
    test(`${share}: labels are the plain coin, amounts never a share count label`, () => {
      expect(coin).toMatch(/^(?:USDC|USDT|ETH)$/);
      expect(tokenAmountLabel('0.1', share)).toBe(`≈ 0.1 ${coin}`);
      expect(approxUnderlyingText(`0.1 ${share}`, share)).toBe(`≈ 0.1 ${coin}`);
      const format = (n: number) => String(n);
      expect(shareAmountText({ amount: 0.1, assetSymbol: share, underlyingAmount: null, format })).toBe(`≈ 0.1 ${coin}`);
      expect(shareReviewHeadline({ isShare: true, shares: 0.1, shareSymbol: share, underlyingSymbol: coin, underlying: null, pending: false, format })).toBe(`≈ 0.1 ${coin}`);
      for (const text of [tokenAmountLabel('0.1', share), approxUnderlyingText(`0.1 ${share}`, share)]) clean(text);
    });

    test(`${share}: a balance view loads as a shimmer, then reads the converted coin`, () => {
      for (const rate of [undefined, RATE_OF(share)]) {
        for (const sharesExact of ['0', '0.00999', '12.5']) {
          const view = underlyingOnlyView(shareBalanceDisplay({ sharesExact, shareSymbol: share, rate, priceMap: {}, fallbackPrice: 0 }), share);
          clean(view.text);
          clean(view.hint);
          expect(view.symbol).toBe(coin);
          // Held, no rate: the figure is a loading state, not a label.
          expect(view.loading).toBe(!rate && sharesExact !== '0');
        }
      }
    });
  }

  test('a plain token is untouched by the label helpers', () => {
    expect(tokenAmountLabel('1.5', 'USDC')).toBe('1.5 USDC');
    expect(tokenAmountLabel('1.5', 'WETH')).toBe('1.5 ETH');
    expect(approxUnderlyingText('1.5 USDC', 'USDC')).toBe('1.5 USDC');
    expect(shareBalanceDisplay({ sharesExact: '1.5', shareSymbol: 'USDC', rate: undefined, priceMap: {}, fallbackPrice: 1 }).loading).toBe(false);
  });

  const SCAN_DIRS = ['components', 'hooks', 'app', 'services'];
  const scanSources = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === '__tests__' || name === 'node_modules') continue;
      if (statSync(p).isDirectory()) out.push(...scanSources(p));
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const withoutComments = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  // Not copy: ABI parameter names, record keys and field lookups ("shares" as data).
  const DATA_TOKEN = /(?:\bname:\s*|\bhas\(|\bf\(|\[)\s*(['"`])shares\1/g;
  const LOG_CALL = /(?:\blog|\bconsole\.\w+)\(.*$/;
  const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  const JSX_TEXT = />([^<>{}]+)</g;
  const CODE_START = /^(?:return|const|let|var|if|else|import|export|type|case|await|throw|async|function|for|while|new)\b/;
  /** Every piece of copy on a line: literals, same-line JSX text, a JSX text line. */
  const copyOn = (line: string): string[] => {
    const code = line.replace(LOG_CALL, '').replace(DATA_TOKEN, '');
    // Interpolations are code, not copy; a TS generic (`Array<X>, y: Z<W>`) is not JSX text.
    const out = [
      ...(code.match(STRING) ?? []).map((s) => s.replace(/\$\{[^{}]*\}/g, '')),
      ...[...code.matchAll(JSX_TEXT)].map((m) => m[1]!).filter((t) => !/[:=();]/.test(t)),
    ];
    const bare = code.replace(STRING, '').replace(/\{[^{}]*\}/g, '').trim();
    if (/^[A-Za-z][A-Za-z'’,.!? ]*$/.test(bare) && bare.includes(' ') && !CODE_START.test(bare)) out.push(bare);
    return out;
  };

  test('the scan catches copy and skips data, logs and identifiers', () => {
    const hit = (line: string) => copyOn(line).some((c) => SHARES_WORD.test(c));
    expect(hit("throw new Error('Your shares were not unwrapped.');")).toBe(true);
    expect(hit('return `${amount} ${coin} shares`;')).toBe(true);
    expect(hit('<Text>0.1 ETH shares</Text>')).toBe(true);
    expect(hit('          Shares keep their count')).toBe(true);
    expect(hit("inputs: [{ name: 'shares', type: 'uint256' }],")).toBe(false);
    expect(hit("text: (f) => `${f('shares')} redeems to nothing after fees.`,")).toBe(false);
    expect(hit("log('info', 'Yield', `minted ${n} shares`);")).toBe(false);
    expect(hit('const shares = sized.shares;')).toBe(false);
    expect(hit('return shares;')).toBe(false);
    expect(hit('const hex = `0x${shares.toString(16)}`;')).toBe(false);
    expect(hit('function f(a: Array<X>, shares: ReturnType<Y>) {')).toBe(false);
  });

  test('no string literal or JSX text in UI or service copy says "shares"', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of scanSources(join(ROOT, dir))) {
        withoutComments(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
          for (const c of copyOn(line)) {
            if (SHARES_WORD.test(c)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${c.trim().slice(0, 120)}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
