import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// plain ESM build script, typed loosely
import { injectSocialMeta, socialMetaTags, META } from '../social-meta-tags.mjs';

// The build reads EXPO_PUBLIC_APP_ORIGIN at load time, so expect whatever origin it resolved.
const BASE = (process.env.EXPO_PUBLIC_APP_ORIGIN?.trim() || String(META.url)).replace(/\/+$/, "");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The shell Expo emits for web.output "single" (title = app slug, no social tags).
const SHELL = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>privacy-pools</title><meta name="viewport" content="width=device-width" /></head><body><div id="root"></div></body></html>';

describe('social meta injection', () => {
  test('the served shell gets the title, description, canonical, every og image with its size, and the twitter card', () => {
    const out = injectSocialMeta(SHELL);
    expect(out).toContain('<title>Privacy Pools</title>');
    expect(out).not.toContain('<title>privacy-pools</title>');
    expect(out).toContain(`<meta property="og:image" content="${BASE}/og-image.png" />`);
    expect(out).toContain('<meta property="og:image:width" content="1200" />');
    expect(out).toContain('<meta property="og:image:height" content="630" />');
    expect(out).toContain(`<meta property="og:image" content="${BASE}/og-image-square.png" />`);
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(out).toContain(`<meta name="twitter:image" content="${BASE}/twitter-card.png" />`);
    expect(out).toContain(`<link rel="canonical" href="${BASE}/" />`);
    // Keep the encoding in the first 1024 bytes, even after reinjecting the large social block.
    expect(injectSocialMeta(out).slice(0, 1024)).toContain('<meta charset="utf-8" />');
    // Social metadata still precedes the viewport metadata.
    expect(out.indexOf('og:title')).toBeLessThan(out.indexOf('name="viewport"'));
  });
  test('running it twice does not duplicate the block', () => {
    const once = injectSocialMeta(SHELL);
    const twice = injectSocialMeta(once);
    expect(twice.split('og:title').length).toBe(2);
    expect(twice.split('<title>').length).toBe(2);
  });
  test('a description with quotes and ampersands is escaped', () => {
    const tags = socialMetaTags({ ...META, description: 'A "quoted" & <tagged> line' });
    expect(tags).toContain('content="A &quot;quoted&quot; &amp; &lt;tagged&gt; line"');
  });
  test('every declared card exists in public/ at the declared size', () => {
    for (const img of META.images as Array<{ file: string; width: number; height: number }>) {
      const p = join(ROOT, 'public', img.file);
      expect(existsSync(p)).toBe(true);
      const buf = readFileSync(p);
      // PNG IHDR: width at byte 16, height at byte 20 (big-endian).
      expect(buf.readUInt32BE(16)).toBe(img.width);
      expect(buf.readUInt32BE(20)).toBe(img.height);
    }
  });
});
