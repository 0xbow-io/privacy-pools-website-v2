import { beforeEach, describe, expect, test } from 'bun:test';

import {
  getPendingRegistration,
  PENDING_REGISTRATION_CAP_MS,
  resetPendingRegistrations,
  subscribePendingRegistration,
  trackPendingRegistration,
} from '../pending-registration-tx';

const OWNER = '0xAbC0000000000000000000000000000000000001';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('pending registration tx', () => {
  beforeEach(() => resetPendingRegistrations());

  test('blocks per owner + chain until the receipt succeeds, survives a remount', async () => {
    const d = deferred<'success' | 'reverted'>();
    let notified = 0;
    const unsubscribe = subscribePendingRegistration(() => { notified += 1; });
    const done = trackPendingRegistration(OWNER, 1, '0xhash', () => d.promise);
    // Case-insensitive owner, same chain: still pending (a fresh modal reads this).
    expect(getPendingRegistration(OWNER.toLowerCase(), 1)?.hash).toBe('0xhash');
    expect(getPendingRegistration(OWNER, 10)).toBeNull();
    d.resolve('success');
    expect(await done).toBe('success');
    expect(getPendingRegistration(OWNER, 1)).toBeNull();
    expect(notified).toBe(2);
    unsubscribe();
  });

  test('a revert clears the block and reports reverted', async () => {
    const outcome = await trackPendingRegistration(OWNER, 1, '0xhash', async () => 'reverted');
    expect(outcome).toBe('reverted');
    expect(getPendingRegistration(OWNER, 1)).toBeNull();
  });

  test('a receipt wait that throws (cap reached) clears it as unknown', async () => {
    const outcome = await trackPendingRegistration(OWNER, 1, '0xhash', async (_h, timeoutMs) => {
      expect(timeoutMs).toBe(PENDING_REGISTRATION_CAP_MS);
      throw new Error('Timed out while waiting for transaction');
    });
    expect(outcome).toBe('unknown');
    expect(getPendingRegistration(OWNER, 1)).toBeNull();
  });

  test('the block expires at the cap even if nothing settles', () => {
    void trackPendingRegistration(OWNER, 1, '0xhash', () => new Promise(() => {}), 1_000);
    expect(getPendingRegistration(OWNER, 1, 1_000 + PENDING_REGISTRATION_CAP_MS - 1)).not.toBeNull();
    expect(getPendingRegistration(OWNER, 1, 1_000 + PENDING_REGISTRATION_CAP_MS)).toBeNull();
  });
});
