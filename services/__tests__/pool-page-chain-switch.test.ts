import { describe, expect, test } from 'bun:test';
import { mustLeavePoolPageToSwitch } from '@/services/pool-page-chain-switch';

describe('mustLeavePoolPageToSwitch (DEV-453)', () => {
  const base = { targetChainId: 4114, targetChainType: 'evm', currentChainId: 56, pathname: '/chains/bsc/bnb' };
  test('another EVM chain from a pool page leaves it first', () => {
    expect(mustLeavePoolPageToSwitch(base)).toBe(true);
  });
  test('the same chain, a non-EVM chain, or off a pool page does not', () => {
    expect(mustLeavePoolPageToSwitch({ ...base, targetChainId: 56 })).toBe(false);
    expect(mustLeavePoolPageToSwitch({ ...base, targetChainType: 'sui' })).toBe(false);
    expect(mustLeavePoolPageToSwitch({ ...base, pathname: '/' })).toBe(false);
  });
});
