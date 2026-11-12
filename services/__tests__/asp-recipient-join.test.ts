// asp-v2#165 (optional dependency): the ASP names a relayed withdrawal's
// recipient on snapshot transact rows and feed withdrawal rows. ppv2 joins it
// in memory with the user's OWN spends only, and falls back silently when the
// field is absent (ASP not deployed), null or malformed.
//
// Fixtures: real prod snapshot rows (pre-#165, no field) and real prod feed
// withdrawal rows, plus the recipient values the #165 producer specs emit.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconstructUserSpends } from '@/services/outgoing-transfers';
import { recipientsFromOwnSpends } from '@/services/recipient-suggestions';
import type { SnapshotTransact } from '@/services/api-types';
import type { Hex, Secret } from '@/services/sdk-types';

const root = join(new URL('.', import.meta.url).pathname, '..', '..');
const fixture = JSON.parse(readFileSync(join(root, 'services/__tests__/fixtures/asp-snapshot-transacts-2026-10-28.json'), 'utf8')) as {
  transacts: SnapshotTransact[];
  producer165: { snapshotRecipients: (string | null)[]; feedRecipient: string };
};
const feed = JSON.parse(readFileSync(join(root, 'services/__tests__/fixtures/prod-feed-withdrawals-2026-10-28.json'), 'utf8')) as {
  events: { type: string; address: string; txHash: string; timestamp: number; asset: { chainId: number } }[];
};
const [RECIPIENT_A, RECIPIENT_B] = fixture.producer165.snapshotRecipients as string[];
const PAYEE = fixture.producer165.feedRecipient;
const evmOnly = () => ['evm'] as const;

// The same deterministic hash stand-in the outgoing-transfers tests use.
const fakeHashService = { hash: (inputs: Hex[]): Hex => `0x${(BigInt(inputs[0]) * 1_000_003n + BigInt(inputs[1])).toString(16)}` as Hex };
const KEY = '0x0abc' as Secret;
const nullifierOf = (c: string) => `0x${BigInt(fakeHashService.hash([KEY, c as Hex])).toString(16).padStart(64, '0')}`;

/** A real prod row, re-pointed at a note of ours, optionally with a #165 recipient. */
function ownRow(i: number, commitment: string, recipient?: string | null): SnapshotTransact & { chainId: number } {
  const base = fixture.transacts[i];
  const row = { ...base, nullifierHashes: [nullifierOf(commitment)], outputCommitments: [], chainId: 1 } as SnapshotTransact & { chainId: number };
  if (recipient !== undefined) row.recipient = recipient;
  return row;
}
const note = (commitment: string, value: bigint) => ({ commitment: commitment as Hex, value: `0x${value.toString(16)}` as Hex, tokenId: fixture.transacts[0].asset as Hex, label: '0xaa' as Hex, txHash: '0xdeposit' as Hex });

describe('snapshot rows: the recipient rides on MY spend only', () => {
  test('pre-#165 real rows (no field): spends classify as before and name no recipient', () => {
    const spends = reconstructUserSpends([note('0x01', 10n ** 18n)], [ownRow(0, '0x01')], KEY, fakeHashService);
    expect(spends).toHaveLength(1);
    expect(spends[0].kind).toBe('withdrawal');
    expect(spends[0].recipients).toBeUndefined();
    expect(recipientsFromOwnSpends({ spends })).toEqual([]);
  });

  test('a #165 recipient on my log is taken; null and malformed are ignored', () => {
    const spends = reconstructUserSpends(
      [note('0x01', 10n ** 18n), note('0x02', 10n ** 18n), note('0x03', 10n ** 18n)],
      [ownRow(0, '0x01', RECIPIENT_A), ownRow(1, '0x02', null), ownRow(2, '0x03', 'not-an-address')],
      KEY,
      fakeHashService,
    );
    const got = recipientsFromOwnSpends({ spends, formatsFor: evmOnly });
    expect(got.map((r) => r.address)).toEqual([RECIPIENT_A]);
    expect(got[0].timestamp).toBe(Date.parse(fixture.transacts[0].blockTimestamp));
  });

  test("a batch tx: another user's log under the same hash never leaks in", () => {
    const mine = ownRow(0, '0x01', RECIPIENT_A);
    const theirs = { ...fixture.transacts[0], logIndex: fixture.transacts[0].logIndex + 1, nullifierHashes: ['0x' + '9'.repeat(64)], outputCommitments: [], recipient: RECIPIENT_B, chainId: 1 };
    const spends = reconstructUserSpends([note('0x01', 10n ** 18n)], [mine, theirs], KEY, fakeHashService);
    expect(spends[0].recipients).toEqual([RECIPIENT_A]);
  });

  test('several Relayed logs of MINE in one tx: every recipient, once', () => {
    const a = ownRow(0, '0x01', RECIPIENT_A);
    const b = { ...ownRow(0, '0x02', RECIPIENT_B), logIndex: a.logIndex + 1 };
    const c = { ...ownRow(0, '0x03', RECIPIENT_A), logIndex: a.logIndex + 2 };
    const spends = reconstructUserSpends([note('0x01', 10n ** 18n), note('0x02', 10n ** 18n), note('0x03', 10n ** 18n)], [a, b, c], KEY, fakeHashService);
    expect(spends).toHaveLength(1);
    expect([...(spends[0].recipients ?? [])].sort()).toEqual([RECIPIENT_A, RECIPIENT_B].sort());
  });

  test('a transfer (not a withdrawal) never names a recipient here', () => {
    expect(recipientsFromOwnSpends({ spends: [{ txHash: '0x1', chainId: 1, kind: 'transfer', recipients: [RECIPIENT_A] }] })).toEqual([]);
  });
});

describe('feed rows: joined by my own spend hash, real prod rows', () => {
  const asRows = (recipient?: unknown) => feed.events.map((e) => ({ type: 'Withdrawal', txHash: e.txHash, chainId: e.asset.chainId, timestamp: e.timestamp * 1000, ...(recipient === undefined ? {} : { recipient }) }));
  const myHash = feed.events[0].txHash;
  const mySpend = [{ txHash: myHash.toUpperCase().replace('0X', '0x'), chainId: feed.events[0].asset.chainId, kind: 'withdrawal' }];

  test('pre-#165 rows (no field) give nothing, silently', () => {
    expect(recipientsFromOwnSpends({ spends: mySpend, feedRows: asRows() })).toEqual([]);
    expect(recipientsFromOwnSpends({ spends: mySpend, feedRows: asRows(null) })).toEqual([]);
    expect(recipientsFromOwnSpends({ spends: mySpend, feedRows: asRows(42) })).toEqual([]);
  });

  test("a #165 row is taken only for MY hash (case-normalized), never another user's row", () => {
    const rows = asRows(PAYEE);
    const got = recipientsFromOwnSpends({ spends: mySpend, feedRows: rows, formatsFor: evmOnly });
    expect(got.map((r) => r.address)).toEqual([PAYEE]);
    expect(recipientsFromOwnSpends({ spends: [], feedRows: rows })).toEqual([]);
  });

  test('two feed Withdrawal rows under one hash (a batch) are not attributed', () => {
    const rows = asRows(PAYEE);
    const dup = [...rows, { ...rows[0], recipient: RECIPIENT_B }];
    expect(recipientsFromOwnSpends({ spends: mySpend, feedRows: dup })).toEqual([]);
  });

  test('a recipient not valid on that chain is dropped', () => {
    expect(recipientsFromOwnSpends({ spends: mySpend, feedRows: asRows('G' + 'A'.repeat(55)), formatsFor: evmOnly })).toEqual([]);
  });
});

describe('wiring', () => {
  const src = (p: string) => readFileSync(join(root, p), 'utf8');
  test('optional on the wire types, plumbed through the provider and into the hook, never into debug captures', () => {
    expect(src('services/api-types.ts')).toMatch(/recipient\?: string \| null;/);
    expect(src('components/pools-provider.tsx')).toContain("...(typeof event.recipient === 'string' && event.recipient ? { recipient: event.recipient } : {}),");
    expect(src('components/pools-provider.tsx')).toContain('recipientsFromOwnSpends({ spends: userSpends.list, feedRows: transactions, formatsFor: recipientFormatsFor })');
    expect(src('hooks/use-contacts.ts')).toContain('...(data.ownPayoutRecipients ?? [])');
    expect(src('services/swap-rows.ts')).toContain('recipients: _recipients');
  });
});
