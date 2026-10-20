/**
 * The pool's Note-event ciphertexts this client has already downloaded, by tx
 * hash.
 *
 * Two bulk reads carry them: the event snapshot's Note section (every Note up
 * to the snapshot, services/snapshot-source.ts) and discovery's chain reads
 * above it (services/pool-session-service.ts). Discovery keeps only what it
 * can decrypt; the rest
 * still answer a question nothing else can: whether a deposit this wallet paid
 * for was sealed to this account at all (services/deposit-ownership.ts,
 * signal 3). Recording them costs no request, and reading them back never
 * issues one.
 *
 * PURE module (no SDK / react-native imports). ONE instance per app, hung off
 * globalThis: the SDK chunk records and the activity chunk reads, and a second
 * module instance would bring its own empty map.
 */

export interface NoteCiphertext {
  ephemeralPubKey: string;
  encryptedPayload: string;
}

type Store = {
  byChain: Map<number, Map<string, Map<string, NoteCiphertext>>>;
  revision: number;
  listeners: Set<() => void>;
};

const STORE_FLAG = '__ppv2NoteCiphertexts';

function store(): Store {
  const g = globalThis as Record<string, unknown>;
  const existing = g[STORE_FLAG] as Store | undefined;
  if (existing) return existing;
  const created: Store = { byChain: new Map(), revision: 0, listeners: new Set() };
  g[STORE_FLAG] = created;
  return created;
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v);

/**
 * Record a bulk Note-event payload. Rows without a tx hash or ciphertext are
 * skipped, never thrown on: this rides on discovery and must not break it.
 * Returns how many ciphertexts were new.
 */
export function recordNoteCiphertexts(chainId: number, events: readonly unknown[]): number {
  const s = store();
  let chain = s.byChain.get(chainId);
  let added = 0;
  for (const raw of events) {
    const e = raw as { txHash?: unknown; logIndex?: unknown; ephemeralPubKey?: unknown; encryptedPayload?: unknown } | null;
    if (!e || !isHex(e.txHash) || !isHex(e.ephemeralPubKey) || !isHex(e.encryptedPayload)) continue;
    if (!chain) {
      chain = new Map();
      s.byChain.set(chainId, chain);
    }
    const txHash = e.txHash.toLowerCase();
    let forTx = chain.get(txHash);
    if (!forTx) {
      forTx = new Map();
      chain.set(txHash, forTx);
    }
    const key = typeof e.logIndex === 'number' ? `log:${e.logIndex}` : `ct:${e.encryptedPayload.toLowerCase()}`;
    if (forTx.has(key)) continue;
    forTx.set(key, { ephemeralPubKey: e.ephemeralPubKey, encryptedPayload: e.encryptedPayload });
    added += 1;
  }
  if (added > 0) {
    s.revision += 1;
    for (const listener of s.listeners) listener();
  }
  return added;
}

/**
 * `read` with every Note event it returns recorded on the way through. The SDK
 * reads the Note events above the ASP's index from the chain, and a deposit the
 * index has not reached yet has its ciphertext only there.
 */
export function recordingNoteEventReads<A extends unknown[], E extends readonly unknown[]>(
  chainId: number,
  read: (...args: A) => Promise<E>,
): (...args: A) => Promise<E> {
  return async (...args) => {
    const events = await read(...args);
    try {
      recordNoteCiphertexts(chainId, events);
    } catch {
      // A cache path never breaks discovery.
    }
    return events;
  };
}

/** Record the Note section of an event-snapshot payload, whatever shape it arrived in. */
export function recordSnapshotNoteCiphertexts(chainId: number, payload: unknown): number {
  const notes = (payload as { notes?: unknown } | null | undefined)?.notes;
  return Array.isArray(notes) ? recordNoteCiphertexts(chainId, notes) : 0;
}

/** Every recorded ciphertext of one tx; empty when nothing has carried it here yet. */
export function noteCiphertextsFor(chainId: number, txHash: string): readonly NoteCiphertext[] {
  const forTx = store().byChain.get(chainId)?.get(txHash.toLowerCase());
  return forTx ? [...forTx.values()] : [];
}

/** Every recorded ciphertext of one chain, with the tx that emitted it. */
export function allNoteCiphertexts(chainId: number): readonly (NoteCiphertext & { txHash: string })[] {
  const chain = store().byChain.get(chainId);
  if (!chain) return [];
  const out: (NoteCiphertext & { txHash: string })[] = [];
  for (const [txHash, forTx] of chain) {
    for (const ciphertext of forTx.values()) out.push({ txHash, ...ciphertext });
  }
  return out;
}

export function getNoteCiphertextsRevision(): number {
  return store().revision;
}

export function subscribeNoteCiphertexts(listener: () => void): () => void {
  const { listeners } = store();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function resetNoteCiphertexts(): void {
  const s = store();
  s.byChain.clear();
  s.revision = 0;
}
