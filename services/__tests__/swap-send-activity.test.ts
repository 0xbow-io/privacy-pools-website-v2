import { describe, expect, mock, test } from 'bun:test';

// DEV-512: a private swap-send spends my note and deposits a note OWNED BY
// ANOTHER ACCOUNT in one relayed tx. My change note from that tx shares its
// hash with the recipient's deposit, which used to make their deposit mine.

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const { buildSpendRows, withWithdrawalDecorations } = await import('@/services/activity-rows');
const { depositMatchesMyNotes, mergeNoteIdentitySets, noteIdentitySets } = await import('@/services/deposit-ownership');
const { rowTypeLabel } = await import('@/services/row-type-label');
const { recordCrossChainSwap, recordSameChainSwap } = await import('@/services/swap-bookkeeping');
const { parseSwapRecords, withDeliveryOutcome } = await import('@/services/swap-records-core');

type Transaction = import('@/components/pools-provider').Transaction;
type UserSpend = import('@/services/outgoing-transfers').UserSpend;
type SwapRecord = import('@/services/swap-records-core').SwapRecord;

const h32 = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RELAY_SWAPS = '0xd0395c08dd8ea7671a7a65bdca8e473e8e8260a8';
const CHAIN = 1;
const SEND_TX = h32(0x5e);
const MY_LABEL = h32(0xaa);
const THEIR_LABEL = h32(0xbb);
const E18 = 10n ** 18n;

// My change note from the swap-send (source token, the send's hash).
const myChange = { commitment: h32(0xc1), label: MY_LABEL, txHash: SEND_TX, tokenId: ETH, value: (E18 / 2n).toString(), status: 'ACTIVE' };

// The recipient's deposit, as the feed lists it: same hash, output token,
// deposited by the RelaySwaps contract, a label none of my notes carries.
const theirDeposit = {
  id: 'their-deposit',
  type: 'Deposit',
  chainId: CHAIN,
  txHash: SEND_TX,
  tokenAddress: USDC,
  label: BigInt(THEIR_LABEL).toString(),
  fullAddress: RELAY_SWAPS,
  address: RELAY_SWAPS,
  rawAmount: '1250000000',
  status: 'completed',
  reviewStatus: 'approved',
} as unknown as Transaction;

const spend: UserSpend = {
  txHash: SEND_TX,
  tokenId: ETH,
  kind: 'withdrawal',
  amount: E18 / 2n,
  grossOutflow: E18 / 2n,
  fee: 0n,
  inputCount: 1,
  outputCount: 1,
  ownOutputValue: E18 / 2n,
  blockTimestamp: '1760000000',
  chainId: CHAIN,
  inputLabels: [MY_LABEL],
  swapRoute: true,
};

const rows = (opts: { records?: SwapRecord[]; feedRows?: Transaction[] }) => buildSpendRows({
  spends: [spend],
  seenTxHashes: new Set(),
  defaultChainId: CHAIN,
  feedRows: opts.feedRows ?? [],
  priceMap: {},
  projectLocalOutputs: () => null,
  records: opts.records ?? [],
});

describe('the recipient note is never mine', () => {
  const sets = noteIdentitySets([myChange]);

  test('a deposit in another token in my change note\'s tx is not claimed by the hash', () => {
    expect(depositMatchesMyNotes({ txHash: SEND_TX, label: theirDeposit.label, tokenAddress: USDC }, sets)).toBe(false);
  });

  test('my own reshield output (same token as my note from that tx) still is', () => {
    const own = noteIdentitySets([{ ...myChange, tokenId: USDC, label: THEIR_LABEL }]);
    expect(depositMatchesMyNotes({ txHash: SEND_TX, label: null, tokenAddress: USDC }, own)).toBe(true);
  });

  test('a deposit row with no label yet in my note\'s token keeps the hash match', () => {
    expect(depositMatchesMyNotes({ txHash: SEND_TX, label: null, tokenAddress: ETH }, sets)).toBe(true);
  });

  test('a non-EVM token id keeps the hash-only rule', () => {
    const sui = noteIdentitySets([{ ...myChange, tokenId: '0x2::sui::SUI' }]);
    expect(depositMatchesMyNotes({ txHash: SEND_TX, label: null, tokenAddress: USDC }, sui)).toBe(true);
  });

  test('a row with no token keeps the hash-only rule', () => {
    expect(depositMatchesMyNotes({ txHash: SEND_TX, label: null }, sets)).toBe(true);
  });

  test('fresh browser: sets merged from stored notes keep the token guard', () => {
    // The pools provider folds every chain's stored notes into the live set.
    const live = noteIdentitySets([]);
    mergeNoteIdentitySets(live, noteIdentitySets([myChange]));
    expect(live.txHashes.has(SEND_TX)).toBe(true);
    expect(depositMatchesMyNotes({ txHash: SEND_TX, label: theirDeposit.label, tokenAddress: USDC }, live)).toBe(false);
  });
});

describe('the outgoing row', () => {
  test('this device\'s send record names it "Sent to another account" with the source amount', () => {
    const [row] = rows({ records: [{ kind: 'send', txHash: SEND_TX, sourceChainId: CHAIN, timestamp: 1, outputChainId: CHAIN, outputToken: USDC }] });
    expect(row.type).toBe('Withdrawal');
    expect(row.sentToOther).toBe(true);
    expect(rowTypeLabel(row)).toBe('Sent to another account');
    expect(row.tokenAddress.toLowerCase()).toBe(ETH);
    expect(row.rawAmount).toBe((E18 / 2n).toString());
    // Nothing about the recipient.
    expect(row.fullAddress ?? '').toBe('');
  });

  test('no record: a batch tx where another account\'s deposit shares the hash stays "Withdrawal via swap"', () => {
    // A receive-as payout to a public wallet relayed in one batch with someone
    // else\'s deposit: the feed has a same-hash Deposit that is not mine.
    const [row] = rows({ feedRows: [theirDeposit] });
    expect(row.sentToOther).toBeUndefined();
    expect(rowTypeLabel(row)).toBe('Withdrawal via swap');
  });

  test('no record: my own reshield on a fresh device, output not synced yet, is never "Sent to another account"', () => {
    const ownOutput = { ...theirDeposit, id: 'own-output', label: BigInt(MY_LABEL).toString() } as Transaction;
    const [row] = rows({ feedRows: [ownOutput] });
    expect(rowTypeLabel(row)).toBe('Withdrawal via swap');
  });

  test('a receive-as payout (no deposit in the tx) stays "Withdrawal via swap"', () => {
    const [row] = rows({ feedRows: [] });
    expect(rowTypeLabel(row)).toBe('Withdrawal via swap');
  });

  for (const outcome of ['refunded', 'recovered', 'failed'] as const) {
    test(`a cross-chain send that was ${outcome} says so, not "Sent to another account"`, () => {
      const sent: SwapRecord = { kind: 'send', txHash: SEND_TX, sourceChainId: CHAIN, timestamp: 1, outputChainId: 10, outputToken: USDC };
      const [record] = withDeliveryOutcome([sent], { sourceChainId: CHAIN, txHash: SEND_TX, outcome });
      expect(record).toMatchObject({ kind: 'send', outcome });
      expect(parseSwapRecords([record])).toHaveLength(1);
      const [row] = rows({ records: [record] });
      expect(row.sentToOther).toBeUndefined();
      expect(row.delivery).toBe(outcome);
    });
  }

  test('a cross-chain send that was deposited stays "Sent to another account"', () => {
    const sent: SwapRecord = { kind: 'send', txHash: SEND_TX, sourceChainId: CHAIN, timestamp: 1, outputChainId: 10, outputToken: USDC };
    const [record] = withDeliveryOutcome([sent], { sourceChainId: CHAIN, txHash: SEND_TX, outcome: 'deposited', destinationTxHash: h32(0xde) });
    expect(record).toMatchObject({ outcome: 'deposited', destinationTxHash: h32(0xde) });
    expect(rowTypeLabel(rows({ records: [record] })[0])).toBe('Sent to another account');
  });

  test('the All feed\'s withdrawal row carries the same label', () => {
    const [own] = rows({ records: [{ kind: 'send', txHash: SEND_TX, sourceChainId: CHAIN, timestamp: 1, outputChainId: CHAIN, outputToken: USDC }] });
    const feed = [{ id: 'w', type: 'Withdrawal', chainId: CHAIN, txHash: SEND_TX } as unknown as Transaction];
    const [decorated] = withWithdrawalDecorations(feed, [own]);
    expect(rowTypeLabel(decorated)).toBe('Sent to another account');
  });
});

describe('bookkeeping', () => {
  const sink = () => {
    const out = { own: [] as unknown[], fees: [] as unknown[], swaps: [] as SwapRecord[] };
    return { out, stores: { recordOwnAction: (a: unknown) => out.own.push(a), recordWithdrawFee: (f: unknown) => out.fees.push(f), recordSwap: (r: SwapRecord) => out.swaps.push(r) } };
  };

  test('a same-chain swap-send writes a send record with no recipient and no own-action stamp', () => {
    const { out, stores } = sink();
    recordSameChainSwap({ chainId: CHAIN, txHash: SEND_TX, inputToken: ETH, outputToken: USDC, feeAmount: '10', noteStored: false, sentToOther: true, now: 5 }, stores);
    expect(out.own).toEqual([]);
    expect(out.swaps).toEqual([{ kind: 'send', txHash: SEND_TX, sourceChainId: CHAIN, timestamp: 5, outputChainId: CHAIN, outputToken: USDC }]);
    expect(JSON.stringify(out.swaps)).not.toContain('recipient');
    expect(parseSwapRecords(out.swaps)).toHaveLength(1);
  });

  test('a cross-chain swap-send records the destination, still no recipient', () => {
    const { out, stores } = sink();
    recordCrossChainSwap({ sourceChainId: CHAIN, destinationChainId: 10, txHash: SEND_TX, inputToken: ETH, outputToken: USDC, feeAmount: '0', note: null, noteStored: false, sentToOther: true, now: 5 }, stores);
    expect(out.own).toEqual([]);
    expect(out.swaps[0]).toMatchObject({ kind: 'send', outputChainId: 10 });
  });

  test('a stored send record that names a recipient is dropped', () => {
    expect(parseSwapRecords([{ kind: 'send', txHash: SEND_TX, sourceChainId: CHAIN, timestamp: 1, outputChainId: CHAIN, outputToken: USDC, recipient: RELAY_SWAPS }])).toEqual([]);
  });
});
