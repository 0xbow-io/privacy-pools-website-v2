import { describe, expect, test } from 'bun:test';
import {
  accountExportIdentityVerdict,
  parkStoredValue,
  stampAccountExport,
  writeStoredValueVerified,
} from '../account-export-identity';

const A = '0xD3581763f41FC0763a49E9ab53F2D3D425870a3D';
const B = '0x98AdDcc75931795eB66c52cA954541c18535E3c0';
const SEPOLIA = 11155111;
const OPTIMISM = 10;

const blob = (extra: object = {}) => ({ notes: [{ commitment: '0xc1' }], syncCursor: '0x5', ...extra });
const ownedBlob = (ownerAddress: string, extra: object = {}) => blob({
  notes: [{ commitment: '0xc1', ownerAddress }],
  ...extra,
});

describe('accountExportIdentityVerdict', () => {
  test('a stamp naming this bucket matches', () => {
    expect(accountExportIdentityVerdict(blob({ owner: A, chainId: SEPOLIA }), {
      address: A, chainId: SEPOLIA,
    })).toEqual({ status: 'match' });
  });

  test('address casing is not a mismatch', () => {
    expect(accountExportIdentityVerdict(blob({ owner: A.toUpperCase() }), {
      address: A.toLowerCase(), chainId: SEPOLIA,
    })).toEqual({ status: 'match' });
  });

  test('THE BUG: unstamped exportState notes from A offered to B are refused', () => {
    // NoteManager.exportState() has no envelope owner. This is the exact shape
    // of the 2026-08-28 leak: notes still A's, destination key already B's.
    expect(accountExportIdentityVerdict(ownedBlob(A), { address: B, chainId: SEPOLIA }))
      .toEqual({
        status: 'mismatch',
        field: 'note.ownerAddress',
        stamped: A.toLowerCase(),
        expected: B.toLowerCase(),
      });
  });

  test('a wrong envelope cannot bless notes that name another owner', () => {
    expect(accountExportIdentityVerdict(ownedBlob(A, { owner: B }), {
      address: B, chainId: SEPOLIA,
    })).toMatchObject({ status: 'mismatch', field: 'note.ownerAddress' });
  });

  test('unstamped exportState notes matching the bucket are accepted', () => {
    expect(accountExportIdentityVerdict(ownedBlob(A), { address: A, chainId: SEPOLIA }))
      .toEqual({ status: 'match' });
  });

  test('the chain half of the key is checked the same way', () => {
    expect(accountExportIdentityVerdict(blob({ owner: A, chainId: OPTIMISM }), {
      address: A, chainId: SEPOLIA,
    })).toEqual({ status: 'mismatch', field: 'chainId', stamped: '10', expected: '11155111' });
  });

  test('owner is reported before chainId when both disagree', () => {
    const verdict = accountExportIdentityVerdict(blob({ owner: A, chainId: OPTIMISM }), {
      address: B, chainId: SEPOLIA,
    });
    expect(verdict).toMatchObject({ status: 'mismatch', field: 'owner' });
  });

  test('a chainId that survived JSON as a string still compares numerically', () => {
    for (const encoded of [SEPOLIA, '11155111', ' 11155111 ', '0xaa36a7']) {
      expect(accountExportIdentityVerdict(blob({ chainId: encoded }), {
        address: A, chainId: SEPOLIA,
      })).toEqual({ status: 'match' });
    }
  });

  test('NO USABLE IDENTITY EVIDENCE IS NOT A MISMATCH', () => {
    // Legacy/malformed identity fields cannot convict a blob. Real exportState
    // notes normally carry ownerAddress and are judged on that evidence above.
    for (const b of [blob(), blob({ owner: null }), blob({ owner: '' }), blob({ owner: '  ' })]) {
      expect(accountExportIdentityVerdict(b, { address: A, chainId: SEPOLIA }).status).toBe('unstamped');
    }
  });

  test('an unreadable chainId stamp is absent evidence, not contrary evidence', () => {
    for (const bad of ['not-a-chain', '  ', {}, [], true, NaN, Infinity, -1, 1.5]) {
      expect(accountExportIdentityVerdict(blob({ chainId: bad }), { address: A, chainId: SEPOLIA }).status)
        .toBe('unstamped');
    }
  });

  test('a half-stamped blob is judged on the half it has', () => {
    expect(accountExportIdentityVerdict(blob({ chainId: SEPOLIA }), { address: A, chainId: SEPOLIA }))
      .toEqual({ status: 'match' });
    expect(accountExportIdentityVerdict(blob({ owner: A }), { address: A, chainId: SEPOLIA }))
      .toEqual({ status: 'match' });
  });

  test('an expected address we cannot read cannot convict a stamp', () => {
    expect(accountExportIdentityVerdict(blob({ owner: A }), { address: '', chainId: SEPOLIA }).status)
      .toBe('match');
  });

  test('a non-object blob is unstamped, never a crash', () => {
    for (const b of [null, undefined, 'nope', 42, []]) {
      expect(accountExportIdentityVerdict(b, { address: A, chainId: SEPOLIA }).status).toBe('unstamped');
    }
  });
});

describe('stampAccountExport', () => {
  test('records the bucket without mutating the caller’s object', () => {
    const original = blob();
    const stamped = stampAccountExport(original, { address: A, chainId: SEPOLIA });
    expect(stamped).toMatchObject({ owner: A, chainId: SEPOLIA });
    expect('owner' in original).toBe(false);
  });

  test('notes and syncCursor survive verbatim — losing either silently empties the manager', () => {
    const original = blob({ paymentRequests: [{ id: 'r1' }] });
    const stamped = stampAccountExport(original, { address: A, chainId: SEPOLIA }) as Record<string, unknown>;
    expect(stamped.notes).toBe(original.notes);
    expect(stamped.syncCursor).toBe('0x5');
    expect(stamped.paymentRequests).toEqual([{ id: 'r1' }]);
  });

  test('a stamped blob verifies against the bucket it was stamped for, and only that one', () => {
    const stamped = stampAccountExport(blob(), { address: A, chainId: SEPOLIA });
    expect(accountExportIdentityVerdict(stamped, { address: A, chainId: SEPOLIA }).status).toBe('match');
    expect(accountExportIdentityVerdict(stamped, { address: B, chainId: SEPOLIA }).status).toBe('mismatch');
    expect(accountExportIdentityVerdict(stamped, { address: A, chainId: OPTIMISM }).status).toBe('mismatch');
  });

  test('re-stamping an already-stamped blob overwrites, so a bucket never carries a stale owner', () => {
    const once = stampAccountExport(blob({ owner: A, chainId: OPTIMISM }), { address: B, chainId: SEPOLIA });
    expect(accountExportIdentityVerdict(once, { address: B, chainId: SEPOLIA }).status).toBe('match');
  });
});

describe('loss-safe storage primitives', () => {
  test('a swallowed write failure is detected by read-back', () => {
    const values = new Map<string, string>();
    expect(writeStoredValueVerified({
      read: (key) => values.get(key) ?? null,
      write: () => { /* storageSetItem swallowed quota */ },
    }, 'bucket', 'notes')).toBe(false);
  });

  test('parking failure keeps the only primary copy intact', () => {
    const values = new Map([['bucket', 'unique-notes']]);
    const result = parkStoredValue({
      read: (key) => values.get(key) ?? null,
      write: (key, value) => {
        if (key !== 'bucket__mismatched') values.set(key, value);
      },
    }, 'bucket', 'bucket__mismatched', 'unique-notes');
    expect(result).toBe('parking-write-failed');
    expect(values.get('bucket')).toBe('unique-notes');
  });

  test('an earlier parked export is never overwritten', () => {
    const values = new Map([
      ['bucket', 'new-unique-notes'],
      ['bucket__mismatched', 'older-unique-notes'],
    ]);
    const result = parkStoredValue({
      read: (key) => values.get(key) ?? null,
      write: (key, value) => { values.set(key, value); },
    }, 'bucket', 'bucket__mismatched', 'new-unique-notes');
    expect(result).toBe('parking-occupied');
    expect(values.get('bucket')).toBe('new-unique-notes');
    expect(values.get('bucket__mismatched')).toBe('older-unique-notes');
  });

  test('a source-clear failure leaves both verified copies intact', () => {
    const values = new Map([['bucket', 'unique-notes']]);
    const result = parkStoredValue({
      read: (key) => values.get(key) ?? null,
      write: (key, value) => {
        if (key !== 'bucket') values.set(key, value);
      },
    }, 'bucket', 'bucket__mismatched', 'unique-notes');
    expect(result).toBe('source-clear-failed');
    expect(values.get('bucket')).toBe('unique-notes');
    expect(values.get('bucket__mismatched')).toBe('unique-notes');
  });

  test('a verified park clears the primary only after the recovery copy exists', () => {
    const values = new Map([['bucket', 'unique-notes']]);
    const writes: string[] = [];
    const result = parkStoredValue({
      read: (key) => values.get(key) ?? null,
      write: (key, value) => {
        writes.push(`${key}:${value}`);
        values.set(key, value);
      },
    }, 'bucket', 'bucket__mismatched', 'unique-notes');
    expect(result).toBe('parked');
    expect(writes).toEqual(['bucket__mismatched:unique-notes', 'bucket:']);
    expect(values.get('bucket__mismatched')).toBe('unique-notes');
    expect(values.get('bucket')).toBe('');
  });
});

describe('note-owner evidence requires UNANIMITY (the stealth landmine)', () => {
  const STEALTH = '0x1111111111111111111111111111111111111111';
  const noteOf = (owner: string) => ({ commitment: `0xc${owner.slice(-2)}`, ownerAddress: owner });

  test('a wholesale-poisoned bucket is still convicted — every note names the other account', () => {
    // NoteManager.exportState() carries no envelope, so this shape IS the
    // wallet-switch incident: A's whole export written under B's key.
    const verdict = accountExportIdentityVerdict(
      { notes: [noteOf(A), noteOf(A)], syncCursor: '0x1' },
      { address: B, chainId: SEPOLIA },
    );
    expect(verdict).toMatchObject({ status: 'mismatch', field: 'note.ownerAddress' });
  });

  test('a MIXED bucket is never convicted — that is what a stealth deposit looks like', () => {
    // The SDK gives a stealth-delivered deposit its derived stealth address as
    // ownerAddress; every other path falls back to the session owner. Convicting
    // on one foreign note would quarantine the bucket and hide the whole
    // balance the day ppv2 passes stealthDepositCredentials.
    const verdict = accountExportIdentityVerdict(
      { notes: [noteOf(A), noteOf(STEALTH), noteOf(A)], syncCursor: '0x1' },
      { address: A, chainId: SEPOLIA },
    );
    expect(verdict.status).toBe('match');
  });

  test('one stealth note in an otherwise-ours bucket does not convict, whatever its order', () => {
    for (const notes of [
      [noteOf(STEALTH), noteOf(A)],
      [noteOf(A), noteOf(STEALTH)],
    ]) {
      expect(accountExportIdentityVerdict({ notes, syncCursor: '0x1' }, { address: A, chainId: SEPOLIA }).status)
        .toBe('match');
    }
  });

  test('the envelope still convicts wholesale replacement even when notes are mixed', () => {
    // Unanimity relaxes only the NOTE evidence; a blob that names another owner
    // outright is refused regardless of what its notes say.
    expect(accountExportIdentityVerdict(
      { owner: A, notes: [noteOf(B), noteOf(STEALTH)], syncCursor: '0x1' },
      { address: B, chainId: SEPOLIA },
    )).toMatchObject({ status: 'mismatch', field: 'owner' });
  });

  test('notes with no readable owner are no evidence either way', () => {
    expect(accountExportIdentityVerdict(
      { notes: [{ commitment: '0xa' }, { commitment: '0xb', ownerAddress: 'nope' }], syncCursor: '0x1' },
      { address: A, chainId: SEPOLIA },
    ).status).toBe('unstamped');
  });
});
