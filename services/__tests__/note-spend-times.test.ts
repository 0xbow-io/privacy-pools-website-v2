import { describe, expect, test } from 'bun:test';

import {
  clearNoteSpendTimes,
  collectNoteSpendTimes,
  noteSpendTime,
  noteSpendTimesFor,
  parseStoredNoteSpendTimes,
  recordNoteSpendTimes,
  restoreNoteSpendTimes,
  serializeNoteSpendTimes,
  subscribeNoteSpendTimes,
} from '@/services/note-spend-times';

// The store is app-wide, so every test uses its own chain id.
let nextChain = 900_000;
const freshChain = () => nextChain++;
const ACCOUNT = '0xB586597aa9DDe1aF2dF46113c7c9561ceF19BDeB';

describe('collectNoteSpendTimes', () => {
  const spends: Record<string, string> = { 'n:0xa': '0x6a91841c', 'n:0xb': '0x6a91db94', 'n:0xc': '0x6a91dac8' };
  const nullifierOf = (commitment: string) => `n:${commitment}`;
  const spentAt = (nullifier: string) => spends[nullifier] ?? null;

  test('reads every spent, exited and active note from the index', () => {
    const times = collectNoteSpendTimes(
      [
        { commitment: '0xa', status: 'SPENT' },
        { commitment: '0xb', status: 'ACTIVE' },
        { commitment: '0xc', status: 'exit_pending' },
      ],
      nullifierOf,
      spentAt,
    );
    expect([...times]).toEqual([['0xa', 0x6a91841c], ['0xb', 0x6a91db94], ['0xc', 0x6a91dac8]]);
  });

  test('skips pending and rejected notes without asking the index', () => {
    const asked: string[] = [];
    collectNoteSpendTimes(
      [{ commitment: '0xa', status: 'PENDING' }, { commitment: '0xc', status: 'REJECTED' }],
      (commitment) => {
        asked.push(commitment);
        return nullifierOf(commitment);
      },
      spentAt,
    );
    expect(asked).toEqual([]);
  });

  test('a note whose nullifier cannot be derived is left out, not fatal', () => {
    const times = collectNoteSpendTimes(
      [{ commitment: '0xbad', status: 'SPENT' }, { commitment: '0xa', status: 'SPENT' }],
      (commitment) => {
        if (commitment === '0xbad') throw new Error('no key');
        return nullifierOf(commitment);
      },
      spentAt,
    );
    expect([...times.keys()]).toEqual(['0xa']);
  });
});

describe('restoreNoteSpendTimes', () => {
  test('fills in persisted times', () => {
    const chain = freshChain();
    restoreNoteSpendTimes(chain, ACCOUNT, new Map([['0xAA', 100]]));
    expect(noteSpendTime(chain, ACCOUNT, '0xaa')).toBe(100);
  });

  test('never overrides a time this page already recorded', () => {
    const chain = freshChain();
    recordNoteSpendTimes(chain, ACCOUNT, new Map([['0xaa', 200]]));
    restoreNoteSpendTimes(chain, ACCOUNT, new Map([['0xAA', 100], ['0xbb', 300]]));
    expect(noteSpendTime(chain, ACCOUNT, '0xaa')).toBe(200);
    expect(noteSpendTime(chain, ACCOUNT, '0xbb')).toBe(300);
  });

  test('notifies only when something was filled in', () => {
    const chain = freshChain();
    recordNoteSpendTimes(chain, ACCOUNT, new Map([['0xaa', 200]]));
    let calls = 0;
    const off = subscribeNoteSpendTimes(() => { calls += 1; });
    restoreNoteSpendTimes(chain, ACCOUNT, new Map([['0xaa', 100]]));
    restoreNoteSpendTimes(chain, ACCOUNT, new Map());
    expect(calls).toBe(0);
    restoreNoteSpendTimes(chain, ACCOUNT, new Map([['0xbb', 1]]));
    expect(calls).toBe(1);
    off();
  });
});

describe('noteSpendTimesFor and clearNoteSpendTimes', () => {
  test('returns a copy of one account and chain', () => {
    const chain = freshChain();
    recordNoteSpendTimes(chain, ACCOUNT, new Map([['0xaa', 1]]));
    const copy = noteSpendTimesFor(chain, ACCOUNT.toLowerCase());
    copy.set('0xbb', 2);
    expect(noteSpendTime(chain, ACCOUNT, '0xbb')).toBeNull();
    expect(noteSpendTimesFor(freshChain(), ACCOUNT).size).toBe(0);
  });

  test('clearing drops the entries and notifies', () => {
    const chain = freshChain();
    recordNoteSpendTimes(chain, ACCOUNT, new Map([['0xaa', 1]]));
    let calls = 0;
    const off = subscribeNoteSpendTimes(() => { calls += 1; });
    clearNoteSpendTimes(chain, ACCOUNT);
    clearNoteSpendTimes(chain, ACCOUNT);
    expect(noteSpendTime(chain, ACCOUNT, '0xaa')).toBeNull();
    expect(calls).toBe(1);
    off();
  });
});

describe('persisted form', () => {
  test('round-trips', () => {
    const times = new Map([['0xaa', 1790304000], ['0xbb', 1790951676]]);
    expect([...parseStoredNoteSpendTimes(serializeNoteSpendTimes(times))]).toEqual([...times]);
  });

  test('drops anything malformed and survives garbage', () => {
    const raw = JSON.stringify({ '0xAA': 5, notHex: 6, '0xbb': -1, '0xcc': 1.5, '0xdd': '7' });
    expect([...parseStoredNoteSpendTimes(raw)]).toEqual([['0xaa', 5]]);
    expect(parseStoredNoteSpendTimes('{not json').size).toBe(0);
    expect(parseStoredNoteSpendTimes('[1,2]').size).toBe(0);
    expect(parseStoredNoteSpendTimes(null).size).toBe(0);
    expect(parseStoredNoteSpendTimes('').size).toBe(0);
  });
});
