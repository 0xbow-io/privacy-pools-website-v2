import { describe, expect, test } from 'bun:test';
import { canonicalAddress, roundToDay, type Contact } from '../address-book-core';
import { buildRecipientIndex, rankRecipientSuggestions, type PayoutRecord } from '../recipient-suggestions';

const A = '0x71c2000000000000000000000000000000009fa3';
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const SUI = '0x' + 'a1'.repeat(32);
const STELLAR = 'G' + 'A'.repeat(55);
const STELLAR2 = 'G' + 'B'.repeat(55);
const noYield = () => Promise.resolve();
const disp = (a: string) => canonicalAddress(a)!.display;

describe('recipient index', () => {
  test('dedupes by address, latest use wins, skips junk', async () => {
    const withdrawals: PayoutRecord[] = [
      { address: A, timestamp: 10 },
      { address: A.toUpperCase().replace('0X', '0x'), timestamp: 30 },
      { address: B, timestamp: 20 },
      { address: 'not-an-address', timestamp: 99 },
      { address: undefined as unknown as string, timestamp: 1 },
    ];
    const sends: PayoutRecord[] = [{ address: A, timestamp: 25 }, { address: STELLAR, timestamp: 5 }];
    const index = await buildRecipientIndex([withdrawals, sends], { yieldFn: noYield });
    expect(index!.size).toBe(3);
    expect(index!.get(A)!.lastUsedAt).toBe(30);
    expect(index!.get(STELLAR)!.format).toBe('stellar');
  });

  test('a huge record set is processed in bounded chunks with a yield between each', async () => {
    const N = 120_000;
    const big: PayoutRecord[] = Array.from({ length: N }, (_, i) => ({ address: `0x${(i % 3000).toString(16).padStart(40, '0')}`, timestamp: i }));
    let yields = 0;
    let since = 0;
    let maxBetweenYields = 0;
    const partials: number[] = [];
    let processedBeforeFirstYield = -1;
    const index = await buildRecipientIndex([big], {
      chunkSize: 500,
      onPartial: (idx) => { partials.push(idx.size); since++; },
      yieldFn: async () => {
        if (processedBeforeFirstYield < 0) processedBeforeFirstYield = partials[0];
        yields++;
        maxBetweenYields = Math.max(maxBetweenYields, since);
        since = 0;
      },
    });
    expect(yields).toBe(N / 500);
    // Exactly one chunk of work between consecutive yields: the thread is
    // handed back at least every 500 records.
    expect(maxBetweenYields).toBe(1);
    // The first partial result is published after the FIRST chunk, before
    // the rest is read: the field can render rows while the index grows.
    expect(processedBeforeFirstYield).toBe(500);
    expect(partials.length).toBe(N / 500);
    expect(index!.size).toBe(3000);
  });

  test('a cancelled build stops at the next chunk and returns null', async () => {
    let chunks = 0;
    const big: PayoutRecord[] = Array.from({ length: 5000 }, (_, i) => ({ address: B, timestamp: i }));
    const r = await buildRecipientIndex([big], { chunkSize: 100, yieldFn: noYield, onPartial: () => { chunks++; }, isCancelled: () => chunks >= 3 });
    expect(r).toBeNull();
    expect(chunks).toBe(3);
  });

  test('the default yield goes through the host (not a synchronous loop)', async () => {
    let afterFirstTick = false;
    setTimeout(() => { afterFirstTick = true; }, 0);
    const big: PayoutRecord[] = Array.from({ length: 1000 }, () => ({ address: B, timestamp: 1 }));
    let sawTick = false;
    await buildRecipientIndex([big], { chunkSize: 250, onPartial: () => { if (afterFirstTick) sawTick = true; } });
    expect(sawTick).toBe(true);
  });
});

describe('ranking', () => {
  const day = roundToDay(Date.UTC(2026, 0, 1));
  const contacts: Contact[] = [
    { address: disp(B), name: 'Bob', createdAt: day, updatedAt: day },
    { address: disp(C), name: 'Carol', createdAt: day, updatedAt: day },
    { address: STELLAR2, name: 'Stella', createdAt: day, updatedAt: day },
  ];
  const build = () => buildRecipientIndex([[{ address: A, timestamp: day + 2000 }, { address: B, timestamp: day + 1000 }, { address: SUI, timestamp: day + 500 }, { address: STELLAR, timestamp: day + 3000 }]], { yieldFn: noYield });

  test('most recent first, saved names attached, contacts without payouts included', async () => {
    const rows = rankRecipientSuggestions(await build(), contacts, { formats: ['evm'], query: '' });
    expect(rows.map((r) => r.address)).toEqual([disp(A), disp(B), disp(C)]);
    expect(rows.map((r) => r.name)).toEqual([null, 'Bob', 'Carol']);
  });

  test('only the formats the field accepts', async () => {
    const idx = await build();
    expect(rankRecipientSuggestions(idx, contacts, { formats: ['stellar'], query: '' }).map((r) => r.address)).toEqual([STELLAR, STELLAR2]);
    expect(rankRecipientSuggestions(idx, contacts, { formats: ['sui'], query: '' }).map((r) => r.address)).toEqual([SUI]);
  });

  test('filters by name or address as the user types', async () => {
    const idx = await build();
    expect(rankRecipientSuggestions(idx, contacts, { formats: ['evm'], query: 'car' }).map((r) => r.name)).toEqual(['Carol']);
    expect(rankRecipientSuggestions(idx, contacts, { formats: ['evm'], query: '0x71C2' }).map((r) => r.address)).toEqual([disp(A)]);
    expect(rankRecipientSuggestions(idx, contacts, { formats: ['evm'], query: 'zzz' })).toEqual([]);
  });

  test('a field holding a known address shows nothing; excluded addresses never show', async () => {
    const idx = await build();
    expect(rankRecipientSuggestions(idx, contacts, { formats: ['evm'], query: A.toUpperCase().replace('0X', '0x') })).toEqual([]);
    expect(rankRecipientSuggestions(idx, contacts, { formats: ['evm'], query: '', exclude: [A] }).map((r) => r.address)).toEqual([disp(B), disp(C)]);
  });

  test('renders with no index yet (cold start): contacts only', () => {
    expect(rankRecipientSuggestions(null, contacts, { formats: ['evm'], query: '' }).map((r) => r.name)).toEqual(['Bob', 'Carol']);
  });

  test('bounded row count', async () => {
    const many = await buildRecipientIndex([Array.from({ length: 50 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}`, timestamp: i }))], { yieldFn: noYield });
    expect(rankRecipientSuggestions(many, [], { formats: ['evm'], query: '' })).toHaveLength(8);
  });
});
