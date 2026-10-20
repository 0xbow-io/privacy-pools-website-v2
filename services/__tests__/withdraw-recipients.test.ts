import { describe, expect, test } from 'bun:test';
import { MAX_WITHDRAW_RECIPIENTS, findWithdrawRecipientIn, parseWithdrawRecipients, upsertWithdrawRecipient, type WithdrawRecipient } from '../withdraw-recipients-core';
import { recordOwnWithdrawal } from '../withdraw-bookkeeping';
import { recordReceiveAs } from '../swap-bookkeeping';
import { debugSafeRow } from '../swap-rows';
import type { OwnAction } from '../own-actions-core';
import type { WithdrawFee } from '../withdraw-fees-core';

const h32 = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const WALLET = '0x71C2000000000000000000000000000000009FA3';
const row: WithdrawRecipient = { txHash: h32(1), chainId: 1, recipient: WALLET.toLowerCase(), timestamp: 1 };

function sink() {
  const actions: OwnAction[] = []; const fees: WithdrawFee[] = []; let recipients: WithdrawRecipient[] = [];
  return {
    actions, fees, get recipients() { return recipients; },
    stores: {
      recordOwnAction: (a: OwnAction) => actions.push(a),
      recordWithdrawFee: (f: WithdrawFee) => fees.push(f),
      recordWithdrawRecipient: (r: WithdrawRecipient) => { recipients = upsertWithdrawRecipient(recipients, r); },
    },
  };
}

describe('withdraw recipients', () => {
  test('parse keeps valid rows only; keyed by chain and hash; bounded', () => {
    expect(parseWithdrawRecipients([row, { ...row, recipient: 'nope' }, { ...row, txHash: '0x1' }, null])).toEqual([row]);
    let list = upsertWithdrawRecipient([], row);
    list = upsertWithdrawRecipient(list, { ...row, recipient: '0x' + '2'.repeat(40) });
    list = upsertWithdrawRecipient(list, { ...row, chainId: 56 });
    expect(list).toHaveLength(2);
    expect(findWithdrawRecipientIn(list, h32(1).toUpperCase().replace('0X', '0x'), 1)).toBe('0x' + '2'.repeat(40));
    let many: WithdrawRecipient[] = [];
    for (let i = 0; i < MAX_WITHDRAW_RECIPIENTS + 2; i++) many = upsertWithdrawRecipient(many, { ...row, txHash: h32(i + 10) });
    expect(many).toHaveLength(MAX_WITHDRAW_RECIPIENTS);
    expect(findWithdrawRecipientIn(many, h32(10))).toBeNull();
    const stored = Array.from({ length: MAX_WITHDRAW_RECIPIENTS + 1 }, (_, i) => ({ ...row, txHash: h32(i + 10) }));
    expect(parseWithdrawRecipients(stored)).toHaveLength(MAX_WITHDRAW_RECIPIENTS);
  });

  test('a confirmed plain withdrawal stamps the action, its fee and its recipient', () => {
    const s = sink();
    recordOwnWithdrawal({ chainId: 1, txHash: h32(1).toUpperCase().replace('0X', '0x'), recipient: WALLET, tokenAddress: '0xeeee', feeAmount: 600n, stampOwnAction: true, now: 2 }, s.stores);
    expect(s.actions).toEqual([{ kind: 'withdraw', chainId: 1, txHash: h32(1), timestamp: 2 }]);
    expect(s.fees.map((f) => [f.txHash, f.feeAmount, f.kind])).toEqual([[h32(1), '600', 'withdrawal']]);
    expect(s.recipients).toEqual([{ ...row, timestamp: 2 }]);
  });

  test('the batch path stamps no own action; no hash writes nothing', () => {
    const s = sink();
    recordOwnWithdrawal({ chainId: 1, txHash: h32(1), recipient: WALLET, tokenAddress: '0xeeee', feeAmount: '1', stampOwnAction: false, now: 2 }, s.stores);
    expect([s.actions.length, s.fees.length, s.recipients.length]).toEqual([0, 1, 1]);
    const t = sink();
    recordOwnWithdrawal({ chainId: 1, txHash: null, recipient: WALLET, tokenAddress: '0xeeee', feeAmount: '1', stampOwnAction: true, now: 2 }, t.stores);
    expect(t.actions.length + t.fees.length + t.recipients.length).toBe(0);
  });

  test('receive-as records the wallet its payout went to', () => {
    const s = sink();
    recordReceiveAs({ sourceChainId: 1, destinationChainId: 1, txHash: h32(1), inputToken: '0xeeee', outputToken: '0xa0b8', feeAmount: '1', quotedOutput: '5', recipient: WALLET, now: 3 }, s.stores);
    expect(s.recipients).toEqual([{ ...row, timestamp: 3 }]);
  });

  test('a recorded recipient never reaches a debug snapshot; a feed address does', () => {
    const lineage = debugSafeRow({ type: 'Withdrawal', isLineageSynthetic: true, address: '0x71c2...9fa3', fullAddress: WALLET });
    const copied = debugSafeRow({ type: 'Withdrawal', recordedRecipient: true, address: '0x71c2...9fa3', fullAddress: WALLET });
    const feed = debugSafeRow({ type: 'Withdrawal', address: '0x71c2...9fa3', fullAddress: WALLET });
    expect([lineage.fullAddress, copied.fullAddress, feed.fullAddress]).toEqual(['', '', WALLET]);
  });

  test('a recorded transfer payee never reaches a debug snapshot', () => {
    const sent = debugSafeRow({ type: 'Transfer', isLineageSynthetic: true, address: '0x71c2...9fa3', fullAddress: WALLET });
    expect([sent.address, sent.fullAddress]).toEqual(['', '']);
  });
});
