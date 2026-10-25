import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// Ameen, QA 2026-10-25: "these buttons arent lined up right with where I'm
// clicking". The jelly pill inflated past its slot and a drag gesture picked
// the tab, so the visible button and the tap target disagreed.
describe('mobile bottom bar hit targets', () => {
  const src = read('components/home/explore-tab-bar.tsx');

  test('no jelly gesture bar: each tab is its own Pressable', () => {
    expect(src).not.toContain('react-native-jelly-tabs');
    expect(src).toContain('<Pressable');
    expect(src).toContain('onPress={() => onSelect(tab.key)}');
  });

  test('slots are equal width and clip their highlight', () => {
    expect(src).toContain('flex-1 basis-0');
    const slot = src.slice(src.indexOf('<Pressable'), src.indexOf('</Pressable>'));
    expect(slot).toContain('overflow-hidden');
    // The pill sits inside the slot, inset 0: no translate, scale or negative margin.
    expect(slot).toContain('absolute inset-0');
    expect(slot).not.toMatch(/translate|scale|-m[xlr]?-\[|marginHorizontal: -/);
  });
});
