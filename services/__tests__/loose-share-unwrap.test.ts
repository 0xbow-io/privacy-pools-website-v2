import { describe, expect, test } from 'bun:test';
import { detectLooseShares, formatShareAmount, needsApproval, planUnwrap, shareSymbol, unwrapTargetSymbol } from '../loose-share-unwrap';
import type { YieldDeployment } from '../sdk-types';

const owner = '0x1111111111111111111111111111111111111111' as const;
const deployment: YieldDeployment = {
  ppRouter: owner,
  ppUSDC: '0x2222222222222222222222222222222222222222',
  zap: '0x3333333333333333333333333333333333333333',
  ppUSDCDecimals: 18,
  underlying: '0x4444444444444444444444444444444444444444',
  underlyingDecimals: 6,
  underlyingSymbol: 'USDC',
};

describe('loose wallet shares', () => {
  test('detects only positive configured wallet balances, once per share', () => {
    const other = { ...deployment, ppUSDC: owner };
    expect(detectLooseShares([deployment, deployment, other], {
      [deployment.ppUSDC]: 123n, [owner]: 0n, unconfigured: 456n,
    })).toEqual([{ deployment, shares: 123n }]);
    expect(detectLooseShares([deployment], {})).toEqual([]);
    expect(detectLooseShares([deployment], { [deployment.ppUSDC]: -1n })).toEqual([]);
    const mixed = { ...deployment, ppUSDC: '0xAbCd111111111111111111111111111111111111' as const };
    expect(detectLooseShares([mixed], { [mixed.ppUSDC.toLowerCase()]: 1n })).toHaveLength(1);
  });

  test('formats raw share units without floating point or rounding up', () => {
    expect(formatShareAmount(1234567890123456789n, 18)).toBe('1.234567');
    expect(formatShareAmount(1000000n, 6)).toBe('1');
    expect(formatShareAmount(1n, 18)).toBe('<0.000001');
    expect(formatShareAmount(0n, 18)).toBe('0');
    expect(formatShareAmount(42n, 0)).toBe('42');
    expect(formatShareAmount(99n, 2, 0)).toBe('<1');
    expect(formatShareAmount(9007199254740993000000000000000000n, 18)).toBe('9007199254740993');
  });

  test('zap pulls exact raw shares with approval only below the balance', () => {
    const plan = planUnwrap(deployment, 123n, owner);
    expect(plan.kind).toBe('zap');
    expect(plan.spender).toBe(deployment.zap!);
    expect(plan.call.address).toBe(deployment.zap!);
    expect(plan.call.functionName).toBe('redeemToUnderlying');
    expect(plan.call.args).toEqual([123n, owner]);
    expect(needsApproval(plan, 122n)).toBe(true);
    expect(needsApproval(plan, 123n)).toBe(false);
    expect(needsApproval(plan, 124n)).toBe(false);
    expect(unwrapTargetSymbol(deployment)).toBe('USDC');
  });

  test('fallback redeems shares from and to the wallet without approval', () => {
    const d = { ...deployment, zap: undefined };
    const plan = planUnwrap(d, 123n, owner);
    expect(plan.kind).toBe('redeem');
    expect(plan.spender).toBeNull();
    expect(plan.call.address).toBe(d.ppUSDC);
    expect(plan.call.functionName).toBe('redeem');
    expect(plan.call.args).toEqual([123n, owner, owner]);
    expect(needsApproval(plan, 0n)).toBe(false);
    expect(unwrapTargetSymbol(d)).toBe('aUSDC');
  });

  test('labels ppETH payout as WETH because the zap cannot unwrap native ETH', () => {
    const d = { ...deployment, nativeMode: true, underlyingSymbol: 'WETH', underlyingDecimals: 18 };
    expect(shareSymbol(d)).toBe('ppETH');
    expect(unwrapTargetSymbol(d)).toBe('WETH');
    expect(unwrapTargetSymbol({ ...d, zap: undefined })).toBe('aWETH');
    expect(shareSymbol({ ...deployment, underlyingSymbol: 'USDT' })).toBe('ppUSDT');
    expect(() => planUnwrap(d, 0n, owner)).toThrow('Nothing to unwrap');
    expect(() => planUnwrap(d, -1n, owner)).toThrow('Nothing to unwrap');
  });
});
