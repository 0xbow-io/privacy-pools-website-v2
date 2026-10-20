import { useMemo } from 'react';
import { formatUnits } from 'viem';
import { getConfiguredYieldDeploymentForAsset, getConfiguredYieldDeployments } from '@/config/yield';
import { useShareRates } from '@/hooks/use-share-rates';
import { shareExactAsUnderlying } from '@/services/share-rates';
import { NoteStatus } from '@/services/sdk-types';
import type { Note, YieldDeployment } from '@/services/sdk-types';

/** One chain can carry several vaults (mainnet: ppUSDC AND ppUSDT). */
export type YieldPositionValue = {
  deployment: YieldDeployment;
  /** ACTIVE shares held, share base units. */
  shares: bigint;
  /** Shares not yet active. Carried separately and never spendable. */
  pendingShares: bigint;
  /** Live vault rate applied locally to ACTIVE shares, underlying whole units. */
  redeemableValue: number;
  /** shares > 0 — ownership, independent of whether the value is known. */
  hasShares: boolean;
};

export type RedeemableYieldResult = {
  /**
   * The deployment this result is SCOPED to when `asset` was given; the first
   * configured one otherwise. Read `positions` for the per-vault breakdown — a
   * chain can carry more than one vault and this field names only one of them.
   */
  deployment: YieldDeployment | undefined;
  /**
   * TOTAL redeemable underlying value (e.g. USDC) of the account's shielded
   * ppUSDC notes, from the router's ERC-4626 `convertToAssets(1 share)` — principal PLUS
   * whatever yield has accrued, valued at the live exchange rate. We surface
   * the honest total, NOT a fabricated principal/yield split (codex findings
   * 2 & 3): without a persisted per-note deposit cost basis we cannot know how
   * much of this value is the user's earned yield vs their principal.
   *
   * Scoped to `asset` when given. UNSCOPED it sums every vault on the chain,
   * which only makes sense as a value total — never as a per-asset balance,
   * because the units differ per vault. Per-asset callers MUST pass `asset`.
   */
  redeemableValue: number;
  /** True when the account holds active shares in the covered deployment(s). */
  hasYieldNotes: boolean;
  /**
   * The public vault rate is still in flight for OWNED shares — the zero in
   * `redeemableValue` means "unknown", not "no position". Always false when
   * there are no shares (nothing to load).
   */
  isValueLoading: boolean;
  /** The public vault rate is unavailable for owned shares — value unavailable, not zero. */
  isValueError: boolean;
  /** Every covered vault the account holds active OR pending shares in. */
  positions: YieldPositionValue[];
};

function isActiveNote(note: Note): boolean {
  const status = String(note.status);
  return status === 'active' || status === 'ACTIVE' || note.status === NoteStatus.ACTIVE;
}

function isPendingNote(note: Note): boolean {
  const status = String(note.status);
  return status === 'pending' || status === 'PENDING' || note.status === NoteStatus.PENDING;
}

/**
 * Total redeemable underlying value of the account's shielded yield-share
 * notes, read from each vault's ERC-4626 surface (`convertToAssets(1 share)`) — the same
 * interactor read the SDK's yield sessions use. Behind the feature gate; every
 * failure mode (gated off, no notes, RPC error, missing contract) degrades to
 * a zero-state so the UI simply omits the yield lines.
 *
 * Pass `asset` (an underlying OR a share address) on any surface that shows a
 * SINGLE asset's position. Without it the hook covered only the chain's first
 * vault, so on mainnet — where ppUSDC and ppUSDT both exist — a USDT surface
 * was handed the user's ppUSDC value and labelled it USDT (codex, 2026-09-04).
 */
export function useRedeemableYield(params: {
  chainId: number;
  notes: Note[];
  enabled?: boolean;
  /**
   * Scope to the vault for this asset (its underlying, e.g. USDT, or its
   * share, e.g. ppUSDT). Omit only when the caller genuinely wants every vault
   * on the chain (the portfolio total).
   */
  asset?: string | undefined;
}): RedeemableYieldResult {
  const { chainId, notes, enabled = true, asset } = params;

  // The covered set: one vault when scoped by asset, otherwise all configured
  // vaults on the chain. Classification does not depend on the transaction probe.
  const scoped = getConfiguredYieldDeploymentForAsset(chainId, asset);
  const all = getConfiguredYieldDeployments(chainId);
  // The config resolvers rebuild their arrays on every render, so the memo is
  // keyed on the stable address list rather than on object identity.
  const deploymentsKey = asset
    ? (scoped?.ppUSDC.toLowerCase() ?? '')
    : all.map((d) => d.ppUSDC.toLowerCase()).join(',');
  const deployments = useMemo(
    () => (asset ? (scoped ? [scoped] : []) : all),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chainId, deploymentsKey],
  );

  // Shared public vault reads are independent of holdings and probe state.
  const { rateFor, loading } = useShareRates();

  // Active + pending shares per vault, keyed by the share address.
  const held = useMemo(() => {
    const byShare = new Map<string, { active: bigint; pending: bigint }>();
    if (deployments.length === 0) return byShare;
    for (const d of deployments) byShare.set(d.ppUSDC.toLowerCase(), { active: 0n, pending: 0n });
    for (const note of notes) {
      const entry = byShare.get(String(note.tokenId || '').toLowerCase());
      if (!entry) continue;
      const active = isActiveNote(note);
      if (!active && !isPendingNote(note)) continue;
      try {
        const value = BigInt(note.value);
        if (active) entry.active += value;
        else entry.pending += value;
      } catch {
        // malformed note value — skip
      }
    }
    return byShare;
  }, [notes, deployments]);

  const positions = useMemo<YieldPositionValue[]>(() => {
    const out: YieldPositionValue[] = [];
    for (const deployment of deployments) {
      const key = deployment.ppUSDC.toLowerCase();
      const entry = held.get(key) ?? { active: 0n, pending: 0n };
      if (entry.active === 0n && entry.pending === 0n) continue;
      const rate = enabled ? rateFor(chainId, deployment.ppUSDC) : undefined;
      const redeemableValue = rate
        ? shareExactAsUnderlying(formatUnits(entry.active, deployment.ppUSDCDecimals), rate) ?? 0
        : 0;
      out.push({
        deployment,
        shares: entry.active,
        pendingShares: entry.pending,
        redeemableValue,
        hasShares: entry.active > 0n,
      });
    }
    return out;
  }, [deployments, held, enabled, rateFor, chainId]);

  const hasYieldNotes = positions.some((p) => p.hasShares);
  const missingRate = positions.some((p) => p.hasShares && !rateFor(chainId, p.deployment.ppUSDC));
  const redeemableValue = useMemo(
    () => positions.reduce((sum, p) => sum + p.redeemableValue, 0),
    [positions],
  );
  const covered = enabled && deployments.length > 0;
  return {
    deployment: asset ? scoped : deployments[0],
    redeemableValue,
    hasYieldNotes,
    // Missing rates are unavailable; a disabled surface is never loading.
    isValueLoading: hasYieldNotes && covered && missingRate && loading,
    isValueError: hasYieldNotes && covered && missingRate && !loading,
    positions,
  };
}
