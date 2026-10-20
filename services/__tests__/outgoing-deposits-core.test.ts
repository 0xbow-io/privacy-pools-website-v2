import { describe, expect, test } from 'bun:test';
import {
  MAX_OUTGOING_DEPOSITS,
  parseOutgoingDeposits,
  toOutgoingDepositTxHashSet,
  upsertOutgoingDeposit,
  type OutgoingDeposit,
} from '../outgoing-deposits-core';

const TX = `0x${'ab'.repeat(32)}`;
const TX2 = `0x${'cd'.repeat(32)}`;
const entry = (over: Partial<OutgoingDeposit> = {}): OutgoingDeposit => ({
  payer: '0xD3F927692168c7912189d95B1fB073eB0394dB15',
  chainId: 11155111,
  txHash: TX,
  kind: 'deposit-for',
  timestamp: 1,
  ...over,
});

describe('parseOutgoingDeposits', () => {
  test('tolerates garbage and drops malformed entries', () => {
    expect(parseOutgoingDeposits(null)).toEqual([]);
    expect(parseOutgoingDeposits('not json')).toEqual([]);
    expect(parseOutgoingDeposits('{"a":1}')).toEqual([]);
    const raw = JSON.stringify([entry(), { payer: 'x', txHash: '0x12', kind: 'deposit-for', chainId: 1, timestamp: 1 }, { kind: 'other' }]);
    expect(parseOutgoingDeposits(raw)).toHaveLength(1);
  });

  test('normalizes payer and tx hash to lowercase', () => {
    const [d] = parseOutgoingDeposits(JSON.stringify([entry({ txHash: TX.toUpperCase().replace('0X', '0x') })]));
    expect(d.payer).toBe('0xd3f927692168c7912189d95b1fb073eb0394db15');
    expect(d.txHash).toBe(TX);
  });

  test('stores no recipient and no amount (shape is tx-hash only)', () => {
    const [d] = parseOutgoingDeposits(JSON.stringify([{ ...entry(), recipient: '0xsomeone', amount: '1' }]));
    expect(Object.keys(d).sort()).toEqual(['chainId', 'kind', 'payer', 'timestamp', 'txHash']);
  });
});

describe('upsertOutgoingDeposit', () => {
  test('replaces by tx hash and bounds the list', () => {
    let list = upsertOutgoingDeposit([], entry({ timestamp: 1 }));
    list = upsertOutgoingDeposit(list, entry({ timestamp: 2 }));
    expect(list).toHaveLength(1);
    expect(list[0].timestamp).toBe(2);
    for (let i = 0; i < MAX_OUTGOING_DEPOSITS + 5; i += 1) {
      list = upsertOutgoingDeposit(list, entry({ txHash: `0x${i.toString(16).padStart(64, '0')}` }));
    }
    expect(list).toHaveLength(MAX_OUTGOING_DEPOSITS);
  });
});

describe('toOutgoingDepositTxHashSet', () => {
  const list = [entry(), entry({ txHash: TX2, chainId: 1 }), entry({ txHash: `0x${'ef'.repeat(32)}`, payer: '0x1111111111111111111111111111111111111111' })];

  test('scopes to payer (case-insensitive) and optionally chain', () => {
    expect([...toOutgoingDepositTxHashSet(list, '0xd3f927692168c7912189d95b1fb073eb0394db15')].sort()).toEqual([TX, TX2].sort());
    expect([...toOutgoingDepositTxHashSet(list, '0xD3F927692168c7912189d95B1fB073eB0394dB15', 11155111)]).toEqual([TX]);
    expect(toOutgoingDepositTxHashSet(list, null).size).toBe(0);
    expect(toOutgoingDepositTxHashSet(list, '0x2222222222222222222222222222222222222222').size).toBe(0);
  });
});
