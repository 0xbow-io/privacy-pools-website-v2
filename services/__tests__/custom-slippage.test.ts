/**
 * A hand-entered slippage is parsed, bounded and never silently clamped.
 *
 * This number decides how much of the swap the route may lose, so 300 typed
 * into a 30% field must be refused rather than quietly become 30.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CUSTOM_SLIPPAGE_MAX_PERCENT,
  isCustomSlippage,
  parseCustomSlippage,
  slippageLabel,
} from '@/services/custom-slippage';

describe('what a person types', () => {
  const accepted: readonly [string, number][] = [
    ['5', 0.05],
    ['12.5', 0.125],
    ['0.5', 0.005],
    ['30', 0.3],
    ['30%', 0.3],
    [' 7 ', 0.07],
    ['0.01', 0.0001],
  ];
  for (const [input, fraction] of accepted) {
    test(`"${input}" is ${fraction}`, () => {
      const r = parseCustomSlippage(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.fraction).toBe(fraction);
    });
  }
});

describe('what is refused, rather than clamped', () => {
  test('over the ceiling says so and returns nothing usable', () => {
    const r = parseCustomSlippage('300');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(CUSTOM_SLIPPAGE_MAX_PERCENT));
    // The failure carries no fraction at all, so no caller can read past it.
    expect('fraction' in r).toBe(false);
  });

  test('just over the ceiling is still over it', () => {
    expect(parseCustomSlippage('30.01').ok).toBe(false);
    expect(parseCustomSlippage('30').ok).toBe(true);
  });

  const rejected = ['', '   ', 'abc', '-5', '1e2', '5,5', '1.23456', '.5', '5.', '+5', 'Infinity', 'NaN'];
  for (const input of rejected) {
    test(`"${input}" is refused`, () => {
      expect(parseCustomSlippage(input).ok).toBe(false);
    });
  }

  test('below the floor is refused', () => {
    expect(parseCustomSlippage('0').ok).toBe(false);
    expect(parseCustomSlippage('0.001').ok).toBe(false);
  });
});

describe('how it reads back', () => {
  test('a preset and a custom value both render without noise', () => {
    expect(slippageLabel(0.005)).toBe('0.5%');
    expect(slippageLabel(0.01)).toBe('1%');
    expect(slippageLabel(0.03)).toBe('3%');
    expect(slippageLabel(0.125)).toBe('12.5%');
    expect(slippageLabel(0.3)).toBe('30%');
  });

  test('the Custom chip owns exactly the values the presets do not', () => {
    const presets = [0.005, 0.01, 0.03];
    for (const p of presets) expect(isCustomSlippage(p, presets)).toBe(false);
    for (const c of [0.02, 0.125, 0.3, 0.0001]) expect(isCustomSlippage(c, presets)).toBe(true);
  });
});

/**
 * The chip and its editor are wired to the rule above, not to their own copy.
 * A source check: the modal needs Expo, wagmi and the pools tree to render.
 */
describe('the swap form uses it', () => {
  const SOURCE = readFileSync(
    join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'swap-modal-provider.tsx'),
    'utf8',
  );

  test('custom is a field in the row, not something that opens', () => {
    expect(SOURCE).toContain('testID="swap-slippage-custom-input"');
    expect(SOURCE).toContain('placeholder="Custom"');
    // No popup state survives: a second place to hold the value is a second
    // place for it to disagree with the chips.
    expect(SOURCE).not.toContain('customSlippageOpen');
    expect(SOURCE).not.toContain('swap-slippage-custom-apply');
  });

  test('it sits after the presets', () => {
    expect(SOURCE.indexOf('SLIPPAGE_OPTIONS.map')).toBeLessThan(SOURCE.indexOf('testID="swap-slippage-custom-input"'));
  });

  test('typing applies only a value the parser accepted', () => {
    const at = SOURCE.indexOf('testID="swap-slippage-custom-input"');
    const block = SOURCE.slice(at, at + 1200);
    expect(block).toContain('parseCustomSlippage(next)');
    // The refusal returns before editSlippage, so a bad value never applies.
    expect(block.indexOf('if (!parsed.ok)')).toBeLessThan(block.indexOf('editSlippage(parsed.fraction)'));
  });

  test('choosing a preset clears the field, so the row shows one selection', () => {
    const at = SOURCE.indexOf('SLIPPAGE_OPTIONS.map');
    const block = SOURCE.slice(at, at + 900);
    expect(block).toContain("setCustomSlippageDraft('')");
    expect(block).toContain('editSlippage(s)');
  });

  test('review rows render through slippageLabel, so a custom value is not rounded away', () => {
    expect(SOURCE).toContain('slippageLabel(reshieldSnapshot.slippage)');
    expect(SOURCE).toContain('slippageLabel(snapshot.slippage)');
    expect(SOURCE).not.toContain('slippage * 100).toFixed(1)');
  });
});
