import { describe, expect, test } from 'bun:test';
import { transactionBaseType, transactionTypeColor, transactionTypeGlyph } from '../transaction-visuals';

const COLORS = { success: '#0A0', danger: '#A00', textMuted: '#888' };

describe('transactionBaseType', () => {
  test('collapses directional transfers to the base type', () => {
    expect(transactionBaseType('Transfer In')).toBe('Transfer');
    expect(transactionBaseType('Transfer Out')).toBe('Transfer');
    expect(transactionBaseType('Transfer')).toBe('Transfer');
  });

  test('leaves other types alone and capitalises', () => {
    expect(transactionBaseType('Deposit')).toBe('Deposit');
    expect(transactionBaseType('deposit')).toBe('Deposit');
    expect(transactionBaseType('Withdrawal')).toBe('Withdrawal');
    expect(transactionBaseType('Exit')).toBe('Exit');
  });

  test('does not throw on empty/nullish input', () => {
    expect(transactionBaseType('')).toBe('');
    expect(transactionBaseType(undefined as unknown as string)).toBe('');
  });
});

describe('transactionTypeGlyph', () => {
  test('direction is carried by the glyph', () => {
    expect(transactionTypeGlyph('Deposit')).toBe('arrow-down');
    expect(transactionTypeGlyph('Withdrawal')).toBe('arrow-up');
    expect(transactionTypeGlyph('Transfer In')).toBe('swap-horizontal');
    expect(transactionTypeGlyph('Transfer Out')).toBe('swap-horizontal');
    expect(transactionTypeGlyph('Exit')).toBe('exit-outline');
  });

  test('falls back to the base type before the generic glyph', () => {
    expect(transactionTypeGlyph('Transfer Sideways', 'Transfer')).toBe('swap-horizontal');
  });

  test('an unknown type still yields a renderable glyph', () => {
    expect(transactionTypeGlyph('Whatever')).toBe('ellipse-outline');
    expect(transactionTypeGlyph('Whatever', 'AlsoUnknown')).toBe('ellipse-outline');
  });
});

describe('transactionTypeColor', () => {
  test('deposit green, exit red, withdrawal neutral. All from theme tokens', () => {
    expect(transactionTypeColor('Deposit', COLORS, 'light')).toBe(COLORS.success);
    expect(transactionTypeColor('Exit', COLORS, 'light')).toBe(COLORS.danger);
    expect(transactionTypeColor('Withdrawal', COLORS, 'light')).toBe(COLORS.textMuted);
  });

  test('transfer purple is scheme-aware and not a theme token', () => {
    const light = transactionTypeColor('Transfer', COLORS, 'light');
    const dark = transactionTypeColor('Transfer', COLORS, 'dark');
    expect(light).not.toBe(dark);
    for (const c of [light, dark]) {
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(Object.values(COLORS)).not.toContain(c);
    }
  });

  test('every colour is driven by the passed tokens, so variants track the theme', () => {
    const other = { success: '#111', danger: '#222', textMuted: '#333' };
    expect(transactionTypeColor('Deposit', other, 'light')).toBe('#111');
    expect(transactionTypeColor('Exit', other, 'light')).toBe('#222');
    expect(transactionTypeColor('Withdrawal', other, 'light')).toBe('#333');
  });
});

test('swap boundary labels preserve their deposit and withdrawal visuals', () => {
  for (const [label, base, glyph, color] of [
    ['Deposit via swap', 'Deposit', 'arrow-down', COLORS.success],
    ['Deposit to recipient', 'Withdrawal', 'arrow-up', COLORS.textMuted],
    ['Withdrawal via swap', 'Withdrawal', 'arrow-up', COLORS.textMuted],
  ]) {
    expect(transactionBaseType(label)).toBe(base);
    expect(transactionTypeGlyph(label, transactionBaseType(label))).toBe(glyph);
    expect(transactionTypeColor(transactionBaseType(label), COLORS, 'dark')).toBe(color);
  }
});
