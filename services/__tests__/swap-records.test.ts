import { describe, expect, test } from 'bun:test';
import {
  MAX_SWAP_RECORDS, findSwapRecordIn, parseSwapRecords, upsertSwapRecord, withDeliveryOutcome, type SwapRecord,
} from '../swap-records-core';
import { recordCrossChainDelivery, recordCrossChainSwap, recordReceiveAs, recordShieldSwap } from '../swap-bookkeeping';
import type { OwnAction } from '../own-actions-core';
import type { WithdrawFee } from '../withdraw-fees-core';

const h32 = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const TX = h32(0x5a);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const cross: SwapRecord = { kind: 'cross-chain', txHash: TX, sourceChainId: 1, timestamp: 1, outputChainId: 56, outputToken: USDC, commitment: h32(0xc4), value: '1248000000' };

function sink() {
  const actions: OwnAction[] = [];
  const fees: WithdrawFee[] = [];
  let records: SwapRecord[] = [];
  return {
    actions, fees, get records() { return records; },
    stores: {
      recordOwnAction: (a: OwnAction) => actions.push(a),
      recordWithdrawFee: (f: WithdrawFee) => fees.push(f),
      recordSwap: (r: SwapRecord) => { records = upsertSwapRecord(records, r); },
      recordSwapDelivery: (u: Parameters<typeof withDeliveryOutcome>[1]) => { records = withDeliveryOutcome(records, u); },
    },
  };
}

describe('swap records', () => {
  test('parse drops malformed rows and keeps valid ones', () => {
    const rows = parseSwapRecords([cross, { ...cross, txHash: '0x12' }, { ...cross, kind: 'nope' }, { ...cross, value: '-1' }, null, 'x']);
    expect(rows).toEqual([cross]);
    expect(parseSwapRecords({})).toEqual([]);
  });

  test('keyed by source chain and hash: a re-record replaces, another chain coexists', () => {
    let list = upsertSwapRecord([], cross);
    list = upsertSwapRecord(list, { ...cross, txHash: TX.toUpperCase().replace('0X', '0x'), value: '1' });
    list = upsertSwapRecord(list, { ...cross, sourceChainId: 10 });
    expect(list).toHaveLength(2);
    expect(findSwapRecordIn(list, 1, TX)?.kind === 'cross-chain' && (findSwapRecordIn(list, 1, TX) as typeof cross).value).toBe('1');
    expect(findSwapRecordIn(list, 56, TX)).toBeNull();
  });

  test('a stored list past the bound reads as its newest entries; an oversized amount is malformed', () => {
    const stored = Array.from({ length: MAX_SWAP_RECORDS + 1 }, (_, i) => ({ ...cross, txHash: h32(i + 1) }));
    const parsed = parseSwapRecords(stored);
    expect(parsed).toHaveLength(MAX_SWAP_RECORDS);
    expect(findSwapRecordIn(parsed, 1, h32(1))).toBeNull();
    expect(parseSwapRecords([{ ...cross, value: '9'.repeat(79) }])).toEqual([]);
  });

  test('bounded: the oldest falls out', () => {
    let list: SwapRecord[] = [];
    for (let i = 0; i < MAX_SWAP_RECORDS + 3; i++) list = upsertSwapRecord(list, { ...cross, txHash: h32(i + 1) });
    expect(list).toHaveLength(MAX_SWAP_RECORDS);
    expect(findSwapRecordIn(list, 1, h32(1))).toBeNull();
    expect(findSwapRecordIn(list, 1, h32(MAX_SWAP_RECORDS + 3))).not.toBeNull();
  });

  test('a delivery outcome lands only on the recorded cross-chain swap', () => {
    const receiveAs: SwapRecord = { kind: 'receive-as', txHash: h32(0x77), sourceChainId: 1, timestamp: 1, outputChainId: 1, outputToken: USDC, quotedOutput: '5' };
    const list = withDeliveryOutcome([cross, receiveAs], { sourceChainId: 1, txHash: TX, outcome: 'deposited', destinationTxHash: h32(0xde) });
    expect(list[0]).toEqual({ ...cross, outcome: 'deposited', destinationTxHash: h32(0xde) });
    expect(list[1]).toEqual(receiveAs);
    expect(withDeliveryOutcome([receiveAs], { sourceChainId: 1, txHash: h32(0x77), outcome: 'failed' })).toEqual([receiveAs]);
    expect(withDeliveryOutcome([cross], { sourceChainId: 10, txHash: TX, outcome: 'failed' })).toEqual([cross]);
  });
});

describe('swap bookkeeping per send path', () => {
  test('cross-chain Swap: fee in the input token, the record, and the stamp on the destination', () => {
    const s = sink();
    recordCrossChainSwap({ sourceChainId: 1, destinationChainId: 56, txHash: TX, inputToken: ETH, outputToken: USDC, feeAmount: '600', note: { commitment: '0xC4', value: '0x4a6366e00' }, noteStored: true, now: 9 }, s.stores);
    expect(s.fees.map((f) => [f.kind, f.chainId, f.tokenAddress])).toEqual([['swap', 1, ETH]]);
    expect(s.records).toEqual([{ kind: 'cross-chain', txHash: TX, sourceChainId: 1, timestamp: 9, outputChainId: 56, outputToken: USDC, commitment: h32(0xc4), value: '19968454144' }]);
    expect(s.actions).toEqual([{ kind: 'swap', chainId: 56, txHash: TX, tokenId: USDC, timestamp: 9 }]);
  });

  test('cross-chain Swap whose note was not stored keeps the record, never the stamp; no note, no record', () => {
    const s = sink();
    recordCrossChainSwap({ sourceChainId: 1, destinationChainId: 56, txHash: TX, inputToken: ETH, outputToken: USDC, feeAmount: '0', note: { commitment: h32(0xc4), value: '5' }, noteStored: false, now: 9 }, s.stores);
    expect([s.records.length, s.actions.length, s.fees.length]).toEqual([1, 0, 0]);
    const t = sink();
    recordCrossChainSwap({ sourceChainId: 1, destinationChainId: 56, txHash: TX, inputToken: ETH, outputToken: USDC, feeAmount: '1', note: null, noteStored: false, now: 9 }, t.stores);
    expect(t.records).toHaveLength(0);
  });

  test('the delivery outcome update', () => {
    const s = sink();
    recordCrossChainSwap({ sourceChainId: 1, destinationChainId: 56, txHash: TX, inputToken: ETH, outputToken: USDC, feeAmount: '1', note: { commitment: h32(0xc4), value: '5' }, noteStored: true, now: 9 }, s.stores);
    recordCrossChainDelivery({ sourceChainId: 1, txHash: TX.toUpperCase().replace('0X', '0x'), outcome: 'refunded' }, s.stores);
    expect((s.records[0] as typeof cross).outcome).toBe('refunded');
    recordCrossChainDelivery({ sourceChainId: 1, txHash: null, outcome: 'failed' }, s.stores);
    expect((s.records[0] as typeof cross).outcome).toBe('refunded');
  });

  test('receive-as, normal or after a receipt timeout: own withdrawal, its fee, the quoted payout', () => {
    const s = sink();
    recordReceiveAs({ sourceChainId: 1, destinationChainId: 56, txHash: TX, inputToken: ETH, outputToken: USDC, feeAmount: '600', quotedOutput: '0x4a817c800', now: 3 }, s.stores);
    expect(s.actions).toEqual([{ kind: 'withdraw', chainId: 1, txHash: TX, timestamp: 3 }]);
    expect(s.fees.map((f) => f.kind)).toEqual(['withdrawal']);
    expect(s.records).toEqual([{ kind: 'receive-as', txHash: TX, sourceChainId: 1, timestamp: 3, outputChainId: 56, outputToken: USDC, quotedOutput: '20000000000' }]);
  });

  test('Shield swap-and-shield is a shield on the deposit chain with what the wallet paid', () => {
    const s = sink();
    recordShieldSwap({ sourceChainId: 1, depositChainId: 56, txHash: TX, inputToken: ETH, estimatedInput: '0x6f05b59d3b20000', note: { commitment: h32(0xc9) }, now: 4 }, s.stores);
    expect(s.actions).toEqual([{ kind: 'shield', chainId: 56, txHash: TX, timestamp: 4 }]);
    expect(s.records).toEqual([{ kind: 'shield', txHash: TX, sourceChainId: 1, timestamp: 4, depositChainId: 56, inputToken: ETH, estimatedInput: '500000000000000000', commitment: h32(0xc9) }]);
  });

  test('same-chain Shield swap-and-shield: a shield on the source chain', () => {
    const s = sink();
    recordShieldSwap({ sourceChainId: 1, depositChainId: 1, txHash: TX, inputToken: ETH, estimatedInput: '7', note: { commitment: h32(0xc9) }, now: 4 }, s.stores);
    expect(s.actions).toEqual([{ kind: 'shield', chainId: 1, txHash: TX, timestamp: 4 }]);
    expect(s.records.map((r) => [r.kind, r.sourceChainId, (r as { depositChainId: number }).depositChainId])).toEqual([['shield', 1, 1]]);
  });

  test('no hash (a rejected or reverted send never reaches here with one) writes nothing', () => {
    const s = sink();
    recordCrossChainSwap({ sourceChainId: 1, destinationChainId: 56, txHash: null, inputToken: ETH, outputToken: USDC, feeAmount: '1', note: { commitment: h32(1), value: '1' }, noteStored: true, now: 1 }, s.stores);
    recordReceiveAs({ sourceChainId: 1, destinationChainId: 1, txHash: null, inputToken: ETH, outputToken: USDC, feeAmount: '1', quotedOutput: '1', now: 1 }, s.stores);
    recordShieldSwap({ sourceChainId: 1, depositChainId: 1, txHash: null, inputToken: ETH, estimatedInput: '1', note: { commitment: h32(1) }, now: 1 }, s.stores);
    expect(s.actions.length + s.fees.length + s.records.length).toBe(0);
  });
});
