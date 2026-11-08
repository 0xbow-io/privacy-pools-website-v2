import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8');

// Loading figures on the portfolio are a shimmer, a known figure that is not
// final is followed by a "syncing" badge, and unavailable is a still "—".
// No spinner beside a dash and no "-.--" placeholder (Pat, QA of #67).
describe('portfolio loading style', () => {
  const files = [
    'components/portfolio/portfolio-stats.tsx',
    'components/portfolio/all-positions.tsx',
    'components/portfolio-provider.tsx',
    'services/yield-earned.ts',
  ];

  test('no spinner and no "-.--" placeholder for yield earned or pending', () => {
    for (const f of files) {
      const src = read(f);
      expect(src).not.toContain('ActivityIndicator');
      expect(src).not.toContain('-.--');
      expect(src).not.toContain('LOADING_USD');
    }
  });

  test('the header draws a shimmer while nothing is known and a syncing badge while partial', () => {
    const stats = read('components/portfolio/portfolio-stats.tsx');
    expect(stats).toContain("import { Skeleton, SyncingBadge } from '@/components/ui/skeleton';");
    expect(stats).toMatch(/yieldEarnedLoading && yieldEarnedUsd == null \?\s*\(\s*<FigureSkeleton/);
    expect(stats).toMatch(/pendingLoading && pending == null \?\s*\(/);
    expect(stats).toMatch(/yieldEarnedLoading \? <SyncingBadge/);
  });

  test('a loading row cell is a shimmer bar then the unit, the loaded cell is unchanged', () => {
    const rows = read('components/portfolio/all-positions.tsx');
    expect(rows).toMatch(/position\.earnedLoading \?\s*\(/);
    expect(rows).toContain('<Skeleton width={40} height={12}');
    expect(rows).toContain('{position.earnedUnit}');
    expect(rows).toContain("{position.earnedText ?? '\\u2014'}");
    const page = read('components/portfolio/portfolio-page-content.tsx');
    expect(page).toContain('earnedUnit: p.tokenSymbol,');
  });

  test('the badge copy', () => {
    const badge = read('components/ui/skeleton.tsx').split('export function SyncingBadge')[1] ?? '';
    expect(badge).toContain('>syncing<');
    expect(badge).not.toMatch(/—|pp[A-Z]{3,}/);
  });
});
