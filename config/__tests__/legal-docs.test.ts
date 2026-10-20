import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { footerLinks } from '../footer-links';
import { PRIVACY_ROUTE, TERMS_ROUTE, isInternalHref } from '../legal/routes';
import { TERMS_OF_USE } from '../legal/terms-of-use';
import { PRIVACY_POLICY } from '../legal/privacy-policy';

const appDir = join(__dirname, '..', '..', 'app');
const plain = (doc: typeof TERMS_OF_USE) =>
  doc.blocks.map((b) => b.runs.map((r) => r.t).join('')).join('\n');

describe('legal documents', () => {
  test('footer Terms and Privacy point at the in-app routes', () => {
    expect(footerLinks.find((l) => l.label === 'Terms')?.href).toBe(TERMS_ROUTE);
    expect(footerLinks.find((l) => l.label === 'Privacy')?.href).toBe(PRIVACY_ROUTE);
    expect(footerLinks.some((l) => l.href.includes('docs.privacypools.com/toc'))).toBe(false);
    expect(footerLinks.some((l) => l.href.includes('privacy-policy'))).toBe(false);
  });

  test('each route has a screen file', () => {
    for (const route of [TERMS_ROUTE, PRIVACY_ROUTE]) {
      expect(existsSync(join(appDir, `${route.slice(1)}.tsx`))).toBe(true);
    }
  });

  test('internal hrefs are only app paths', () => {
    expect(isInternalHref('/terms')).toBe(true);
    expect(isInternalHref('https://x.com/0xbowio')).toBe(false);
    expect(isInternalHref('//evil.example')).toBe(false);
    expect(isInternalHref('')).toBe(false);
  });

  test('terms carry all 23 numbered sections and the date', () => {
    expect(TERMS_OF_USE.lastUpdated.length).toBeGreaterThan(0);
    const text = plain(TERMS_OF_USE);
    for (let n = 1; n <= 23; n++) expect(text).toMatch(new RegExp(`(^|\\n)${n}\\. `));
    expect(text).toContain('BINDING INDIVIDUAL ARBITRATION AGREEMENT IN SECTION 13');
  });

  test("no stray Word glyphs or zero-width characters", () => {
    for (const doc of [TERMS_OF_USE, PRIVACY_POLICY]) {
      const text = plain(doc);
      expect(text).not.toMatch(/[\u200b\u200c\u200d\u2060\ufeff]/);
      expect(text).not.toMatch(/(^|\n)o /);
    }
  });

  test('privacy policy carries its sections and the date', () => {
    expect(PRIVACY_POLICY.lastUpdated.length).toBeGreaterThan(0);
    const headings = PRIVACY_POLICY.blocks.filter((b) => b.heading).map((b) => b.runs.map((r) => r.t).join(''));
    expect(headings).toContain('Your Rights');
    expect(headings).toContain('Changes To This Privacy Policy');
  });
});
