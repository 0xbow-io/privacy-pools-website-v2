import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const { parseSecurityKeyFlag, resolveSecurityKeyFlag } = await import('../../config/security-key-flag');

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe('security-key sign-in flag', () => {
  test('parses the usual on and off spellings', () => {
    expect(parseSecurityKeyFlag('1')).toBe(true);
    expect(parseSecurityKeyFlag('')).toBe(true);
    expect(parseSecurityKeyFlag('off')).toBe(false);
    expect(parseSecurityKeyFlag('maybe')).toBe(null);
    expect(parseSecurityKeyFlag(null)).toBe(null);
  });
  test('off unless the tab asked for it', () => {
    expect(resolveSecurityKeyFlag({ fromUrl: null, storage: memoryStorage(), buildAllows: true })).toBe(false);
  });
  test('the ask sticks to the tab and =0 clears it', () => {
    const storage = memoryStorage();
    expect(resolveSecurityKeyFlag({ fromUrl: '1', storage, buildAllows: true })).toBe(true);
    expect(resolveSecurityKeyFlag({ fromUrl: null, storage, buildAllows: true })).toBe(true);
    expect(resolveSecurityKeyFlag({ fromUrl: '0', storage, buildAllows: true })).toBe(false);
    expect(resolveSecurityKeyFlag({ fromUrl: null, storage, buildAllows: true })).toBe(false);
  });
  test('a build without passkeys never turns it on', () => {
    expect(resolveSecurityKeyFlag({ fromUrl: '1', storage: memoryStorage(), buildAllows: false })).toBe(false);
  });
  test('a storage that throws still honours the URL', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(resolveSecurityKeyFlag({ fromUrl: '1', storage: broken, buildAllows: true })).toBe(true);
    expect(resolveSecurityKeyFlag({ fromUrl: null, storage: broken, buildAllows: true })).toBe(false);
  });
});
