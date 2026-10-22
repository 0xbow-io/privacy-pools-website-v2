import { describe, expect, mock, test } from 'bun:test';
import { rowTypeLabel } from '../row-type-label';

// The row builders read token and chain metadata (config/tokens pulls
// react-native at load); stub the one RN symbol and pin the env.
mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const { reconstructUserSpends, mergeClaimsByPayment } = await import('@/services/outgoing-transfers');
const { buildSpendRows, countSpendActions, decorateOwnRows, withWithdrawalDecorations } = await import('@/services/activity-rows');
type SwapRecord = import('@/services/swap-records-core').SwapRecord;
const { mergeMyTransactions, withLineageTransfers } = await import('@/services/transfer-direction');
const { anyLeg, debugSafeRow, debugSafeSpend, isSwapRow, projectOwnOutputs, rowLegs, swapHeadline, swapOutputDepositView } = await import('@/services/swap-rows');
const { tokenAmountLabel } = await import('@/services/share-display');
const { isSwapRouteCaller } = await import('@/config/intent-swaps');
const { swapRouteKinds, withPublicSwapRows, withSwapRouteWithdrawals } = await import('@/services/swap-route-evidence');
const { EXPORT_TYPES, buildAccountingItems, buildKoinlyCsv } = await import('@/services/accounting-export');

type Transaction = import('@/components/pools-provider').Transaction;
type SnapshotTransact = import('@/services/api-types').SnapshotTransact;
type Hex = import('@/services/sdk-types').Hex;
type Secret = import('@/services/sdk-types').Secret;
type Note = import('@/services/sdk-types').Note;

// Deterministic stand-in for Poseidon, as in outgoing-transfers.test.ts.
const hashService = { hash: (inputs: Hex[]): Hex => `0x${(BigInt(inputs[0]) * 1_000_003n + BigInt(inputs[1])).toString(16)}` as Hex };
const KEY = '0x0abc' as Secret;
const nf = (c: string) => `0x${BigInt(hashService.hash([KEY, c as Hex])).toString(16).padStart(64, '0')}`;
const h32 = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const MAINNET = 1;
const BSC = 56;
const RELAY_SWAPS = '0xd0395c08dd8ea7671a7a65bdca8e473e8e8260a8';
const E18 = 10n ** 18n;

const SWAP_TX = h32(0x5a);
const DEPOSIT_TX = h32(0xd0);
const LABEL_IN = h32(0xaa);
const LABEL_OUT = h32(0xbb);

type TestNote = Note & { chainId?: number };
const note = (commitment: string, value: bigint, tokenId: string, label: string, txHash: string, status: string, chainId = MAINNET): TestNote => ({
  commitment, value: `0x${value.toString(16)}`, tokenId, label, txHash, status, chainId,
  ownerAddress: '0x1111111111111111111111111111111111111111',
  noteSecret: h32(0x5ec),
} as unknown as TestNote);

const transact = (over: Partial<SnapshotTransact> & { chainId?: number }): SnapshotTransact & { chainId?: number } => ({
  txHash: SWAP_TX, logIndex: 0, outputCommitments: [], nullifierHashes: [], caller: RELAY_SWAPS,
  withdrawnValue: '0', encryptedPayload: null, blockNumber: '1', blockTimestamp: '1759760000', asset: ETH,
  chainId: MAINNET, ...over,
});

// 1 ETH deposited; the Swap tab swaps 0.5 ETH (gross, fee inside) into 1250
// USDC on the same chain. The tx outputs the 0.5 ETH change and, through
// RelaySwaps' embedded deposit, a USDC note of a NEW label.
const deposit = note(h32(0xc1), E18, ETH, LABEL_IN, DEPOSIT_TX, 'SPENT');
const change = note(h32(0xc2), E18 / 2n, ETH, LABEL_IN, SWAP_TX, 'ACTIVE');
const output = (status: string) => note(h32(0xc3), 1250_000000n, USDC, LABEL_OUT, SWAP_TX, status);
const swapTransact = transact({ nullifierHashes: [nf(h32(0xc1))], outputCommitments: [h32(0xc2)], withdrawnValue: (E18 / 2n).toString() });

const feedRow = (over: Partial<Transaction>): Transaction => ({
  id: `feed-${over.type}-${over.txHash}-${over.label}`, address: '', fullAddress: '', type: 'Deposit', chain: 'Ethereum', chainId: MAINNET,
  asset: 'ETH', tokenAddress: ETH, rawAmount: '0', tokenAmount: 0, usdValue: 0, value: '$0', timestamp: 1759760000000,
  status: 'completed', txHash: SWAP_TX, reviewStatus: 'approved', aspRoot: null, label: null, ...over,
});
const feedWithdrawal = feedRow({ type: 'Withdrawal', rawAmount: (E18 / 2n).toString(), tokenAmount: 0.5, label: LABEL_IN });
const feedOutputDeposit = (reviewStatus: string, status = reviewStatus === 'approved' ? 'completed' : 'pending') =>
  feedRow({ type: 'Deposit', asset: 'USDC', tokenAddress: USDC, rawAmount: '1250000000', tokenAmount: 1250, label: LABEL_OUT, reviewStatus, status });
const strangerInBatch = feedRow({ id: 'stranger', type: 'Withdrawal', rawAmount: '7', tokenAmount: 0, label: h32(0xee) });
const earlierDeposit = feedRow({ id: 'dep', type: 'Deposit', txHash: DEPOSIT_TX, rawAmount: E18.toString(), tokenAmount: 1, label: LABEL_IN, timestamp: 1759700000000 });

const ctx = { leafReady: true, registration: 'registered' as const };
const leafConfirmed = new Set<string>();
const projectLocal = (chainId: number, outputs: readonly { status: string; commitment: string }[]) =>
  projectOwnOutputs(outputs.map((o) => ({ noteStatus: o.status, leafConfirmed: chainId === MAINNET && leafConfirmed.has(o.commitment) })), chainId === MAINNET ? ctx : { leafReady: false, registration: 'unknown' });

/** The provider's assembly: classify, build lineage rows, decorate, merge per scope. */
function assemble(
  notes: TestNote[],
  transacts: (SnapshotTransact & { chainId?: number })[],
  feedIn: Transaction[],
  extraLineage: Transaction[] = [],
  records: SwapRecord[] = [],
  depositCommitments: Set<string> = new Set(),
) {
  // The snapshot's view of the same txs: its transacts, and the feed's deposits.
  const kinds = swapRouteKinds({ transacts: transacts.map((t) => ({ ...t, chainId: t.chainId ?? MAINNET })), deposits: feedIn.filter((r) => r.type === 'Deposit') }, isSwapRouteCaller);
  feedIn = withSwapRouteWithdrawals(feedIn, kinds);
  const crossChainOutputCommitments = new Set(records.flatMap((r) => (r.kind === 'cross-chain' ? [r.commitment] : [])));
  const spends = reconstructUserSpends(notes, transacts, KEY, hashService, { isSwapRouteCaller, crossChainOutputCommitments });
  const byCommitment = new Map(notes.map((n) => [`${n.chainId}|${String(n.commitment).toLowerCase()}`, { status: String(n.status), label: String(n.label), commitment: String(n.commitment), value: String(n.value), tokenId: String(n.tokenId), txHash: String(n.txHash) }]));
  const noteOn = (chainId: number, c: string) => byCommitment.get(`${chainId}|${c.toLowerCase()}`) ?? null;
  const priceMap = { ETH: 2500, USDC: 1 };
  const spendRows = buildSpendRows({
    spends: mergeClaimsByPayment(spends), seenTxHashes: new Set(), defaultChainId: MAINNET, feedRows: feedIn,
    priceMap, projectLocalOutputs: projectLocal, records, noteOn, depositCommitments,
  });
  const { feedRows: feed, lineageRows: lineage } = decorateOwnRows({ feedRows: feedIn, lineageRows: [...extraLineage, ...spendRows], records, noteOn, priceMap });
  const mineFeed = feed.filter((r) => r.id !== 'stranger');
  return { spends, spendRows, lineage, feed, mine: mergeMyTransactions(mineFeed, lineage), all: withPublicSwapRows(withLineageTransfers(feed, lineage), kinds) };
}

describe('classifier', () => {
  test('a same-chain reshield with withdrawnValue is a swap of the gross, with its output', () => {
    const [spend] = reconstructUserSpends([deposit, change, output('ACTIVE')], [swapTransact], KEY, hashService);
    expect(spend.kind).toBe('swap');
    expect(spend.amount).toBe(E18 / 2n);
    expect(spend.swapOutputs?.map((o) => [o.value, o.tokenId, o.label])).toEqual([[1250_000000n, USDC, LABEL_OUT]]);
  });

  test('a destination note on ANOTHER chain under the source hash does not make the spend a swap', () => {
    const crossOut = note(h32(0xc4), 1248_000000n, USDC, LABEL_OUT, SWAP_TX, 'PENDING', BSC);
    const [spend] = reconstructUserSpends([deposit, change, crossOut], [swapTransact], KEY, hashService, { isSwapRouteCaller });
    expect(spend.kind).toBe('withdrawal');
    expect(spend.swapRoute).toBe(true);
    expect(spend.swapOutputs).toBeUndefined();
  });

  test('a transfer and a stamped claim keep precedence over a redeposit', () => {
    const recipient = transact({ nullifierHashes: [nf(h32(0xc1))], outputCommitments: [h32(0xc2), h32(0x99)], withdrawnValue: '1000' });
    expect(reconstructUserSpends([deposit, change, output('ACTIVE')], [recipient], KEY, hashService)[0].kind).toBe('transfer');
    const anchored = reconstructUserSpends([deposit, change, output('ACTIVE')], [swapTransact], KEY, hashService, { anchorTxHashes: new Set([SWAP_TX]) });
    expect(anchored[0].kind).toBe('claim');
  });

  test('a RelaySwaps caller, current or past, marks a withdrawal as via swap; another caller does not', () => {
    const run = (caller: string) => reconstructUserSpends([deposit, change], [{ ...swapTransact, caller }], KEY, hashService, { isSwapRouteCaller })[0];
    expect(run(RELAY_SWAPS).swapRoute).toBe(true);
    expect(run('0x5936aefb2134550f3f526d65e984620582d270e7').swapRoute).toBe(true);
    expect(run('0x0000000000000000000000000000000000000001').swapRoute).toBeUndefined();
    expect(run(RELAY_SWAPS).kind).toBe('withdrawal');
  });
});

describe('activity assembly: same-chain swap', () => {
  test('before the ASP indexes the output: one Swap row, pending on local evidence', () => {
    const { mine, all } = assemble([deposit, change, output('ACTIVE')], [swapTransact], [earlierDeposit, feedWithdrawal]);
    const swaps = mine.filter((r) => r.txHash === SWAP_TX);
    expect(swaps.map((r) => r.type)).toEqual(['Swap']);
    expect(swaps[0].status).toBe('pending');
    expect(swaps[0].reviewStatus).toBe('pending');
    expect(swaps[0].rawAmount).toBe((E18 / 2n).toString());
    expect(swaps[0].swapOut?.rawAmount).toBe('1250000000');
    expect(all.filter((r) => r.txHash === SWAP_TX).map((r) => r.type)).toEqual(['Swap']);
  });

  test('indexed in the feed: my swap stays my own Swap row in All; a stranger\'s folds the same way', () => {
    const feed = [feedWithdrawal, feedOutputDeposit('approved')];
    const own = assemble([deposit, change, output('ACTIVE')], [swapTransact], feed).all;
    expect(own.map((r) => [r.type, r.isLineageSynthetic, rowLegs(r)?.fromCaption])).toEqual([['Swap', true, 'You swapped']]);
    const stranger = assemble([], [swapTransact], feed).all;
    expect(stranger.map((r) => [r.type, r.isLineageSynthetic, rowLegs(r)?.fromCaption, r.swapOut?.rawAmount])).toEqual([['Swap', undefined, 'Swapped', '1250000000']]);
  });

  test("before indexing, the output's published association leaf approves the row", () => {
    leafConfirmed.add(h32(0xc3));
    try {
      const { mine } = assemble([deposit, change, output('ACTIVE')], [swapTransact], [earlierDeposit, feedWithdrawal]);
      const [swap] = mine.filter((r) => r.txHash === SWAP_TX);
      expect([swap.type, swap.reviewStatus]).toEqual(['Swap', 'approved']);
    } finally {
      leafConfirmed.clear();
    }
  });

  test('a synthesized own Deposit of the output folds into the Swap row', () => {
    const synthesized = feedRow({ id: 'lineage-deposit-out', type: 'Deposit', asset: 'USDC', tokenAddress: USDC, label: LABEL_OUT, isLineageSynthetic: true, status: 'pending', reviewStatus: 'pending' });
    const { mine } = assemble([deposit, change, output('ACTIVE')], [swapTransact], [feedWithdrawal], [synthesized]);
    expect(mine.map((r) => r.type)).toEqual(['Swap']);
  });

  test('after indexing: the feed Deposit row folds in and lends its status; the row stays a Swap', () => {
    const feed = [earlierDeposit, feedWithdrawal, feedOutputDeposit('approved'), strangerInBatch];
    const { mine, all } = assemble([deposit, change, output('ACTIVE')], [swapTransact], feed);
    const mineSwap = mine.filter((r) => r.txHash === SWAP_TX);
    expect(mineSwap.map((r) => r.type)).toEqual(['Swap']);
    expect(mineSwap[0].status).toBe('completed');
    expect(mineSwap[0].reviewStatus).toBe('approved');
    // All: the Swap takes the Withdrawal's place, the Deposit goes, the
    // stranger's row under the same batch hash stays; the window gains nothing.
    expect(all.map((r) => (r.id === 'stranger' ? 'stranger' : r.type))).toEqual(['Deposit', 'Swap', 'stranger']);
    expect(all.length).toBeLessThan(feed.length);
    // All and My agree on the shared action.
    const allSwap = all.find((r) => r.type === 'Swap')!;
    expect([allSwap.rawAmount, allSwap.swapOut?.rawAmount, allSwap.status, allSwap.reviewStatus])
      .toEqual([mineSwap[0].rawAmount, mineSwap[0].swapOut?.rawAmount, mineSwap[0].status, mineSwap[0].reviewStatus]);
  });

  test("All never replaces a stranger's row: with only theirs under the hash, the output row anchors the Swap", () => {
    const { all } = assemble([deposit, change, output('ACTIVE')], [swapTransact], [strangerInBatch, feedOutputDeposit('approved')]);
    expect(all.map((r) => (r.id === 'stranger' ? 'stranger' : r.type))).toEqual(['stranger', 'Swap']);
    // Theirs under a label of mine (a note I once sent them) is no proof either.
    const sharedLabel = { ...strangerInBatch, label: LABEL_IN };
    const shared = assemble([deposit, change, output('ACTIVE')], [swapTransact], [feedWithdrawal, sharedLabel, feedOutputDeposit('approved')]).all;
    expect(shared.map((r) => (r.id === 'stranger' ? 'stranger' : r.type))).toEqual(['Withdrawal', 'stranger', 'Swap']);
  });

  test('an output under review keeps the row pending with the ASP verdict', () => {
    const { mine } = assemble([deposit, change, output('ACTIVE')], [swapTransact], [feedWithdrawal, feedOutputDeposit('pending')]);
    expect(mine[0].type).toBe('Swap');
    expect(mine[0].reviewStatus).toBe('pending');
  });

  test('a spent output changes funds state only, never the swap', () => {
    const { mine } = assemble([deposit, change, output('SPENT')], [swapTransact], [feedWithdrawal]);
    expect(mine[0].type).toBe('Swap');
    expect(mine[0].reviewStatus).toBe('approved');
    expect(mine[0].swapOut?.rawAmount).toBe('1250000000');
  });

  test('filters match either leg', () => {
    const { mine } = assemble([deposit, change, output('ACTIVE')], [swapTransact], [feedWithdrawal]);
    const swap = mine[0];
    expect(anyLeg(swap, (l) => l.asset === 'USDC')).toBe(true);
    expect(anyLeg(swap, (l) => l.asset === 'ETH')).toBe(true);
    expect(anyLeg(swap, (l) => l.asset === 'USDT')).toBe(false);
    expect(anyLeg(swap, (l) => l.chainId === MAINNET)).toBe(true);
  });

  test('the folded output keeps its deposit identity for fund actions and fully-spent', () => {
    const { mine } = assemble([deposit, change, output('ACTIVE')], [swapTransact], [feedWithdrawal]);
    const swap = mine[0];
    if (!isSwapRow(swap)) throw new Error('not a swap');
    const view = swapOutputDepositView(swap);
    expect([view.type, view.chainId, view.asset, view.txHash, view.label, view.rawAmount]).toEqual(['Deposit', MAINNET, 'USDC', SWAP_TX, LABEL_OUT, '1250000000']);
  });

  test('a cross-chain swap without a record stays a Withdrawal and its destination Deposit stays', () => {
    const crossOut = note(h32(0xc4), 1248_000000n, USDC, LABEL_OUT, SWAP_TX, 'PENDING', BSC);
    const destRow = feedRow({ id: 'dest', type: 'Deposit', chainId: BSC, chain: 'BNB Chain', asset: 'USDC', tokenAddress: USDC, label: LABEL_OUT, txHash: h32(0xde) });
    const { mine } = assemble([deposit, change, crossOut], [swapTransact], [feedWithdrawal, destRow]);
    expect(mine.map((r) => r.type).sort()).toEqual(['Deposit', 'Withdrawal']);
  });
});

describe('every chain', () => {
  test("an own spend on another chain is classified from that chain's notes and its row is on that chain", () => {
    const bscIn = note(h32(0xb1), E18, ETH, LABEL_IN, DEPOSIT_TX, 'SPENT', BSC);
    const bscChange = note(h32(0xb2), E18 / 2n, ETH, LABEL_IN, SWAP_TX, 'ACTIVE', BSC);
    const bscOut = note(h32(0xb3), 1250_000000n, USDC, LABEL_OUT, SWAP_TX, 'ACTIVE', BSC);
    const tx = transact({ chainId: BSC, nullifierHashes: [nf(h32(0xb1))], outputCommitments: [h32(0xb2)], withdrawnValue: (E18 / 2n).toString() });
    const { lineage } = assemble([bscIn, bscChange, bscOut], [tx], []);
    expect(lineage.map((r) => [r.type, r.chainId, r.swapOut?.chainId])).toEqual([['Swap', BSC, BSC]]);
  });
});

describe('counts', () => {
  test('My Pools counts agree with the classified actions', () => {
    const { spends, spendRows, mine } = assemble([deposit, change, output('ACTIVE')], [swapTransact], [earlierDeposit, feedWithdrawal, feedOutputDeposit('approved')]);
    const snapshotDeposits = [{ outputCommitment: h32(0xc1) }, { outputCommitment: h32(0xc3) }];
    const counts = countSpendActions({ spends: mergeClaimsByPayment(spends), spendRows, receivedCount: 0, exitCount: 0, depositCount: snapshotDeposits.length, snapshotDeposits });
    expect(counts).toEqual({ transfers: 0, withdrawals: 0, swaps: 1, deposits: 1 });
    expect(mine.filter((r) => r.type === 'Swap')).toHaveLength(counts.swaps);
    expect(mine.filter((r) => r.type === 'Deposit')).toHaveLength(counts.deposits);
    expect(mine.filter((r) => r.type === 'Withdrawal')).toHaveLength(counts.withdrawals);
  });
});

describe('accounting', () => {
  const lookups = { findSentAudits: () => [], findSentTransfer: () => null };
  const fee = (E18 * 6n) / 10000n; // 0.0006 ETH, inside the 0.5 gross

  async function ledger(notes: TestNote[], extraFeed: Transaction[] = []) {
    const { mine } = assemble(notes, [swapTransact], [earlierDeposit, feedWithdrawal, feedOutputDeposit('approved'), ...extraFeed]);
    const items = buildAccountingItems({
      mineRows: mine, notes: notes as Note[], notesByChain: new Map([[MAINNET, notes as Note[]]]),
      sentTxHashes: new Set(), transferTxHashes: new Set(), transferClassificationReady: true,
      myDeposits: [{ txHash: DEPOSIT_TX, logIndex: 0, depositAddress: '0x1', outputCommitment: h32(0xc1), depositedValue: E18.toString(), fee: '0', blockNumber: '1', blockTimestamp: '1759700000', asset: ETH },
        { txHash: SWAP_TX, logIndex: 1, depositAddress: RELAY_SWAPS, outputCommitment: h32(0xc3), depositedValue: '1250000000', fee: '0', blockNumber: '2', blockTimestamp: '1759760000', asset: USDC }],
      myExits: [], evmChainId: MAINNET, ...lookups,
    }).filter((it) => EXPORT_TYPES.includes(it.type));
    const csv = await buildKoinlyCsv(items, { notes, findFee: (h) => (h === SWAP_TX ? { feeAmount: fee.toString() } : null), buildOriginProof: () => null });
    return { items, rows: csv.split('\n').slice(1).map((l) => l.split(',')) };
  }

  test('one trade line with both legs in their own units; the output deposit is booked once', async () => {
    const { items, rows } = await ledger([deposit, change, output('ACTIVE')]);
    expect(items.map((it) => it.type).sort()).toEqual(['deposit', 'trade']);
    const trade = rows.find((r) => r[11] === SWAP_TX)!;
    // Sent, SentCur, Received, ReceivedCur, Fee, FeeCur
    expect(trade.slice(1, 7)).toEqual(['0.4994', 'ETH', '1250', 'USDC', '0.0006', 'ETH']);
    expect(trade[10]).toContain('Privacy Pools swap');
    expect(trade[10]).toContain('verify:');
  });

  test('the ledger reconciles to the balance, including a later-spent output', async () => {
    const later = feedRow({ id: 'later', type: 'Withdrawal', txHash: h32(0x1a7), asset: 'USDC', tokenAddress: USDC, rawAmount: '1250000000', tokenAmount: 1250, label: LABEL_OUT, isLineageSynthetic: true });
    const { rows } = await ledger([deposit, change, output('SPENT')], [later]);
    const net = new Map<string, number>();
    const add = (cur: string, v: string, sign: number) => { if (cur) net.set(cur, (net.get(cur) ?? 0) + sign * Number(v || 0)); };
    for (const r of rows) { add(r[2], r[1], -1); add(r[4], r[3], 1); add(r[6], r[5], -1); }
    // Balance: the 0.5 ETH change; the USDC output was withdrawn.
    expect(Number((net.get('ETH') ?? 0).toFixed(9))).toBe(0.5);
    expect(Number((net.get('USDC') ?? 0).toFixed(6))).toBe(0);
  });
});

describe('debug snapshots', () => {
  test('neither snapshot carries the swap output or pairing', () => {
    const { spends, mine } = assemble([deposit, change, output('ACTIVE')], [swapTransact], [feedWithdrawal]);
    const rowJson = JSON.stringify(mine.map(debugSafeRow));
    const spendJson = JSON.stringify(spends.map(debugSafeSpend), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(spends[0].inputLabels?.length).toBeGreaterThan(0);
    expect(spendJson).not.toContain(LABEL_IN.slice(2));
    for (const json of [rowJson, spendJson]) {
      expect(json).not.toContain(LABEL_OUT.slice(2));
      expect(json).not.toContain(h32(0xc3).slice(2));
      expect(json).not.toContain('swapOut');
    }
  });
});

describe('activity assembly: recorded on the sending device', () => {
  const BSC_OUT = h32(0xc4);
  const LABEL_DEST = h32(0xcc);
  const crossOut = (status: string) => note(BSC_OUT, 1248_000000n, USDC, LABEL_DEST, SWAP_TX, status, BSC);
  const crossRecord = (over: Partial<Extract<SwapRecord, { kind: 'cross-chain' }>> = {}): SwapRecord => ({
    kind: 'cross-chain', txHash: SWAP_TX, sourceChainId: MAINNET, timestamp: 1, outputChainId: BSC, outputToken: USDC, commitment: BSC_OUT, value: '1248000000', ...over,
  });
  const preparedRow = feedRow({ id: 'lineage-deposit-prepared', type: 'Deposit', chainId: BSC, chain: 'BNB Chain', asset: 'USDC', tokenAddress: USDC, label: LABEL_DEST, status: 'pending', reviewStatus: 'pending', isLineageSynthetic: true });
  const destFeedRow = feedRow({ id: 'dest', type: 'Deposit', chainId: BSC, chain: 'BNB Chain', asset: 'USDC', tokenAddress: USDC, label: LABEL_DEST, txHash: h32(0xde), status: 'completed', reviewStatus: 'approved' });

  test('a recorded commitment never makes a spend a same-chain swap, even untagged', () => {
    const untagged = { ...crossOut('PENDING'), chainId: undefined } as unknown as TestNote;
    const [spend] = reconstructUserSpends([deposit, change, untagged], [swapTransact], KEY, hashService, { crossChainOutputCommitments: new Set([BSC_OUT]) });
    expect(spend.kind).toBe('withdrawal');
  });

  test('cross-chain, prepared: one pending Swap row delivering, the prepared deposit folded', () => {
    const { mine, all } = assemble([deposit, change, crossOut('PENDING')], [swapTransact], [feedWithdrawal], [preparedRow], [crossRecord()]);
    expect(mine.map((r) => r.type)).toEqual(['Swap']);
    expect(mine[0].status).toBe('pending');
    expect(mine[0].swapOut?.delivering).toBe(true);
    expect(mine[0].swapOut?.chainId).toBe(BSC);
    expect(all.map((r) => r.type)).toEqual(['Swap']);
  });

  test('cross-chain, delivered: the destination Deposit row folds in and lends its status; two transactions', () => {
    const { mine, all, spendRows, spends } = assemble([deposit, change, crossOut('ACTIVE')], [swapTransact], [feedWithdrawal, destFeedRow], [],
      [crossRecord({ outcome: 'deposited', destinationTxHash: h32(0xde) })]);
    expect(mine.map((r) => r.type)).toEqual(['Swap']);
    expect([mine[0].status, mine[0].reviewStatus, mine[0].swapOut?.delivering, mine[0].swapOut?.deliveryTxHash]).toEqual(['completed', 'approved', undefined, h32(0xde)]);
    // Fully spent and the Exit filter key on the held note's own tx, not the delivery's.
    if (!isSwapRow(mine[0])) throw new Error('not a swap');
    expect(swapOutputDepositView(mine[0]).txHash).toBe(SWAP_TX);
    expect(all.map((r) => r.type)).toEqual(['Swap']);
    const counts = countSpendActions({ spends: mergeClaimsByPayment(spends), spendRows, receivedCount: 0, exitCount: 0, depositCount: 2, snapshotDeposits: [{ outputCommitment: h32(0xc1) }, { outputCommitment: BSC_OUT }] });
    expect(counts).toEqual({ transfers: 0, withdrawals: 0, swaps: 1, deposits: 1 });
  });

  test('cross-chain: the snapshot listing the destination note proves delivery without a poller outcome', () => {
    const { mine } = assemble([deposit, change, crossOut('PENDING')], [swapTransact], [feedWithdrawal], [], [crossRecord()], new Set([BSC_OUT]));
    expect(mine.map((r) => r.type)).toEqual(['Swap']);
    expect(mine[0].swapOut?.delivering).toBeUndefined();
  });

  test('cross-chain, pending delivery still counts as a swap', () => {
    const { spends, spendRows } = assemble([deposit, change, crossOut('PENDING')], [swapTransact], [feedWithdrawal], [], [crossRecord()]);
    const counts = countSpendActions({ spends: mergeClaimsByPayment(spends), spendRows, receivedCount: 0, exitCount: 0, depositCount: 1, snapshotDeposits: [{ outputCommitment: h32(0xc1) }] });
    expect(counts).toEqual({ transfers: 0, withdrawals: 0, swaps: 1, deposits: 1 });
  });

  test('cross-chain, recovered: a Withdrawal that says so, in My and All, counted as a withdrawal', () => {
    const { mine, all, spends, spendRows } = assemble([deposit, change], [swapTransact], [feedWithdrawal], [], [crossRecord({ outcome: 'refunded' })]);
    expect(mine.map((r) => [r.type, r.delivery])).toEqual([['Withdrawal', 'refunded']]);
    expect(all.map((r) => [r.type, r.delivery])).toEqual([['Withdrawal', 'refunded']]);
    const counts = countSpendActions({ spends: mergeClaimsByPayment(spends), spendRows, receivedCount: 0, exitCount: 0, depositCount: 1, snapshotDeposits: [] });
    expect([counts.swaps, counts.withdrawals]).toEqual([0, 1]);
  });

  test('receive-as: a Withdrawal received as the quoted token, in My and All; a batch row is left alone', () => {
    const receiveAs: SwapRecord = { kind: 'receive-as', txHash: SWAP_TX, sourceChainId: MAINNET, timestamp: 1, outputChainId: MAINNET, outputToken: USDC, quotedOutput: '1247900000' };
    const { mine, all } = assemble([deposit, change], [swapTransact], [feedWithdrawal], [], [receiveAs]);
    expect(mine.map((r) => [r.type, r.receivedAs?.asset, r.receivedAs?.rawAmount])).toEqual([['Withdrawal', 'USDC', '1247900000']]);
    expect(swapHeadline(mine[0], (leg) => `${leg.tokenAmount} ${leg.asset}`)).toBe('0.5 ETH → ≈ 1247.9 USDC');
    expect(all.map((r) => [r.type, r.receivedAs?.asset])).toEqual([['Withdrawal', 'USDC']]);
    const batch = assemble([deposit, change], [swapTransact], [feedWithdrawal, strangerInBatch], [], [receiveAs]);
    expect(batch.all.every((r) => !r.receivedAs)).toBe(true);
  });

  test('Shield swap-and-shield: the Deposit says what the wallet paid, before and after the feed handoff', () => {
    const SHIELD_TX = h32(0x5d);
    const shieldNote = note(h32(0xc9), 1250_000000n, USDC, h32(0xc8), SHIELD_TX, 'PENDING');
    const record: SwapRecord = { kind: 'shield', txHash: SHIELD_TX, sourceChainId: MAINNET, timestamp: 1, depositChainId: MAINNET, inputToken: ETH, estimatedInput: '501200000000000000', commitment: h32(0xc9) };
    const pending = feedRow({ id: 'pending-shield', type: 'Deposit', txHash: SHIELD_TX, asset: 'USDC', tokenAddress: USDC, rawAmount: '1250000000', tokenAmount: 1250, label: h32(0xc8), status: 'pending', reviewStatus: 'pending', isLineageSynthetic: true });
    const before = assemble([shieldNote], [], [], [pending], [record]);
    expect(before.mine.map((r) => [r.type, r.swappedFrom?.asset, r.swappedFrom?.rawAmount])).toEqual([['Deposit', 'ETH', '501200000000000000']]);
    const indexed = feedRow({ id: 'shield-feed', type: 'Deposit', txHash: SHIELD_TX, asset: 'USDC', tokenAddress: USDC, rawAmount: '1250000000', tokenAmount: 1250, label: h32(0xc8) });
    const after = assemble([shieldNote], [], [indexed], [], [record]);
    expect(after.mine.map((r) => [r.type, r.swappedFrom?.asset])).toEqual([['Deposit', 'ETH']]);
    expect(after.all.map((r) => [r.type, r.swappedFrom?.asset])).toEqual([['Deposit', 'ETH']]);
    for (const row of [before.mine[0], after.mine[0], after.all[0]]) {
      expect(rowTypeLabel(row)).toBe('Deposit via swap');
      expect(swapHeadline(row, (leg) => `${leg.tokenAmount} ${leg.asset}`)).toBe('≈ 0.5012 ETH → 1250 USDC');
    }
    // Without a rate the share leg keeps its own units.
    expect(swapHeadline({ ...after.mine[0], asset: 'ppUSDC' }, (leg) => tokenAmountLabel(String(leg.tokenAmount), leg.asset)))
      .toBe('≈ 0.5012 ETH → 1250 ppUSDC');
    // Never a swap, never a Reshield: no record, no decoration.
    expect(assemble([shieldNote], [], [indexed]).mine[0].swappedFrom).toBeUndefined();
  });

  test('a cross-chain Shield input remains approximate: only the quote is recorded', () => {
    const record: SwapRecord = { kind: 'shield', txHash: SWAP_TX, sourceChainId: MAINNET, timestamp: 1, depositChainId: BSC, inputToken: ETH, estimatedInput: '500000000000000000', commitment: BSC_OUT };
    const { mine } = assemble([crossOut('ACTIVE')], [], [{ ...destFeedRow, rawAmount: '1248000000', tokenAmount: 1248 }], [], [record]);
    expect(swapHeadline(mine[0], (leg) => `${leg.tokenAmount} ${leg.asset}`)).toBe('≈ 0.5 ETH → 1248 USDC');
  });

  test('the delivered leg is the owned note, never the record', () => {
    const { mine } = assemble([deposit, change, crossOut('ACTIVE')], [swapTransact], [feedWithdrawal], [], [crossRecord({ outcome: 'deposited', value: '9999000000' })]);
    expect(mine[0].swapOut?.rawAmount).toBe('1248000000');
  });

  test('accounting: an undelivered output exports only the source withdrawal; a delivered one is a trade', async () => {
    const run = async (records: SwapRecord[], notes: TestNote[], feed: Transaction[]) => {
      const { mine } = assemble(notes, [swapTransact], feed, [], records);
      return buildAccountingItems({
        mineRows: mine, notes: notes as Note[], notesByChain: new Map([[MAINNET, notes.filter((n) => n.chainId === MAINNET) as Note[]], [BSC, notes.filter((n) => n.chainId === BSC) as Note[]]]),
        sentTxHashes: new Set(), transferTxHashes: new Set(), transferClassificationReady: true, myDeposits: [], myExits: [], evmChainId: MAINNET,
        findSentAudits: () => [], findSentTransfer: () => null,
      }).filter((it) => it.txHash === SWAP_TX);
    };
    const pending = await run([crossRecord()], [deposit, change, crossOut('PENDING')], [feedWithdrawal]);
    expect(pending.map((it) => it.type)).toEqual(['withdraw']);
    const delivered = await run([crossRecord({ outcome: 'deposited' })], [deposit, change, crossOut('ACTIVE')], [feedWithdrawal, destFeedRow]);
    expect(delivered.map((it) => [it.type, it.received?.chainId, it.bundles?.length])).toEqual([['trade', BSC, 1]]);
    // Delivered by the tracker, but the output note is not held here: no credit.
    const unheld = await run([crossRecord({ outcome: 'deposited' })], [deposit, change], [feedWithdrawal, destFeedRow]);
    expect(unheld.map((it) => it.type)).toEqual(['withdraw']);
  });
});

describe('debug snapshots: record fields', () => {
  test('record-backed decorations never reach a snapshot', () => {
    const leg = { chainId: 1, chain: 'Ethereum', asset: 'USDC', tokenAddress: USDC, rawAmount: '1', tokenAmount: 1, usdValue: 1 };
    const row = feedRow({ type: 'Withdrawal', receivedAs: leg, delivery: 'recovered', swappedFrom: leg });
    const safe = debugSafeRow(row) as Record<string, unknown>;
    expect(['receivedAs', 'delivery', 'swappedFrom', 'swapOut'].filter((k) => k in safe)).toEqual([]);
  });
});

describe('without a record: route and funding labels', () => {
  test('my own RelaySwaps withdrawal reads "Withdrawal via swap" in My and All; a batch row is left alone', async () => {
    const { rowTypeLabel } = await import('@/services/row-type-label');
    const { mine, all } = assemble([deposit, change], [swapTransact], [feedWithdrawal]);
    expect(mine.map(rowTypeLabel)).toEqual(['Withdrawal via swap']);
    expect(all.map(rowTypeLabel)).toEqual(['Withdrawal via swap']);
    expect(mine[0].type).toBe('Withdrawal');
    // A batch whose other log another caller submitted proves nothing per row.
    const strangerLog = transact({ logIndex: 1, caller: '0x0000000000000000000000000000000000000001' });
    const batch = assemble([deposit, change], [swapTransact, strangerLog], [feedWithdrawal, strangerInBatch]);
    expect(batch.all.map(rowTypeLabel)).toEqual(['Withdrawal', 'Withdrawal']);
    // Every log of the tx through the route: every row went through it.
    const routed = assemble([deposit, change], [swapTransact, { ...strangerLog, caller: RELAY_SWAPS }], [feedWithdrawal, strangerInBatch]);
    expect(routed.all.map(rowTypeLabel)).toEqual(['Withdrawal via swap', 'Withdrawal via swap']);
  });

  test('another caller is a plain Withdrawal', async () => {
    const { rowTypeLabel } = await import('@/services/row-type-label');
    const plain = { ...swapTransact, caller: '0x0000000000000000000000000000000000000001' };
    expect(assemble([deposit, change], [plain], [feedWithdrawal]).mine.map(rowTypeLabel)).toEqual(['Withdrawal']);
  });
});

describe('fundingSource', () => {
  test('only my own bridged_pool deposit without a Shield record reads as funded by a swap', async () => {
    const { fundedBySwap } = await import('@/services/swap-rows');
    const dep = feedRow({ type: 'Deposit', fundingSource: 'bridged_pool' });
    expect(fundedBySwap(dep, true)).toBe(true);
    expect(fundedBySwap(dep, false)).toBe(false);
    for (const source of ['pool', 'wallet', 'bridged_wallet', undefined]) expect(fundedBySwap({ ...dep, fundingSource: source }, true)).toBe(false);
    expect(fundedBySwap({ ...dep, swappedFrom: { chainId: 1, chain: 'Ethereum', asset: 'ETH', tokenAddress: ETH, rawAmount: '1', tokenAmount: 1, usdValue: 1 } }, true)).toBe(false);
    expect(fundedBySwap({ ...dep, type: 'Withdrawal' }, true)).toBe(false);
  });
});

describe('own withdrawal recipient', () => {
  test('All shows the recipient my lineage row recorded where the feed names none, and flags it', () => {
    const lineageRow = feedRow({ id: 'lineage-out', type: 'Withdrawal', isLineageSynthetic: true, fullAddress: '0x71c2000000000000000000000000000000009fa3', address: '0x71c2...9fa3' });
    const [decorated] = withWithdrawalDecorations([feedRow({ type: 'Withdrawal', fullAddress: '' })], [lineageRow]);
    expect([decorated.fullAddress, decorated.recordedRecipient]).toEqual(['0x71c2000000000000000000000000000000009fa3', true]);
    const [kept] = withWithdrawalDecorations([feedRow({ type: 'Withdrawal', fullAddress: '0x' + '9'.repeat(40) })], [lineageRow]);
    expect([kept.fullAddress, kept.recordedRecipient]).toEqual(['0x' + '9'.repeat(40), undefined]);
  });
});
