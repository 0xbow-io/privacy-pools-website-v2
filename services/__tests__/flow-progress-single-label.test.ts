/**
 * A flow status line is printed once.
 *
 * `FlowProgress` takes `message` for two reasons: it derives the phase from it
 * AND it prints it. The swap flow prints the same string itself, in bold, so it
 * has to keep passing the prop (or the stepper stops advancing) while asking
 * the component not to render it. Without that it read "Selecting notes…"
 * twice, once regular and once bold (QA, 2026-09-22).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const read = (...p: string[]) => readFileSync(join(here, '..', '..', ...p), 'utf8');
const SWAP = read('components', 'swap-modal-provider.tsx');
const PROGRESS = read('components', 'ui', 'flow-progress.tsx');

describe('the swap flow', () => {
  test('still passes the message, so the stepper keeps advancing', () => {
    const uses = SWAP.match(/<FlowProgress[^/]*\/>/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toContain('message={executingLabel}');
  });

  test('and asks the component not to print it, because it prints it itself', () => {
    const uses = SWAP.match(/<FlowProgress[^/]*\/>/g) ?? [];
    for (const use of uses) expect(use).toContain('showMessage={false}');
    // The bold line Pat asked to keep.
    expect(SWAP).toContain('font-pp-bold">{executingLabel}</Text>');
  });
});

describe('every other caller is unaffected', () => {
  test('the message still renders by default', () => {
    expect(PROGRESS).toContain('showMessage = true');
    expect(PROGRESS).toContain('{message && showMessage ?');
  });

  test('no other surface opts out, so none of them lost their status line', () => {
    for (const file of [
      ['components', 'withdraw-modal-provider.tsx'],
      ['components', 'deposit-modal-provider.tsx'],
      ['components', 'import-note-modal-provider.tsx'],
      ['components', 'keystore-registration-modal-provider.tsx'],
      ['components', 'payment-request-modal-provider.tsx'],
      ['components', 'home', 'action-hub.tsx'],
    ]) {
      const source = read(...file);
      for (const use of source.match(/<FlowProgress[^/]*\/>/g) ?? []) {
        expect(use).not.toContain('showMessage');
      }
    }
  });
});
