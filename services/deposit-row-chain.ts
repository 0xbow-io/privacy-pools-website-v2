/**
 * Per-chain policy for a deposit row in My transactions.
 *
 * The balance has been multichain since 2026-08-18 (the active chain from the
 * live session, every other chain from its own stored export), but the deposit
 * ROW matcher stayed single-chain: it matched every deposit event, whatever
 * chain it happened on, against the ACTIVE chain's notes and gated it on the
 * ACTIVE chain's association set. Two consequences, both of which Pat saw on
 * 2026-08-28 as "all OP tx show pending":
 *
 *   1. An Optimism deposit can never match a note, because Optimism's notes are
 *      not in the active session — so every one of them fell into the
 *      "approved on-chain, absent on this device" branch and rendered pending
 *      forever, while the balance counted the same funds correctly.
 *   2. Even a matched note would be gated on the wrong association set: an
 *      Optimism label is not published in Sepolia's leaves, so `leafReady &&
 *      !leafConfirmed` forced pending a second time.
 *
 * Matching is now scoped to the row's OWN chain, and this decides the two
 * policies that follow. The leaf gate applies only on the active chain — the
 * same rule the balance already states: the other chains' leaves are not
 * computed, so their ACTIVE notes are trusted rather than pessimised.
 *
 * "Absent on this device" is not re-derived at all. #213 exists so a deposit
 * row and the balance never contradict each other, and re-deriving the same
 * verdict from a differently-scoped set is exactly how they drifted apart: the
 * balance counts an unbacked approved deposit as pending across ALL chains,
 * while the row was asking a single chain's note pool. So the row now reads the
 * balance's own ledger of what it counted pending (`unmatchedApprovedDeposits`)
 * and agrees by construction — this is what Pat's screenshots showed as 9.0000
 * USDC pending in the balance beside three ticked Optimism deposit rows.
 *
 * PURE: no notes, no SDK, no React — just the decision.
 */
export interface DepositRowChainPolicy {
  /** Apply the association-set gate (only the active chain has one loaded). */
  leafGated: boolean;
  /** Show a row with no matching note as pending/syncing. */
  showAsMissing: boolean;
}

export function depositRowChainPolicy(input: {
  /** The chain the deposit event happened on. */
  txChainId: number;
  /** The chain the live session (and `leafState`) belongs to. */
  activeChainId: number;
  /** Did the balance count THIS deposit as pending? The row must agree. */
  balanceCountsPending: boolean;
}): DepositRowChainPolicy {
  return {
    leafGated: input.txChainId === input.activeChainId,
    showAsMissing: input.balanceCountsPending,
  };
}
