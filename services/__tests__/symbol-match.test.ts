/**
 * Four of the nine symbols this app ships are mixed case: cBTC, ppETH, ppUSDC,
 * ppUSDT. Comparisons that uppercased one side and used === could never match
 * any of them, and on 2026-09-22 that surfaced three ways in one morning:
 *
 *   - the swap form found no pool for 'ppETH', so the balance read 0n and
 *     0.003 against a shielded 0.005 was "more than you have shielded here"
 *   - the same user's cBTC balance was wrong at the same moment, with no share
 *     involved at all, which is what showed it was the CASE and not the shares
 *   - the swap hand-off refused every share outright (#99, three sites)
 *
 * The guard at the bottom is the part that matters: fixing the sites without it
 * just waits for the next one.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bySymbol, sameSymbol } from '@/services/symbol-match';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/** Every symbol the app ships, as the registry spells them. */
const SHIPPED = ['ETH', 'USDC', 'USDT', 'BNB', 'FDUSD', 'cBTC', 'ppETH', 'ppUSDC', 'ppUSDT'];

describe('sameSymbol', () => {
  test('every shipped symbol matches itself in any case', () => {
    for (const symbol of SHIPPED) {
      expect(sameSymbol(symbol, symbol)).toBe(true);
      expect(sameSymbol(symbol, symbol.toUpperCase())).toBe(true);
      expect(sameSymbol(symbol, symbol.toLowerCase())).toBe(true);
      expect(sameSymbol(symbol.toUpperCase(), symbol)).toBe(true);
    }
  });

  test('the four mixed-case ones, which is where this bites', () => {
    for (const share of ['cBTC', 'ppETH', 'ppUSDC', 'ppUSDT']) {
      // What the old comparison did.
      expect(share.toUpperCase() === share).toBe(false);
      // What it meant to do.
      expect(sameSymbol(share.toUpperCase(), share)).toBe(true);
    }
  });

  test('different assets are still different', () => {
    expect(sameSymbol('ETH', 'ppETH')).toBe(false);
    expect(sameSymbol('USDC', 'USDT')).toBe(false);
    expect(sameSymbol('ppUSDC', 'ppUSDT')).toBe(false);
  });

  test('surrounding space does not make a name a different name', () => {
    expect(sameSymbol(' ppETH ', 'ppeth')).toBe(true);
  });

  test('nothing matches nothing', () => {
    expect(sameSymbol(null, 'ETH')).toBe(false);
    expect(sameSymbol('ETH', undefined)).toBe(false);
    expect(sameSymbol('', '')).toBe(false);
  });

  test('bySymbol finds the row whatever its case', () => {
    const rows = [{ name: 'ppETH' }, { name: 'USDC' }];
    expect(rows.find(bySymbol('PPETH'))).toBe(rows[0]);
    expect(rows.find(bySymbol('usdc'))).toBe(rows[1]);
    expect(rows.find(bySymbol('ppUSDT'))).toBeUndefined();
  });
});

describe('no component compares a symbol by uppercasing one side', () => {
  // The shape that bit us is ONE side uppercased: `row.name.toUpperCase() ===
  // somethingNotUppercased`. Three things are deliberately not flagged:
  //
  //   - a quoted literal, which is a status or a constant, not a name
  //     (`String(n.status).toUpperCase() === 'ACTIVE'`)
  //   - a right side that uppercases itself, which matches correctly
  //   - a right side already named `...Upper`, same reason
  //
  // Those are correct today, if one careless edit from being wrong. Rewriting
  // them is worth doing; failing a build over them today is not, and a guard
  // that cries wolf is one people delete.
  const LEFT = /\.(name|symbol|asset)\s*\.toUpperCase\(\)\s*===\s*(.*)$/;

  /** Does the right-hand side uppercase itself, or is it a literal? */
  function rightSideIsSafe(rest: string): boolean {
    // Up to the next boolean operator: the rest of the line is other conditions.
    const operand = rest.split(/&&|\|\||\?|;/)[0] ?? '';
    return /^['"`]/.test(operand.trim())
      || operand.includes('toUpperCase()')
      || /Upper\b/.test(operand);
  }

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  test('components, services, hooks and config are clean', () => {
    const offenders: string[] = [];
    for (const dir of ['components', 'services', 'hooks', 'config']) {
      for (const file of sources(join(ROOT, dir))) {
        const source = readFileSync(file, 'utf8');
        source.split('\n').forEach((line, i) => {
          const hit = LEFT.exec(line);
          if (hit && !rightSideIsSafe(hit[2] ?? '')) {
            offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    // Use sameSymbol from services/symbol-match.ts, or compare addresses when
    // the question is really "which pool" rather than "which name".
    expect(offenders).toEqual([]);
  });
});
