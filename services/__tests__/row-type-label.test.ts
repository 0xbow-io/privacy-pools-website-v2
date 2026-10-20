import { describe, expect, test } from 'bun:test';
import { rowTypeLabel } from '../row-type-label';
import { SWAP_DELIVERING_COPY, SWAP_PENDING_COPY, swapPendingLabel } from '../swap-rows';

const out = { chainId: 1, chain: 'Ethereum', asset: 'USDC', tokenAddress: '0xa0', rawAmount: '1', tokenAmount: 1, usdValue: 1, txHash: '0x1', labels: ['0x01'], commitments: ['0x02'], sourceLabels: [] };

describe('row type label', () => {
  test('a row reads its own type; nothing is renamed Reshield', () => {
    expect(rowTypeLabel({ type: 'Swap' })).toBe('Swap');
    expect(rowTypeLabel({ type: 'Deposit' })).toBe('Deposit');
    expect(rowTypeLabel({ type: 'Withdrawal' })).toBe('Withdrawal');
  });

  test('a transfer of known direction says which way', () => {
    expect(rowTypeLabel({ type: 'Transfer', direction: 'in' })).toBe('Transfer In');
    expect(rowTypeLabel({ type: 'Transfer', direction: 'out' })).toBe('Transfer Out');
    expect(rowTypeLabel({ type: 'Transfer' })).toBe('Transfer');
  });
});

describe('swap pending copy', () => {
  test('only a pending Swap row explains its wait', () => {
    expect(swapPendingLabel({ type: 'Swap', status: 'pending', swapOut: out })).toBe(SWAP_PENDING_COPY);
    expect(swapPendingLabel({ type: 'Swap', status: 'pending', swapOut: { ...out, delivering: true } })).toBe(SWAP_DELIVERING_COPY);
    expect(swapPendingLabel({ type: 'Swap', status: 'completed', swapOut: out })).toBeNull();
    expect(swapPendingLabel({ type: 'Deposit', status: 'pending' })).toBeNull();
    expect(swapPendingLabel({ type: 'Withdrawal', status: 'pending' })).toBeNull();
  });

  test('the copy uses no em dash and never says Reshield', () => {
    for (const copy of [SWAP_PENDING_COPY, SWAP_DELIVERING_COPY]) {
      expect(copy).not.toContain('—');
      expect(copy.toLowerCase()).not.toContain('reshield');
    }
  });
});

describe('swap boundary labels', () => {
  test('recorded deposit and withdrawal swaps keep their boundary type', () => {
    expect(rowTypeLabel({ type: 'Deposit', swappedFrom: out })).toBe('Deposit via swap');
    expect(rowTypeLabel({ type: 'Withdrawal', receivedAs: out })).toBe('Withdrawal via swap');
    expect(rowTypeLabel({ type: 'Withdrawal', viaSwap: true })).toBe('Withdrawal via swap');
    expect(rowTypeLabel({ type: 'Swap', receivedAs: out })).toBe('Swap');
  });

  test('the ASP funding tag never names a swap: it is a LI.FI lookup, not chain evidence', () => {
    for (const fundingSource of ['pool', 'bridged_pool', 'wallet', 'bridged_wallet']) {
      expect(rowTypeLabel({ type: 'Deposit', fundingSource } as Parameters<typeof rowTypeLabel>[0])).toBe('Deposit');
    }
  });

  test('a deposit made for someone else reads Deposit to recipient, however it was paid for', () => {
    expect(rowTypeLabel({ type: 'Deposit', authored: true })).toBe('Deposit to recipient');
    expect(rowTypeLabel({ type: 'Deposit', authored: true, swappedFrom: out })).toBe('Deposit to recipient');
    expect(rowTypeLabel({ type: 'Withdrawal', authored: true })).toBe('Withdrawal');
  });

  test('All keeps deposit labels neutral while Mine and details name the payer', () => {
    expect(rowTypeLabel({ type: 'Deposit', authored: true, scope: 'all' })).toBe('Deposit');
    expect(rowTypeLabel({ type: 'Deposit', authored: true, scope: 'mine' })).toBe('Deposit to recipient');
    expect(rowTypeLabel({ type: 'Deposit', authored: true })).toBe('Deposit to recipient');
  });
});
