import { beforeEach, expect, test } from 'bun:test';
import { readBulkRegistry, resetBulkRegistriesForTests, sweepBulkRegistry, type RegistryEvent } from '../keystore-bulk-fallback';
const ks = `0x${'11'.repeat(20)}`;
const account = `0x${'22'.repeat(20)}`;
const value = `0x${'33'.repeat(32)}`;
const event = (kind: RegistryEvent['kind'], blockNumber = 0n, v = value): RegistryEvent => ({ kind, account, value: v, blockNumber, logIndex: 0 });
beforeEach(resetBulkRegistriesForTests);
test('a partial sweep cannot turn absence into unregistered, and resumes configured ranges only', async () => {
  const ranges: bigint[][] = [];
  const reads = { head: async () => 9n, blockHash: async () => 'canonical', events: async (from: bigint, to: bigint) => { ranges.push([from, to]); return from === 0n ? [event('auth')] : []; } };
  expect(await sweepBulkRegistry(1, ks, 0n, 1n, reads)).toBe(false);
  expect(readBulkRegistry(1, ks)).toBeNull();
  expect(await sweepBulkRegistry(1, ks, 0n, 1n, reads)).toBe(true);
  expect(ranges).toEqual(Array.from({ length: 10 }, (_, i) => [BigInt(i), BigInt(i)]));
  expect(readBulkRegistry(1, ks)?.hashes[account]).toBe(value);
  expect(readBulkRegistry(2, ks)).toBeNull();
  expect(readBulkRegistry(1, `0x${'44'.repeat(20)}`)).toBeNull();
  expect(readBulkRegistry(1, ks, Date.now() + 12 * 60_000)).toBeNull();
});
test('full sweeps rebuild viewing-key rotations and deletions in chain order', async () => {
  await sweepBulkRegistry(1, ks, 0n, 100n, { head: async () => 10n, blockHash: async () => 'same', events: async () => [event('viewing', 8n, `0x${'00'.repeat(32)}`), event('viewing', 2n), event('auth', 1n)] });
  expect(readBulkRegistry(1, ks)?.viewing).toEqual({});
  expect(readBulkRegistry(1, ks)?.hashes[account]).toBe(value);
});
test('a reorg or malformed/incomplete RPC result invalidates the entire fallback', async () => {
  let hash = 0;
  await expect(sweepBulkRegistry(1, ks, 0n, 100n, { head: async () => 10n, blockHash: async () => String(hash++), events: async () => [event('auth')] })).rejects.toThrow('reorganized');
  expect(readBulkRegistry(1, ks)).toBeNull();
  await expect(sweepBulkRegistry(1, ks, 0n, 100n, { head: async () => 10n, blockHash: async () => 'same', events: async () => [{ ...event('auth'), account: 'bad' }] })).rejects.toThrow('Malformed');
  expect(readBulkRegistry(1, ks)).toBeNull();
});
test('refresh replays the aligned public tail from its baseline without reviving an old viewing key', async () => {
  const ranges: bigint[][] = [];
  let head = 25_050n;
  const reads = { head: async () => head, blockHash: async () => 'same', events: async (from: bigint, to: bigint) => {
    ranges.push([from, to]);
    return [event('auth', 100n), event('viewing', 20_001n), event('viewing', 25_049n, `0x${'00'.repeat(32)}`)].filter(e => e.blockNumber >= from && e.blockNumber <= to);
  } };
  expect(await sweepBulkRegistry(1, ks, 0n, 100_000n, reads)).toBe(true);
  expect(readBulkRegistry(1, ks)?.viewing).toEqual({});
  ranges.length = 0; head = 25_100n;
  expect(await sweepBulkRegistry(1, ks, 0n, 100_000n, reads)).toBe(true);
  expect(ranges).toEqual([[20_000n, head]]);
  expect(readBulkRegistry(1, ks)?.hashes[account]).toBe(value);
  expect(readBulkRegistry(1, ks)?.viewing).toEqual({});
});
