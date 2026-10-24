import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Execute the installed dependency, so a missing Bun patch fails this test.
test('browser traversal retains route records and pushes from the landed entry', () => {
  const file = require.resolve('expo-router/build/fork/createMemoryHistory');
  const target = new EventTarget();
  const entries: { state: { id?: string }; path: string }[] = [{ state: {}, path: '/' }];
  let at = 0;
  const browser = {
    get state() { return entries[at].state; },
    pushState(state: { id: string }, _title: string, path: string) {
      entries.splice(++at, entries.length, { state, path });
    },
    replaceState(state: { id: string }, _title: string, path: string) { entries[at] = { state, path }; },
  };
  const exports: Record<string, any> = {};
  runInNewContext(readFileSync(file, 'utf8'), {
    exports, require: createRequire(file), location: { hash: '' },
    window: { history: browser, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target) },
  });
  const memory = exports.createMemoryHistory();
  const home = { key: 'retained-home' };
  const pool = { key: 'retained-pool' };
  memory.replace({ path: '/', state: home });
  memory.push({ path: '/pool', state: pool });
  const unlisten = memory.listen(() => {
    const record = memory.get(memory.index);
    expect(record.path).toBe(entries[at].path);
    memory.replace({ path: record.path, state: record.state });
  });
  for (let i = 0; i < 3; i++) {
    at = 0;
    target.dispatchEvent(new Event('popstate'));
    expect(memory.get(0).state).toBe(home);
    at = 1;
    target.dispatchEvent(new Event('popstate'));
    expect(memory.get(1).state).toBe(pool);
  }
  at = 0;
  target.dispatchEvent(new Event('popstate'));
  memory.push({ path: '/explore', state: { key: 'explore' } });
  expect(memory.get(1).path).toBe('/explore');
  expect(memory.get(2)).toBeUndefined();
  unlisten();
});

test('managed panel URLs match saved route identity regardless of when the record was captured', () => {
  const source = readFileSync(require.resolve('expo-router/build/fork/useLinking'), 'utf8');
  const declaration = source.match(/const routePath = \(value\) => \{[\s\S]*?\n            \};/)?.[0];
  expect(declaration).toBeDefined();
  const normalize = runInNewContext(`${declaration}; routePath`, {
    uiEntry: true, URL, window: { location: { origin: 'https://app.test' } },
  });
  expect(normalize('/?panel=balances')).toBe(normalize('/'));
  expect(normalize('/?action=withdraw&panel=balances#receipt')).toBe('/?action=withdraw#receipt');
  expect(normalize('/?action=withdraw')).not.toBe(normalize('/?action=shield'));
  expect(normalize('/explore?panel=balances')).not.toBe(normalize('/?panel=balances'));
  const unmanaged = runInNewContext(`${declaration}; routePath`, { uiEntry: false });
  expect(unmanaged('/?panel=balances')).toBe('/?panel=balances');
});
