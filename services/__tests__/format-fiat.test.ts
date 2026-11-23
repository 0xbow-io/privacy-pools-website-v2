import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUsd, formatUsdBalance, formatUsdPrecise } from '@/services/format-fiat';

describe('formatUsd (compact)', () => {
  test('renders zero as $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  test('guards sub-cent positive amounts', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0.005)).toBe('<$0.01');
  });

  test('shows cents under a dollar so testnet dust stays visible', () => {
    expect(formatUsd(0.42)).toBe('$0.42');
  });

  test('exactly two decimals, rounded down, under the $10k cutover (DEV-621)', () => {
    expect(formatUsd(4674.1)).toBe('$4,674.10');
    expect(formatUsd(9999)).toBe('$9,999.00');
    // The QA position: 4.9727 USDT read "$5" beside "4.97 USDT".
    expect(formatUsd(4.9727)).toBe('$4.97');
    expect(formatUsd(5.03)).toBe('$5.03');
  });

  test('abbreviates to k/M/B above the cutover, trailing zeros stripped', () => {
    expect(formatUsd(10_000)).toBe('$10k');
    expect(formatUsd(10_820)).toBe('$10.82k');
    expect(formatUsd(1_500_000)).toBe('$1.5M');
    expect(formatUsd(2_000_000_000)).toBe('$2B');
  });
});

describe('formatUsdBalance', () => {
  test('a balance is never abbreviated and always has cents, rounded down', () => {
    expect(formatUsdBalance(0)).toBe('$0.00');
    expect(formatUsdBalance(4.9799)).toBe('$4.97');
    expect(formatUsdBalance(12_345.678)).toBe('$12,345.67');
    expect(formatUsdBalance(0.004)).toBe('<$0.01');
  });
});

describe('formatUsdPrecise', () => {
  test('always shows two decimals', () => {
    expect(formatUsdPrecise(5)).toBe('$5.00');
    expect(formatUsdPrecise(0)).toBe('$0.00');
  });

  test('adds thousands separators (the improvement over $${x.toFixed(2)})', () => {
    expect(formatUsdPrecise(1234.56)).toBe('$1,234.56');
    expect(formatUsdPrecise(1234567.891)).toBe('$1,234,567.89');
  });

  test('rounds to cents', () => {
    expect(formatUsdPrecise(0.005)).toBe('$0.01');
    expect(formatUsdPrecise(10.999)).toBe('$11.00');
  });
});

// e2e 2026-11-21: the batch withdraw review painted "$5.1". Each of those sites
// hand-formatted dollars with `maximumFractionDigits: 2` and no minimum, which
// strips a trailing zero. Dollars with cents always show two (DEV-621); only
// the k/M/B abbreviations may drop them.
describe('no hand-formatted dollar figure drops a trailing zero', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const DOLLAR = /(?:\$|\{symbol\}|^\s*|>)\$\{([^{}\n]*\.toLocaleString\([^)\n]*\))\}(?![kKMB])/g;
  const stripsZero = (line: string) => [...line.matchAll(DOLLAR)]
    .some((m) => /maximumFractionDigits:\s*2\b/.test(m[1]) && !/minimumFractionDigits/.test(m[1]));
  const sources = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(rel);
    return /\.tsx?$/.test(e.name) ? [rel] : [];
  });

  test('the pattern catches the shapes that shipped "$5.1"', () => {
    expect(stripsZero("text-muted\">${netUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</Text>")).toBe(true);
    expect(stripsZero("  return `$${numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;")).toBe(true);
    expect(stripsZero("  if (precise) return `${symbol}${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;")).toBe(true);
    expect(stripsZero("    return `$${(value / 1_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}k`;")).toBe(false);
    expect(stripsZero("  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;")).toBe(false);
  });

  test('app sources hold none', () => {
    const hits = ['components', 'services', 'app', 'hooks'].flatMap(sources).flatMap((file) =>
      readFileSync(join(ROOT, file), 'utf8').split('\n')
        .map((line, i) => (stripsZero(line) ? `${file}:${i + 1}` : null))
        .filter((hit): hit is string => hit !== null));
    expect(hits).toEqual([]);
  });

  test('the shared formatters keep the trailing zero', () => {
    expect(formatUsdBalance(5.1)).toBe('$5.10');
    expect(formatUsdBalance(1234.5)).toBe('$1,234.50');
  });
});
