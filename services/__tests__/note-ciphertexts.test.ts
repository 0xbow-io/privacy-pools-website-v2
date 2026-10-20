import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getNoteCiphertextsRevision,
  noteCiphertextsFor,
  recordNoteCiphertexts,
  recordingNoteEventReads,
  resetNoteCiphertexts,
  subscribeNoteCiphertexts,
} from '@/services/note-ciphertexts';

const TX = '0xA45C56491A6A66EB0461EC67CAF9A90CAD622313AB7FCD5D30044F11957EE22D';
const event = (over: Record<string, unknown> = {}) => ({
  blockNumber: '0x18ee26e',
  txHash: TX,
  hint: '0x01',
  ephemeralPubKey: '0xaa',
  encryptedPayload: '0xbb',
  ...over,
});

beforeEach(() => resetNoteCiphertexts());

describe('note ciphertext harvest', () => {
  test('records by chain and tx hash, case-insensitively', () => {
    expect(recordNoteCiphertexts(1, [event()])).toBe(1);
    expect(noteCiphertextsFor(1, TX.toLowerCase())).toEqual([{ ephemeralPubKey: '0xaa', encryptedPayload: '0xbb' }]);
    expect(noteCiphertextsFor(56, TX)).toEqual([]);
  });

  test('a tx with several Note events keeps each one', () => {
    recordNoteCiphertexts(1, [event(), event({ ephemeralPubKey: '0xcc', encryptedPayload: '0xdd' })]);
    expect(noteCiphertextsFor(1, TX)).toHaveLength(2);
  });

  test('the same payload seen by a later discovery pass is not added again', () => {
    recordNoteCiphertexts(1, [event()]);
    const revision = getNoteCiphertextsRevision();
    expect(recordNoteCiphertexts(1, [event()])).toBe(0);
    expect(getNoteCiphertextsRevision()).toBe(revision);
    expect(noteCiphertextsFor(1, TX)).toHaveLength(1);
  });

  test('malformed rows are skipped, never thrown on', () => {
    expect(recordNoteCiphertexts(1, [null, {}, event({ txHash: 'nope' }), event({ encryptedPayload: undefined })])).toBe(0);
    expect(noteCiphertextsFor(1, TX)).toEqual([]);
  });

  test('subscribers hear about new ciphertexts only', () => {
    let calls = 0;
    const unsubscribe = subscribeNoteCiphertexts(() => { calls += 1; });
    recordNoteCiphertexts(1, [event()]);
    recordNoteCiphertexts(1, [event()]);
    unsubscribe();
    recordNoteCiphertexts(1, [event({ encryptedPayload: '0xee' })]);
    expect(calls).toBe(1);
  });
});

describe("discovery's chain reads", () => {
  test('the Note events read past the ASP index are recorded and passed through unchanged', async () => {
    const events = [event()];
    const read = recordingNoteEventReads(1, async (_from?: string, _to?: string) => events);
    expect(await read('0x1', '0x2')).toBe(events);
    expect(noteCiphertextsFor(1, TX)).toEqual([{ ephemeralPubKey: '0xaa', encryptedPayload: '0xbb' }]);
  });

  test('a failed read still fails, and records nothing', async () => {
    const read = recordingNoteEventReads(1, async () => { throw new Error('rpc down'); });
    await expect(read()).rejects.toThrow('rpc down');
    expect(noteCiphertextsFor(1, TX)).toEqual([]);
  });
});
