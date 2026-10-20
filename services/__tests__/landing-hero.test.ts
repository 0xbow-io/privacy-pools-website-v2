import { describe, expect, test } from 'bun:test';
import { LANDING_HERO } from '../../config/landing-hero';

describe('landing hero copy', () => {
  test('the rotation keeps its prefix and the added audiences', () => {
    expect(LANDING_HERO.prefix).toBe('Privacy for');
    for (const phrase of ['DAOs.', 'wallets.', 'enterprises.', 'you.', 'cypherpunks.']) {
      expect(LANDING_HERO.phrases).toContain(phrase);
    }
  });

  test('every phrase completes the prefix as one short sentence', () => {
    expect(LANDING_HERO.phrases.length).toBeGreaterThan(0);
    for (const phrase of LANDING_HERO.phrases) {
      expect(phrase).toMatch(/^\S.*\.$/);
      expect(phrase).toBe(phrase.trim());
    }
  });

  test('no phrase repeats', () => {
    expect(new Set(LANDING_HERO.phrases).size).toBe(LANDING_HERO.phrases.length);
  });

  test('copy uses sentence breaks, never em dashes', () => {
    for (const text of [LANDING_HERO.prefix, LANDING_HERO.body, ...LANDING_HERO.phrases]) {
      expect(text).not.toContain('—');
    }
  });
});
