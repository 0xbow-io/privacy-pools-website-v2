import { describe, expect, test } from 'bun:test';
import { poolHubTabPath, registerPoolHubHandoff, takePoolHubHandoff } from '@/services/pool-hub-handoff';

describe('pool hub selection handoff', () => {
  test('pool hub navigation selects a tab without issuing a modal deep link', () => {
    expect(poolHubTabPath('/chains/base/eth', 'withdraw')).toBe('/chains/base/eth?hubAction=withdraw');
    expect(poolHubTabPath('/chains/base/eth', 'shield')).toBe('/chains/base/eth');
    const url = poolHubTabPath('/chains/base/eth', 'withdraw', 'opaque-id');
    expect(url).toBe('/chains/base/eth?hubAction=withdraw&hubHandoff=opaque-id');
    expect(url).not.toContain('1.5');
  });
  test('waits for the destination route and chain, then consumes exactly once', () => {
    const selection = { kind: 'pay' as const, symbol: 'LINK', address: '0x1234', decimals: 18, name: 'Chainlink', external: true, amount: '1.5' };
    const id = registerPoolHubHandoff({ pathname: '/chains/base/eth', chainId: 8453, selection });
    expect(takePoolHubHandoff('/chains/ethereum/eth', 8453, id)).toBeNull();
    expect(takePoolHubHandoff('/chains/base/eth', 1, id)).toBeNull();
    // A later unrelated visit to the same route does not have this entry's id.
    expect(takePoolHubHandoff('/chains/base/eth', 8453, null)).toBeNull();
    expect(takePoolHubHandoff('/chains/base/eth', 8453, 'other-entry')).toBeNull();
    expect(takePoolHubHandoff('/chains/base/eth', 8453, id)).toEqual(selection);
    expect(takePoolHubHandoff('/chains/base/eth', 8453, id)).toBeNull();
  });

  test('a later selection supersedes an unconsumed one', () => {
    const first = registerPoolHubHandoff({ pathname: '/chains/base/eth', chainId: 8453, selection: { kind: 'request', address: '0x01' } });
    const second = registerPoolHubHandoff({ pathname: '/chains/bsc/bnb', chainId: 56, selection: { kind: 'request', address: '0x02' } });
    expect(takePoolHubHandoff('/chains/base/eth', 8453, first)).toBeNull();
    expect(takePoolHubHandoff('/chains/bsc/bnb', 56, second)).toEqual({ kind: 'request', address: '0x02' });
  });

  test('expires a pending selection even when its route and id match', () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 1_000;
      const id = registerPoolHubHandoff({ pathname: '/chains/base/eth', chainId: 8453, selection: { kind: 'request', address: '0x03' } });
      Date.now = () => 31_001;
      expect(takePoolHubHandoff('/chains/base/eth', 8453, id)).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });
});
