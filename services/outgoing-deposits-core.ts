/**
 * Deposits this wallet made FOR SOMEONE ELSE ("Deposit to another address",
 * SDK `prepareDepositFor`). PURE module: parsing, upsert, set-building.
 *
 * Why a local stamp: on-chain and in the ASP feed the deposit names only its
 * submitter (`Entrypoint.Deposited(_depositor = msg.sender)`); the recipient is
 * hidden inside `noteAddressHash`. Every "is this deposit mine?" surface would
 * therefore claim the money the user just gave away: pending balance, deposit
 * counts, Withdraw/Exit actions on the row. The payment-request flow solved the
 * same problem with services/paid-requests-core.ts; this is the same trick for
 * a plain depositFor, deliberately storing LESS: no recipient, no amount. The
 * tx hash is all the exclusion needs, and persisting the recipient would leave
 * a durable funder -> recipient link on the device.
 *
 * Per-device by nature. Missing stamp (another device, cleared storage) means
 * the old cosmetic over-count, never a wrong on-chain outcome.
 */

export type OutgoingDeposit = {
  /** Payer wallet, lowercase. */
  payer: string;
  chainId: number;
  /** Confirmed deposit tx hash, lowercase. */
  txHash: string;
  kind: 'deposit-for';
  timestamp: number;
};

/** Bounded so a long-lived device cannot grow the record without limit. */
export const MAX_OUTGOING_DEPOSITS = 500;

const lower = (v: string): string => v.toLowerCase();

export function parseOutgoingDeposits(raw: string | null | undefined): OutgoingDeposit[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Pick the known fields only: anything else (a recipient, an amount) must
    // not survive a round trip through storage.
    return parsed.filter(isOutgoingDeposit).map((d) => ({
      payer: lower(d.payer),
      chainId: d.chainId,
      txHash: lower(d.txHash),
      kind: d.kind,
      timestamp: d.timestamp,
    }));
  } catch {
    return [];
  }
}

function isOutgoingDeposit(v: unknown): v is OutgoingDeposit {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return typeof d.payer === 'string'
    && typeof d.chainId === 'number'
    && typeof d.txHash === 'string'
    && /^0x[0-9a-fA-F]{64}$/.test(d.txHash)
    && d.kind === 'deposit-for'
    && typeof d.timestamp === 'number';
}

/** Replace by tx hash; newest last; oldest evicted past the cap. */
export function upsertOutgoingDeposit(list: OutgoingDeposit[], entry: OutgoingDeposit): OutgoingDeposit[] {
  const normalized: OutgoingDeposit = { ...entry, payer: lower(entry.payer), txHash: lower(entry.txHash) };
  const next = list.filter((d) => d.txHash !== normalized.txHash);
  next.push(normalized);
  return next.length > MAX_OUTGOING_DEPOSITS ? next.slice(next.length - MAX_OUTGOING_DEPOSITS) : next;
}

/** Tx hashes (lowercase) this payer stamped, optionally scoped to one chain. */
export function toOutgoingDepositTxHashSet(
  list: readonly OutgoingDeposit[],
  payer: string | null | undefined,
  chainId?: number,
): Set<string> {
  const out = new Set<string>();
  if (!payer) return out;
  const p = lower(payer);
  for (const d of list) {
    if (lower(d.payer) !== p) continue;
    if (chainId !== undefined && d.chainId !== chainId) continue;
    out.add(lower(d.txHash));
  }
  return out;
}
