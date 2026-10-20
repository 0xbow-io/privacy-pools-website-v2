import { describe, expect, test } from 'bun:test';

import type { GlobalEvent } from '@/services/api-types';
import {
  MAX_PENDING_OWN_ROWS,
  PENDING_OWN_ROW_MAX_AGE_MS,
  buildOptimisticDepositEvent,
  expiredPendingOwnRows,
  feedRowKey,
  operationKey,
  pendingDepositRow,
  reconcileFeedRows,
  removePendingOwnRowFrom,
  upsertPendingOwnRow,
  withoutPendingOwnRows,
  type PendingOwnRow,
} from '@/services/feed-reconciliation';
import {
  addPendingOwnRow,
  prunePendingOwnRows,
  readPendingOwnRows,
  removePendingOwnRow,
  resetPendingOwnRowsForTests,
  subscribePendingOwnRows,
} from '@/services/pending-own-rows-store';

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const ME = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const NOW = 1_758_450_000_000;

// Our side comes from the REAL producer the deposit flow uses.
function ours(n: number, overrides: Partial<Parameters<typeof pendingDepositRow>[0]> = {}) {
  return pendingDepositRow({
    chainId: 11155111,
    chainName: 'Sepolia',
    address: ME,
    txHash: H(n),
    amountRaw: '1000000000000000000',
    tokenAddress: ETH,
    tokenSymbol: 'ETH',
    denomination: 18,
    now: NOW,
    ...overrides,
  });
}

// The ASP's side has no producer in this repo; this mirrors GlobalEvent as
// services/api-types.ts declares it, with the ASP's own eventId.
function aspRow(eventId: number, n: number, overrides: Partial<GlobalEvent> = {}): GlobalEvent {
  return {
    type: 'deposit',
    eventId,
    createdAt: new Date(NOW + 5_000).toISOString(),
    amount: '1000000000000000000',
    address: ME,
    txHash: H(n),
    timestamp: NOW + 5_000,
    reviewStatus: 'pending',
    asset: {
      asset: ETH,
      chainId: 11155111,
      chainName: 'Sepolia',
      tokenSymbol: 'ETH',
      tokenAddress: ETH,
      assetAddress: ETH,
      denomination: 18,
    },
    ...overrides,
  };
}

const VISIBLE = new Set([11155111, 1]);

function reconcile(input: Partial<Parameters<typeof reconcileFeedRows<GlobalEvent>>[0]>) {
  return reconcileFeedRows<GlobalEvent>({
    publicRows: [],
    ownRows: [],
    visibleChainIds: VISIBLE,
    pendingOwn: [],
    now: NOW + 10_000,
    ...input,
  });
}

/** Every row the list would show, as operation keys, with multiplicity. */
function shown(result: ReturnType<typeof reconcile>): string[] {
  return [...result.pendingRows, ...result.publicRows, ...result.ownRows]
    .map((r) => operationKey(r.asset.chainId, r.txHash, r.type)!)
    .sort();
}

describe('feed reconciliation: our own operation is counted exactly once', () => {
  test('still in flight and absent from every feed, our deposit shows once, as ours', () => {
    for (const [n, amount] of [[1, '1000000000000000000'], [2, '2500000']] as const) {
      const pending = ours(n, { amountRaw: amount, tokenAddress: n === 2 ? USDC : ETH, tokenSymbol: n === 2 ? 'USDC' : 'ETH', denomination: n === 2 ? 6 : 18 });
      const result = reconcile({ publicRows: [aspRow(900, 77, { address: STRANGER })], pendingOwn: [pending] });
      expect(result.pendingRows).toEqual([pending.row]);
      expect(result.settled).toEqual([]);
      expect(shown(result).filter((k) => k.includes(H(n)))).toHaveLength(1);
    }
  });

  test('once the public feed carries it, our deposit shows once, as the feed row, and the ledger entry is settled', () => {
    for (const n of [3, 4]) {
      const pending = ours(n);
      const result = reconcile({ publicRows: [aspRow(1000 + n, n)], pendingOwn: [pending] });
      expect(result.pendingRows).toEqual([]);
      expect(result.settled).toEqual([pending]);
      expect(shown(result)).toEqual([operationKey(11155111, H(n), 'deposit')]);
    }
  });

  test('our own history row alone is enough to settle it: it need not be in the public window', () => {
    // The double count the pause hid: a second source delivered the deposit
    // under a different eventId while the optimistic row (a synthetic eventId)
    // still sat in the public cache, and an eventId dedupe kept both.
    for (const n of [5, 6]) {
      const pending = ours(n);
      const result = reconcile({ ownRows: [aspRow(2000 + n, n)], pendingOwn: [pending] });
      expect(result.pendingRows).toEqual([]);
      expect(result.ownRows).toHaveLength(1);
      expect(result.settled).toEqual([pending]);
      expect(shown(result)).toHaveLength(1);
    }
  });

  test('a stranger\'s deposit that looks identical (amount, token, chain, time) is still counted: only the hash decides', () => {
    for (const n of [7, 8]) {
      const pending = ours(n);
      const twin = aspRow(3000 + n, 500 + n, { address: STRANGER, timestamp: NOW, amount: pending.row.amount });
      const result = reconcile({ publicRows: [twin], pendingOwn: [pending] });
      expect(result.pendingRows).toEqual([pending.row]);
      expect(result.publicRows).toEqual([twin]);
      expect(shown(result)).toHaveLength(2);
    }
  });

  test('the same hash on another chain is a different operation', () => {
    const pending = ours(9);
    const onMainnet = aspRow(4009, 9, { asset: { ...aspRow(0, 9).asset, chainId: 1, chainName: 'Ethereum' } });
    const result = reconcile({ publicRows: [onMainnet], pendingOwn: [pending] });
    expect(result.pendingRows).toEqual([pending.row]);
    expect(result.settled).toEqual([]);
    expect(shown(result)).toHaveLength(2);
  });

  test('a reshield: the Withdrawal row of the same tx does not shadow our pending Deposit', () => {
    for (const n of [10, 11]) {
      const pending = ours(n);
      const withdrawal = aspRow(5000 + n, n, { type: 'withdrawal', address: STRANGER, amount: '1200000000000000' });
      const result = reconcile({ publicRows: [withdrawal], pendingOwn: [pending] });
      expect(result.pendingRows).toEqual([pending.row]);
      expect(shown(result)).toEqual([
        operationKey(11155111, H(n), 'deposit'),
        operationKey(11155111, H(n), 'withdrawal'),
      ].sort());
    }
  });
});

describe('feed reconciliation: feed rows arriving twice, late, or in either source', () => {
  test('the same event in both sources is one row; the same event twice in one source is one row', () => {
    for (const n of [12, 13]) {
      const row = aspRow(6000 + n, n);
      const both = reconcile({ publicRows: [row], ownRows: [{ ...row }] });
      expect(both.publicRows).toHaveLength(1);
      expect(both.ownRows).toHaveLength(0);
      const twice = reconcile({ publicRows: [row, { ...row }] });
      expect(twice.publicRows).toHaveLength(1);
      const twiceOwn = reconcile({ ownRows: [row, { ...row }] });
      expect(twiceOwn.ownRows).toHaveLength(1);
    }
  });

  test('an own row yields to the public row for its operation, whatever the ids', () => {
    // Own rows come from the snapshot and carry local ids; inside the window
    // the ASP's row, with its review verdict, is the one shown.
    const row = aspRow(6100, 21);
    const result = reconcile({ publicRows: [row], ownRows: [{ ...row, eventId: 999_999 }] });
    expect(result.publicRows).toEqual([row]);
    expect(result.ownRows).toEqual([]);
  });

  test('a public row takes the commitment of the own row it covers, and keeps its ASP verdict', () => {
    const own = { ...aspRow(7301, 24), eventId: 0, commitment: '0xc0' } as GlobalEvent & { commitment?: string };
    const result = reconcile({ publicRows: [aspRow(9300, 24, { reviewStatus: 'approved' })], ownRows: [own] });
    expect(result.ownRows).toEqual([]);
    expect(result.publicRows).toHaveLength(1);
    expect(result.publicRows[0]).toMatchObject({ eventId: 9300, commitment: '0xc0', reviewStatus: 'approved' });
  });

  test('a batch the window cuts through keeps the legs the window lost', () => {
    const legs = [aspRow(7201, 23, { amount: '1' }), aspRow(7202, 23, { amount: '2' }), aspRow(7203, 23, { amount: '3' })];
    const result = reconcile({ publicRows: [aspRow(9200, 23, { amount: '3' })], ownRows: legs });
    expect(result.ownRows.map((r) => r.amount)).toEqual(['1', '2']);
    expect(shown(result)).toHaveLength(3);
    // An amount the window spells differently still covers one leg, never none.
    const odd = reconcile({ publicRows: [aspRow(9201, 23, { amount: '999' })], ownRows: legs });
    expect(odd.ownRows).toHaveLength(2);
  });

  test('a batch deposit is N rows under one hash and stays N: the ASP gave them distinct ids', () => {
    const rows = [aspRow(7001, 14), aspRow(7002, 14), aspRow(7003, 14)];
    const result = reconcile({ publicRows: rows, ownRows: rows });
    expect(result.publicRows).toHaveLength(3);
    expect(result.ownRows).toHaveLength(0);
    // ...and our pending row for that batch yields to them.
    const withPending = reconcile({ publicRows: rows, pendingOwn: [ours(14)] });
    expect(withPending.pendingRows).toEqual([]);
    expect(withPending.settled).toHaveLength(1);
  });

  test('the SET of shown operations does not depend on arrival order', () => {
    const pendings = [ours(15), ours(16), ours(17)];
    const publics = [aspRow(8015, 15), aspRow(8099, 99, { address: STRANGER }), aspRow(8098, 98, { address: STRANGER })];
    const owns = [aspRow(8016, 16), aspRow(8015, 15), aspRow(8050, 50)];
    const baseline = shown(reconcile({ publicRows: publics, ownRows: owns, pendingOwn: pendings }));
    const permutations = [
      { publicRows: [...publics].reverse(), ownRows: [...owns].reverse(), pendingOwn: [...pendings].reverse() },
      { publicRows: [publics[1], publics[0], publics[2]], ownRows: [owns[2], owns[0], owns[1]], pendingOwn: [pendings[2], pendings[0], pendings[1]] },
    ];
    for (const p of permutations) {
      expect(shown(reconcile(p))).toEqual(baseline);
    }
    // 15 and 16 are settled by a feed row; 17 is still ours; 98, 99, 50 are theirs.
    expect(baseline).toHaveLength(6);
    expect(baseline.filter((k) => k.includes(H(15)))).toHaveLength(1);
    expect(baseline.filter((k) => k.includes(H(16)))).toHaveLength(1);
  });

  test('own-history rows on a chain the aggregate does not show are dropped', () => {
    const hidden = aspRow(9001, 18, { asset: { ...aspRow(0, 18).asset, chainId: 102, chainName: 'Sui' } });
    const result = reconcile({ ownRows: [hidden, aspRow(9002, 19)] });
    expect(result.ownRows.map((r) => r.eventId)).toEqual([9002]);
  });

  test('a row without an eventId dedupes on operation and time, so two batch legs without ids stay apart', () => {
    const a = aspRow(0, 20);
    delete (a as Partial<GlobalEvent>).eventId;
    const b = { ...a, timestamp: a.timestamp + 1 };
    expect(feedRowKey(a)).not.toEqual(feedRowKey(b));
    expect(reconcile({ publicRows: [a, { ...a }, b] }).publicRows).toHaveLength(2);
  });
});

describe('feed reconciliation: the pending ledger', () => {
  test('a pending entry past the age bound expires without a feed row; one inside it does not', () => {
    for (const age of [PENDING_OWN_ROW_MAX_AGE_MS + 1, PENDING_OWN_ROW_MAX_AGE_MS * 3]) {
      const stale = ours(21);
      const fresh = ours(22);
      const result = reconcile({ pendingOwn: [stale, fresh], now: NOW + age });
      expect(result.expired).toEqual([stale, fresh]); // both recorded at NOW
      expect(result.pendingRows).toEqual([]);
    }
    const result = reconcile({ pendingOwn: [ours(23)], now: NOW + PENDING_OWN_ROW_MAX_AGE_MS });
    expect(result.expired).toEqual([]);
    expect(result.pendingRows).toHaveLength(1);
  });

  test('without a clock nothing expires in render; the off-render helper judges the same bound', () => {
    const stale = ours(40);
    const fresh = { ...ours(41), recordedAt: NOW + PENDING_OWN_ROW_MAX_AGE_MS };
    const result = reconcile({ pendingOwn: [stale, fresh], now: undefined });
    expect(result.expired).toEqual([]);
    expect(result.pendingRows).toHaveLength(2);
    for (const now of [NOW + PENDING_OWN_ROW_MAX_AGE_MS + 1, NOW + PENDING_OWN_ROW_MAX_AGE_MS * 2]) {
      expect(expiredPendingOwnRows([stale, fresh], now)).toEqual([stale]);
    }
    expect(expiredPendingOwnRows([stale, fresh], NOW + PENDING_OWN_ROW_MAX_AGE_MS)).toEqual([]);
  });

  test('a settled entry is settled even when it is also old: the feed row wins over the clock', () => {
    const old = ours(24);
    const result = reconcile({ publicRows: [aspRow(10024, 24)], pendingOwn: [old], now: NOW + PENDING_OWN_ROW_MAX_AGE_MS * 2 });
    expect(result.settled).toEqual([old]);
    expect(result.expired).toEqual([]);
  });

  test('upsert replaces the entry for the same (chain, hash, type), case-insensitively, and stays bounded', () => {
    let list: PendingOwnRow<GlobalEvent>[] = [];
    list = upsertPendingOwnRow(list, ours(25));
    list = upsertPendingOwnRow(list, { ...ours(25, { amountRaw: '5' }), txHash: H(25).toUpperCase().replace('0X', '0x') });
    expect(list).toHaveLength(1);
    expect(list[0].row.amount).toBe('5');
    expect(list[0].txHash).toBe(H(25));
    list = upsertPendingOwnRow(list, { ...ours(25), chainId: 1 });
    expect(list).toHaveLength(2);
    for (let i = 100; i < 100 + MAX_PENDING_OWN_ROWS + 3; i++) list = upsertPendingOwnRow(list, ours(i));
    expect(list).toHaveLength(MAX_PENDING_OWN_ROWS);
    expect(list.some((p) => p.txHash === H(25))).toBe(false);
  });

  test('a malformed hash is never recorded', () => {
    expect(upsertPendingOwnRow([], { ...ours(26), txHash: '0xnothex' })).toEqual([]);
    expect(upsertPendingOwnRow([], { ...ours(26), txHash: '' })).toEqual([]);
  });

  test('remove drops every type for the (chain, hash) and leaves other chains alone', () => {
    const list = [ours(27), { ...ours(27), chainId: 1 }, ours(28)];
    const next = removePendingOwnRowFrom(list, 11155111, H(27).toUpperCase().replace('0X', '0x'));
    expect(next.map((p) => `${p.chainId}:${p.txHash}`)).toEqual([`1:${H(27)}`, `11155111:${H(28)}`]);
    expect(withoutPendingOwnRows(list, [list[0], list[2]])).toEqual([list[1]]);
    expect(withoutPendingOwnRows(list, [])).toEqual(list);
  });

  test('the store publishes an immutable snapshot and notifies on every change only', () => {
    resetPendingOwnRowsForTests();
    let notified = 0;
    const unsubscribe = subscribePendingOwnRows(() => { notified += 1; });
    const before = readPendingOwnRows();
    addPendingOwnRow(ours(29));
    const after = readPendingOwnRows();
    expect(after).not.toBe(before);
    expect(after).toHaveLength(1);
    expect(Object.isFrozen(after)).toBe(true);
    removePendingOwnRow(1, H(29)); // wrong chain: nothing changes, nobody is told
    expect(readPendingOwnRows()).toBe(after);
    expect(notified).toBe(1);
    removePendingOwnRow(11155111, H(29));
    expect(readPendingOwnRows()).toHaveLength(0);
    expect(notified).toBe(2);
    addPendingOwnRow(ours(30));
    addPendingOwnRow(ours(31));
    prunePendingOwnRows([ours(30)]);
    expect(readPendingOwnRows().map((p) => p.txHash)).toEqual([H(31)]);
    prunePendingOwnRows([]);
    expect(notified).toBe(5);
    unsubscribe();
    resetPendingOwnRowsForTests();
  });
});

describe('the optimistic deposit row', () => {
  test('is a feed-shaped row for the operation, with the ASP fields it can honestly fill', () => {
    const row = buildOptimisticDepositEvent({
      chainId: 1, chainName: 'Ethereum', address: ME, txHash: H(32), amountRaw: '2500000', tokenAddress: USDC, tokenSymbol: 'USDC', denomination: 6, now: NOW,
    });
    expect(row.type).toBe('deposit');
    expect(row.reviewStatus).toBe('pending');
    expect(row.txHash).toBe(H(32));
    expect(row.amount).toBe('2500000');
    expect(row.asset).toEqual({ asset: USDC, chainId: 1, chainName: 'Ethereum', tokenSymbol: 'USDC', tokenAddress: USDC, assetAddress: USDC, denomination: 6 });
    expect(operationKey(row.asset.chainId, row.txHash, row.type)).toBe(`1:${H(32)}:deposit`);
    // Two deposits built a millisecond apart never collide on the row key.
    const other = buildOptimisticDepositEvent({ chainId: 1, chainName: 'Ethereum', address: ME, txHash: H(33), amountRaw: '1', tokenAddress: USDC, tokenSymbol: 'USDC', denomination: 6, now: NOW + 1 });
    expect(feedRowKey(row)).not.toEqual(feedRowKey(other));
  });
});
