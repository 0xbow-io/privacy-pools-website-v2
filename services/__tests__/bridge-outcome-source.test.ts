import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/**
 * Every flow that watches a bridge must read the SUBSTATUS, not the status.
 *
 * LI.FI reports DONE both when the destination call ran and when it did not and
 * the bridged funds went to the fallback address instead. `bridgeDeliveryOutcome`
 * is the single place that distinguishes them. The cross-chain shield used it;
 * the cross-chain swap did not, and branched on `status.status === 'DONE'`
 * alone, so it told the user their note had landed while the amount sat in
 * their wallet on the other chain and left a note in the local balance that
 * would never confirm (QA, 2026-09-23).
 *
 * Read off the source because reproducing it needs a real bridge recovery. The
 * behaviour of the helper itself is covered in swap-flows.test.ts, which is
 * where the PARTIAL / REFUNDED substatuses are pinned. This file is only about
 * whether the callers ask it.
 */
describe('a bridge verdict is never taken from the status alone', () => {
  const watchers = ['components/swap-modal-provider.tsx', 'components/deposit-modal-provider.tsx'];

  for (const file of watchers) {
    const source = read(file);

    test(`${file} decides with bridgeDeliveryOutcome`, () => {
      expect(source).toContain('bridgeDeliveryOutcome');
    });

    test(`${file} never treats a bare DONE as delivered`, () => {
      // The exact shape that shipped the false success. A comparison against
      // 'DONE' anywhere in a watcher is the thing being ratcheted.
      expect(source).not.toMatch(/status\.status\s*===\s*['"]DONE['"]/);
    });
  }

  test('the swap watcher stores the destination note only once the far leg deposited', () => {
    const source = read('components/swap-modal-provider.tsx');
    // Nothing is stored at relay time any more, so there is nothing to drop on
    // a recovery or failure. Guarded on the outcome, not on the raw status.
    expect(source).not.toContain('withoutStrandedPendingNote');
    expect(source).toContain("outcome === 'deposited'");
  });

  test('the swap success screen has a state for funds paid to the fallback address', () => {
    const source = read('components/swap-modal-provider.tsx');
    expect(source).toContain("'recovered'");
    // And it must stop promising the note in that state.
    expect(source).toMatch(/!\(delivery\?\.status === 'recovered' \|\| delivery\?\.status === 'failed'\)/);
  });

});
