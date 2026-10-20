// Pure half of services/own-actions-store.ts: which action THIS device
// performed for a transaction hash. The row classifier consults it before it
// can default a fresh own note to "Transfer In" (Pat, 2026-09-04: a Shield's
// pending row vanished at confirmation, came back as Transfer, then became
// Deposit once the ASP indexed the event). The action name is the only thing
// stored: a public tx hash and a word, nothing derived from a note. A swap
// also keeps the PUBLIC output asset it deposited into, so the classifier can
// tell the swap's new note from the source-side change the same tx produced.

// 'setup-gas' and 'setup-register': a relayed spend made only to set up the
// account (the gasless registration, or the gas top-up that pays for the
// viewing key). Its row is named for that, not as a withdrawal (DEV-574).
export type OwnActionKind = 'shield' | 'withdraw' | 'send' | 'swap' | 'consolidate' | 'setup-gas' | 'setup-register';

export type OwnAction = {
  txHash: string; // lowercase
  chainId: number;
  kind: OwnActionKind;
  /** unix ms */
  timestamp: number;
  /** swap only: lowercase address of the asset the swap deposited into. */
  tokenId?: string;
};

/** Bounded so a long-lived device cannot grow the record without limit. */
export const MAX_OWN_ACTIONS = 500;

const HASH_RE = /^0x[0-9a-f]{64}$/;

export function parseOwnActions(raw: unknown): OwnAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is OwnAction => !!a
    && typeof a === 'object'
    && typeof (a as OwnAction).txHash === 'string'
    && HASH_RE.test((a as OwnAction).txHash)
    && typeof (a as OwnAction).chainId === 'number'
    && ['shield', 'withdraw', 'send', 'swap', 'consolidate', 'setup-gas', 'setup-register'].includes((a as OwnAction).kind)
    && typeof (a as OwnAction).timestamp === 'number'
    && ((a as OwnAction).tokenId === undefined || typeof (a as OwnAction).tokenId === 'string'));
}

/**
 * Latest record per (chain, hash) wins; the list stays bounded, oldest first
 * out. Keyed by chain too: the same public hash on two chains must coexist.
 */
export function upsertOwnAction(list: OwnAction[], entry: OwnAction): OwnAction[] {
  const txHash = entry.txHash.toLowerCase();
  const kept = list.filter((a) => !(a.txHash === txHash && a.chainId === entry.chainId));
  const next: OwnAction = { ...entry, txHash };
  if (entry.tokenId !== undefined) next.tokenId = entry.tokenId.toLowerCase();
  else delete next.tokenId;
  kept.push(next);
  return kept.length > MAX_OWN_ACTIONS ? kept.slice(kept.length - MAX_OWN_ACTIONS) : kept;
}

export function findOwnActionIn(list: readonly OwnAction[], txHash: string | null | undefined, chainId?: number): OwnAction | null {
  if (!txHash) return null;
  const needle = txHash.toLowerCase();
  return list.find((a) => a.txHash === needle && (chainId === undefined || a.chainId === chainId)) ?? null;
}

/** txHash -> record for one chain, for the classifier's per-pass lookup. */
export function toOwnActionMap(list: readonly OwnAction[], chainId: number): Map<string, OwnAction> {
  const out = new Map<string, OwnAction>();
  for (const a of list) if (a.chainId === chainId) out.set(a.txHash, a);
  return out;
}

/**
 * Is `note` the output this own action created, as opposed to another note
 * the same tx produced? A shield's tx produces only its deposit note(s). A
 * swap's tx also produces the source-side change, so only a note in the swap's
 * recorded output asset counts; a swap record without one (older device
 * record) claims nothing rather than mislabel the change.
 */
export function isOwnDepositOutput(action: OwnAction, noteTokenId: string): boolean {
  if (action.kind === 'shield') return true;
  if (action.kind !== 'swap' || !action.tokenId) return false;
  return noteTokenId.toLowerCase() === action.tokenId;
}

export type OwnDepositBridgeInput = {
  /** The public events feed has loaded (an empty feed still counts as loaded). */
  feedLoaded: boolean;
  /** The deposit snapshot has loaded. */
  snapshotLoaded: boolean;
  /** The snapshot already lists this deposit. */
  snapshotKnows: boolean;
  /** Oldest row of THIS chain's public feed, ms; null = the feed has no row for the chain. */
  oldestFeedTs: number | null;
  /** The note's healed block time, ms; 0 or negative = not healed yet. */
  noteTs: number;
  /** When this device recorded the action, ms. */
  actionTs: number;
};

/**
 * May a locally stamped own shield / swap get a synthesized Deposit row while
 * the feed has no row for its tx?
 *
 * - Nothing until the public feed has answered once: with saved notes and
 *   stamps but no feed yet, every old deposit would flash up and vanish.
 * - Inside the feed window (newer than its oldest row) and absent from it: the
 *   ASP lags, bridge. Older than the window: evicted or simply old, no row.
 *   An empty window evicts nothing. An unhealed note time is unknown, so the
 *   action's own time stands in, never "ancient".
 * - The snapshot has not confirmed it (unknown, failed for this chain, or
 *   still loading): only an action stamped inside the window bridges.
 */
export function ownDepositBridgeAllowed(input: OwnDepositBridgeInput): boolean {
  if (!input.feedLoaded) return false;
  const cutoff = input.oldestFeedTs !== null && Number.isFinite(input.oldestFeedTs) ? input.oldestFeedTs : null;
  if (cutoff === null) return true;
  const ts = input.noteTs > 0 ? input.noteTs : input.actionTs;
  // Older than the window: evicted (snapshot knows it) or simply old (it does
  // not, or has not answered yet). Either way no row.
  if (ts > 0 && ts < cutoff) return false;
  // The snapshot has not confirmed it: only an action stamped inside the
  // window bridges, so a saved old stamp cannot flash while a chain's snapshot
  // is missing or still loading.
  if (!(input.snapshotLoaded && input.snapshotKnows) && input.actionTs < cutoff) return false;
  return true;
}

/**
 * A note's healed block time in ms, or 0 when it is not healed yet. The SDK
 * writes the BLOCK NUMBER into createdAtBlock first and heals it to unix
 * seconds later; a block number (a few million) read as seconds is 1970, so
 * anything below one billion seconds is "not a time yet".
 */
export function noteTimeMs(createdAtBlock: string | null | undefined): number {
  let seconds = 0;
  try { seconds = Number(BigInt(createdAtBlock ?? '0x0')); } catch { return 0; }
  if (!Number.isFinite(seconds) || seconds < 1_000_000_000) return 0;
  return seconds * 1000;
}
