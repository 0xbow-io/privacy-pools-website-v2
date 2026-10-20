import { describe, expect, test } from 'bun:test';
import { readCollapsed, writeCollapsed } from '../collapsed-store';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('collapsed-store', () => {
  test('defaults to expanded when nothing is stored', () => {
    expect(readCollapsed('all-pools', memoryStorage())).toBe(false);
  });

  // DEV-369: "My transactions" must start closed, and must STAY open once the
  // user opens it — the two halves of the same default.
  test('honours a per-key default only while the user has never touched it', () => {
    const storage = memoryStorage();
    expect(readCollapsed('my-transactions-inline', storage, true)).toBe(true);
    writeCollapsed('my-transactions-inline', false, storage);
    expect(readCollapsed('my-transactions-inline', storage, true)).toBe(false);
    writeCollapsed('my-transactions-inline', true, storage);
    expect(readCollapsed('my-transactions-inline', storage, true)).toBe(true);
  });

  test('a per-key default survives unavailable and throwing storage', () => {
    expect(readCollapsed('my-transactions-inline', undefined, true)).toBe(true);
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(readCollapsed('my-transactions-inline', throwing, true)).toBe(true);
  });

  test('round-trips collapsed state per key', () => {
    const storage = memoryStorage();
    writeCollapsed('all-pools', true, storage);
    expect(readCollapsed('all-pools', storage)).toBe(true);
    expect(readCollapsed('transactions', storage)).toBe(false);
    writeCollapsed('all-pools', false, storage);
    expect(readCollapsed('all-pools', storage)).toBe(false);
  });

  test('keys are namespaced with the versioned prefix', () => {
    const storage = memoryStorage();
    writeCollapsed('my-pools', true, storage);
    expect([...storage.map.keys()]).toEqual(['ppv2_section_collapsed_v1:my-pools']);
  });

  test('is inert when storage is unavailable or throws', () => {
    expect(readCollapsed('x', undefined)).toBe(false);
    writeCollapsed('x', true, undefined); // must not throw
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(readCollapsed('x', throwing)).toBe(false);
    writeCollapsed('x', true, throwing); // must not throw
  });
});
