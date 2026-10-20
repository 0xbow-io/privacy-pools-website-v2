// The Freighter watcher: an empty, failed or slow read must never sign the user out
// (freighter-api resolves a 2 s timeout as an empty key); only a revoked site does, and an
// account that reads again is picked back up.

import { describe, expect, test } from 'bun:test';

import { watchFreighter } from '@/services/stellar/freighter-watch';

const A = `G${'A'.repeat(55)}`;
const B = `G${'B'.repeat(55)}`;
const TESTNET = 'Test SDF Network ; September 2015';
const PUBNET = 'Public Global Stellar Network ; September 2015';

type Read = { address: string; error?: { message: string } } | 'hang';

function fakeFreighter(reads: Read[], opts: { allowed?: boolean[]; passphrases?: string[] } = {}) {
  let i = 0;
  let a = 0;
  let p = 0;
  const api = {
    getAddress: () => {
      const read = reads[Math.min(i++, reads.length - 1)];
      return read === 'hang' ? new Promise<never>(() => {}) : Promise.resolve(read);
    },
    getNetworkDetails: () => {
      const list = opts.passphrases ?? [TESTNET];
      const networkPassphrase = list[Math.min(p++, list.length - 1)];
      return Promise.resolve({ network: '', networkUrl: '', networkPassphrase });
    },
    isAllowed: () => {
      const list = opts.allowed ?? [true];
      return Promise.resolve({ isAllowed: list[Math.min(a++, list.length - 1)] });
    },
  };
  return { api: api as never, reads: () => i };
}

function run(reads: Read[], start: { address: string | null; passphrase: string | null }, opts?: Parameters<typeof fakeFreighter>[1]) {
  const fake = fakeFreighter(reads, opts);
  const events: string[] = [];
  const watcher = watchFreighter(fake.api, start, {
    change: ({ address, passphrase }) => events.push(`change:${address.slice(0, 2)}:${passphrase === PUBNET ? 'pub' : 'test'}`),
    revoked: () => events.push('revoked'),
  }, 2, 15);
  return { events, watcher, fake };
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe('watchFreighter', () => {
  test('an empty read (locked, or the 2 s timeout) while the site is allowed changes nothing', async () => {
    const { events, watcher, fake } = run([{ address: '' }], { address: A, passphrase: TESTNET });
    await settle();
    watcher.stop();
    expect(fake.reads()).toBeGreaterThan(3);
    expect(events).toEqual([]);
  });

  test('a failed read changes nothing, and the next good read is not a change', async () => {
    const { events, watcher } = run([{ address: '', error: { message: 'boom' } }, { address: A }], { address: A, passphrase: TESTNET });
    await settle();
    watcher.stop();
    expect(events).toEqual([]);
  });

  test('a read that never answers does not stall the loop', async () => {
    const { events, watcher, fake } = run(['hang', { address: B }], { address: A, passphrase: TESTNET });
    await settle();
    watcher.stop();
    expect(fake.reads()).toBeGreaterThan(2);
    expect(events).toEqual(['change:GB:test']);
  });

  test('reports an account switch and a network switch, once each', async () => {
    const { events, watcher } = run([{ address: A }, { address: B }], { address: A, passphrase: TESTNET }, { passphrases: [TESTNET, TESTNET, PUBNET] });
    await settle();
    watcher.stop();
    expect(events).toEqual(['change:GB:test', 'change:GB:pub']);
  });

  test('a site Freighter no longer allows is revoked once, and picked up again when it reads', async () => {
    const { events, watcher } = run([{ address: '' }, { address: '' }, { address: A }], { address: A, passphrase: TESTNET }, { allowed: [false] });
    await settle();
    watcher.stop();
    expect(events).toEqual(['revoked', 'change:GA:test']);
  });

  test('a silent reconnect that read nothing yet adopts the account once it reads', async () => {
    const { events, watcher } = run([{ address: '' }, { address: '' }, { address: A }], { address: null, passphrase: null });
    await settle();
    watcher.stop();
    expect(events).toEqual(['change:GA:test']);
  });

  test('stop() ends it', async () => {
    const { events, watcher, fake } = run([{ address: B }], { address: A, passphrase: TESTNET });
    watcher.stop();
    await settle();
    expect(fake.reads()).toBe(0);
    expect(events).toEqual([]);
  });
});
