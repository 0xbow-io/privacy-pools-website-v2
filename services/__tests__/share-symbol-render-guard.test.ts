import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { shareBalanceDisplay } from '@/services/share-balance-display';
import {
  approxUnderlyingText, displayTokenSymbol, shareAmountText, shareReviewHeadline, tokenAmountLabel, underlyingOnlyView,
} from '@/services/share-display';
import type { ShareRate } from '@/services/share-rates';

/**
 * DEV-428: a share's own name (ppUSDC / ppUSDT / ppETH) must never reach the
 * screen. It was fixed one string at a time four times in one week and kept
 * coming back, because nothing stopped a new `${token.symbol}` in a message.
 *
 * This walks every source file and fails on a raw `.symbol` interpolated into
 * a template string or rendered as a JSX child. Route it through
 * `displayTokenSymbol` (a name) or `approxUnderlyingText` (an amount + symbol,
 * which also marks a share count approximate). Lines that never reach a user
 * (logs, test ids, keys) are exempt, as is a chain's native currency, which is
 * never a share.
 */
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const DIRS = ['components', 'services', 'hooks', 'app'];
// Indexed access too: `${balances[i].symbol}`, `{tokens[0].symbol}` (#150 review).
const RAW = /\$\{[A-Za-z0-9_.?!()[\]]*\.symbol\}|(?:^|[^=$])\{[A-Za-z0-9_.?!()[\]]*\.symbol\}/g;
// `raw-data:` marks a string that is data, not copy: a consumer parses it, and
// every render of it goes through a display rule (say which in the comment).
const EXEMPT_LINE = /(want=|got=|\[perf\]|raw-data:)/;
/**
 * Exemptions are TOKEN-scoped, not line-scoped (#150 review): a line that
 * carries a test id or a key can still render a symbol beside it. Only the
 * exempt part is removed: a testID / key / accessibilityLabel template, the
 * template handed to approxUnderlyingText, and a log call to the end of its line.
 */
function renderable(line: string): string {
  return line
    .replace(/\b(?:testID|key|accessibilityLabel)=\{`[^`]*`\}/g, '')
    .replace(/\{(?:amountField|view)\.symbol\}/g, '')
    .replace(/\{(?:isShareSymbol\(requestToken\.symbol\) \? requestToken\.symbol : displayTokenSymbol\(requestToken\.symbol\))\}/g, '')
    .replace(/\$\{requestTokenSymbol\}/g, '')
    .replace(/approxUnderlyingText\(`[^`]*`/g, 'approxUnderlyingText(')
    .replace(/(?:\blog|\bconsole\.\w+)\(.*$/, '');
}
const EXEMPT_EXPR = /\{\s*(?:native|nativeCurrency|chain\.nativeCurrency)\.symbol\}/;

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

describe('no raw share symbol can reach a render', () => {
  test('pool balance strings stay parseable: the hub reads them with parseFloat', () => {
    // #150 review: wrapping these in approxUnderlyingText made them "≈ 12.34
    // USDC", parseFloat gave NaN, and every share balance on the hub read 0.
    const src = readFileSync(join(ROOT, 'components/pools-provider.tsx'), 'utf8');
    const line = src.split('\n').find((l) => l.includes('balanceToken: '))!;
    expect(line).not.toContain('approxUnderlyingText(');
    expect(parseFloat('12.34 ppUSDC')).toBe(12.34);
  });


  test('every interpolated or rendered .symbol goes through a display rule', () => {
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of sources(join(ROOT, dir))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (EXEMPT_LINE.test(line)) return;
          for (const m of renderable(line).match(RAW) ?? []) {
            if (EXEMPT_EXPR.test(m)) continue;
            offenders.push(`${relative(ROOT, file)}:${i + 1}: ${m.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the guard itself catches the shapes it is for', () => {
    const hits = (line: string) => (EXEMPT_LINE.test(line) ? [] : (renderable(line).match(RAW) ?? []).filter((m) => !EXEMPT_EXPR.test(m)));
    expect(hits('return `covers ${amount} ${units.symbol}`;')).toHaveLength(1);
    expect(hits('<Text>{t.symbol}</Text>')).toHaveLength(1);
    expect(hits('symbol={t.symbol}')).toHaveLength(0);
    expect(hits('`${displayTokenSymbol(units.symbol)}`')).toHaveLength(0);
    expect(hits('`needs a little ${native.symbol}`')).toHaveLength(0);
    // Token-scoped: a test id or key on the same line does not hide a render.
    expect(hits('<Text testID="bal">{t.symbol}</Text>')).toHaveLength(1);
    expect(hits('tokens.map(t => <Text key={t.symbol}>{t.symbol}</Text>)')).toHaveLength(1);
    expect(hits('<View testID={`row-${t.symbol}`} />')).toHaveLength(0);
    expect(hits("log('info', 'X', `sent ${t.symbol}`)")).toHaveLength(0);
    // Indexed access.
    expect(hits('`${balances[i].symbol}`')).toHaveLength(1);
    expect(hits('<Text>{tokens[0].symbol}</Text>')).toHaveLength(1);
  });

  test('the display rules rename shares and leave plain tokens alone', () => {
    expect(displayTokenSymbol('ppUSDT')).toBe('USDT');
    expect(displayTokenSymbol('USDC')).toBe('USDC');
    expect(approxUnderlyingText('1.5 ppUSDC', 'ppUSDC')).toBe('… USDC');
    expect(approxUnderlyingText('1.5 USDC', 'USDC')).toBe('1.5 USDC');
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
    test(`${share}: labels are the plain coin, a count never reaches the screen (DEV-621)`, () => {
      expect(coin).toMatch(/^(?:USDC|USDT|ETH)$/);
      expect(tokenAmountLabel('0.1', share)).toBe(`… ${coin}`);
      expect(approxUnderlyingText(`0.1 ${share}`, share)).toBe(`… ${coin}`);
      const format = (n: number) => String(n);
      expect(shareAmountText({ amount: 0.1, assetSymbol: share, underlyingAmount: null, format })).toBe(`… ${coin}`);
      expect(shareReviewHeadline({ isShare: true, shares: 0.1, shareSymbol: share, underlyingSymbol: coin, underlying: null, pending: false, format })).toBe(`… ${coin}`);
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
