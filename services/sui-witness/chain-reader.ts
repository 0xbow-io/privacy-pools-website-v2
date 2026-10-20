/**
 * Browser-safe Sui chain reader (ported from the protocol SDK's
 * `sdk/src/chain-reader.mjs`). Reads the live pool/keystore/ASP state the UI
 * needs to build a correct transact/withdraw and to discover notes:
 *
 *   - getGvkEnabled() / getPoolGvk() — the per-deployment GVK toggle + key, so
 *     the witness binds to `pool.gvk` (avoids E_GVK_MISMATCH) and selects the
 *     GVK vs plain path (avoids E_INVALID_CIPHERTEXT). Mirrors
 *     `pool::gvk_enabled(pool)` / `pool::gvk(pool)`.
 *   - getNoteEvents() — the `NoteEvent` stream (encrypted hints + data per
 *     output), paginated to exhaustion and FAILS LOUD on a page-cap so a busy
 *     window never silently truncates a user's note.
 *   - getDepositEvents() / getTransactEvents() — commitment/nullifier streams
 *     used to reconstruct note state + lifecycle.
 *
 * Only the read methods the website consumes are ported; the SDK retains the
 * full surface. The @mysten/sui `SuiClient` is supplied by the caller (dapp-kit
 * `useSuiClient()`), so this file stays React-free and unit-traceable.
 */
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

/** The client shape we rely on (the dapp-kit `useSuiClient()` return type). */
type SuiClient = SuiJsonRpcClient;

/**
 * Default ceiling on the number of pages a single fetch loop will walk before
 * throwing. Defensive backstop against a misbehaving RPC that never returns a
 * short page; hitting the cap THROWS (never a silent partial). Matches the SDK
 * default (10k pages).
 */
const DEFAULT_MAX_PAGES = 10_000;

/** Default per-page RPC timeout (ms). */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Thrown when event pagination hits the page cap or an RPC page times out. */
export class EventPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventPaginationError';
  }
}

/** A single Sui event as returned by `queryEvents` (only the fields we read). */
export interface SuiEventEnvelope {
  id?: { txDigest?: string; eventSeq?: string };
  parsedJson?: Record<string, unknown>;
  [k: string]: unknown;
}

interface QueryAllOptions {
  cursor?: { txDigest: string; eventSeq: string } | null;
  limit?: number;
  order?: 'ascending' | 'descending';
}

/** Minimal shape of a `queryEvents` page we read (decoder-version-agnostic). */
interface QueryEventsPage {
  data: SuiEventEnvelope[];
  hasNextPage: boolean;
  nextCursor: { txDigest: string; eventSeq: string } | null;
}

interface ChainReaderConfig {
  client: SuiClient;
  packageId: string;
  poolId: string;
  keystoreId?: string;
  aspRegistryId?: string;
  maxPagesPerFetch?: number;
  rpcTimeoutMs?: number;
}

/** Normalize one event's payload (parsedJson) across decoder shapes. */
function eventFields(ev: SuiEventEnvelope): Record<string, unknown> {
  const e = ev as { parsedJson?: Record<string, unknown>; fields?: Record<string, unknown> };
  return e.parsedJson ?? e.fields ?? {};
}

/** Coerce a Move u256/u64 (string | number | { value }) into a bigint. */
function toBig(raw: unknown): bigint {
  if (raw == null) return 0n;
  if (typeof raw === 'object') {
    const o = raw as { value?: unknown; hash?: unknown };
    return BigInt((o.value ?? o.hash ?? 0) as string | number | bigint);
  }
  return BigInt(raw as string | number | bigint);
}

/** Race a promise against a bounded timeout (rejects with EventPaginationError). */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new EventPaginationError(`RPC timeout (${timeoutMs}ms) during ${label}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class SuiChainReader {
  private client: SuiClient;
  private packageId: string;
  private poolId: string;
  private keystoreId?: string;
  private aspRegistryId?: string;
  private maxPagesPerFetch: number;
  private rpcTimeoutMs: number;

  constructor(config: ChainReaderConfig) {
    this.client = config.client;
    this.packageId = config.packageId;
    this.poolId = config.poolId;
    this.keystoreId = config.keystoreId;
    this.aspRegistryId = config.aspRegistryId;
    this.maxPagesPerFetch = config.maxPagesPerFetch ?? DEFAULT_MAX_PAGES;
    this.rpcTimeoutMs = config.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  /**
   * Walk a `queryEvents` cursor to exhaustion. A single call caps at `limit`
   * (default 50), so without paging a busy window silently truncates past the
   * first page. Bounded two ways so a misbehaving RPC cannot loop forever or
   * hang: a per-page timeout, and a max-pages ceiling that THROWS (never a
   * silent partial return). Ported from chain-reader.mjs `_queryAllEvents`.
   */
  private async queryAllEvents(
    moveEventType: string,
    options: QueryAllOptions = {},
  ): Promise<SuiEventEnvelope[]> {
    const pageLimit = options.limit || 50;
    const order = options.order || 'ascending';
    const all: SuiEventEnvelope[] = [];
    let cursor = options.cursor ?? null;

    for (let page = 0; page < this.maxPagesPerFetch; page++) {
      const result = (await withTimeout(
        this.client.queryEvents({
          query: { MoveEventType: moveEventType },
          cursor,
          limit: pageLimit,
          order,
        }) as Promise<QueryEventsPage>,
        this.rpcTimeoutMs,
        `queryEvents(${moveEventType})`,
      )) as QueryEventsPage;

      if (Array.isArray(result.data)) all.push(...(result.data as SuiEventEnvelope[]));

      // Terminate on a non-advancing cursor too, so a buggy RPC that keeps
      // echoing the same cursor cannot spin until the page cap.
      const next = result.nextCursor ?? null;
      if (!result.hasNextPage || !next || sameCursor(next, cursor)) {
        return all;
      }
      cursor = next;
    }

    throw new EventPaginationError(
      `Exceeded max page count (${this.maxPagesPerFetch}) draining ${moveEventType}`,
    );
  }

  /** Get pool object fields (showContent). */
  async getPool() {
    const obj = await this.client.getObject({
      id: this.poolId,
      options: { showContent: true },
    });
    if (!obj.data) throw new Error(`Pool object not found: ${this.poolId}`);
    return obj.data;
  }

  /**
   * Read the pool's `gvk_enabled` flag. Defaults to true when absent (the
   * contract default), so an older snapshot is treated as GVK-enabled rather
   * than silently flipping to the plain path. Mirrors `pool::gvk_enabled`.
   */
  async getGvkEnabled(): Promise<boolean> {
    const data = await this.getPool();
    const fields = poolFields(data);
    const raw = fields.gvk_enabled;
    if (raw == null) return true;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    if (typeof raw === 'string') return raw === 'true' || raw === '1';
    return Boolean(raw);
  }

  /**
   * Read the pool's Global View Key coords (LOW-2: the Pool is the single
   * source of truth). Transact proofs MUST encrypt to this key; the contract
   * binds gvk_x/gvk_y on-chain. Mirrors `pool::gvk`. Returns bigint coords.
   */
  async getPoolGvk(): Promise<{ x: bigint; y: bigint }> {
    const data = await this.getPool();
    const fields = poolFields(data);
    const x = fields.gvk_x;
    const y = fields.gvk_y;
    if (x == null || y == null) {
      throw new Error('Pool object has no gvk_x/gvk_y fields (stale snapshot or pre-LOW-2 package)');
    }
    return { x: BigInt(x as string), y: BigInt(y as string) };
  }

  /** Query ALL `Deposited` events (paginated to exhaustion). */
  async getDepositEvents(options: QueryAllOptions = {}): Promise<SuiEventEnvelope[]> {
    return this.queryAllEvents(`${this.packageId}::pool::Deposited`, options);
  }

  /** Query ALL `Transacted` events (paginated to exhaustion). */
  async getTransactEvents(options: QueryAllOptions = {}): Promise<SuiEventEnvelope[]> {
    return this.queryAllEvents(`${this.packageId}::pool::Transacted`, options);
  }

  /**
   * Query ALL `NoteEvent` events (encrypted hints + data per output),
   * paginated to exhaustion (fails loud on the page cap). Mirrors
   * `chain-reader.mjs#getNoteEvents`.
   */
  async getNoteEvents(options: QueryAllOptions = {}): Promise<SuiEventEnvelope[]> {
    return this.queryAllEvents(`${this.packageId}::pool::NoteEvent`, options);
  }

  /** Query ALL `RagequitEvent` events (paginated to exhaustion). */
  async getRagequitEvents(options: QueryAllOptions = {}): Promise<SuiEventEnvelope[]> {
    return this.queryAllEvents(`${this.packageId}::pool::RagequitEvent`, options);
  }

  /** Query ALL `LeavesInserted` events (paginated to exhaustion). Backs the
   * state-tree reconstruction: each event carries `leaves` (the leaves appended
   * by that deposit/transact, in order) + `start_index`. Mirrors the live script
   * (live-relay-withdraw-e2e STEP 2). */
  async getLeavesInsertedEvents(options: QueryAllOptions = {}): Promise<SuiEventEnvelope[]> {
    return this.queryAllEvents(`${this.packageId}::pool::LeavesInserted`, options);
  }

  /** Query ALL keystore `LeafInserted` events (paginated to exhaustion). Each
   * carries `{ leaf, root, index }`. Backs keystore-tree reconstruction. */
  async getKeystoreLeafEvents(options: QueryAllOptions = {}): Promise<SuiEventEnvelope[]> {
    return this.queryAllEvents(`${this.packageId}::keystore::LeafInserted`, options);
  }

  /**
   * Reconstruct the full ordered state-tree leaf list from `LeavesInserted`
   * events. Every deposit (1 leaf) and transact (M commitments + N nullifiers)
   * appends to the same LeanIMT in event order, so concatenating each event's
   * `leaves` (ascending) yields the exact on-chain leaf order. `start_index`
   * lets us verify there are no gaps (a missing page would mis-order the tree
   * and silently produce a wrong root). Mirrors live-relay-withdraw-e2e STEP 2.
   */
  async reconstructStateLeaves(options: QueryAllOptions = {}): Promise<bigint[]> {
    const events = await this.getLeavesInsertedEvents({ ...options, order: 'ascending' });
    const leaves: bigint[] = [];
    for (const ev of events) {
      const f = eventFields(ev);
      const startIndex = f.start_index != null ? Number(toBig(f.start_index)) : leaves.length;
      // Gap/ordering guard: a dropped page would make start_index != current
      // length, producing a wrong tree. Fail loud rather than silently.
      if (startIndex !== leaves.length) {
        throw new EventPaginationError(
          `LeavesInserted ordering gap: event start_index=${startIndex} but ` +
            `${leaves.length} leaves reconstructed so far`,
        );
      }
      const evLeaves = Array.isArray(f.leaves) ? (f.leaves as unknown[]) : [];
      for (const lf of evLeaves) leaves.push(toBig(lf));
    }
    return leaves;
  }

  /** Reconstruct the full ordered keystore-tree leaf list from `LeafInserted`
   * events. Mirrors live-relay-withdraw-e2e STEP 3. */
  async reconstructKeystoreLeaves(options: QueryAllOptions = {}): Promise<bigint[]> {
    const events = await this.getKeystoreLeafEvents({ ...options, order: 'ascending' });
    const leaves: bigint[] = [];
    for (const ev of events) {
      const f = eventFields(ev);
      // Index guard: keystore appends one leaf per event, monotonically.
      const idx = f.index != null ? Number(toBig(f.index)) : leaves.length;
      if (idx !== leaves.length) {
        throw new EventPaginationError(
          `keystore LeafInserted ordering gap: event index=${idx} but ` +
            `${leaves.length} leaves reconstructed so far`,
        );
      }
      leaves.push(toBig(f.leaf));
    }
    return leaves;
  }

  /**
   * Read the on-chain timestamp the contract stamped on a commitment (the
   * `CommitmentKey -> u64` dynamic field). REQUIRED to recompute the timestamped
   * state-tree leaf `Poseidon(TAG, commitment, timestamp)`. Mirrors
   * `pool::commitment_timestamp` and the live script's getDynamicFieldObject.
   */
  async getCommitmentTimestamp(commitment: bigint): Promise<bigint> {
    const obj = await withTimeout(
      this.client.getDynamicFieldObject({
        parentId: this.poolId,
        name: {
          type: `${this.packageId}::pool::CommitmentKey`,
          value: { hash: commitment.toString() },
        },
      }) as Promise<{ data?: { content?: { fields?: { value?: unknown } } } }>,
      this.rpcTimeoutMs,
      'getCommitmentTimestamp',
    );
    const raw = obj?.data?.content?.fields?.value;
    if (raw == null) {
      throw new Error(`commitment ${commitment} not found on-chain (no timestamp)`);
    }
    return toBig(raw);
  }

  /**
   * Read the pool's circular root buffer as the set of LIVE (non-zero) state
   * roots. A reconstructed state root MUST be present here or the transact
   * aborts E_UNKNOWN_STATE_ROOT. Mirrors the live script's root_buffer scan and
   * `root_buffer::is_known_root`.
   */
  async getPoolRootBuffer(): Promise<bigint[]> {
    const data = await this.getPool();
    const fields = poolFields(data);
    const rb = fields.root_buffer as { fields?: { buffer?: unknown[] }; buffer?: unknown[] } | undefined;
    const buffer = rb?.fields?.buffer ?? rb?.buffer ?? [];
    return (Array.isArray(buffer) ? buffer : [])
      .map((r) => toBig(r))
      .filter((r) => r !== 0n);
  }

  /** Read the keystore's `current_root`. Mirrors `keystore::current_root`. */
  async getKeystoreCurrentRoot(): Promise<bigint> {
    if (!this.keystoreId) throw new Error('keystoreId not configured');
    const obj = await this.client.getObject({
      id: this.keystoreId,
      options: { showContent: true },
    });
    if (!obj.data) throw new Error(`Keystore object not found: ${this.keystoreId}`);
    const fields = poolFields(obj.data);
    return toBig(fields.current_root);
  }

  /** Read the ASP registry's latest root. Mirrors `asp_registry::latest_asp_root`. */
  async getLatestAspRoot(): Promise<bigint> {
    if (!this.aspRegistryId) throw new Error('aspRegistryId not configured');
    const obj = await this.client.getObject({
      id: this.aspRegistryId,
      options: { showContent: true },
    });
    if (!obj.data) throw new Error(`ASP registry object not found: ${this.aspRegistryId}`);
    const fields = poolFields(obj.data);
    const roots = fields.roots;
    if (!Array.isArray(roots) || roots.length === 0) return 0n;
    return toBig(roots[roots.length - 1]);
  }
}

/** Normalize the @mysten/sui object decoder shapes to the inner fields map. */
function poolFields(data: unknown): Record<string, unknown> {
  const d = data as { content?: { fields?: Record<string, unknown> }; fields?: Record<string, unknown> };
  return d?.content?.fields ?? d?.fields ?? {};
}

function sameCursor(
  a: { txDigest: string; eventSeq: string } | null,
  b: { txDigest: string; eventSeq: string } | null,
): boolean {
  if (a == null || b == null) return a === b;
  return a.txDigest === b.txDigest && a.eventSeq === b.eventSeq;
}
