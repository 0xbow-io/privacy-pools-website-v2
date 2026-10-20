import { describe, expect, test } from 'bun:test';

import type { GlobalEvent, SnapshotDeposit, SnapshotRagequit } from '@/services/api-types';
import { buildOwnHistoryEvents, ownDepositReviewStatus } from '@/services/own-history-rows';

const SEPOLIA = 11155111;
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ME = '0x20c09bad97c8b6772aa3902e7b4004c2b910a6ed';
const STRANGER = '0x2222222222222222222222222222222222222222';
const EXECUTOR = '0x3333333333333333333333333333333333333333';

// One deposit and one ragequit as the dev ASP served them on 2026-10-07, from
// both sources: the public events feed and the Sepolia event snapshot. The
// snapshot row has to reproduce what the feed said about the same operation.
const FEED_DEPOSIT: GlobalEvent = {
  type: 'deposit',
  eventId: 342308,
  createdAt: '2026-10-07T19:39:55.051Z',
  amount: '1000000000000000',
  address: ME,
  txHash: '0x997c06321fb24336656d78308b54dc3c4efede056c17f0511dc75f15a264d16f',
  timestamp: 1791401988000,
  reviewStatus: 'approved',
  asset: { asset: ETH, chainId: SEPOLIA, chainName: 'Chain 11155111', tokenSymbol: ETH, tokenAddress: ETH, assetAddress: ETH, denomination: 18 },
};
const SNAPSHOT_DEPOSIT: SnapshotDeposit & { chainId: number } = {
  txHash: '0x997c06321fb24336656d78308b54dc3c4efede056c17f0511dc75f15a264d16f',
  logIndex: 171,
  depositAddress: ME,
  outputCommitment: '8286358398627273009367582677847902479573893523925900114120148392344273691238',
  depositedValue: '1000000000000000',
  fee: '0',
  blockNumber: '11865131',
  blockTimestamp: '2026-10-07T19:39:48.000Z',
  asset: ETH,
  chainId: SEPOLIA,
};
const FEED_RAGEQUIT = {
  type: 'ragequit' as const,
  amount: '1000000000000000',
  address: ME,
  txHash: '0x99f3023381',
  timestamp: 1791402060000,
  label: '7572105567460929232306977467547182810807225831564806684110367428892326874174',
};
const SNAPSHOT_RAGEQUIT: SnapshotRagequit & { chainId: number } = {
  txHash: '0x99f3023381',
  logIndex: 9,
  ragequitter: ME,
  withdrawnValue: '1000000000000000',
  commitment: '82863583986272730093',
  nullifierHash: '1',
  label: '7572105567460929232306977467547182810807225831564806684110367428892326874174',
  blockNumber: '11865137',
  blockTimestamp: '2026-10-07T19:41:00.000Z',
  asset: ETH,
  chainId: SEPOLIA,
};

function build(over: Partial<Parameters<typeof buildOwnHistoryEvents>[0]> = {}) {
  return buildOwnHistoryEvents({
    deposits: [SNAPSHOT_DEPOSIT],
    ragequits: [SNAPSHOT_RAGEQUIT],
    activityAddress: ME,
    ownedCommitments: [],
    chainName: () => 'Sepolia',
    ...over,
  });
}

describe('own history rows from the event snapshot', () => {
  test('a deposit row carries what the feed row did for the same operation', () => {
    const [row] = build({ ragequits: [] });
    expect(row.type).toBe(FEED_DEPOSIT.type);
    expect(row.amount).toBe(FEED_DEPOSIT.amount);
    expect(row.address).toBe(FEED_DEPOSIT.address);
    expect(row.txHash).toBe(FEED_DEPOSIT.txHash);
    expect(row.timestamp).toBe(FEED_DEPOSIT.timestamp);
    expect(row.asset.chainId).toBe(FEED_DEPOSIT.asset.chainId);
    expect(row.asset.tokenAddress).toBe(FEED_DEPOSIT.asset.tokenAddress);
    // No verdict claimed: the provider derives it from the matched note.
    expect(row.reviewStatus).toBeUndefined();
    expect(row.commitment).toBe(SNAPSHOT_DEPOSIT.outputCommitment);
    expect(String(row.eventId)).not.toBe(String(FEED_DEPOSIT.eventId));
  });

  test('a ragequit row carries what the feed row did, label included', () => {
    const [row] = build({ deposits: [] });
    expect(row.type).toBe(FEED_RAGEQUIT.type);
    expect(row.amount).toBe(FEED_RAGEQUIT.amount);
    expect(row.address).toBe(FEED_RAGEQUIT.address);
    expect(row.txHash).toBe(FEED_RAGEQUIT.txHash);
    expect(row.timestamp).toBe(FEED_RAGEQUIT.timestamp);
    expect(row.label).toBe(FEED_RAGEQUIT.label);
  });

  test('a stranger\'s operations are not mine', () => {
    expect(build({ activityAddress: STRANGER })).toEqual([]);
    expect(build({ activityAddress: null })).toEqual([]);
  });

  test('the activity address matches in any case', () => {
    expect(build({ activityAddress: ME.toUpperCase().replace('0X', '0x') })).toHaveLength(2);
  });

  test('an owned commitment claims a deposit someone else submitted, in either encoding', () => {
    const bridged = { ...SNAPSHOT_DEPOSIT, depositAddress: EXECUTOR };
    const hex = `0x${BigInt(bridged.outputCommitment).toString(16)}`;
    for (const owned of [bridged.outputCommitment, hex, hex.toUpperCase().replace('0X', '0x')]) {
      const rows = build({ deposits: [bridged], ragequits: [], activityAddress: STRANGER, ownedCommitments: [owned] });
      expect(rows).toHaveLength(1);
      expect(rows[0].address).toBe(EXECUTOR);
    }
  });

  test('an owned commitment claims its ragequit whoever sent it', () => {
    const rows = build({ deposits: [], ragequits: [{ ...SNAPSHOT_RAGEQUIT, ragequitter: STRANGER }], activityAddress: null, ownedCommitments: [SNAPSHOT_RAGEQUIT.commitment] });
    expect(rows).toHaveLength(1);
  });

  test('the legs of a batch deposit stay distinct rows', () => {
    const legs = [0, 1, 2].map((i) => ({ ...SNAPSHOT_DEPOSIT, logIndex: 171 + i, outputCommitment: String(1000 + i) }));
    const rows = build({ deposits: legs, ragequits: [] });
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(3);
  });
});

describe('the review verdict of an own snapshot deposit', () => {
  const LABEL_DEC = '7572105567460929232306977467547182810807225831564806684110367428892326874174';
  const LABEL_HEX = `0x${BigInt(LABEL_DEC).toString(16).padStart(64, '0')}`;
  const none = { rejected: new Set<string>(), poiRequired: new Set<string>() };
  const verdict = (over: Partial<Parameters<typeof ownDepositReviewStatus>[0]>) => ownDepositReviewStatus({
    label: LABEL_DEC,
    noteStatus: 'ACTIVE',
    decisions: none,
    leafConfirmed: null,
    ...over,
  });

  test('published decisions win over everything else, whichever encoding the label has', () => {
    for (const label of [LABEL_DEC, LABEL_HEX]) {
      expect(verdict({ label, leafConfirmed: true, decisions: { ...none, rejected: new Set([LABEL_HEX]) } })).toBe('declined');
      expect(verdict({ label, leafConfirmed: true, decisions: { ...none, poiRequired: new Set([LABEL_HEX]) } })).toBe('poi_required');
    }
  });

  test('the session gate decides an ACTIVE note it has judged, as the balance does', () => {
    expect(verdict({ leafConfirmed: true })).toBe('approved');
    expect(verdict({ leafConfirmed: false })).toBe('pending');
  });

  test('without a gate, the note status the last sync set decides', () => {
    expect(verdict({ noteStatus: 'ACTIVE' })).toBe('approved');
    expect(verdict({ noteStatus: 'REJECTED' })).toBe('declined');
    expect(verdict({ noteStatus: 'PENDING' })).toBe('pending');
    expect(verdict({ noteStatus: 'SPENT' })).toBe('approved');
  });

  test('an exited note has no verdict, unless the pool published one', () => {
    expect(verdict({ noteStatus: 'EXITED' })).toBeNull();
    expect(verdict({ noteStatus: 'EXIT_PENDING' })).toBeNull();
    expect(verdict({ noteStatus: 'EXITED', decisions: { ...none, rejected: new Set([LABEL_HEX]) } })).toBe('declined');
  });

  test('unknown decisions or no label fall through to the local evidence', () => {
    expect(verdict({ decisions: null, noteStatus: 'REJECTED' })).toBe('declined');
    expect(verdict({ label: null, noteStatus: 'PENDING' })).toBe('pending');
  });
});
