import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard the OWNER argument of the unanchored-note store.
 *
 * The flag says "this owner holds a note reachable only through its receipt
 * link". It is written by hooks/use-note-import.ts and read by
 * components/pools/my-privacy-pools.tsx, and the two must agree on who "this
 * owner" is or the record is simply invisible: written under one key, looked up
 * under another.
 *
 * They did not agree. Shipped 2026-09-01 in 0191820, the write side used wagmi's
 * `useAccount().address` while the read side used `sessionAddress`. Those are
 * different values whenever an account key is signed in (a key identity outranks
 * a connected wallet in `effectiveAddress`, components/sdk-provider.tsx), and
 * with no wallet connected the write side is `undefined` and records nothing at
 * all. Claiming from a receipt link with no wallet connected is the normal case
 * for this flow, so the callout could essentially never appear.
 *
 * The right identity is the one the account export itself is filed under
 * (`accountExportKey(effectiveAddress, chainId)`), because that is what decides
 * which notes are on screen next to the callout.
 *
 * A unit test cannot catch this: both sides are individually correct and the
 * pure core round-trips fine. Only the wiring is wrong. So this asserts on the
 * source, in the same spirit as no-targeted-reads.test.ts, and for the same
 * reason: CI runs `bun test` and nothing else, so a lint rule would not run.
 */

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/** Every call must pass this identity, and no other, as the owner. */
const REQUIRED_OWNER = 'sessionAddress';

/** Identities that are NOT the export identity and must never be the owner. */
const FORBIDDEN_OWNERS = ['address ?? null', 'address,', 'myAddress', 'connectedAddress'];

const CALLERS = [
  'hooks/use-note-import.ts',
  'components/pools/my-privacy-pools.tsx',
];

const FNS = ['recordUnanchoredNotes', 'clearUnanchoredNotes', 'readUnanchoredCommitments'];

/** Grab the first argument of each call, tolerating whitespace and newlines. */
function ownerArgs(source: string, fn: string): string[] {
  const out: string[] = [];
  // Calls are single-line in both callers; the store's own definitions are
  // excluded by only scanning the caller files listed above.
  const re = new RegExp(`${fn}\\(\\s*([^,)]+)`, 'g');
  for (const m of source.matchAll(re)) out.push(m[1].trim());
  return out;
}

describe('unanchored-note store owner identity', () => {
  test('every caller keys the flag on the account-export identity', () => {
    const offenders: string[] = [];
    let calls = 0;

    for (const rel of CALLERS) {
      const source = readFileSync(join(ROOT, rel), 'utf8');
      for (const fn of FNS) {
        for (const owner of ownerArgs(source, fn)) {
          calls += 1;
          if (owner !== REQUIRED_OWNER) offenders.push(`${rel}: ${fn}(${owner}…)`);
        }
      }
    }

    // If this trips to zero the guard has silently stopped guarding, e.g. the
    // callers were renamed. That must fail, not pass.
    expect(calls).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test('no caller passes a wallet-scoped identity as the owner', () => {
    const offenders: string[] = [];

    for (const rel of CALLERS) {
      const source = readFileSync(join(ROOT, rel), 'utf8');
      for (const fn of FNS) {
        for (const owner of ownerArgs(source, fn)) {
          const bad = FORBIDDEN_OWNERS.find((f) => owner === f.replace(/,$/, ''));
          if (bad) offenders.push(`${rel}: ${fn}(${owner}…) is wallet-scoped, not the export identity`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('the flag is recorded on BOTH device-resident paths, not just the device-only one', () => {
    // The on-chain claim merges the note into the account export before it
    // attempts the anchor. If the anchor does not confirm, that note is exactly
    // as link-only as one kept on the device deliberately. Recording only on the
    // "keep on this device" button left the failed-anchor case with no record,
    // which is the case that actually stranded a real payment.
    const source = readFileSync(join(ROOT, 'hooks/use-note-import.ts'), 'utf8');
    const records = ownerArgs(source, 'recordUnanchoredNotes');
    expect(records.length).toBeGreaterThanOrEqual(2);
  });
});
