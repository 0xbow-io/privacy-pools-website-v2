import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { approxUnderlyingText, displayTokenSymbol, withoutShareNames } from '@/services/share-display';

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
// `not-rendered:` marks a line inside a log or report payload that a
// multi-line call keeps out of reach of the per-line log exemption.
const EXEMPT_LINE = /(want=|got=|\[perf\]|raw-data:|not-rendered:)/;
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
    expect(approxUnderlyingText('1.5 ppUSDC', 'ppUSDC')).toBe('≈ 1.5 USDC');
    expect(approxUnderlyingText('1.5 USDC', 'USDC')).toBe('1.5 USDC');
  });
});

/**
 * Mike, 2026-11-07: "the entire app is still full of share names". The guard
 * above only knew `.symbol`; the leaks were symbols carried under other names
 * (`tokenSymbol`, `paySymbol`, `displaySymbol`, `actionSymbol`) and SDK,
 * relayer and LI.FI text shown verbatim in a flow's error, step or toast.
 */
// Names that can never hold a share: a chain's gas coin, the Sui/Stellar coin,
// an underlying, and a name already put through displayTokenSymbol.
// An underlying is never a share, wherever it is read from (d.underlyingSymbol).
const SAFE_NAMED = /^(?:nativeSymbol|altSymbol|(?:[\w$]+\.)*underlyingSymbol|recvSymbol|suiSymbol|native\.symbol|nativeCurrency\.symbol|chain\.nativeCurrency\.symbol)$/;
// The display rules themselves build these strings from raw symbols on purpose.
const RULE_FILES = new Set(['services/share-display.ts']);
// What a user sees: a template interpolation, or a JSX child. A JSX child is
// written unpadded ({x.symbol}); an object literal, destructuring or import list
// is padded ({ symbol }), and a prop value follows "=", so neither is read.
const RENDERED_EXPR = /\$\{((?:[^{}]|\{[^{}]*\})*)\}|(?:^|[^=$\w])\{(?!\s)((?:[^{}]|\{[^{}]*\})*)\}/g;

/**
 * Every symbol-carrying value ANYWHERE inside a rendered expression, not only
 * one that ends it (cubic on #324): {tokenSymbol.toUpperCase()},
 * ${tokenSymbol ?? 'ETH'}, {row.symbol || 'Unknown asset'}. A value is a
 * '.symbol' property or a camelCase name ending in Symbol. A bare 'symbol' local
 * is the display name by convention (const symbol = displayTokenSymbol(...)).
 * Not counted: an argument to a call (displayTokenSymbol(x.symbol) renders what
 * the call returns), a called name itself, a side of a comparison, and a
 * value only tested as a condition.
 */
function namedOffenders(line: string): string[] {
  if (EXEMPT_LINE.test(line)) return [];
  const hits: string[] = [];
  for (const m of renderable(line).matchAll(RENDERED_EXPR)) {
    let expr = (m[1] ?? m[2] ?? '').replace(/'[^']*'|"[^"]*"/g, "''");
    if (/^\s*\/\*/.test(expr)) continue; // a JSX comment
    let prev;
    do { prev = expr; expr = expr.replace(/\((?:[^()]|\(\))+\)/g, '()'); } while (expr !== prev);
    expr = expr.replace(/`[^`]*`/g, '""'); // a nested template is matched on its own
    for (const c of expr.matchAll(/[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[^\]]*\])*(\s*\()?/g)) {
      const segs = c[0].replace(/\s*\($/, '').split(/\??\.|\[[^\]]*\]/).filter(Boolean);
      const values = c[1] ? segs.slice(0, -1) : segs;
      const idx = values.findIndex((v, i) => /[a-z0-9]Symbol$/.test(v) || (v === 'symbol' && i > 0));
      if (idx < 0) continue;
      const path = segs.slice(0, idx + 1).join('.');
      if (SAFE_NAMED.test(path)) continue;
      const at = c.index ?? 0;
      const after = expr.slice(at + c[0].length);
      // Compared, or tested as a condition (`x.symbol ? … : …`, `x.symbol && …`): not shown.
      if (/^\s*(?:[!=]==?|\?(?![?.])|&&)/.test(after) || /[!=]==?\s*$/.test(expr.slice(0, at))) continue;
      hits.push(path);
    }
  }
  return hits;
}

// Free text from outside the app (SDK, relayer, LI.FI, a thrown Error) shown by
// a transaction flow. Each must be rendered through withoutShareNames.
const FLOW_FILES = [
  'components/deposit-modal-provider.tsx',
  'components/withdraw-modal-provider.tsx',
  'components/transfer-modal-provider.tsx',
  'components/swap-modal-provider.tsx',
  'components/ragequit-modal-provider.tsx',
  'components/payment-request-modal-provider.tsx',
  'components/keystore-registration-modal-provider.tsx',
  'components/consolidation-panel.tsx',
  'components/home/action-hub.tsx',
];
const RAW_FREE_TEXT = /(?<!\$)\{\s*(?:[A-Za-z]+\.)?(?:withdrawError|swapError|transferError|depositError|errorMessage|loadingMessage|statusMessage|warningMessage|claimError|claimStatusMessage|stuckMessage|validationError|amountError|error|message)\s*(?:\?\?|\|\||\})/g;

describe('no share name reaches a render under another name', () => {
  test('every rendered …Symbol goes through a display rule', () => {
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of sources(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (RULE_FILES.has(rel)) continue;
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          for (const m of namedOffenders(line)) offenders.push(`${rel}:${i + 1}: ${m.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the named guard catches the shapes it is for', () => {
    const hits = (line: string) => namedOffenders(line).length;
    expect(hits('`${p.balanceFormatted} ${p.tokenSymbol}`')).toBe(1);
    expect(hits('Two transactions: a {depositFlow.swapConsent.paySymbol} approval')).toBe(1);
    expect(hits('held as {position.actionSymbol}')).toBe(1);
    // Anywhere in the expression, not only at its end (cubic on #324).
    expect(hits('<Text>{tokenSymbol.toUpperCase()}</Text>')).toBe(1);
    expect(hits("`${tokenSymbol ?? \'ETH\'} balance`")).toBe(1);
    expect(hits("<Text>{row.symbol || 'Unknown asset'}</Text>")).toBe(1);
    expect(hits('`${t.symbol.toLowerCase()} pool`')).toBe(1);
    expect(hits("<Text>{isShare ? note.tokenSymbol : 'ETH'}</Text>")).toBe(1);
    // Display rules, props, comparisons, objects and safe names pass.
    expect(hits('held as {displayTokenSymbol(position.actionSymbol)}')).toBe(0);
    expect(hits('{tokenAmountLabel(formatUnits(v, d), selectedSymbol)}')).toBe(0);
    expect(hits('`a little ${nativeSymbol} here`')).toBe(0);
    expect(hits('tokenSymbol={p.tokenSymbol}')).toBe(0);
    expect(hits("{tokenSymbol === 'ETH' ? 'gas' : 'token'}")).toBe(0);
    expect(hits('const x = { symbol: t.symbol, decimals: 6 };')).toBe(0);
    expect(hits("<Text>{row.symbol ? displayTokenSymbol(row.symbol) : 'Unknown asset'}</Text>")).toBe(0);
    expect(hits('{note.tokenSymbol && <Mark />}')).toBe(0);
    expect(hits("<Text>{row.symbol ?? 'Unknown'}</Text>")).toBe(1);
    expect(hits('`${formatTokenBalance(v, symbol)} ${symbol}`')).toBe(0);
  });

  test('flow errors, step messages and toasts render through withoutShareNames', () => {
    const offenders: string[] = [];
    for (const rel of FLOW_FILES) {
      readFileSync(join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
        // Props such as error={x} hand the text on to a component that renders it;
        // only JSX children are checked here.
        for (const m of line.replace(/\b[A-Za-z]+=\{[^}]*\}/g, '').match(RAW_FREE_TEXT) ?? []) {
          offenders.push(`${rel}:${i + 1}: ${m.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
    // useShareNameText is withoutShareNames bound to the live rates.
    for (const rel of ['components/toast-provider.tsx', 'components/ui/flow-progress.tsx']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src).toContain('useShareNameText(');
      expect(src).toContain('{shareText(');
    }
  });

  test('withoutShareNames renames a share and marks its count approximate', () => {
    expect(withoutShareNames('Insufficient ppUSDC balance: need 12.5 ppUSDC, have 1,234.5 PPUSDC'))
      .toBe('Insufficient USDC balance: need ≈ 12.5 USDC, have ≈ 1,234.5 USDC');
    expect(withoutShareNames('Relayer fee ≈ 0.1 ppETH')).toBe('Relayer fee ≈ 0.1 ETH');
    expect(withoutShareNames('~3 ppusdt')).toBe('~3 USDT');
    expect(withoutShareNames('Fee 1.23K ppUSDC.')).toBe('Fee ≈ 1.23K USDC.');
    expect(withoutShareNames('ppUSDT Pool')).toBe('USDT Pool');
    expect(withoutShareNames('0.5 WETH and 3 USDC')).toBe('0.5 WETH and 3 USDC');
    expect(withoutShareNames('xppUSDC')).toBe('xppUSDC');
    expect(withoutShareNames(null)).toBeNull();
  });
});
