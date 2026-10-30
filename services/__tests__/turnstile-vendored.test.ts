// Turnstile's loader is served from our origin, pinned by hash. If this fails,
// public/vendor/turnstile-api.js changed: review the diff, then update
// TURNSTILE_VENDORED_SHA256 in config/turnstile.ts on purpose.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  TURNSTILE_SCRIPT_PATH,
  TURNSTILE_SCRIPT_SRC,
  TURNSTILE_VENDORED_SHA256,
} from '@/config/turnstile';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

describe('vendored Turnstile loader', () => {
  test('the file served at the script path matches the pinned hash', () => {
    const bytes = readFileSync(join(ROOT, 'public', TURNSTILE_SCRIPT_PATH));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(TURNSTILE_VENDORED_SHA256);
  });

  test('the app loads it from our own origin', () => {
    expect(TURNSTILE_SCRIPT_SRC.startsWith('/')).toBe(true);
    expect(TURNSTILE_SCRIPT_SRC).toBe(`${TURNSTILE_SCRIPT_PATH}?render=explicit`);
  });

  test('no client code loads api.js from Cloudflare any more (the server-side siteverify call is fine)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?|html)$/.test(name) && /turnstile\/v0\/api\.js/.test(readFileSync(full, 'utf8'))) {
          offenders.push(full.slice(ROOT.length + 1));
        }
      }
    };
    for (const dir of ['components', 'app', 'hooks', 'services', 'config']) walk(join(ROOT, dir));
    // config/turnstile.ts mentions it in a comment (the refresh command); nothing else may.
    expect(offenders.filter((f) => f !== 'config/turnstile.ts')).toEqual([]);
  });
});
