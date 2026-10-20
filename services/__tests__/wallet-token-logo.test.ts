import { describe, expect, test } from 'bun:test';
import { safeLogoUrl } from '@/services/wallet-tokens';

describe('safeLogoUrl', () => {
  test('keeps an https URL, trimmed', () => {
    expect(safeLogoUrl(' https://static.alchemyapi.io/images/assets/3408.png ')).toBe('https://static.alchemyapi.io/images/assets/3408.png');
  });
  test('drops anything that is not a plain https URL', () => {
    for (const bad of [null, undefined, '', 'http://x.y/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'https://x.y/a.png" onerror="x', 42 as unknown as string]) {
      expect(safeLogoUrl(bad)).toBeUndefined();
    }
  });
});
