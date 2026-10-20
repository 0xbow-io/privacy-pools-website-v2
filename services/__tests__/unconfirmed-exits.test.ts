import { describe, expect, test } from 'bun:test';
import { findUnconfirmedExits } from '../unconfirmed-exits';
import type { ExitProof } from '../unconfirmed-exits';

const EXIT_PROOF: ExitProof = { terminalStatus: 'EXITED', blockNumber: '0x10' };
const SPEND_PROOF: ExitProof = { terminalStatus: 'SPENT', blockNumber: '0x10' };

const note = (commitment: string, value = '100', tokenId = '0xeee') => ({
  commitment,
  value,
  tokenId,
});

describe('findUnconfirmedExits', () => {
  test('offers an exit the chain never showed', () => {
    // THE FINDING. Local state says EXITED because the ASP snapshot said so. The
    // chain was consulted and there is no ragequit. The note comes back.
    const report = findUnconfirmedExits({
      notes: [note('0xa')],
      exitProofOf: () => null,
      isObservedOnChain: () => true,
    });

    expect(report.offerableCommitments).toEqual(['0xa']);
    expect(report.unconfirmed).toBe(1);
    expect(report.offerableValueByToken).toEqual({ '0xeee': '100' });
    expect(report.confirmed).toBe(0);
  });

  test('excludes an exit the chain confirms', () => {
    const report = findUnconfirmedExits({
      notes: [note('0xa')],
      exitProofOf: () => EXIT_PROOF,
      isObservedOnChain: () => true,
    });

    expect(report.confirmed).toBe(1);
    expect(report.offerableCommitments).toEqual([]);
  });

  test('excludes a note the chain says was SPENT rather than exited', () => {
    // The local EXITED label is wrong, but the nullifier was consumed by a
    // transact: the funds are gone. Offering it would promise an exit that
    // cannot succeed.
    const report = findUnconfirmedExits({
      notes: [note('0xa')],
      exitProofOf: () => SPEND_PROOF,
      isObservedOnChain: () => true,
    });

    expect(report.spentNotExited).toBe(1);
    expect(report.offerableCommitments).toEqual([]);
  });

  // The four cases below are the whole point of positive exclusion. Each is a
  // failure to LOOK, and under an "offer only what we confirmed" rule each would
  // hide the note again — reproducing the finding whenever evidence is merely
  // missing rather than contrary.

  test('offers the note when no verdict could be reached', () => {
    const report = findUnconfirmedExits({
      notes: [note('0xa')],
      exitProofOf: () => undefined,
      isObservedOnChain: () => true,
    });

    expect(report.offerableCommitments).toEqual(['0xa']);
    expect(report.indeterminate).toBe(1);
  });

  test('offers the note when the bulk index never observed its commitment', () => {
    // And note this guard is not load-bearing anyway: the index unions ASP rows,
    // so a fabricated ragequit row marks its own commitment observed.
    const report = findUnconfirmedExits({
      notes: [note('0xa')],
      exitProofOf: () => null,
      isObservedOnChain: () => false,
    });

    expect(report.offerableCommitments).toEqual(['0xa']);
    expect(report.indeterminate).toBe(1);
  });

  test('offers the note when a probe throws', () => {
    // An RPC failure must never read as "the note is gone".
    const thrower = findUnconfirmedExits({
      notes: [note('0xa')],
      exitProofOf: () => {
        throw new Error('rpc down');
      },
      isObservedOnChain: () => true,
    });
    expect(thrower.offerableCommitments).toEqual(['0xa']);
    expect(thrower.indeterminate).toBe(1);

    const observedThrower = findUnconfirmedExits({
      notes: [note('0xa')],
      exitProofOf: () => null,
      isObservedOnChain: () => {
        throw new Error('index broken');
      },
    });
    expect(observedThrower.offerableCommitments).toEqual(['0xa']);
  });

  test('never lets a missing verdict exclude a note, across every shape at once', () => {
    // The ratchet: only a returned proof may exclude. Anything else is offered.
    const report = findUnconfirmedExits({
      notes: [note('0xa'), note('0xb'), note('0xc'), note('0xd'), note('0xe')],
      exitProofOf: (c) => {
        if (c === '0xa') return null;
        if (c === '0xb') return undefined;
        if (c === '0xc') throw new Error('probe failed');
        if (c === '0xd') return EXIT_PROOF;
        return SPEND_PROOF;
      },
      isObservedOnChain: (c) => c !== '0xb',
    });

    expect(report.offerableCommitments).toEqual(['0xa', '0xb', '0xc']);
    expect(report.confirmed).toBe(1);
    expect(report.spentNotExited).toBe(1);
  });

  test('sums offered value per token without mixing assets', () => {
    const report = findUnconfirmedExits({
      notes: [
        note('0xa', '100', '0xeee'),
        note('0xb', '250', '0xeee'),
        note('0xc', '7', '0xusdc'),
      ],
      exitProofOf: () => null,
      isObservedOnChain: () => true,
    });

    expect(report.offerableCommitments).toHaveLength(3);
    expect(report.offerableValueByToken).toEqual({ '0xeee': '350', '0xusdc': '7' });
  });

  test('treats checksum and lowercase spellings of one token as one asset', () => {
    // Keying the id verbatim splits a single asset across two buckets, the same
    // trap services/balance-crosscheck.ts normalises away.
    const report = findUnconfirmedExits({
      notes: [
        note('0xa', '100', '0xAbCdEf0123456789012345678901234567890123'),
        note('0xb', '250', '0xabcdef0123456789012345678901234567890123'),
      ],
      exitProofOf: () => null,
      isObservedOnChain: () => true,
    });

    expect(Object.keys(report.offerableValueByToken)).toHaveLength(1);
    expect(report.offerableValueByToken['0xabcdef0123456789012345678901234567890123']).toBe('350');
  });

  test('still offers a note whose value will not parse', () => {
    const report = findUnconfirmedExits({
      notes: [note('0xa', 'not-a-number')],
      exitProofOf: () => null,
      isObservedOnChain: () => true,
    });

    expect(report.offerableCommitments).toEqual(['0xa']);
    expect(report.offerableValueByToken).toEqual({});
  });

  test('reports nothing for an account with no exited notes', () => {
    const report = findUnconfirmedExits({
      notes: [],
      exitProofOf: () => null,
      isObservedOnChain: () => true,
    });

    expect(report.checked).toBe(0);
    expect(report.offerableCommitments).toEqual([]);
  });
});
