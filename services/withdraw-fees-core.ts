// Pure logic behind services/withdraw-fees-store — no react-native, no
// storage, so it is directly unit-testable (same split as
// services/paid-requests-core).
//
// The store keeps the relayer/processor fee paid on a RELAYED SPEND:
// withdrawals (kind 'withdrawal') and outgoing transfers / paid payment
// requests (kind 'transfer'), and private swaps (kind 'swap', inside the gross
// that went into the swap, like a withdrawal's). A claim of a received payment
// (kind 'claim') keeps the relayer fee it was quoted, for its row's details.
// The fee is never recoverable from the activity feed after the fact, in either direction:
//   - a withdrawal's feed amount is the GROSS that left the pool
//     (withdrawnValue = amount + feeAmount), so the split is invisible;
//   - a transfer's row amount is what the recipient got, and the fee was
//     debited ON TOP of it, so the row understates what the account spent.
// Either way a user adding their own history up cannot reach their balance,
// which is the report this store exists to answer (Mike, 2026-08-26).

export interface WithdrawFee {
  txHash: string;        // lowercase
  feeAmount: string;     // bigint as decimal OR 0x-hex string; smallest-units, same token as the spend
  tokenAddress: string;  // lowercase
  chainId: number;
  timestamp: number;     // unix ms
  /** Which kind of spend paid this fee. Absent on rows written before
   *  transfers started stamping fees, which were all withdrawals — so
   *  `undefined` MUST keep reading as 'withdrawal' (see
   *  toWithdrawalTxHashSet, where it is ownership evidence). */
  kind?: 'withdrawal' | 'transfer' | 'swap' | 'claim';
  /** USD price of one unit of the fee token when the fee was recorded, from
   *  the public price feed the app already holds. Lets the detail panel show
   *  what the fee was worth when it was paid. Absent for a stablecoin (the
   *  amount is the dollar figure) and on rows recorded before it existed. */
  priceUsd?: number;
}

/** True for a withdrawal row, including legacy rows with no `kind`. */
export function isWithdrawalFee(fee: WithdrawFee): boolean {
  return fee.kind === undefined || fee.kind === 'withdrawal';
}

export function normalizeWithdrawFee(fee: WithdrawFee): WithdrawFee {
  return {
    ...fee,
    txHash: fee.txHash.toLowerCase(),
    tokenAddress: fee.tokenAddress.toLowerCase(),
  };
}

/** Row-level validation, not just "is it an array".
 *
 *  Every reader below lowercases `txHash`, and the detail panel calls the
 *  lookup during render OUTSIDE its own try/catch, so a single malformed row
 *  (`[{}]` from a truncated write, a hand-edited localStorage, an older shape)
 *  would throw while drawing a transaction and would also make the next fee
 *  stamp fail. Drop bad rows here so nothing downstream has to defend itself. */
function isWithdrawFeeRow(row: unknown): row is WithdrawFee {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  if (typeof r.txHash !== 'string' || r.txHash.length === 0) return false;
  if (typeof r.feeAmount !== 'string' || r.feeAmount.length === 0) return false;
  if (typeof r.tokenAddress !== 'string') return false;
  if (typeof r.chainId !== 'number' || !Number.isFinite(r.chainId)) return false;
  if (typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp)) return false;
  if (r.kind !== undefined && r.kind !== 'withdrawal' && r.kind !== 'transfer' && r.kind !== 'swap' && r.kind !== 'claim') return false;
  if (r.priceUsd !== undefined && !(typeof r.priceUsd === 'number' && Number.isFinite(r.priceUsd) && r.priceUsd > 0)) return false;
  return true;
}

export function parseWithdrawFees(raw: string | null): WithdrawFee[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWithdrawFeeRow);
  } catch {
    return [];
  }
}

/** One fee per tx: a re-record (e.g. a re-proved retry quoting a new fee)
 *  replaces the earlier row rather than doubling it. */
export function upsertWithdrawFee(list: WithdrawFee[], fee: WithdrawFee): WithdrawFee[] {
  const normalized = normalizeWithdrawFee(fee);
  return [...list.filter((f) => f.txHash.toLowerCase() !== normalized.txHash), normalized];
}

export function findWithdrawFeeIn(list: WithdrawFee[], txHash: string | null | undefined): WithdrawFee | null {
  if (!txHash) return null;
  const needle = txHash.toLowerCase();
  return list.find((f) => f.txHash.toLowerCase() === needle) ?? null;
}

/** Tx hashes of WITHDRAWALS recorded on this device — exact ownership evidence
 *  for the accounting scope. Transfer fees share the store, so the kind filter
 *  is load-bearing: without it an outgoing transfer's hash would enter the
 *  scope as a withdrawal. */
export function toWithdrawalTxHashSet(list: WithdrawFee[]): Set<string> {
  return new Set(list.filter(isWithdrawalFee).map((f) => f.txHash.toLowerCase()));
}

/** The fee with its send-time unit price attached, when one is known and the
 *  token is not a stablecoin. A price already on the row is kept. */
export function withSendTimePrice(fee: WithdrawFee, price: number | undefined, stablecoin: boolean): WithdrawFee {
  if (fee.priceUsd !== undefined || stablecoin || !(typeof price === 'number' && Number.isFinite(price) && price > 0)) return fee;
  return { ...fee, priceUsd: price };
}
