// Loose ppAsset shares in the user's OWN wallet (e.g. after a ragequit from a
// yield pool returned the share token rather than the underlying). Pure parts:
// which wallet balances count, the amount text, and which on-chain call turns
// the shares back into something the user recognises.
//
// Call path, per deployment:
//   - `zap` configured: PPYieldTokenZap.redeemToUnderlying(shares, receiver).
//     The zap redeems the share to the aToken and withdraws the plain
//     underlying from Aave in one call. It pulls the shares with transferFrom,
//     so it needs an allowance. For ppETH the underlying is WETH (the zap does
//     not unwrap to native), and the UI says so.
//   - no zap: the share's own ERC-4626 redeem(shares, receiver, owner). The
//     owner is the caller, so no allowance is needed, but the payout is the
//     share's asset(), the Aave aToken, not the plain underlying.
//
// No read here is keyed on a note: balances come from the app's fixed-cadence
// wallet balance poll over a static, config-derived token list.

import type { Address } from 'viem';
import type { YieldDeployment } from '@/services/sdk-types';

export const ZAP_UNWRAP_ABI = [
  {
    type: 'function',
    name: 'redeemToUnderlying',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_shares', type: 'uint256' }, { name: '_receiver', type: 'address' }],
    outputs: [{ name: '_underlyingOut', type: 'uint256' }],
  },
] as const;

export const ERC4626_REDEEM_ABI = [
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
] as const;

export type LooseShare = {
  deployment: YieldDeployment;
  /** Share balance in the wallet, raw units (share decimals). */
  shares: bigint;
};

/** Every configured share the wallet holds a non-zero balance of, in config order, one per share address. */
export function detectLooseShares(
  deployments: readonly YieldDeployment[],
  balances: Readonly<Record<string, bigint>>,
): LooseShare[] {
  const seen = new Set<string>();
  const out: LooseShare[] = [];
  for (const d of deployments) {
    const key = d.ppUSDC.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const shares = balances[key];
    if (typeof shares === 'bigint' && shares > 0n) out.push({ deployment: d, shares });
  }
  return out;
}

/** Share symbol shown to the user: "pp" + the plain asset (ppETH for a native-mode WETH share). */
export function shareSymbol(d: YieldDeployment): string {
  const sym = d.underlyingSymbol;
  return `pp${d.nativeMode && sym.toUpperCase() === 'WETH' ? 'ETH' : sym}`;
}

/** What the user receives: the plain underlying through the zap (WETH for ppETH), the Aave aToken through redeem. */
export function unwrapTargetSymbol(d: YieldDeployment): string {
  return d.zap ? d.underlyingSymbol : `a${d.underlyingSymbol}`;
}

export type UnwrapPlan =
  | {
    kind: 'zap';
    /** Spender the share token must approve before the call. */
    spender: Address;
    call: { address: Address; abi: typeof ZAP_UNWRAP_ABI; functionName: 'redeemToUnderlying'; args: readonly [bigint, Address] };
  }
  | {
    kind: 'redeem';
    spender: null;
    call: { address: Address; abi: typeof ERC4626_REDEEM_ABI; functionName: 'redeem'; args: readonly [bigint, Address, Address] };
  };

/** The call that unwraps `shares` for `owner` (who is also the receiver). */
export function planUnwrap(d: YieldDeployment, shares: bigint, owner: Address): UnwrapPlan {
  if (shares <= 0n) throw new Error('Nothing to unwrap');
  if (d.zap) {
    return {
      kind: 'zap',
      spender: d.zap,
      call: { address: d.zap, abi: ZAP_UNWRAP_ABI, functionName: 'redeemToUnderlying', args: [shares, owner] as const },
    };
  }
  return {
    kind: 'redeem',
    spender: null,
    call: { address: d.ppUSDC, abi: ERC4626_REDEEM_ABI, functionName: 'redeem', args: [shares, owner, owner] as const },
  };
}

/** True when the plan needs an approval first, given the current allowance. */
export function needsApproval(plan: UnwrapPlan, allowance: bigint): boolean {
  return plan.kind === 'zap' && allowance < (plan.call.args[0] as bigint);
}

/** Trimmed decimal string, at most `maxFraction` fraction digits, never rounded up past the balance. */
export function formatShareAmount(raw: bigint, decimals: number, maxFraction = 6): string {
  if (raw < 0n) raw = 0n;
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  let frac = (raw % base).toString().padStart(decimals, '0').slice(0, Math.max(0, maxFraction));
  frac = frac.replace(/0+$/, '');
  if (whole === 0n && frac === '' && raw > 0n) {
    return maxFraction <= 0 ? '<1' : `<0.${'0'.repeat(maxFraction - 1)}1`;
  }
  return frac ? `${whole}.${frac}` : whole.toString();
}
