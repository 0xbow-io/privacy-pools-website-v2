import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { approxUnderlyingText, displayTokenSymbol } from '@/services/share-display';

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

  /**
   * DEV-591: `{t.symbol === fromToken.symbol ? fromToken.symbol : displayTokenSymbol(t.symbol)}`
   * printed "ppETH" on the swap chip, and the rule above only sees a bare
   * `{x.symbol}`. A JSX child whose ternary yields a raw `.symbol` is the same
   * defect. Exempt: fields that hold an amount entered in shares, labelled with
   * the share's own symbol by the share-amount field rule.
   */
  const RAW_TERNARY = /(?:^\s*|>\s*)\{[^{}]*(?:\?\s*[A-Za-z0-9_.?!()[\]]+\.symbol\s*:|\?[^{}]*:\s*[A-Za-z0-9_.?!()[\]]+\.symbol\s*\})/;
  const TERNARY_EXEMPT = /amountField\.symbol|isShareSymbol\(requestToken\.symbol\) \? requestToken\.symbol/;
  test('no JSX child picks a raw .symbol through a ternary', () => {
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of sources(join(ROOT, dir))) {
        if (!file.endsWith('.tsx')) continue;
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (RAW_TERNARY.test(line) && !TERNARY_EXEMPT.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
    expect(RAW_TERNARY.test('  {t.symbol === f.symbol ? f.symbol : displayTokenSymbol(t.symbol)}')).toBe(true);
    expect(RAW_TERNARY.test('  {ok ? displayTokenSymbol(t.symbol) : t.symbol}')).toBe(true);
    expect(RAW_TERNARY.test('  input: { decimals: t.decimals, symbol: t.symbol },')).toBe(false);
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
    expect(approxUnderlyingText('1.5 ppUSDC', 'ppUSDC')).toBe('1.5 ppUSDC');
    expect(approxUnderlyingText('1.5 USDC', 'USDC')).toBe('1.5 USDC');
  });
});
