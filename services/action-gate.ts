// Stage-aware action gating (Withdraw / Transfer) — pure and fail-open.
//
// Only a CONFIRMED zero spendable balance may disable the actions:
//  - pending funds are NOT spendable, so they are excluded by construction
//    (callers pass the pools' exact ACTIVE balances only);
//  - dust below the 4-decimal display rounding still counts as funds, so the
//    check runs on the exact decimal strings (`balanceTokenExact`), never the
//    rounded display values;
//  - while balances are still loading (or a value is unparseable) the state
//    is unknown, and unknown must never present as confirmed zero.

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** True when `value` is a well-formed decimal string strictly above zero. */
export function hasPositiveDecimal(value: string | null | undefined): boolean {
  const trimmed = (value ?? '').trim();
  return DECIMAL_RE.test(trimmed) && /[1-9]/.test(trimmed);
}

/**
 * Whether the funded actions should be greyed out.
 *
 * @param connected active-chain connection (EVM via wagmi OR Sui via the
 *   Wallet Standard — use useMultiChainWallet().isConnected, not the
 *   EVM-only wagmi flag, or a Sui-only session never gates).
 * @param balancesLoading notes/balances still hydrating → unknown → enabled.
 * @param activeBalancesExact exact ACTIVE (spendable) balance per pool as
 *   decimal strings; pending balances must not be included.
 */
export function fundedActionsDisabled(params: {
  connected: boolean;
  balancesLoading: boolean;
  activeBalancesExact: Array<string | null | undefined>;
}): boolean {
  const { connected, balancesLoading, activeBalancesExact } = params;
  if (!connected || balancesLoading) return false;
  for (const value of activeBalancesExact) {
    const trimmed = (value ?? '').trim();
    // Unparseable balance → unknown, fail open (never disable on bad data).
    if (!DECIMAL_RE.test(trimmed)) return false;
    if (/[1-9]/.test(trimmed)) return false;
  }
  // Every balance parsed and equals zero → confirmed nothing to spend.
  return true;
}
