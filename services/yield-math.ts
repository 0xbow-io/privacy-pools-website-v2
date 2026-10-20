// Pure math + state helpers for the Aave yield module UI.
// No React/React Native imports — unit-tested in services/__tests__.

/**
 * Review-deposit total: the entered amount, plus the non-yield-pool fee when
 * the user opted OUT of the yield pool. The caller passes 0 for the fee unless
 * it is BOTH configured and enforced on-chain (see yieldOptOutFeeActive) — the
 * UI must never advertise a fee no transaction charges (codex finding 4).
 */
export function computeDepositTotal(
  amount: number,
  yieldOptIn: boolean,
  optOutFee: number,
): number {
  if (!(amount > 0)) return 0;
  return yieldOptIn ? amount : amount + Math.max(0, optOutFee);
}

/** Tab the FullWithdrawalGuard escape hatch resets the selection to. */
export const FULL_WITHDRAWAL_ESCAPE_TAB = '75%';

/**
 * Integer-unit percentage of a base-unit balance (codex finding 6: percentage
 * tabs must be computed in bigint, not by flooring a float to 4 decimals).
 * `pct` is a whole percentage (25/50/75/100).
 */
export function percentOfWei(availableWei: bigint, pct: number): bigint {
  if (availableWei <= 0n || pct <= 0) return 0n;
  const p = BigInt(Math.round(pct));
  return (availableWei * p) / 100n;
}

/**
 * True when the current selection withdraws the ENTIRE available balance in one
 * transaction. Exact and fee-aware, in token base units (codex finding 6):
 * `grossLeavingWei` is the total leaving the selected lineage (entered + relayer
 * fee in receive-exact mode), compared against the per-withdrawal cap.
 */
export function isFullWithdrawalSelectionWei(params: {
  grossLeavingWei: bigint;
  totalBalanceWei: bigint;
}): boolean {
  const { grossLeavingWei, totalBalanceWei } = params;
  if (totalBalanceWei <= 0n || grossLeavingWei <= 0n) return false;
  return grossLeavingWei >= totalBalanceWei;
}

export type FullWithdrawalGuardState = {
  /** Selection is at 100% — red tab + warning box + CTA gate are active. */
  tripped: boolean;
  /** User ticked the acknowledgment checkbox (only meaningful while tripped). */
  acknowledged: boolean;
};

export const INITIAL_GUARD_STATE: FullWithdrawalGuardState = {
  tripped: false,
  acknowledged: false,
};

export type FullWithdrawalGuardEvent =
  | { type: 'selection'; full: boolean }
  | { type: 'ack'; value: boolean }
  | { type: 'escape' }
  | { type: 'reset' };

/**
 * FullWithdrawalGuard transitions (codex finding 7 — consent is never stale):
 * - selection → tripped = full, AND acknowledgment ALWAYS cleared. Every new
 *   selection (typed, tab, repeated 100%, token change, reopen) requires fresh
 *   consent, so a prior ack can never carry across a selection change.
 * - ack       → only recorded while tripped.
 * - escape / reset → clears the guard (escape also resets the amount to 75%).
 */
export function guardNext(
  state: FullWithdrawalGuardState,
  event: FullWithdrawalGuardEvent,
): FullWithdrawalGuardState {
  switch (event.type) {
    case 'selection':
      return { tripped: event.full, acknowledged: false };
    case 'ack':
      if (!state.tripped) return state;
      return { ...state, acknowledged: event.value };
    case 'escape':
    case 'reset':
      return { tripped: false, acknowledged: false };
  }
}

/** CTA gate: disabled until the tripped guard is acknowledged. */
export function guardBlocksCta(state: FullWithdrawalGuardState): boolean {
  return state.tripped && !state.acknowledged;
}
