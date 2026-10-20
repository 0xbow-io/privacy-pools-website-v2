import { describe, expect, test } from 'bun:test';

import { mergeNotesByCommitment } from '../note-sets';

describe('mergeNotesByCommitment', () => {
  test('every chain once, the live copy winning', () => {
    const live = [{ commitment: '0xA', status: 'SPENT' }];
    const stored = [[{ commitment: '0xa', status: 'ACTIVE' }, { commitment: '0xb', status: 'ACTIVE' }], [{ commitment: '0xc', status: 'ACTIVE' }]];
    expect(mergeNotesByCommitment(live, stored)).toEqual([
      { commitment: '0xA', status: 'SPENT' },
      { commitment: '0xb', status: 'ACTIVE' },
      { commitment: '0xc', status: 'ACTIVE' },
    ]);
  });

  test('a note without a commitment is dropped', () => {
    expect(mergeNotesByCommitment([{ commitment: '' }], [[{}]])).toEqual([]);
  });
});
