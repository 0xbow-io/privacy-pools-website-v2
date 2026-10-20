import { describe, expect, test } from 'bun:test';

import { APP_ORIGIN, DEFAULT_APP_ORIGIN, DEFAULT_V1_URL, V1_URL, WHITEPAPER_URL, hostOf } from '../site-urls';

describe('site urls', () => {
  test('defaults are the post-switch domains', () => {
    expect(DEFAULT_APP_ORIGIN).toBe('https://privacypools.com');
    expect(DEFAULT_V1_URL).toBe('https://v1.privacypools.com');
    if (!process.env.EXPO_PUBLIC_APP_ORIGIN) expect(APP_ORIGIN).toBe('https://privacypools.com');
    if (!process.env.EXPO_PUBLIC_V1_URL) {
      expect(V1_URL).toBe('https://v1.privacypools.com');
      expect(WHITEPAPER_URL).toBe('https://v1.privacypools.com/whitepaper.pdf');
    }
  });
  test('hostOf strips scheme and path', () => {
    expect(hostOf('https://v1.privacypools.com/x?y')).toBe('v1.privacypools.com');
  });
});
