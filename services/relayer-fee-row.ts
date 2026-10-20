// The "Relayer fee" row of a transaction's View details (DEV-517).
//
// The fee shown is the one RECORDED for the operation: the quote this device
// paid, stamped at submit time (services/withdraw-fees-store.ts), or for an
// outgoing transfer the relayer's withdrawnValue the chain carries. Never a
// re-quote at view time, and never a guess: a row with no recorded fee (a
// direct deposit, a self-paid ragequit, an old row from before fees were
// stored) gets no fee row at all, not "0".
//
// PURE module: no react-native, no storage, no network.

export type StoredFee = { feeAmount: string; priceUsd?: number };

export type RelayerFeeRowInput = {
  type: string;
  /** Resolved direction of a Transfer row, null for other types. */
  direction: 'in' | 'out' | 'self' | null;
  txHash: string;
  /** A claimed payment's row: the claim tx, which is what paid the fee. */
  claimTxHash?: string;
  /** Every claim tx of a payment claimed over several txs; their fees add up. */
  claimTxHashes?: readonly string[];
  /** Feed-only fallback for an outgoing transfer: the fee read from chain. */
  relayFeeRaw?: string;
  /** A row whose amount IS the relayer fee (isFeeAmountRow). */
  feeAmountRow: boolean;
  rawAmount?: string;
  /** One Withdrawal row of a batch tx: the stored aggregate fee is not its own. */
  isBatchItemRow: boolean;
  findFee: (txHash: string) => StoredFee | null;
};

export type RelayerFee = {
  wei: bigint;
  /** The unit price stamped when the fee was paid, when one was. */
  priceUsd?: number;
  /** The fee came from this device's record of the operation. */
  stored: boolean;
};

function positive(raw: string | undefined | null): bigint | null {
  if (!raw) return null;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** The relayer fee this row paid, or null when it has none to show. */
export function relayerFeeFor(input: RelayerFeeRowInput): RelayerFee | null {
  // Never relayed: a deposit comes from a wallet, an exit is self-paid.
  if (input.type === 'Deposit' || input.type === 'Exit') return null;
  // A claimed payment: the claim tx paid the relayer, not the payment.
  if (input.type === 'Transfer' && input.direction === 'in') {
    const hashes = input.claimTxHashes?.length ? input.claimTxHashes : input.claimTxHash ? [input.claimTxHash] : [];
    if (hashes.length === 0) return null;
    // Every leg's fee, or none: one leg's fee alone would understate it.
    let wei = 0n;
    // The legs' stamped prices, weighted by fee, when every leg has one.
    let priced = 0;
    let allPriced = true;
    for (const hash of hashes) {
      const stored = input.findFee(hash);
      const leg = positive(stored?.feeAmount);
      if (!leg) return null;
      wei += leg;
      if (stored?.priceUsd) priced += Number(leg) * stored.priceUsd;
      else allPriced = false;
    }
    const priceUsd = allPriced && wei > 0n ? priced / Number(wei) : undefined;
    return { wei, ...(priceUsd ? { priceUsd } : {}), stored: true };
  }
  const lookup = !input.isBatchItemRow && (
    (input.type === 'Transfer' && (input.direction === 'out' || input.direction === 'self'))
    || input.type === 'Withdrawal'
    || input.type === 'Swap'
  );
  const stored = lookup && input.txHash ? input.findFee(input.txHash) : null;
  const storedWei = positive(stored?.feeAmount);
  if (storedWei) return { wei: storedWei, ...(stored?.priceUsd ? { priceUsd: stored.priceUsd } : {}), stored: true };
  // The chain still has an outgoing transfer's fee; a row whose amount is the
  // fee names it too. A withdrawal folds its fee into the gross, so without a
  // record there is nothing to split out.
  const chainWei = (input.direction === 'out' ? positive(input.relayFeeRaw) : null)
    ?? (input.feeAmountRow ? positive(input.rawAmount) : null);
  return chainWei ? { wei: chainWei, stored: false } : null;
}

/**
 * The fee's dollar value as the review step prints it, "(~$0.16)". The price
 * stamped when the fee was paid is the historical figure; without one today's
 * price is used and says so. A stablecoin is a dollar when no price is known.
 * Empty when there is no price at all.
 */
export function relayerFeeUsdNote(
  tokenAmount: number,
  price: { stamped?: number; now?: number | null; stablecoin: boolean },
): string {
  const unit = price.stamped ?? (price.now && price.now > 0 ? price.now : price.stablecoin ? 1 : 0);
  if (!(unit > 0) || !(tokenAmount > 0)) return '';
  const usd = tokenAmount * unit;
  const text = usd < 0.01 ? '<$0.01' : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const live = price.stamped === undefined && !price.stablecoin;
  return ` (~${text}${live ? ' now' : ''})`;
}
