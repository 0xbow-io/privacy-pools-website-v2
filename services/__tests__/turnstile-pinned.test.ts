// Turnstile's loader is pinned by Subresource Integrity on a versioned, immutable
// URL (config/turnstile.ts). Self-hosting api.js is not possible: the script
// throws unless its own tag points at challenges.cloudflare.com (#50).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TURNSTILE_BUILD,
  TURNSTILE_INTEGRITY,
  TURNSTILE_SCRIPT_SRC,
  TURNSTILE_SCRIPT_URL,
} from '@/config/turnstile';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

// The check api.js itself runs on its own <script src> (copied from the pinned build).
const API_JS_ACCEPTS = /^https:\/\/(challenges(\.fed)?\.cloudflare\.com|challenges\.cloudflare-cn\.com)\/turnstile\/v0(\/.*)?\/api\.js/;

describe('pinned Turnstile loader', () => {
  test('the src is one api.js accepts: Cloudflare host, versioned path', () => {
    expect(API_JS_ACCEPTS.test(TURNSTILE_SCRIPT_SRC)).toBe(true);
    expect(TURNSTILE_SCRIPT_URL).toBe(`https://challenges.cloudflare.com/turnstile/v0/g/${TURNSTILE_BUILD}/api.js`);
    expect(TURNSTILE_BUILD).toMatch(/^[0-9a-f]{12}$/);
  });

  test('the integrity is a well-formed sha256 SRI value', () => {
    expect(TURNSTILE_INTEGRITY).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
  });

  test('the modal loads it with the integrity hash and anonymous CORS, never the unversioned URL', () => {
    const modal = readFileSync(join(ROOT, 'components', 'newsletter-modal.tsx'), 'utf8');
    expect(modal).toContain('script.integrity = TURNSTILE_INTEGRITY');
    expect(modal).toContain("script.crossOrigin = 'anonymous'");
    expect(modal).not.toMatch(/turnstile\/v0\/api\.js/);
  });

  test('a loaded script that installs no window.turnstile fails visibly', () => {
    const modal = readFileSync(join(ROOT, 'components', 'newsletter-modal.tsx'), 'utf8');
    expect(modal).toMatch(/if \(!api\) \{\s*fail\(\);\s*return;\s*\}/);
  });
});
