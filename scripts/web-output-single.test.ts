// F-C follow-up (codex review, finding 4): `expo.web.output` must stay
// "single" until static hydration is DESIGNED and TESTED.
//
// Why this gate exists: the theme bootstrap in app/+html.tsx can put the
// right root classes on <html> pre-paint, but classes cannot make a STATIC
// server render hydration-safe — the server always resolves the default
// design variant (constants/theme.ts: no window ⇒ DEFAULT_DESIGN_VARIANT)
// while the browser can synchronously resolve a ?theme/localStorage variant,
// and the variants differ in legacy inline token values. A query/localStorage choice cannot be known by a static server
// render, so "static" requires a deterministic first server/client tree
// (client-only variant boundary or equivalent), ?theme= + stored-dark
// hydration tests, per-route export checks, and an exact bootstrap-presence
// assertion — none of which exist yet. See nativewind-fc-gates.md
// ("static-mode prerequisites").
//
// If you are here because you flipped web.output: implement those
// prerequisites first, then update this test and the gates doc together.

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');

describe('expo web output mode', () => {
  test('web.output stays "single" (static hydration is not designed yet)', () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')) as {
      expo?: { web?: { output?: string } };
    };
    expect(appJson.expo?.web?.output).toBe('single');
  });

  test('app.config.js does not override web output', () => {
    // The only dynamic config behavior is the harness gallery router root;
    // nothing may rewrite expo.web at config time.
    const src = fs.readFileSync(path.join(ROOT, 'app.config.js'), 'utf8');
    expect(src).not.toMatch(/output|['"]web['"]\s*:/);
  });
});
