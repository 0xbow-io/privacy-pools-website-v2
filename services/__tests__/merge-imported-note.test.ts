import { describe, expect, test } from 'bun:test';

import { mergeImportedNote } from '@/services/payment-request-codec';
import { NoteStatus } from '@/services/sdk-types';
import type { AccountExport, Hash, Hex } from '@/services/sdk-types';

const TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const OWNER = '0xBbBBbbBBbbbbBBbbBBbbBBbBbBbbBBbbBBbbBBbB';
const h = (c: string) => `0x${c.repeat(64)}` as Hash;

const note = (commitment: string, over: Record<string, unknown> = {}) =>
  ({
    commitment: h(commitment),
    label: h('a'),
    noteAddressHash: h('b'),
    value: '0xe' as Hex,
    tokenId: TOKEN,
    ownerAddress: OWNER,
    noteSecret: h('c') as Hex,
    status: NoteStatus.ACTIVE,
    ...over,
  }) as unknown as AccountExport['notes'][number];

describe('mergeImportedNote', () => {
  test('adds a new note to an empty/null account', () => {
    const merged = mergeImportedNote(null, note('1'));
    expect(merged.notes).toHaveLength(1);
    expect(merged.notes[0].commitment).toBe(h('1'));
  });

  test('is idempotent on the same commitment. No duplicate value', () => {
    const once = mergeImportedNote(null, note('1'));
    const twice = mergeImportedNote(once, note('1'));
    expect(twice.notes).toHaveLength(1);
  });

  // Re-importing a receipt link AFTER anchoring must not resurrect the spent
  // note as ACTIVE — that would inflate the balance and produce a note the
  // wallet then fails to spend on-chain.
  test('does NOT overwrite a locally SPENT note with the receipt ACTIVE copy', () => {
    const base: AccountExport = {
      notes: [note('1', { status: NoteStatus.SPENT })],
      syncCursor: '0x0' as Hex,
    };
    const merged = mergeImportedNote(base, note('1', { status: NoteStatus.ACTIVE }));
    expect(merged.notes).toHaveLength(1);
    expect((merged.notes[0] as { status?: unknown }).status).toBe(NoteStatus.SPENT);
  });

  test('same guard for EXITED', () => {
    const base: AccountExport = {
      notes: [note('1', { status: NoteStatus.EXITED })],
      syncCursor: '0x0' as Hex,
    };
    const merged = mergeImportedNote(base, note('1', { status: NoteStatus.ACTIVE }));
    expect((merged.notes[0] as { status?: unknown }).status).toBe(NoteStatus.EXITED);
  });

  test('same guard for EXIT_PENDING, so a receipt cannot resurrect a mined exit', () => {
    // EXIT_PENDING is NOT terminal — discovery can still send it back to ACTIVE —
    // but a ragequit for this note is already mined and waiting to settle. A
    // receipt import resetting it to ACTIVE would make the note look spendable
    // again and inflate the balance until the next sync. Only discovery may
    // resolve it, in either direction.
    //
    // This guard is a DENYLIST, unlike the SDK where spendability is an allowlist
    // on ACTIVE, so a new status is not safe here by default and has to be added
    // by hand. That is precisely how this case was missed.
    const base: AccountExport = {
      notes: [note('1', { status: NoteStatus.EXIT_PENDING })],
      syncCursor: '0x0' as Hex,
    };
    const merged = mergeImportedNote(base, note('1', { status: NoteStatus.ACTIVE }));
    expect((merged.notes[0] as { status?: unknown }).status).toBe(NoteStatus.EXIT_PENDING);
  });

  test('still replaces a non-terminal (PENDING/ACTIVE) note', () => {
    const base: AccountExport = {
      notes: [note('1', { status: NoteStatus.PENDING })],
      syncCursor: '0x0' as Hex,
    };
    const merged = mergeImportedNote(base, note('1', { status: NoteStatus.ACTIVE }));
    expect((merged.notes[0] as { status?: unknown }).status).toBe(NoteStatus.ACTIVE);
  });
});
