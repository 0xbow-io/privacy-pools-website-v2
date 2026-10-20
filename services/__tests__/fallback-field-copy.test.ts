/**
 * The sentence that asks the user to choose a fallback address, and the field
 * that would let them, must appear on the same surfaces.
 *
 * The inline hub rendered the copy while suppressing the input, so the one
 * control the paragraph is about did not exist where it was read (Mike,
 * 2026-09-23: "There is no field to set fallback option btw"). A cross-chain
 * reshield now shows the field everywhere, and one boolean gates both.
 *
 * Source-level because the condition is the thing being fixed: a render test
 * would have to reproduce the hub, and the two conditions agreeing is what
 * went wrong, not what either one renders.
 */
import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const source = readFileSync(join(ROOT, 'components/swap-modal-provider.tsx'), 'utf8');

describe('the fallback copy and its field are gated together', () => {
  test('a cross-chain reshield shows the field on every surface, hub included', () => {
    // A same-chain reshield on the modal surface also shows it now (a swap-send
    // names a recipient there), but never on the hub, which keeps its own card.
    // The cross-chain clause is the one this test guards: still on every surface.
    // The inline private swap-send adds its own same-chain term on the hub.
    expect(source).toMatch(
      // DEV-510: except when the hub Swap tab's own recipient row drives it.
      /const showRecipientField = !hubRecipientDriven && \(\(\(!isReshield \|\| crossChainReshield \|\| \(sameChainReshield && !inlineHubActive\)\)\s*&& \(crossChainReshield \|\| !inlineHubActive\)\)\s*\|\| \(sameChainReshield && inlineSend\)\);/,
    );
  });

  test('the long fallback paragraph is gone, the field caption is enough (DEV-565)', () => {
    expect(source).not.toContain('point it somewhere unlinked');
  });

  test('nothing points at an address that may not be rendered', () => {
    // The old copy said "the address below is where that would land" whether or
    // not anything was below it. The phrase may still exist, but only inside a
    // branch on whether the field is there.
    const phrase = 'the address below is where that would land';
    expect(source).toContain(phrase);
    const at = source.indexOf(phrase);
    const gate = source.lastIndexOf('showRecipientField ?', at);
    expect(gate).toBeGreaterThan(-1);
    expect(at - gate).toBeLessThan(200);
  });

  test('the field itself is not gated on anything else', () => {
    expect(source).toContain('{showRecipientField && (');
    expect(source).not.toMatch(/\(!isReshield \|\| crossChainReshield\) && !inlineHubActive && \(/);
  });
});
