import { describe, expect, test } from 'bun:test';

import {
  buildTransitionEvent,
  depositTransitionTxs,
  detectStatusTransitions,
  type DepositRowLike,
  type TransitionTx,
} from '@/services/notification-transitions';

const tx = (over: Partial<TransitionTx> = {}): TransitionTx => ({
  id: 't1',
  type: 'Deposit',
  status: 'pending',
  tokenAmount: 0.002,
  asset: 'ETH',
  timestamp: 1_700_000_000_000,
  ...over,
});

describe('detectStatusTransitions', () => {
  test('seeds first-sighting txs without emitting (no burst on fresh load)', () => {
    const { events, next } = detectStatusTransitions({}, [
      tx({ id: 'a', status: 'pending' }),
      tx({ id: 'b', status: 'completed' }),
    ]);
    expect(events).toEqual([]);
    expect(next).toEqual({ a: 'pending', b: 'completed' });
  });

  test('emits when a known pending tx settles', () => {
    const prev = { a: 'pending' };
    const { events, next } = detectStatusTransitions(prev, [tx({ id: 'a', status: 'completed' })]);
    expect(events).toHaveLength(1);
    expect(events[0].txId).toBe('a');
    expect(events[0].title).toBe('Deposit approved');
    expect(events[0].variant).toBe('success');
    expect(next.a).toBe('completed');
  });

  test('does not emit for an unchanged status', () => {
    const { events } = detectStatusTransitions({ a: 'completed' }, [tx({ id: 'a', status: 'completed' })]);
    expect(events).toEqual([]);
  });

  test('does not emit for a settled → settled change (only pending → settled)', () => {
    const { events } = detectStatusTransitions({ a: 'completed' }, [tx({ id: 'a', status: 'spent' })]);
    expect(events).toEqual([]);
  });

  test('emits a destructive event when a pending tx fails', () => {
    const { events } = detectStatusTransitions({ a: 'pending' }, [tx({ id: 'a', status: 'failed', type: 'Withdrawal' })]);
    expect(events).toHaveLength(1);
    expect(events[0].variant).toBe('destructive');
    expect(events[0].title).toBe('Withdrawal failed');
  });

  test('gives each transition a stable, unique id (txId + status)', () => {
    const { events } = detectStatusTransitions({ a: 'pending' }, [tx({ id: 'a', status: 'completed' })]);
    expect(events[0].id).toBe('a:completed');
  });
});

describe('buildTransitionEvent copy', () => {
  test('deposit → approved wording (never claims spendability. Leaf lag)', () => {
    const e = buildTransitionEvent(tx({ type: 'Deposit', status: 'completed', tokenAmount: 0.002, asset: 'ETH' }));
    expect(e.title).toBe('Deposit approved');
    expect(e.description).toContain('ETH');
    expect(e.description).not.toContain('spendable');
  });

  test('directional transfer type reduces to the base label', () => {
    const e = buildTransitionEvent(tx({ type: 'Transfer Out', status: 'completed' }));
    expect(e.title).toBe('Transfer complete');
  });

  test('withdrawal and exit have their own settled copy', () => {
    expect(buildTransitionEvent(tx({ type: 'Withdrawal', status: 'completed' })).title).toBe('Withdrawal complete');
    expect(buildTransitionEvent(tx({ type: 'Exit', status: 'completed' })).title).toBe('Exit complete');
  });
});

describe('monotonic memory (gaps, stale replays, bounds)', () => {
  test('pending → absent (feed gap) → approved still emits on reappearance', () => {
    // Seed while pending.
    const r1 = detectStatusTransitions({}, [tx({ id: 'a', status: 'pending' })]);
    // The tx drops out of the 50-row window: its entry must be RETAINED.
    const r2 = detectStatusTransitions(r1.next, []);
    expect(r2.next.a).toBe('pending');
    expect(r2.events).toEqual([]);
    // It reappears settled: the transition emits (not re-seeded as first sighting).
    const r3 = detectStatusTransitions(r2.next, [tx({ id: 'a', status: 'completed' })]);
    expect(r3.events).toHaveLength(1);
    expect(r3.events[0].title).toBe('Deposit approved');
  });

  test('pending → approved → stale pending → approved emits exactly once', () => {
    const r1 = detectStatusTransitions({ a: 'pending' }, [tx({ id: 'a', status: 'completed' })]);
    expect(r1.events).toHaveLength(1);
    // A stale feed page reports pending again: terminal state is sticky.
    const r2 = detectStatusTransitions(r1.next, [tx({ id: 'a', status: 'pending' })]);
    expect(r2.events).toEqual([]);
    expect(r2.next.a).toBe('completed');
    // The fresh page settles again: no duplicate.
    const r3 = detectStatusTransitions(r2.next, [tx({ id: 'a', status: 'completed' })]);
    expect(r3.events).toEqual([]);
  });

  test('retention is bounded (oldest entries evicted beyond the cap)', () => {
    const prev: Record<string, string> = {};
    for (let i = 0; i < 1100; i += 1) prev[`old-${i}`] = 'completed';
    const { next } = detectStatusTransitions(prev, [tx({ id: 'fresh', status: 'pending' })]);
    expect(Object.keys(next).length).toBeLessThanOrEqual(1000);
    expect(next.fresh).toBe('pending'); // newest survives
    expect(next['old-0']).toBeUndefined(); // oldest evicted
  });

  test('declined is terminal and sticky like approval', () => {
    const r1 = detectStatusTransitions({ a: 'pending' }, [tx({ id: 'a', status: 'declined' })]);
    expect(r1.events).toHaveLength(1);
    expect(r1.events[0].variant).toBe('destructive');
    expect(r1.events[0].title).toBe('Deposit declined');
    const r2 = detectStatusTransitions(r1.next, [tx({ id: 'a', status: 'pending' })]);
    expect(r2.events).toEqual([]);
    expect(r2.next.a).toBe('declined');
  });
});

describe('poi_required (Proof of Innocence demanded)', () => {
  const poiTx = (status: string) => ({ id: 'p', type: 'Deposit', status, tokenAmount: 1, asset: 'ETH', timestamp: 1 });

  test('pending -> poi_required announces once, as a warning, not as an approval', () => {
    const r = detectStatusTransitions({ p: 'pending' }, [poiTx('poi_required')]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].variant).toBe('warning');
    expect(r.events[0].title).toBe('Proof required');
    expect(r.next.p).toBe('poi_required');
    // Same status again: silent.
    const again = detectStatusTransitions(r.next, [poiTx('poi_required')]);
    expect(again.events).toHaveLength(0);
  });

  test('poi_required stays OPEN: the eventual approval or decline still emits', () => {
    const approved = detectStatusTransitions({ p: 'poi_required' }, [poiTx('approved')]);
    expect(approved.events.map((e) => e.title)).toEqual(['Deposit approved']);
    const declined = detectStatusTransitions({ p: 'poi_required' }, [poiTx('declined')]);
    expect(declined.events.map((e) => e.variant)).toEqual(['destructive']);
  });

  test('a stale pending after poi_required does not rewind or re-emit', () => {
    const r = detectStatusTransitions({ p: 'poi_required' }, [poiTx('pending')]);
    expect(r.events).toHaveLength(0);
    expect(r.next.p).toBe('poi_required');
  });
});

test('share deposit approval and decline use approximate coin quantities', () => {
  for (const status of ['approved', 'declined']) {
    const event = buildTransitionEvent(tx({ status, asset: 'ppETH', tokenAmount: 0.1 }));
    expect(event.description).toContain('≈ 0.10 ETH');
    expect(event.description).not.toContain('ppETH');
  }
});

describe('depositTransitionTxs: the account\'s deposits, one per transaction', () => {
  const HASH = `0x${'ab'.repeat(32)}`;
  const row = (over: Partial<DepositRowLike> = {}): DepositRowLike => ({
    type: 'Deposit',
    txHash: HASH,
    chainId: 1,
    status: 'pending',
    reviewStatus: 'pending',
    tokenAmount: 0.1,
    asset: 'ETH',
    timestamp: 1_700_000_000_000,
    ...over,
  });
  const mine = () => true;

  test('a deposit evicted from the public window still announces its approval as a snapshot row', () => {
    // Pending under its ASP row, then approved under the snapshot row that
    // replaces it once 50 newer events push it out of the window.
    const first = detectStatusTransitions({}, depositTransitionTxs([row()], mine));
    const evicted = row({ ownCommitment: '0x1', noteStatus: 'ACTIVE', status: 'completed', reviewStatus: 'approved' });
    const { events } = detectStatusTransitions(first.next, depositTransitionTxs([evicted], mine));
    expect(events.map((e) => e.title)).toEqual(['Deposit approved']);
  });

  test('a restore does not announce old deposits as their notes sync', () => {
    const unmatched = row({ ownCommitment: '0x1', reviewStatus: '' });
    expect(depositTransitionTxs([unmatched], mine)).toEqual([]);
    const matched = row({ ownCommitment: '0x1', noteStatus: 'ACTIVE', status: 'completed', reviewStatus: 'approved' });
    const seeded = detectStatusTransitions({}, depositTransitionTxs([matched], mine));
    expect(seeded.events).toEqual([]);
  });

  test('a matched snapshot row is mine whoever submitted it: a cross-chain shield names the bridge executor', () => {
    const bridged = row({ ownCommitment: '0x1', noteStatus: 'PENDING' });
    expect(depositTransitionTxs([bridged], () => false)).toHaveLength(1);
  });

  test('a row with no verdict never announces: an exit is not an approval', () => {
    const exited = row({ ownCommitment: '0x1', noteStatus: 'EXITED', status: 'completed', reviewStatus: '' });
    expect(depositTransitionTxs([exited], mine)).toEqual([]);
  });

  test('a batch announces its most decisive leg, whatever the row order', () => {
    const settled = row({ status: 'completed', reviewStatus: 'approved' });
    const declined = row({ status: 'failed', reviewStatus: 'declined', tokenAmount: 0.2 });
    for (const legs of [[row(), settled, declined], [declined, row(), settled], [settled, declined, row()]]) {
      expect(depositTransitionTxs(legs, mine).map((t) => t.status)).toEqual(['declined']);
    }
    expect(depositTransitionTxs([row(), settled], mine).map((t) => t.status)).toEqual(['completed']);
  });

  test('the legs of a batch deposit announce once', () => {
    const before = detectStatusTransitions({}, depositTransitionTxs([row(), row({ tokenAmount: 0.2 })], mine));
    const approved = { status: 'completed', reviewStatus: 'approved' };
    const { events } = detectStatusTransitions(before.next, depositTransitionTxs([row(approved), row({ ...approved, tokenAmount: 0.2 })], mine));
    expect(events).toHaveLength(1);
  });
});
