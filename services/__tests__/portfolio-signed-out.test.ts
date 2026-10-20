// Ratchet (QA 2026-10-12): a connected but signed-out wallet saw $0 and "No
// positions yet" on Portfolio over real deposits. The page must gate its
// figures on the same unlock signal and action My balances uses.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'components/portfolio/portfolio-page-content.tsx'), 'utf8');

describe('portfolio signed-out gate', () => {
  test('uses the shared unlock gate and the My balances sign-in action', () => {
    expect(src).toContain('useWalletUnlockGate()');
    expect(src).toMatch(/const signedOut = requiresWalletUnlock \|\| keyInitFailed;/);
    expect(src).toContain('openSeedDerivationModal()');
    expect(src).toContain('Sign in to see your positions');
  });

  test('stats and positions render only behind the gate', () => {
    const gate = src.indexOf('{signedOut ? (');
    expect(gate).toBeGreaterThan(-1);
    const prompt = src.indexOf('Sign in to see your positions', gate);
    const stats = src.indexOf('<PortfolioStats', gate);
    const positions = src.indexOf('<AllPositions', gate);
    // The figures live in the ternary's ELSE branch: after `) : (` and before
    // the `)}` that closes it, and nowhere else in the file (review of #257:
    // ordering alone would also pass if they rendered after the ternary).
    const elseStart = src.indexOf(') : (', gate);
    const elseEnd = src.indexOf('\n          )}', elseStart);
    expect(prompt).toBeGreaterThan(gate);
    expect(prompt).toBeLessThan(elseStart);
    expect(elseStart).toBeGreaterThan(-1);
    expect(elseEnd).toBeGreaterThan(elseStart);
    for (const [tag, at] of [['<PortfolioStats', stats], ['<AllPositions', positions]] as const) {
      expect(at).toBeGreaterThan(elseStart);
      expect(at).toBeLessThan(elseEnd);
      expect(src.split(tag).length - 1).toBe(1);
    }
  });
});

describe('yield earned recomputes when the snapshot lands', () => {
  const hook = readFileSync(join(process.cwd(), 'hooks/use-yield-earned.ts'), 'utf8');
  test('a snapshot change runs the current tick, not only the 60s interval', () => {
    expect(hook).toMatch(/useEffect\(\(\) => \{\s*tickRef\.current\?\.\(\);\s*\}, \[params\.snapshot\]\);/);
    expect(hook).toContain('tickRef.current = null;');
  });
});
