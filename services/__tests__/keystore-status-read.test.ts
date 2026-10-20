import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { keysBelongTo, pickStatusIdentity, readStatusWithRetry } from '../keystore-status-read';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/**
 * DEV-439: right after unlock every chain row read "Couldn't check - Retry".
 * The keys were ready but the session (the only source the read used) was not
 * committed yet, so every read answered 'unknown'.
 */
describe('pickStatusIdentity', () => {
  test('the committed session wins when there is one', () => {
    expect(pickStatusIdentity({ keystoreManager: 'S', address: '0xs' }, { keystoreManager: 'D', address: '0xd' }))
      .toEqual({ keystoreManager: 'S', address: '0xs' });
  });
  test('before the session commits, the unlocked keys answer', () => {
    expect(pickStatusIdentity(null, { keystoreManager: 'D', address: '0xd' }))
      .toEqual({ keystoreManager: 'D', address: '0xd' });
  });
  test('nothing unlocked, nothing to read with', () => {
    expect(pickStatusIdentity(null, { keystoreManager: null, address: '0xd' })).toBeNull();
    expect(pickStatusIdentity(undefined, { keystoreManager: 'D', address: undefined })).toBeNull();
  });
});

describe('keysBelongTo', () => {
  test('keys pinned to the same address, any case', () => {
    expect(keysBelongTo('0xabc:1', '0xABC')).toBe(true);
  });
  test('a wallet switch: the old keys do not answer for the new address', () => {
    expect(keysBelongTo('0xold:1', '0xnew')).toBe(false);
    expect(keysBelongTo(null, '0xnew')).toBe(false);
    expect(keysBelongTo('0xold:1', undefined)).toBe(false);
  });
});

describe('readStatusWithRetry', () => {
  test('a failed read is tried once more', async () => {
    const answers = ['unknown', 'compatible'];
    let calls = 0;
    const slept: number[] = [];
    const r = await readStatusWithRetry(async () => { calls += 1; return answers.shift() as string; }, { sleep: async (ms) => { slept.push(ms); } });
    expect(r).toBe('compatible');
    expect(calls).toBe(2);
    // The pause is part of the fix: an immediate re-read hits the same failing RPC.
    expect(slept).toEqual([1_500]);
  });
  test('a real answer is not read again, and a second failure stays unknown', async () => {
    let calls = 0;
    expect(await readStatusWithRetry(async () => { calls += 1; return 'unregistered'; }, { sleep: async () => {} })).toBe('unregistered');
    expect(calls).toBe(1);
    expect(await readStatusWithRetry(async () => 'unknown', { sleep: async () => {} })).toBe('unknown');
  });
});

describe('sdk-provider wires it', () => {
  const src = readFileSync(join(ROOT, 'components/sdk-provider.tsx'), 'utf8');
  test('keystoreStatusForChain reads with the unlock keys before the session commits', () => {
    const start = src.indexOf('const keystoreStatusForChain = useCallback(');
    const body = src.slice(start, src.indexOf('}, []);', start));
    expect(body).toContain('pickStatusIdentity(committedSessionRef.current, derivedIdentityRef.current)');
    expect(body).toContain('readStatusWithRetry(');
    expect(src).toContain('keysReady && keysBelongTo(keystoreTargetRef.current, effectiveAddress) ? keystoreManager : null');
  });
});
