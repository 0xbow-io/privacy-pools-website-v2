/**
 * DEV-516: on the inline Swap tab, the registration gate closed the flow, the
 * hub's watchdog reopened it, and the reopen reset the form, so the pasted
 * "If this fails, send to" address came back as the connected wallet.
 *
 * Source-level, like fallback-field-copy.test.ts: reproducing it in a render
 * test would need the whole hub, and the bug is which call the gate makes.
 */
import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const source = readFileSync(join(ROOT, 'components/swap-modal-provider.tsx'), 'utf8');

function body(start: string, end: string): string {
  const a = source.indexOf(start);
  expect(a).toBeGreaterThan(-1);
  const b = source.indexOf(end, a);
  expect(b).toBeGreaterThan(a);
  return source.slice(a, b);
}

describe('the registration gate keeps the inline swap form', () => {
  test('hiding for registration is a no-op on the inline hub', () => {
    expect(source).toMatch(
      /const hideForRegistration = useCallback\(\(\) => \{\s*if \(!inlineBase\) setIsOpen\(false\);\s*\}, \[inlineBase\]\);/,
    );
  });

  test('both registration prompts (source and destination chain) go through it', () => {
    const gate = body('const resolveSwapSession = useCallback', '// --- Quote (input → review) ---');
    expect(gate).not.toContain('setIsOpen(false)');
    expect(gate.match(/hideForRegistration\(\);/g)?.length).toBe(2);
    expect(gate.match(/openKeystoreRegistrationModal\(/g)?.length).toBe(2);
  });
});
