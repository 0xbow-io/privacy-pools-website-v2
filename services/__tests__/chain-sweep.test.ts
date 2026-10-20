import { describe, expect, test } from 'bun:test';
import { createChainLimiter, feedHasData, snapshotActivityFingerprint, sweepChains, syncingLabel, waitForFeed } from '../chain-sweep';


describe('sweepChains', () => {
  test('runs chains side by side, not one after another', async () => {
    const ids = [10, 8453, 42161, 4663, 56, 4114];
    const gates: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const done = sweepChains(ids, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight--;
      return 'synced';
    }, 4);
    // Let the workers start; none can finish until a gate opens.
    await Promise.resolve(); await Promise.resolve();
    expect(inFlight).toBe(4);
    while (gates.length) { gates.shift()!(); await new Promise((r) => setImmediate(r)); }
    expect(await done).toBe('done');
    expect(peak).toBe(4);
  });

  test('visits every chain exactly once', async () => {
    const seen: number[] = [];
    await sweepChains([1, 2, 3, 4, 5], async (c) => { seen.push(c); return 'synced'; }, 2);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test('a throwing or failed chain does not stop the others', async () => {
    const seen: number[] = [];
    const res = await sweepChains([1, 2, 3], async (c) => {
      seen.push(c);
      if (c === 1) throw new Error('rpc down');
      return c === 2 ? 'failed' : 'synced';
    }, 1);
    expect(res).toBe('done');
    expect(seen).toEqual([1, 2, 3]);
  });

  test('stale stops starting new chains and reports stale', async () => {
    const seen: number[] = [];
    const res = await sweepChains([1, 2, 3, 4], async (c) => {
      seen.push(c);
      return c === 2 ? 'stale' : 'synced';
    }, 1);
    expect(res).toBe('stale');
    expect(seen).toEqual([1, 2]);
  });

  test('empty list is a no-op', async () => {
    expect(await sweepChains([], async () => 'synced')).toBe('done');
  });
});

describe('chains-left count', () => {
  test('counts down per finished chain, failed ones included, not on stale', async () => {
    const done: number[] = [];
    await sweepChains([1, 2, 3], async (c) => (c === 2 ? 'failed' : 'synced'), 1, (c) => done.push(c));
    expect(done).toEqual([1, 2, 3]);
    const stale: number[] = [];
    await sweepChains([1, 2, 3], async (c) => (c === 2 ? 'stale' : 'synced'), 1, (c) => stale.push(c));
    expect(stale).toEqual([1]);
  });

  test('label', () => {
    expect(syncingLabel(3)).toBe('Syncing (3 chains left)');
    expect(syncingLabel(1)).toBe('Syncing (1 chain left)');
    expect(syncingLabel(0)).toBe('Syncing');
  });
});

describe('snapshot readiness gate', () => {
  const feeds = (initial: { status: string; data?: unknown }) => {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
      read: () => state,
      subscribe: (_k: string, l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
      set: (s: { status: string; data?: unknown }) => { state = s; for (const l of [...listeners]) l(); },
      listeners,
    };
  };

  test('held data counts as ready, even after a failed refresh', () => {
    expect(feedHasData({ status: 'ready', data: '1' })).toBe(true);
    expect(feedHasData({ status: 'error', data: '1' })).toBe(true);
    expect(feedHasData({ status: 'error' })).toBe(false);
    expect(feedHasData({ status: 'empty' })).toBe(false);
  });

  test('resolves when the grid lands the feed, and unsubscribes', async () => {
    const f = feeds({ status: 'empty' });
    const p = waitForFeed(f, 'k', 10_000);
    expect(f.listeners.size).toBe(1);
    f.set({ status: 'ready', data: '1' });
    expect(await p).toBe(true);
    expect(f.listeners.size).toBe(0);
  });

  test('gives up after the timeout without data', async () => {
    const f = feeds({ status: 'error' });
    expect(await waitForFeed(f, 'k', 5)).toBe(false);
    expect(f.listeners.size).toBe(0);
  });
});

describe('background pass trigger', () => {
  const held = (notes: number, newest: string) => ({
    notes: Array.from({ length: notes }, () => ({ blockNumber: newest })), deposits: [], transacts: [], ragequits: [],
  });
  test('changes only when pool-wide rows change', () => {
    expect(snapshotActivityFingerprint(held(2, '100'))).toBe(snapshotActivityFingerprint(held(2, '100')));
    expect(snapshotActivityFingerprint(held(3, '100'))).not.toBe(snapshotActivityFingerprint(held(2, '100')));
    expect(snapshotActivityFingerprint(held(2, '101'))).not.toBe(snapshotActivityFingerprint(held(2, '100')));
  });
  test('a payload missing a section has no fingerprint, so it never suppresses a pass', () => {
    expect(snapshotActivityFingerprint({ notes: [] })).toBeNull();
    expect(snapshotActivityFingerprint(null)).toBeNull();
  });
});

test('same-height replacement and corrected ciphertext invalidate the background fingerprint', () => {
  const snapshot = { notes: [{ blockNumber: '100', txHash: '0x1', encryptedPayload: '0xaa' }],
    deposits: [], transacts: [], ragequits: [], snapshotBlockNumber: '120' };
  const key = snapshotActivityFingerprint(snapshot);
  expect(snapshotActivityFingerprint({ ...snapshot, snapshotBlockNumber: '130' })).toBe(key);
  expect(snapshotActivityFingerprint({ ...snapshot, notes: [{ ...snapshot.notes[0], txHash: '0x2' }] })).not.toBe(key);
  expect(snapshotActivityFingerprint({ ...snapshot, notes: [{ ...snapshot.notes[0], encryptedPayload: '0xbb' }] })).not.toBe(key);
});

test('approval or rejection changes invalidate discovery even without a new chain event', () => {
  const snapshot = { notes: [], deposits: [], transacts: [], ragequits: [] };
  expect(snapshotActivityFingerprint(snapshot, { associationRoot: '0x1' }))
    .not.toBe(snapshotActivityFingerprint(snapshot, { associationRoot: '0x2' }));
  expect(snapshotActivityFingerprint(snapshot, { rejected: [] }))
    .not.toBe(snapshotActivityFingerprint(snapshot, { rejected: ['0x1'] }));
});


test('grid discoveries and a foreground sweep share the four-sibling limit', async () => {
  const limited = createChainLimiter();
  const gates: Array<() => void> = [];
  let running = 0;
  let peak = 0;
  let finished = 0;
  const step = async (): Promise<'synced'> => {
    running++;
    peak = Math.max(peak, running);
    await new Promise<void>(resolve => gates.push(resolve));
    running--;
    finished++;
    return 'synced';
  };
  const grid = [limited(step), limited(step), limited(step)];
  const foreground = sweepChains([1, 2, 3, 4, 5], () => limited(step));
  expect(running).toBe(4);
  while (finished < 8) {
    gates.shift()!();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  await Promise.all([...grid, foreground]);
  expect(peak).toBe(4);
});
