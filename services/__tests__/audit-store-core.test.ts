import { describe, expect, test } from 'bun:test';

import { mergeSentAudits, parseStoredAudits, readStoredAudits } from '../audit-store-core';

/**
 * These rows are the only route back to money paid to someone who never
 * registered: the row menu rebuilds their one-time claim link from them.
 *
 * The bug this pins: reading an unreadable store answered "empty", and the
 * caller writes back whatever it read, so ONE bad read turned the next
 * recorded payment into a silent erasure of every disclosure already held.
 */

const d = (txHash: string, commitment: string) => ({
  chainId: 11155111,
  txHash,
  commitment,
  ownerAddress: '0x1111111111111111111111111111111111111111',
  noteSecret: '0x2222',
  tokenId: '0x3333333333333333333333333333333333333333',
  value: '0x1',
  label: '0x4444',
}) as never;

describe('telling "empty" apart from "cannot read"', () => {
  test('a key that was never written is genuinely empty, and readable', () => {
    for (const raw of [null, undefined, '']) {
      expect(parseStoredAudits(raw)).toEqual({ ok: true, list: [] });
    }
  });

  test('an empty array is readable and empty', () => {
    expect(parseStoredAudits('[]')).toEqual({ ok: true, list: [] });
  });

  test('unparseable JSON is a READ FAILURE, not an empty store', () => {
    expect(parseStoredAudits('{ not json').ok).toBe(false);
    expect(parseStoredAudits('').ok).toBe(true);
  });

  test('a value that is not an array is a read failure', () => {
    // A half-written value, another writer, or a storage shim answering with
    // something else entirely. None of these mean "no payments were made".
    for (const raw of ['{"a":1}', '"a string"', '42', 'null']) {
      expect({ raw, ok: parseStoredAudits(raw).ok }).toEqual({ raw, ok: false });
    }
  });

  test('a readable array comes back intact', () => {
    const stored = JSON.stringify([d('0xAAA', '0xc1')]);
    const result = parseStoredAudits(stored);
    expect(result.ok).toBe(true);
    expect(result.list.length).toBe(1);
  });
});

describe('merging one payment into the set', () => {
  test('earlier payments survive a later one', () => {
    const merged = mergeSentAudits([d('0xaaa', '0xc1')], [d('0xbbb', '0xc2')]);
    expect(merged.map((x) => x.txHash)).toEqual(['0xaaa', '0xbbb']);
  });

  test('re-recording one tx replaces only that tx', () => {
    const merged = mergeSentAudits(
      [d('0xaaa', '0xc1'), d('0xbbb', '0xc2')],
      [d('0xAAA', '0xc9')],
    );
    expect(merged.map((x) => x.commitment).sort()).toEqual(['0xc2', '0xc9']);
  });

  test('a multi-note payment keeps all of its own rows', () => {
    const merged = mergeSentAudits([], [d('0xaaa', '0xc1'), d('0xaaa', '0xc2')]);
    expect(merged.length).toBe(2);
  });

  test('tx hashes are stored lowercased so lookups match', () => {
    expect(mergeSentAudits([], [d('0xAAA', '0xc1')])[0].txHash).toBe('0xaaa');
  });

  test('recording nothing changes nothing', () => {
    const current = [d('0xaaa', '0xc1')];
    expect(mergeSentAudits(current, [])).toEqual(current);
  });
});

describe('a throwing storage accessor is a failed read, not an empty store', () => {
  // The store used to swallow the accessor's exception into `null`, and null
  // parses as "never written" - so a throwing localStorage/SecureStore made
  // every read-modify-write see an empty list and write `[]` back, erasing
  // every disclosure held (codex third pass, 2026-09-16).
  test('the accessor throwing is ok:false', () => {
    expect(readStoredAudits(() => { throw new Error('SecurityError'); })).toEqual({ ok: false, list: [] });
  });

  test('a readable accessor still classifies by content', () => {
    expect(readStoredAudits(() => null)).toEqual({ ok: true, list: [] });
    expect(readStoredAudits(() => 'not json')).toEqual({ ok: false, list: [] });
    expect(readStoredAudits(() => JSON.stringify([d('0xa', '0x1')]))).toEqual({ ok: true, list: [d('0xa', '0x1')] });
  });
});
