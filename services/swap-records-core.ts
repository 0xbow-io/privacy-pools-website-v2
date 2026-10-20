// Pure half of services/swap-records-store.ts: what THIS device knows about a
// swap it sent that chain data and its own notes cannot tell it.
//
// - A cross-chain Swap-tab swap: the destination leg is a separate event on
//   another chain, and nothing public links it to the source tx (asp-v2 plan
//   022). The record names the output chain, token and the prepared note, and
//   later the delivery outcome and destination tx the delivery poller learns.
// - A Withdraw "receive as": the payout chain and token, and the quoted
//   payout. The relayed receipt carries only the pool's and keystore's logs,
//   so the quote is the figure on every route, marked ≈.
// - A Shield swap-and-shield: what the wallet paid (the quote of an
//   exact-output swap) and the deposit note it bought.
//
// Records only decorate or link actions independently established as this
// account's; they are never ownership evidence. A missing, malformed or
// evicted record falls back to the labels chain data supports. Every value is
// one the flow already held in memory when it wrote the record; nothing here
// reads the network. Never in a debug snapshot or a request.

const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
// A uint256 in decimal has at most 78 digits.
const UINT_RE = /^[0-9]{1,78}$/;

/** Bounded so a long-lived device cannot grow the record without limit. */
export const MAX_SWAP_RECORDS = 500;

export type DeliveryOutcome = 'deposited' | 'recovered' | 'refunded' | 'failed';

type RecordBase = {
  /** Lowercase hash of the tx this device submitted (the source leg). */
  txHash: string;
  sourceChainId: number;
  /** unix ms */
  timestamp: number;
};

export type CrossChainSwapRecord = RecordBase & {
  kind: 'cross-chain';
  outputChainId: number;
  outputToken: string;
  /** The prepared destination note: proves intent, not delivery. */
  commitment: string;
  /** Its value, decimal smallest units. */
  value: string;
  outcome?: DeliveryOutcome;
  destinationTxHash?: string;
};

export type ReceiveAsRecord = RecordBase & {
  kind: 'receive-as';
  outputChainId: number;
  outputToken: string;
  /** The quoted payout, decimal smallest units. */
  quotedOutput: string;
};

export type ShieldSwapRecord = RecordBase & {
  kind: 'shield';
  /** The deposit's chain (the destination of a cross-chain shield). */
  depositChainId: number;
  inputToken: string;
  /** LI.FI's quoted input in smallest units (hex or decimal), not a measured
   *  wallet debit. The route may return unused input to the wallet. */
  estimatedInput: string;
  /** The deposit note bought, as the note stores it, lowercase. */
  commitment: string;
};

/**
 * A private swap-send: my note paid for a note OWNED BY ANOTHER ACCOUNT. No
 * recipient is stored, on purpose (DEV-512): the row only says it was sent.
 */
export type SwapSendRecord = RecordBase & {
  kind: 'send';
  outputChainId: number;
  outputToken: string;
  /** A cross-chain send's delivery, as the poller learned it. */
  outcome?: DeliveryOutcome;
  destinationTxHash?: string;
};

export type SwapRecord = CrossChainSwapRecord | ReceiveAsRecord | ShieldSwapRecord | SwapSendRecord;

const isChain = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isUint = (v: unknown): v is string => typeof v === 'string' && UINT_RE.test(v);
const isHash = (v: unknown): v is string => typeof v === 'string' && HASH_RE.test(v);
const isAddress = (v: unknown): v is string => typeof v === 'string' && ADDRESS_RE.test(v);
const isCommitment = (v: unknown): v is string => typeof v === 'string' && HASH_RE.test(v);

function isRecord(raw: unknown): raw is SwapRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (!isHash(r.txHash) || !isChain(r.sourceChainId) || typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp)) return false;
  switch (r.kind) {
    case 'cross-chain':
      return isChain(r.outputChainId) && isAddress(r.outputToken) && isCommitment(r.commitment) && isUint(r.value)
        && (r.outcome === undefined || ['deposited', 'recovered', 'refunded', 'failed'].includes(r.outcome as string))
        && (r.destinationTxHash === undefined || isHash(r.destinationTxHash));
    case 'receive-as':
      return isChain(r.outputChainId) && isAddress(r.outputToken) && isUint(r.quotedOutput);
    case 'send':
      return isChain(r.outputChainId) && isAddress(r.outputToken) && !('recipient' in r)
        && (r.outcome === undefined || ['deposited', 'recovered', 'refunded', 'failed'].includes(r.outcome as string))
        && (r.destinationTxHash === undefined || isHash(r.destinationTxHash));
    case 'shield':
      return isChain(r.depositChainId) && isAddress(r.inputToken) && isUint(r.estimatedInput) && isCommitment(r.commitment);
    default:
      return false;
  }
}

/** Drop anything malformed rather than let one bad row break a render; a
 *  stored list past the bound keeps its newest entries. */
export function parseSwapRecords(raw: unknown): SwapRecord[] {
  return Array.isArray(raw) ? raw.filter(isRecord).slice(-MAX_SWAP_RECORDS) : [];
}

const lower = (v: string) => v.toLowerCase();

/** The record in canonical spelling, or null when it would not parse back. */
export function normalizeSwapRecord(record: SwapRecord): SwapRecord | null {
  const base = { ...record, txHash: lower(record.txHash) };
  const next: SwapRecord = record.kind === 'shield'
    ? { ...(base as ShieldSwapRecord), inputToken: lower(record.inputToken), commitment: lower(record.commitment) }
    : record.kind === 'cross-chain'
      ? {
        ...(base as CrossChainSwapRecord),
        outputToken: lower(record.outputToken),
        commitment: lower(record.commitment),
        ...(record.destinationTxHash ? { destinationTxHash: lower(record.destinationTxHash) } : {}),
      }
      : record.kind === 'send'
        ? { ...(base as SwapSendRecord), outputToken: lower(record.outputToken), ...(record.destinationTxHash ? { destinationTxHash: lower(record.destinationTxHash) } : {}) }
        : { ...(base as ReceiveAsRecord), outputToken: lower(record.outputToken) };
  return isRecord(next) ? next : null;
}

const sameKey = (a: SwapRecord, sourceChainId: number, txHash: string) =>
  a.sourceChainId === sourceChainId && a.txHash === lower(txHash);

/** Latest record per (source chain, hash) wins; oldest out past the bound. */
export function upsertSwapRecord(list: readonly SwapRecord[], record: SwapRecord): SwapRecord[] {
  const next = normalizeSwapRecord(record);
  if (!next) return [...list];
  const kept = list.filter((r) => !sameKey(r, next.sourceChainId, next.txHash));
  kept.push(next);
  return kept.length > MAX_SWAP_RECORDS ? kept.slice(kept.length - MAX_SWAP_RECORDS) : kept;
}

/**
 * The delivery poller learned how a cross-chain swap ended. A recorded
 * cross-chain swap or swap-send (`send`) takes the outcome; anything else is
 * left as it is.
 */
export function withDeliveryOutcome(
  list: readonly SwapRecord[],
  update: { sourceChainId: number; txHash: string; outcome: DeliveryOutcome; destinationTxHash?: string | null },
): SwapRecord[] {
  return list.map((r) => {
    if ((r.kind !== 'cross-chain' && r.kind !== 'send') || !sameKey(r, update.sourceChainId, update.txHash)) return r;
    const next: CrossChainSwapRecord | SwapSendRecord = { ...r, outcome: update.outcome };
    const dest = update.destinationTxHash?.toLowerCase();
    if (dest && HASH_RE.test(dest)) next.destinationTxHash = dest;
    return next;
  });
}

export function findSwapRecordIn(list: readonly SwapRecord[], sourceChainId: number, txHash: string | null | undefined): SwapRecord | null {
  if (!txHash) return null;
  return list.find((r) => sameKey(r, sourceChainId, txHash)) ?? null;
}
