import { newestSnapshotRowBlock, snapshotCursor } from '@/services/asp-event-snapshot';
import { isRangeDepthRefusal } from '@/services/rpc-range-refusal';
import { createPublicClient, fallback } from 'viem';
import { policedHttp } from '@/services/egress-transport';

import type { Hash, Hex } from '@/services/sdk-types';
import { getAspBlockTimestamp } from '@/services/asp-block-timestamps';
import {
  verifySnapshotPoolState,
  type PoolStateReader,
} from '@/services/snapshot-pool-state';

/** Chains already warned about a snapshot without poolState, so the warning is once per session. */
const warnedNoPoolState = new Set<number>();

/**
 * Structural subsets of the SDK interfaces this index needs. Declared locally
 * rather than imported so this module stays free of any SDK value import — the
 * SDK pulls in snarkjs/ffjavascript, which `sdk-types.ts` exists to keep off the
 * page-load path.
 */
type HashServiceLike = { hash: (inputs: Hex[]) => Hex };

type BlockScoped = { blockNumber: Hex; txHash?: Hash };

type PoolVaultLike = {
  getStateLeaves: () => Promise<Hash[]>;
  getDepositedEvents: (
    fromBlock?: Hex,
    toBlock?: Hex,
  ) => Promise<Array<BlockScoped & { outputCommitment: Hex }>>;
  getTransactedEvents: (
    fromBlock?: Hex,
    toBlock?: Hex,
  ) => Promise<Array<BlockScoped & { outputCommitments: Hex[]; nullifierHashes: Hex[] }>>;
  getRagequitEvents: (
    fromBlock?: Hex,
    toBlock?: Hex,
  ) => Promise<Array<BlockScoped & { commitment: Hex; nullifierHash: Hex }>>;
};

/**
 * Bulk-derived, locally queried index of the PoolVault facts the app needs
 * about a user's notes: whether a commitment exists, when it was inserted,
 * whether a nullifier has been spent, and which Transacted event spent it.
 *
 * ## Why this exists (READ BEFORE ADDING ANY CHAIN READ KEYED ON A NOTE)
 *
 * `PoolVault.commitments(c)` and `PoolVault.spentNullifiers(n)` answer the same
 * questions in one `eth_call` each, and they leak: the argument is a
 * secret-derived value that also appears in public chain state, so the RPC
 * provider can join "this IP asked about nullifier N" with "N appeared in a
 * Transacted event" and deanonymize the spend. The transfer and withdraw flows
 * made exactly those calls immediately before spending; it was observed on a
 * real send (108 spentNullifiers() calls, one of them for the nullifier the
 * relayed tx published 15 seconds later). See
 * `v2-monorepo/docs/PRIVACY_RPC_METADATA_AUDIT.md` and this repo's
 * `docs/privacy-request-discipline.md`.
 *
 * The rule: every client fetches the SAME bulk data (ASP event snapshot, tail
 * `eth_getLogs`, state leaves) and answers its questions in memory. No request
 * leaving this app may carry a commitment, nullifier, label, or note-derived
 * value as an argument. `services/__tests__/no-targeted-reads.test.ts` and the
 * `privacy-no-targeted-reads` PreToolUse hook enforce it.
 *
 * ## Why this lives in the website rather than the SDK
 *
 * The upstream SDK branch ships `OnChainNoteIndex` with the same design, but
 * this app consumes a vendored tarball (`vendor/privacy-pools-v2-sdk-*.tgz`).
 * Until that tarball is rebuilt, the app needs an equivalent built on the
 * vendored SDK's existing public API. Keep the two in sync; see SDK_PATCHES.md.
 *
 * ## Trust model, and what is verified against what
 *
 * - PRESENCE (`hasCommitment`) and SPENT STATE (`isNullifierSpent`) come from
 *   the union of every Deposited / Transacted / Ragequit event seen in the ASP
 *   snapshot and the chain tail. They do NOT depend on a block timestamp
 *   resolving: a note whose block lookup failed is still present, and a
 *   nullifier in such a block is still spent. (The first cut tied both to the
 *   timestamp, so an RPC hiccup could delete a real note or let a spent note be
 *   selected as an input. Codex review, 2026-08-26.)
 * - TIMESTAMPS (`commitmentTimestamp`) are served only with chain-grade
 *   provenance, in one of three tiers (a wrong timestamp produces a witness
 *   that fails inside the circuit with no actionable error, so "unknown" is
 *   strictly better than "plausible"):
 *     1. chain-derived: the tail saw the creation event and took getBlock() of its
 *        own block - that value IS the leaf's second operand by construction;
 *     2. ASP-sourced with leaf proof: `Poseidon(COMMITMENT_LEAF_TAG, c, t)`
 *        appears in the leaf set rebuilt from `LeavesInserted`;
 *     3. healed with event proof: the ASP timestamp failed the leaf proof, but
 *        the row's own block was fetched and its Deposited or Transacted events
 *        CREATE the commitment, so getBlock(block).timestamp is chain-grade.
 *   Anything provable by none of the three is parked as unverified (null),
 *   never served. The leaf set alone is NOT trusted to condemn a value: the
 *   public RPC's eth_getLogs loses ranges silently (2026-08-27), so tier-1 and
 *   tier-3 values bypass it deliberately.
 * - The ASP SNAPSHOT is validated as a whole before any of it is merged: a row
 *   that fails to parse discards the entire snapshot and the index falls back
 *   to a full chain scan, so a malformed feed can never leave partial rows
 *   behind. Its watermark advances through empty blocks, which is what makes a
 *   quiet pool cheap to resume, but it is a CLAIM about the server's own
 *   progress: the tail starts below whichever is lower, that watermark or the
 *   newest block the snapshot proved by returning a row for it. Trusting the
 *   claim alone hid a relayed spend on 2026-08-27; trusting the newest row
 *   alone re-walks a quiet pool's history, so a provider that refuses the
 *   deeper range falls back to the claim and says so. See
 *   services/asp-event-snapshot.ts.
 */

/** Must match `Constants.COMMITMENT_LEAF_TAG` in PoolVault. */
const COMMITMENT_LEAF_TAG =
  '0x086205d9d9e32ce53fc309585685ddb629e878ddd2dd04f575089c3a421342d9' as const;

/** Window during which a built index is reused without re-fetching. */
const DEFAULT_STALE_AFTER_MS = 30_000;

/** Blocks fetched concurrently when resolving tail timestamps. */
const BLOCK_TIMESTAMP_CONCURRENCY = 16;

/**
 * Recheck this many blocks below the snapshot's section watermark as a
 * backstop for ingestion races. A previous ASP pipeline lagged a relayed spend
 * by six minutes; this retains about an hour of overlap on a 12s chain.
 */
const SNAPSHOT_OVERLAP_BLOCKS = 300n;

/**
 * How long a tail-hint delta window is considered already fetched. Long enough
 * to collapse the several index builds a single page load performs, short enough
 * that a new tail event is picked up promptly.
 *
 * Remembered per CHAIN for the whole app, not per index: every withdraw,
 * transfer and spendability check builds its own index, and a per-instance
 * memory meant each one re-sent the same `sinceBlock` (Mike's prod log,
 * 2026-10-01: `tail-hints since=26097874 rows=7 recorded=0` on every press).
 * The hints are best effort; the chain scan stays authoritative. They are
 * block timestamps only, never events: a block they miss is resolved from the
 * chain, so nothing (an own new deposit or withdrawal included) is hidden.
 * 30s, as before: long enough to collapse one press's several index builds,
 * short enough that hints for newly landed blocks arrive promptly.
 */
const TAIL_HINT_TTL_MS = 30_000;
const lastTailHintByChain = new Map<number, { since: bigint; at: number }>();

export type OnChainNoteIndexParams = {
  chainId: number;
  poolVaultInteractor: PoolVaultLike;
  hashService: HashServiceLike;
  /** ASP event snapshot loader. Optional; absence only costs performance. */
  loadEventSnapshot?: () => Promise<unknown>;
  /**
   * Optional: the ASP's event-snapshot rows from `sinceBlock` up, used only to
   * learn block timestamps for the tail window.
   *
   * Injected exactly like loadEventSnapshot, and for the same reason - a direct
   * api-client import here would make every consumer, the test runner included,
   * perform real HTTP. It did: wiring it inline made the suite hit the live ASP,
   * took it from 2.5s to 6.0s, and made a golden accounting test depend on live
   * data. Unset means no hints and the chain stays the source.
   */
  loadEventSnapshotDelta?: (sinceBlock: bigint) => Promise<unknown>;
  /**
   * Optional: the configured pool and the two pool-wide root reads that check
   * a snapshot's `poolState` (asp-v2#150) against the chain. When the roots
   * match, the tail trusts the advertised cursor instead of the proven bound
   * (services/snapshot-pool-state.ts). Unset, or any failure, keeps the proven
   * bound. Set only when the vault being scanned IS this pool.
   */
  poolStateCheck?: { poolAddress: string; reader: PoolStateReader };
  staleAfterMs?: number;
};

/** The subset of the ASP event snapshot this index consumes. */
export type EventSnapshotLike = {
  snapshotBlockNumber: string;
  deposits?: Array<{ outputCommitment: string; blockTimestamp: string; blockNumber?: string }>;
  transacts?: Array<{
    outputCommitments?: string[];
    nullifierHashes?: string[];
    blockTimestamp: string;
    blockNumber?: string;
    txHash?: string;
  }>;
  ragequits?: Array<{ commitment: string; nullifierHash: string; blockTimestamp: string; blockNumber?: string }>;
};

/** One observed Transacted event, enough to match a relayed spend exactly. */
export type ObservedTransact = {
  nullifierHashes: string[];
  outputCommitments: string[];
  /**
   * Set by findTransacted when the caller passed expected outputs: false means
   * the spend of these nullifiers landed with DIFFERENT outputs than this flow
   * built (a same-input spend from another device or a replacement). The event
   * is still the one that consumed our inputs; callers must show ITS txHash.
   */
  outputsMatch?: boolean;
  /** Hex block number when known (chain tail); null for snapshot rows. */
  blockNumber: Hex | null;
  /** Unix-seconds hex when known. */
  timestamp: Hex | null;
  txHash: Hash | null;
};

type Built = {
  commitments: Map<string, Hex>;
  nullifierTimestamps: Map<string, Hex>;
  observedCommitments: Set<string>;
  spentNullifiers: Set<string>;
  transacts: ObservedTransact[];
  unverified: string[];
  /** Commitments whose timestamp came from the chain itself (getBlock of the
   *  event's own block). That value IS what the contract hashed into the leaf,
   *  so it needs no leaf proof — and must not be hostage to one. The public
   *  RPC's eth_getLogs silently drops ranges under load (two identical sweeps
   *  returned 469 vs 257 events, 2026-08-27), so a leaf set fetched once and
   *  cached can have holes; verifying chain-derived timestamps against it
   *  condemned fresh notes forever and starved payee discovery. */
  chainVerified: Set<string>;
  /** commitment -> block that produced it, for healing a dropped ASP
   *  timestamp from the chain (getBlock(block).timestamp). */
  sourceBlocks: Map<string, Hex>;
};

export class OnChainNoteIndex {
  private readonly params: OnChainNoteIndexParams;
  private readonly staleAfterMs: number;

  /** block -> commitments PROVEN emitted in that block by a per-block event
   *  fetch. Positive membership only: a miss deletes the entry so a lossy
   *  fetch is retried next build instead of permanently blocking a heal. */
  private healProofs = new Map<string, Set<string>>();

  /** block -> consecutive builds it was requested and produced neither a
   *  timestamp nor a proof. At the cap the block is dropped from the heal
   *  queue for the session: a permanently unfetchable block must not burn a
   *  heal slot (plus two proof getLogs) on every rebuild (kimi review, F5). */
  private healFailures = new Map<string, number>();

  private state: Built | null = null;
  private builtAtMs: number | null = null;
  private inFlight: Promise<void> | null = null;
  /**
   * Set when the ASP advertised coverage its rows did not prove: the advertised
   * figure, kept so the tail can fall back to it if the deeper, proved start is
   * refused by a pruning provider. Null whenever the claim was proved.
   */
  private unprovenGapFrom: bigint | null = null;
  /**
   * Block number -> block.timestamp, kept across refreshes. Timestamps are
   * immutable, so a rebuild only resolves blocks it has not seen; without
   * this, every forced refresh (the relayed-spend wait polls one every few
   * seconds) re-fetched a few hundred blocks and took ~20s.
   *
   * Seeded from, and written back to, localStorage (see loadPersistedBlockTimestamps).
   */
  private readonly blockTimestamps = new Map<string, Hex>();
  /**
   * Blocks whose timestamp came from an ASP hint (services/asp-block-timestamps.ts)
   * rather than from getBlock. Commitments dated from one of these are NOT added
   * to `chainVerified`, so they still have to prove themselves against the
   * on-chain leaf set - an ASP-supplied value is a claim, not a chain read.
   */
  private readonly aspSourcedBlocks = new Set<string>();
  /** Whether the persisted seed has been merged in yet (once per instance). */
  private persistedSeedLoaded = false;
  /** Entries added since the last flush, so a flush writes rather than rebuilds. */
  private persistDirty = false;

  constructor(params: OnChainNoteIndexParams) {
    this.params = params;
    this.staleAfterMs = params.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  /** Builds or refreshes the index. Idempotent; concurrent callers share one build. */
  async refresh(opts?: { force?: boolean }): Promise<void> {
    if (!opts?.force && this.builtAtMs !== null && Date.now() - this.builtAtMs < this.staleAfterMs) {
      return;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.build().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** True once a build has completed. */
  isBuilt(): boolean {
    return this.builtAtMs !== null;
  }

  /**
   * Canonical `block.timestamp` for a commitment, or `null` when unknown.
   *
   * `null` means "absent, or present but unverifiable" — never assume a note is
   * off-chain from this alone. Use {@link hasCommitment} for that.
   */
  commitmentTimestamp(commitment: Hash): Hex | null {
    return this.built().commitments.get(key(commitment)) ?? null;
  }

  /**
   * Whether a commitment appears in bulk on-chain event data, independent of
   * whether its timestamp resolved or verified. Use this, not a null timestamp,
   * to guard anything destructive.
   */
  hasCommitment(commitment: Hash): boolean {
    return this.built().observedCommitments.has(key(commitment));
  }

  /**
   * Whether a nullifier appears in any Transacted / Ragequit event, independent
   * of whether its block timestamp resolved. THE spent check.
   */
  isNullifierSpent(nullifier: Hash): boolean {
    return this.built().spentNullifiers.has(key(nullifier));
  }

  /**
   * `block.timestamp` at which a nullifier was spent when known, `null` when
   * unspent OR spent in a block whose timestamp did not resolve. Informational;
   * decide spent-ness with {@link isNullifierSpent}.
   */
  nullifierSpentAt(nullifier: Hash): Hex | null {
    return this.built().nullifierTimestamps.get(key(nullifier)) ?? null;
  }

  /**
   * The Transacted event that spent ALL the given nullifiers.
   *
   * A nullifier can be consumed exactly once on-chain, so the event holding all
   * of ours IS the spend of our inputs; that is what makes this an exact
   * confirmation. `outputCommitments`, when given, are compared and reported
   * through `outputsMatch` rather than used as a filter: a same-input spend
   * from another device lands with other outputs, and the caller must learn
   * that (and show the observed txHash) instead of waiting forever for an
   * event that can no longer exist.
   */
  findTransacted(params: {
    nullifiers: readonly Hash[];
    outputCommitments?: readonly Hash[];
  }): ObservedTransact | null {
    if (params.nullifiers.length === 0) return null;
    const wantN = params.nullifiers.map(key);
    const wantC = (params.outputCommitments ?? []).map(key);
    // The same event can appear twice (snapshot row without txHash/block, and
    // the overlapping chain-tail row with both); keep the most informative.
    let best: ObservedTransact | null = null;
    const score = (t: ObservedTransact) => (t.txHash ? 2 : 0) + (t.blockNumber ? 1 : 0) + (t.timestamp ? 1 : 0);
    for (const t of this.built().transacts) {
      const n = new Set(t.nullifierHashes);
      if (!wantN.every((x) => n.has(x))) continue;
      if (best === null || score(t) > score(best)) best = t;
    }
    if (best === null) return null;
    if (wantC.length === 0) return { ...best, outputsMatch: undefined };
    const c = new Set(best.outputCommitments);
    return { ...best, outputsMatch: wantC.every((x) => c.has(x)) };
  }

  /** Commitments dropped because their timestamp did not reproduce a chain leaf. */
  unverifiedCommitments(): string[] {
    return [...this.built().unverified];
  }

  private built(): Built {
    if (this.state === null || this.builtAtMs === null) {
      throw new Error('OnChainNoteIndex queried before refresh(); call refresh() first');
    }
    return this.state;
  }

  private async build(): Promise<void> {
    const next: Built = {
      commitments: new Map(),
      nullifierTimestamps: new Map(),
      observedCommitments: new Set(),
      spentNullifiers: new Set(),
      transacts: [],
      unverified: [],
      chainVerified: new Set(),
      sourceBlocks: new Map(),
    };

    const snapshotBlock = await this.applySnapshot(next);
    await this.applyChainTail(next, snapshotBlock);
    // Leaf-verify only ASP-SOURCED timestamps. Chain-derived ones (tail scan:
    // getBlock of the event's block) are exempt — that timestamp is by
    // construction the leaf's own second operand, and subjecting it to a leaf
    // set that can be silently incomplete (lossy eth_getLogs, then cached for
    // the session) starved discovery of fresh notes (payee bug, 2026-08-27).
    const dropped = await this.verifyAgainstChainLeaves(next.commitments, next.chainVerified);
    // Heal: a dropped ASP timestamp whose row named its block can be
    // re-derived from the chain — same authority as the tail path. Bulk block
    // reads only; no request ever names a commitment.
    const healable = dropped.filter((c) => next.sourceBlocks.has(c));
    if (healable.length > 0) {
      // HARD CAP on the heal's NETWORK fan-out. A lossy leaf fetch can drop
      // hundreds of snapshot rows at once, and healing them all in one build
      // floods the throttled RPC queue with getBlock calls — which starves
      // every other consumer behind the same interactor (observed: the payee's
      // discovery never got past "Starting" while a build healed, 2026-08-27).
      // Three load-bearing details, each broken once before being written down:
      //   - the cap counts only UNCACHED blocks. Cached ones are free, and
      //     capping them froze the drain: the same first-24 slice was
      //     re-requested (all cache hits) every build while the rest sat
      //     "deferred to the next rebuild" forever;
      //   - NEWEST blocks first. A fresh payment is by definition the newest
      //     dropped row, and oldest-first put it permanently behind the
      //     backlog — the payee's note was among the "22 deferred" 13 builds
      //     in a row;
      //   - the timestamp cache persists across builds, so each 30-second
      //     rebuild drains another slice until the backlog is gone.
      const HEAL_FETCHES_PER_BUILD = 24;
      // A slice of the cap is reserved for the OLDEST uncached blocks so a
      // sustained stream of new drops can never starve an old note forever
      // (codex review of d465b4c).
      const OLDEST_RESERVE = 6;
      const distinctBlocks = [...new Set(healable.map((c) => String(next.sourceBlocks.get(c))))] as Hex[];
      distinctBlocks.sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0));
      const HEAL_FAILURE_CAP = 3;
      const usable = distinctBlocks.filter((b) => (this.healFailures.get(String(b)) ?? 0) < HEAL_FAILURE_CAP);
      const cachedBlocks = usable.filter((b) => this.blockTimestamps.has(String(b)));
      const uncachedBlocks = usable.filter((b) => !this.blockTimestamps.has(String(b)));
      const newestShare = uncachedBlocks.slice(0, Math.max(0, HEAL_FETCHES_PER_BUILD - OLDEST_RESERVE));
      const oldestShare = uncachedBlocks
        .slice(newestShare.length)
        .slice(-Math.min(OLDEST_RESERVE, HEAL_FETCHES_PER_BUILD - newestShare.length));
      const blockSlice: Hex[] = [...cachedBlocks, ...newestShare, ...oldestShare];
      const deferred = uncachedBlocks.length - newestShare.length - oldestShare.length;
      if (deferred > 0) {
        console.warn(`[PrivacyIndex] timestamp heal fetching ${newestShare.length + oldestShare.length} new block(s); ${deferred} deferred to the next rebuild`);
      }
      const ts = await this.fetchBlockTimestamps(blockSlice, true);
      // PROVE each heal before serving it. The ASP's blockNumber is a hint
      // from an untrusted feed: a wrong or lying block would make us serve
      // getBlock(wrongBlock).timestamp for a REAL commitment, and a wrong
      // timestamp builds a witness that fails inside the circuit with no
      // actionable error - strictly worse than staying null (codex review).
      // Proof = the commitment was created by that block's own events.
      // Block-keyed fetches only, so no request ever names a commitment.
      await this.proveHealBlocks(blockSlice);
      // Score each fetched block: no timestamp or no proof set counts one
      // failure; success clears the counter.
      for (const b of blockSlice.map(String)) {
        if (ts.has(b) && this.healProofs.has(b)) this.healFailures.delete(b);
        else this.healFailures.set(b, (this.healFailures.get(b) ?? 0) + 1);
      }
      for (const c of healable) {
        const b = String(next.sourceBlocks.get(c));
        const t = ts.get(b);
        if (!t) continue;
        const proven = this.healProofs.get(b);
        if (proven?.has(c)) {
          next.commitments.set(c, t);
          next.chainVerified.add(c);
        } else if (proven) {
          // Cached proof set exists but misses this commitment: either the ASP
          // lied about the block, or the proof fetch itself was lossy. Drop
          // the cached set so the next build re-fetches instead of blocking
          // the heal forever on one bad read.
          this.healProofs.delete(b);
        }
      }
    }
    next.unverified = dropped.filter((c) => !next.commitments.has(c));

    this.state = next;
    this.builtAtMs = Date.now();
  }

  /**
   * Parses the ASP snapshot into a STAGING copy and merges it only if every
   * consumed row validated. Returns the snapshot block (tail start) on success,
   * `null` when there is no snapshot or it was rejected.
   */
  private async applySnapshot(target: Built): Promise<bigint | null> {
    if (!this.params.loadEventSnapshot) return null;
    let snapshot: EventSnapshotLike;
    let cursor: bigint | null;
    let raw: unknown;
    try {
      raw = await this.params.loadEventSnapshot();
      snapshot = parseEventSnapshot(raw);
      // Partial feeds may contribute validated rows, but cannot cover history.
      cursor = snapshotCursor(raw, ['deposits', 'transacts', 'ragequits']);
    } catch {
      // Snapshot is an optimisation, not a dependency: a fetch or parse failure
      // falls through to a full chain scan and leaves NOTHING behind.
      return null;
    }

    const staged: Built = {
      commitments: new Map(),
      nullifierTimestamps: new Map(),
      observedCommitments: new Set(),
      spentNullifiers: new Set(),
      transacts: [],
      unverified: [],
      chainVerified: new Set(),
      sourceBlocks: new Map(),
    };
    // A row claiming a block beyond the snapshot's own advertised boundary is
    // self-inconsistent; letting it into the heal queue hands the ASP a lever
    // to burn heal slots on unfetchable blocks forever (kimi review, F5).
    const advertisedBoundary = BigInt(snapshot.snapshotBlockNumber);
    const healSourceBlock = (blockNumber: string | undefined): Hex | null => {
      if (blockNumber === undefined) return null;
      const b = BigInt(blockNumber);
      if (b > advertisedBoundary) return null;
      return toHex(b) as Hex;
    };
    for (const deposit of snapshot.deposits ?? []) {
      const c = key(deposit.outputCommitment);
      staged.observedCommitments.add(c);
      const ts = isoToHexSeconds(deposit.blockTimestamp);
      if (ts) staged.commitments.set(c, ts);
      {
        const sb = healSourceBlock(deposit.blockNumber);
        if (sb !== null) staged.sourceBlocks.set(c, sb);
      }
    }
    for (const transact of snapshot.transacts ?? []) {
      const ts = isoToHexSeconds(transact.blockTimestamp);
      const outs = (transact.outputCommitments ?? []).map(key);
      const nulls = (transact.nullifierHashes ?? []).map(key);
      for (const c of outs) {
        staged.observedCommitments.add(c);
        if (ts) staged.commitments.set(c, ts);
        {
        const sb = healSourceBlock(transact.blockNumber);
        if (sb !== null) staged.sourceBlocks.set(c, sb);
      }
      }
      for (const n of nulls) {
        staged.spentNullifiers.add(n);
        if (ts) staged.nullifierTimestamps.set(n, ts);
      }
      staged.transacts.push({
        nullifierHashes: nulls,
        outputCommitments: outs,
        blockNumber: transact.blockNumber ? (toHex(BigInt(transact.blockNumber)) as Hex) : null,
        timestamp: ts,
        txHash: transact.txHash ? (transact.txHash as Hash) : null,
      });
    }
    for (const ragequit of snapshot.ragequits ?? []) {
      // An exit proves presence and spend, not the commitment's creation time.
      const c = key(ragequit.commitment);
      const n = key(ragequit.nullifierHash);
      staged.observedCommitments.add(c);
      staged.spentNullifiers.add(n);
      const ts = isoToHexSeconds(ragequit.blockTimestamp);
      if (ts) {
        staged.nullifierTimestamps.set(n, ts);
      }
    }

    mergeInto(target, staged);
    // The watermark covers empty blocks, which is what makes a quiet pool cheap
    // to resume. It is also an unverifiable CLAIM about the server's own
    // progress, and this tail decides whether a note is spent. So start below
    // whichever is LOWER: the advertised watermark, or the newest block the
    // snapshot actually PROVED by returning a row for it.
    //
    // Both halves are load-bearing. Trusting the claim alone is the 2026-08-27
    // incident (advertised at the chain head, rows six minutes behind, tail an
    // empty range, a relayed spend hidden). Using the newest row alone re-scans
    // a quiet pool's whole history on every load, which public RPCs prune — so
    // when the proved figure sends us deeper than the claim, the scan is
    // allowed to fall back to the claim rather than fail (see applyChainTail).
    if (cursor === null) return null;
    // asp-v2#150: a poolState whose state root equals the chain's root at the
    // advertised block proves no Deposited/Transacted/Ragequit insert below it
    // is missing from the ASP's rows, which is exactly what the proven bound
    // below guards against. Only an exact match buys the advertised cursor;
    // anything else keeps the proven bound unchanged.
    const check = this.params.poolStateCheck;
    if (check) {
      const verdict = await verifySnapshotPoolState({
        chainId: this.params.chainId,
        poolAddress: check.poolAddress,
        raw,
        snapshotBlock: cursor,
        reader: check.reader,
      });
      if (verdict.trusted) {
        this.unprovenGapFrom = null;
        const start = cursor - SNAPSHOT_OVERLAP_BLOCKS;
        return start > 0n ? start : 0n;
      }
      if ((raw as { poolState?: unknown } | null)?.poolState != null) {
        console.warn(`[note-index] snapshot poolState not trusted (${verdict.reason}); scanning from the proved figure`);
      } else if (!warnedNoPoolState.has(this.params.chainId)) {
        warnedNoPoolState.add(this.params.chainId);
        console.warn(`[note-index] snapshot carries no poolState on chain ${this.params.chainId}; scanning from the proved figure`);
      }
    }
    const proven = newestSnapshotRowBlock(snapshot, cursor);
    // No row names a block: this snapshot proves no coverage at all. Its rows
    // still merge above as hints, but the chain is scanned in full — expensive,
    // never wrong.
    if (proven === null) return null;
    if (proven < cursor) {
      // The gap is the ASP lagging its own claim. Nothing else reports it, and
      // it is pool-wide block numbers only — no note data.
      this.unprovenGapFrom = cursor;
      console.warn(`[note-index] ASP advertises block ${cursor} but proves only ${proven}; scanning from the proved figure`);
    } else {
      this.unprovenGapFrom = null;
    }
    const bounded = proven < cursor ? proven : cursor;
    const start = bounded - SNAPSHOT_OVERLAP_BLOCKS;
    return start > 0n ? start : 0n;
  }

  /**
   * Chain-verified means "this timestamp came from a block WE read", which is
   * the provenance that exempts a commitment from the leaf proof. A timestamp
   * the ASP volunteered is a claim, so it must not buy that exemption: it stays
   * out of the set and is checked against the on-chain leaf set like any other
   * ASP-sourced value.
   */
  private markChainVerified(target: Built, commitment: string, blockNumber: unknown): void {
    if (this.aspSourcedBlocks.has(String(blockNumber))) return;
    target.chainVerified.add(commitment);
  }

  private async applyChainTail(target: Built, snapshotBlock: bigint | null): Promise<void> {
    const vault = this.params.poolVaultInteractor;
    // Inclusive of the snapshot block: re-delivering the boundary block's events
    // is harmless (everything here is set/map keyed); skipping them is not.
    const fromBlock = snapshotBlock === null ? undefined : (toHex(snapshotBlock) as Hex);

    const readTail = (from?: Hex) => Promise.all([
      vault.getDepositedEvents(from),
      vault.getTransactedEvents(from),
      vault.getRagequitEvents(from),
    ]);

    let deposits; let transacts; let ragequits;
    try {
      [deposits, transacts, ragequits] = await readTail(fromBlock);
    } catch (error) {
      // The proved start can sit far below the advertised one in a pool that
      // has been quiet for a long time, and a pruning provider refuses that
      // depth. Falling back to the advertised start is strictly better than
      // failing the whole index: it restores today's behaviour for this build
      // and says so, rather than pretending the gap was covered.
      const fallbackFrom = this.unprovenGapFrom === null
        ? null
        : this.unprovenGapFrom - SNAPSHOT_OVERLAP_BLOCKS;
      if (fallbackFrom === null || fromBlock === undefined) throw error;
      // ONLY a recognised range/depth refusal earns the shallower retry. A
      // timeout, a 429 or a decode failure says nothing about depth, and
      // retrying shallower on one would publish an index that skipped the gap
      // and answers isNullifierSpent false for a spend inside it. Unrecognised
      // errors propagate and the previous completed index stays authoritative
      // (codex, 2026-09-15).
      if (!isRangeDepthRefusal(error)) throw error;
      console.warn(`[note-index] tail from proved block ${snapshotBlock} was refused; retrying from the advertised ${fallbackFrom}. Events below it are NOT covered by this build.`);
      [deposits, transacts, ragequits] = await readTail(
        toHex(fallbackFrom > 0n ? fallbackFrom : 0n) as Hex,
      );
    }

    // Presence and spent state first, from every event, before any timestamp
    // work can fail.
    for (const d of deposits) target.observedCommitments.add(key(d.outputCommitment));
    for (const t of transacts) {
      for (const c of t.outputCommitments) target.observedCommitments.add(key(c));
      for (const n of t.nullifierHashes) target.spentNullifiers.add(key(n));
    }
    for (const r of ragequits) {
      target.observedCommitments.add(key(r.commitment));
      target.spentNullifiers.add(key(r.nullifierHash));
    }

    // PRIVACY: resolve timestamps for EVERY distinct block in the tail event
    // set, never only the blocks holding this user's notes. Narrowing the set
    // would tell the RPC provider which blocks matter to this client, which is
    // the leak this module exists to remove.
    const blocks = [
      ...deposits.map((d) => d.blockNumber),
      ...transacts.map((t) => t.blockNumber),
      ...ragequits.map((r) => r.blockNumber),
    ];
    // Ask the ASP for the timestamps of this overlap window BEFORE falling back
    // to one getBlock per block. The ASP's own watermark is at chain head
    // (measured 2026-08-27), so it already covers the whole
    // SNAPSHOT_OVERLAP_BLOCKS window, and its deposits/transacts/ragequits rows
    // carry blockTimestamp (asp-v2#117) for exactly these events. That turned
    // ~227 block reads per load into ~0.
    //
    // The EVENT SET still comes from the chain above: presence and spent state
    // stay chain-derived on purpose. Only the timestamps are taken on trust
    // here, and every commitment dated this way is kept out of chainVerified,
    // so it must still prove itself against the on-chain leaf set.
    //
    // The window start comes from the ASP's own watermark, so every client sends
    // the same sinceBlock; it says nothing about when this client was last online.
    if (blocks.length > 0) {
      // Ask from the LOWEST block we actually need, not from a window we assumed.
      // The first cut used snapshotBlock - SNAPSHOT_OVERLAP_BLOCKS and covered
      // only 18 of the 210 blocks the scan asked for: the vault interactor's
      // event scan reaches much further back than that overlap, so a window
      // derived from the snapshot boundary was simply the wrong range. Deriving
      // it from `blocks` cannot drift out of alignment with the scan again.
      let lowest: bigint | null = null;
      for (const b of blocks) {
        try {
          const v = BigInt(b);
          if (lowest === null || v < lowest) lowest = v;
        } catch {
          // ignore an unparseable block number
        }
      }
      if (lowest !== null) await this.recordTailTimestampHints(lowest);
    }
    const timestamps = await this.fetchBlockTimestamps(blocks);

    for (const deposit of deposits) {
      const ts = timestamps.get(String(deposit.blockNumber));
      if (ts) {
        const c = key(deposit.outputCommitment);
        target.commitments.set(c, ts);
        this.markChainVerified(target, c, deposit.blockNumber);
      }
    }
    for (const transact of transacts) {
      const ts = timestamps.get(String(transact.blockNumber)) ?? null;
      const outs = transact.outputCommitments.map(key);
      const nulls = transact.nullifierHashes.map(key);
      if (ts) {
        for (const c of outs) {
          target.commitments.set(c, ts);
          this.markChainVerified(target, c, transact.blockNumber);
        }
        for (const n of nulls) target.nullifierTimestamps.set(n, ts);
      }
      target.transacts.push({
        nullifierHashes: nulls,
        outputCommitments: outs,
        blockNumber: transact.blockNumber,
        timestamp: ts,
        txHash: transact.txHash ?? null,
      });
    }
    for (const ragequit of ragequits) {
      const ts = timestamps.get(String(ragequit.blockNumber));
      if (!ts) continue;
      target.nullifierTimestamps.set(key(ragequit.nullifierHash), ts);
    }
  }

  /**
   * Fetches each block's OWN events and records which commitments they emit.
   * Positive proof for the heal path; per-block, bounded by the heal cap, and
   * cached so a proven block costs nothing on later builds.
   */
  private async proveHealBlocks(blocks: readonly Hex[]): Promise<void> {
    const vault = this.params.poolVaultInteractor;
    const missing = [...new Set(blocks.map(String))].filter((b) => !this.healProofs.has(b));
    for (const b of missing) {
      try {
        const [deposits, transacts] = await Promise.all([
          vault.getDepositedEvents(b as Hex, b as Hex),
          vault.getTransactedEvents(b as Hex, b as Hex),
        ]);
        const proven = new Set<string>();
        // Privacy-aligned scans can also return events from earlier blocks.
        for (const d of deposits) if (BigInt(d.blockNumber) === BigInt(b)) proven.add(key(d.outputCommitment));
        for (const t of transacts) {
          if (BigInt(t.blockNumber) === BigInt(b)) for (const c of t.outputCommitments) proven.add(key(c));
        }
        this.healProofs.set(b, proven);
      } catch {
        // No proof, no heal: the commitment stays unverified this build and
        // the block is retried next build.
      }
    }
  }

  /**
   * Block timestamps survive the tab, in localStorage.
   *
   * Safe to persist, and specifically safe in localStorage rather than
   * sessionStorage, for two reasons:
   *
   *  - It is not user data. This index is POOL-WIDE by construction: the tail
   *    scan resolves every distinct block in the pool's event set, never only
   *    the blocks holding this user's notes (that narrowing is the leak this
   *    module exists to remove). So the key set is the same for every client
   *    watching the same pool, and reveals nothing about which notes are ours.
   *  - A block timestamp is an immutable public fact, so a cached value cannot
   *    go stale or be wrong later. Near-head blocks are the one exception and
   *    are never cached at all (they can be reorged out), which is already the
   *    rule for the in-memory map.
   *
   * This exists because the map was memory-only: every new tab re-resolved a
   * few hundred blocks one eth_getBlockByNumber at a time (measured 2026-08-27:
   * ~450 calls per cold load, of which a rate-limited RPC shed ~72), and that
   * dominated the wait before a balance appeared.
   *
   * Cap and eviction: oldest-block-first, keeping the newest MAX_PERSISTED
   * entries, because the tail scan always needs the recent end of the range.
   */
  private persistKey(): string {
    return `ppv2_block_ts_v1:${this.params.chainId}`;
  }

  private loadPersistedBlockTimestamps(): void {
    if (this.persistedSeedLoaded) return;
    this.persistedSeedLoaded = true;
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(this.persistKey());
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      for (const [block, ts] of Object.entries(parsed as Record<string, unknown>)) {
        // Only seed entries the in-memory map does not already hold, and only
        // well-formed hex values - a corrupted entry must not become a
        // timestamp we later feed into a commitment leaf.
        if (this.blockTimestamps.has(block)) continue;
        if (typeof ts !== 'string' || !/^0x[0-9a-fA-F]+$/.test(ts)) continue;
        this.blockTimestamps.set(block, ts as Hex);
      }
    } catch {
      // Corrupt or unavailable store: it is only a cache.
    }
  }

  private flushPersistedBlockTimestamps(): void {
    if (!this.persistDirty) return;
    this.persistDirty = false;
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const MAX_PERSISTED = 20_000;
      let entries = Array.from(this.blockTimestamps.entries());
      if (entries.length > MAX_PERSISTED) {
        // Newest blocks are the ones a tail scan will ask for again.
        entries.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? 1 : -1));
        entries = entries.slice(0, MAX_PERSISTED);
      }
      window.localStorage.setItem(this.persistKey(), JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // Quota or private mode: non-fatal, we simply refetch next time.
    }
  }

  /**
   * Harvest (block, timestamp) pairs for the tail window from the ASP's event
   * snapshot delta, into the hint store the timestamp resolver consults first.
   *
   * Best effort by design: no loader, or any failure, leaves the chain as the
   * source, which is exactly the behaviour that existed before this call.
   */
  private async recordTailTimestampHints(fromBlock: bigint): Promise<void> {
    if (!this.params.loadEventSnapshotDelta) return;
    try {
      const since = fromBlock < 0n ? 0n : fromBlock;
      // Skip a repeat of the same window inside TAIL_HINT_TTL_MS. Measured on a
      // real load: the delta ran four times per page load and the later calls
      // reported `rows=234 recorded=0` - the same rows, none of them new, about
      // 260KB each. A short TTL rather than a permanent skip, because new tail
      // events DO appear in the same window as the chain advances; and the chain
      // scan remains the authoritative event source either way.
      const now = Date.now();
      const last = lastTailHintByChain.get(this.params.chainId);
      if (last && last.since === since && now - last.at < TAIL_HINT_TTL_MS) {
        return;
      }
      lastTailHintByChain.set(this.params.chainId, { since, at: now });
      const payload = await this.params.loadEventSnapshotDelta(since);
      const rows: Array<{ blockNumber?: unknown; blockTimestamp?: unknown }> = [];
      for (const section of ['deposits', 'transacts', 'privateTransfers', 'ragequits'] as const) {
        const list = (payload as Record<string, unknown> | null)?.[section];
        if (Array.isArray(list)) rows.push(...(list as typeof rows));
      }
      const { recordAspBlockTimestamps } = await import('@/services/asp-block-timestamps');
      const added = rows.length > 0 ? recordAspBlockTimestamps(this.params.chainId, rows) : 0;
      try {
        console.log(
          `[perf] · tail-hints since=${since} rows=${rows.length} recorded=${added}`
          + ` sample=${rows.length > 0 ? JSON.stringify({ b: rows[0]?.blockNumber, t: rows[0]?.blockTimestamp }) : 'none'}`,
        );
      } catch { /* ignore */ }
      if (rows.length === 0) return;
    } catch {
      // No hints: fetchBlockTimestamps falls back to the chain, as before.
    }
  }

  private async fetchBlockTimestamps(blockNumbers: readonly Hex[], chainOnly = false): Promise<Map<string, Hex>> {
    // Seed from the previous tab's work before deciding what is missing.
    this.loadPersistedBlockTimestamps();
    const out = new Map<string, Hex>();
    const unique = [...new Set(blockNumbers.map(String))];

    // Resolved lazily: a static import of '@/config/chains' drags the
    // react-native entrypoint into every consumer, including the test runner.
    const { getChainConfig } = await import('@/config/chains');
    const chain = getChainConfig(this.params.chainId);
    if (!chain) {
      for (const b of unique) {
        const cached = this.blockTimestamps.get(b);
        if (cached) out.set(b, cached);
      }
      return out;
    }
    // Same fail-over as wagmi: this index is what issued the per-block reads a
    // rate-limited endpoint shed (72 of 232 in one measured load), so it is
    // exactly the client that should roll over rather than drop rows.
    const client = createPublicClient({
      // policedHttp: this index is the bulk replacement for the per-note
      // reads, so it above all must not be able to make one by accident.
      transport: fallback((chain.rpcUrls ?? [chain.rpcUrl]).map((url) => policedHttp(url))),
    });

    // REORG GUARD: a cached timestamp for a block near the head may belong to
    // an orphaned block (getLogs raced a reorg, or the cache outlived one).
    // Serving it would bypass leaf verification via chainVerified with a
    // wrong value, so near-head blocks are always re-fetched, never cached
    // (codex review of f962e17). One getBlockNumber per call, only when any
    // requested block might be cached.
    let nearHeadCutoff: bigint | null = null;
    let missing: string[] = [];
    for (const b of unique) {
      const cached = this.blockTimestamps.get(b);
      if (cached) {
        if (nearHeadCutoff === null) {
          try {
            nearHeadCutoff = (await client.getBlockNumber()) - 64n;
          } catch {
            nearHeadCutoff = 0n; // head unknown: treat every cached block as near-head
          }
        }
        if (BigInt(b) < nearHeadCutoff) {
          out.set(b, cached);
          continue;
        }
        this.blockTimestamps.delete(b);
      }
      missing.push(b);
    }
    // ASP hints next, for blocks the chain-derived cache does not hold. These
    // come from the bulk note-events payload we already fetch (asp-v2#117) and
    // are the reason this method no longer issues hundreds of getBlock calls.
    // They are NOT written into this.blockTimestamps: that map is persisted and
    // must stay purely chain-derived, or a later session would trust a claim as
    // a chain read.
    const stillMissing: string[] = [];
    let hintCovered = 0;
    for (const b of missing) {
      const hint = chainOnly ? null : getAspBlockTimestamp(this.params.chainId, b);
      if (hint && /^0x[0-9a-fA-F]+$/.test(hint)) {
        out.set(b, hint as Hex);
        this.aspSourcedBlocks.add(String(b));
        hintCovered += 1;
        continue;
      }
      stillMissing.push(b);
    }
    missing = stillMissing;

    try {
      const nums = blockNumbers.map((b) => { try { return BigInt(b); } catch { return 0n; } }).filter((v) => v > 0n);
      const lo = nums.length ? nums.reduce((a, b) => (b < a ? b : a)) : 0n;
      const hi = nums.length ? nums.reduce((a, b) => (b > a ? b : a)) : 0n;
      console.log(`[perf] · block-ts asked=${blockNumbers.length} span=${lo}..${hi} cached=${blockNumbers.length - missing.length} hinted=${hintCovered} toFetch=${missing.length}`);
    } catch { /* ignore */ }
    if (missing.length === 0) return out;
    let fetchedAny = false;

    for (let i = 0; i < missing.length; i += BLOCK_TIMESTAMP_CONCURRENCY) {
      const window = missing.slice(i, i + BLOCK_TIMESTAMP_CONCURRENCY);
      const results = await Promise.all(
        window.map(async (blockNumber) => {
          try {
            const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
            return [blockNumber, toHex(block.timestamp) as Hex] as const;
          } catch {
            // Omit rather than default. A defaulted timestamp yields a leaf that
            // does not exist on-chain, and the failure surfaces only inside the
            // circuit. Presence/spent state were recorded before this step.
            return null;
          }
        }),
      );
      for (const entry of results) {
        if (!entry) continue;
        out.set(entry[0], entry[1]);
        // A real chain read supersedes any hint for this block: the value is
        // now chain-grade, so it must no longer be treated as ASP-sourced.
        this.aspSourcedBlocks.delete(entry[0]);
        // Near-head timestamps stay uncached so the next build re-reads them
        // past any reorg; settled blocks cache forever.
        if (nearHeadCutoff === null || BigInt(entry[0]) < nearHeadCutoff) {
          this.blockTimestamps.set(entry[0], entry[1]);
          this.persistDirty = true;
          fetchedAny = true;
        }
      }
    }

    if (fetchedAny) this.flushPersistedBlockTimestamps();
    return out;
  }

  /**
   * Drops every NON-EXEMPT commitment whose `Poseidon(COMMITMENT_LEAF_TAG, c,
   * t)` is absent from the chain-derived leaf set. Chain-derived timestamps
   * (`exempt` = chainVerified) skip the check - they are the leaf's own
   * operand by construction, and the leaf set itself can be silently
   * incomplete (lossy eth_getLogs). Dropped entries may still be healed with
   * event proof afterwards (see build()). Presence is untouched.
   */
  private async verifyAgainstChainLeaves(
    commitments: Map<string, Hex>,
    exempt: ReadonlySet<string>,
  ): Promise<string[]> {
    const leaves = await this.params.poolVaultInteractor.getStateLeaves();
    const leafSet = new Set(leaves.filter(Boolean).map((l: string) => key(l)));
    // A LeavesInserted range lost by the RPC leaves holes in the index-placed
    // array. The set above hides them, so name them: a holed leaf set is the
    // one thing that makes verification lie (2026-08-27 payee incident).
    const holes = leaves.length - leafSet.size >= 0 ? leaves.filter((l) => !l).length : 0;
    if (holes > 0) {
      console.warn(`[PrivacyIndex] leaf set has ${holes} hole(s): an eth_getLogs range was lost; verification may drop real timestamps`);
    }
    const dropped: string[] = [];

    for (const [commitment, timestamp] of commitments) {
      if (exempt.has(commitment)) continue; // chain-derived: the leaf's own operand
      const leaf = this.params.hashService.hash([
        COMMITMENT_LEAF_TAG,
        commitment as Hex,
        timestamp,
      ]);
      if (!leafSet.has(key(leaf))) dropped.push(commitment);
    }
    for (const commitment of dropped) commitments.delete(commitment);

    return dropped;
  }
}

function mergeInto(target: Built, staged: Built): void {
  for (const [k, v] of staged.commitments) target.commitments.set(k, v);
  for (const [k, v] of staged.nullifierTimestamps) target.nullifierTimestamps.set(k, v);
  for (const k of staged.observedCommitments) target.observedCommitments.add(k);
  for (const k of staged.spentNullifiers) target.spentNullifiers.add(k);
  for (const k of staged.chainVerified) target.chainVerified.add(k);
  for (const [k, v] of staged.sourceBlocks) target.sourceBlocks.set(k, v);
  target.transacts.push(...staged.transacts);
}

/**
 * Strict structural validation of the ASP snapshot envelope and of every row
 * this index consumes. Throws on the first problem so the caller discards the
 * whole snapshot; partial feeds must never be merged.
 */
export function parseEventSnapshot(raw: unknown): EventSnapshotLike {
  if (!raw || typeof raw !== 'object') throw new Error('snapshot: not an object');
  const s = raw as Record<string, unknown>;
  const block = s.snapshotBlockNumber;
  if (typeof block !== 'string' && typeof block !== 'number') {
    throw new Error('snapshot: missing snapshotBlockNumber');
  }
  BigInt(block); // throws on garbage
  const isBig = (v: unknown): v is string => {
    if (typeof v !== 'string' || v.length === 0) return false;
    try {
      BigInt(v);
      return true;
    } catch {
      return false;
    }
  };
  const isTs = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
  const arr = (v: unknown, name: string): unknown[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`snapshot: ${name} is not an array`);
    return v;
  };

  const optBlock = (v: unknown, where: string): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!isBig(typeof v === 'number' ? String(v) : v)) throw new Error(`snapshot: .blockNumber malformed`);
    return String(v);
  };
  const deposits = arr(s.deposits, 'deposits').map((d, i) => {
    const row = d as Record<string, unknown>;
    if (!isBig(row.outputCommitment) || !isTs(row.blockTimestamp)) {
      throw new Error(`snapshot: deposits[${i}] malformed`);
    }
    return {
      outputCommitment: row.outputCommitment,
      blockTimestamp: row.blockTimestamp,
      blockNumber: optBlock(row.blockNumber, `deposits[${i}]`),
    };
  });
  const transacts = arr(s.transacts, 'transacts').map((t, i) => {
    const row = t as Record<string, unknown>;
    const outs = arr(row.outputCommitments, `transacts[${i}].outputCommitments`);
    const nulls = arr(row.nullifierHashes, `transacts[${i}].nullifierHashes`);
    if (!isTs(row.blockTimestamp) || !outs.every(isBig) || !nulls.every(isBig)) {
      throw new Error(`snapshot: transacts[${i}] malformed`);
    }
    return {
      outputCommitments: outs as string[],
      nullifierHashes: nulls as string[],
      blockTimestamp: row.blockTimestamp,
      blockNumber: optBlock(row.blockNumber, `transacts[${i}]`),
      txHash: typeof row.txHash === 'string' ? row.txHash : undefined,
    };
  });
  const ragequits = arr(s.ragequits, 'ragequits').map((r, i) => {
    const row = r as Record<string, unknown>;
    if (!isBig(row.commitment) || !isBig(row.nullifierHash) || !isTs(row.blockTimestamp)) {
      throw new Error(`snapshot: ragequits[${i}] malformed`);
    }
    return {
      commitment: row.commitment,
      nullifierHash: row.nullifierHash,
      blockTimestamp: row.blockTimestamp,
      blockNumber: optBlock(row.blockNumber, `ragequits[${i}]`),
    };
  });

  return { snapshotBlockNumber: String(block), deposits, transacts, ragequits };
}

/** Canonical 32-byte lowercase hex key, so decimal/hex/padding variants collide correctly. */
function key(value: string): string {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function toHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/** ASP ISO-8601 `blockTimestamp` to hex Unix seconds, matching Solidity's `block.timestamp`. */
function isoToHexSeconds(iso: string): Hex | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return `0x${Math.floor(ms / 1000).toString(16)}` as Hex;
}

/** The deposit, transact and ragequit rows of a held snapshot at or above `sinceBlock`. */
export function eventSnapshotRowsFrom(payload: unknown, sinceBlock: bigint): Record<string, unknown[]> {
  const held = (payload ?? {}) as Record<string, unknown>;
  const inTail = (row: { blockNumber?: unknown } | null) => {
    try {
      return BigInt(row?.blockNumber as string) >= sinceBlock;
    } catch {
      return false;
    }
  };
  return Object.fromEntries((['deposits', 'transacts', 'ragequits'] as const).map((section) => {
    const rows = held[section];
    return [section, Array.isArray(rows) ? (rows as Array<{ blockNumber?: unknown } | null>).filter(inTail) : []];
  }));
}

/**
 * Builds an index wired to this app's ASP snapshot endpoint.
 *
 * Prefer this over constructing {@link OnChainNoteIndex} directly so every flow
 * gets the same bulk sources; a flow that skips the snapshot still works, but
 * pays a full chain scan.
 */
const ROOT_BUFFER_ABI = [
  { type: 'function', name: 'currentRootIndex', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'roots', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * The poolState reader and chain head over the chain's own RPC endpoints, for
 * the configured pool only. Pool-wide view calls at a historical block: the
 * arguments are a block number and a root-buffer slot, never a note value.
 * They run inside an index build, which already reads the chain at that
 * moment, and a verified block is not read again this session.
 */
function chainPoolStateWiring(chainId: number, poolAddress: string): Pick<OnChainNoteIndexParams, 'poolStateCheck'> {
  let client: Promise<{ client: ReturnType<typeof createPublicClient>; pool: `0x${string}` }> | null = null;
  const connect = () => {
    client ??= (async () => {
      const { getChainConfig } = await import('@/config/chains');
      const chain = getChainConfig(chainId);
      const pinned = chain?.contracts?.poolAddress;
      if (!chain || !pinned) throw new Error(`no pinned pool for chain ${chainId}`);
      return {
        client: createPublicClient({
          transport: fallback((chain.rpcUrls ?? [chain.rpcUrl]).map((url) => policedHttp(url))),
        }),
        pool: pinned as `0x${string}`,
      };
    })();
    client.catch(() => { client = null; });
    return client;
  };
  return {
    poolStateCheck: {
      poolAddress,
      reader: {
        stateRootAt: async (blockNumber) => {
          const { client: c, pool } = await connect();
          // Only the pinned pool is checked. A caller scanning another pool
          // (a legacy one) gets a read failure, so it keeps the proven bound.
          if (pool.toLowerCase() !== poolAddress.toLowerCase()) {
            throw new Error('scanned pool is not the pinned pool');
          }
          const index = await c.readContract({ address: pool, abi: ROOT_BUFFER_ABI, functionName: 'currentRootIndex', blockNumber });
          return c.readContract({ address: pool, abi: ROOT_BUFFER_ABI, functionName: 'roots', args: [BigInt(index)], blockNumber });
        },
      },
    },
  };
}

export function createOnChainNoteIndex(params: {
  chainId: number;
  poolVaultInteractor: OnChainNoteIndexParams['poolVaultInteractor'];
  hashService: OnChainNoteIndexParams['hashService'];
  /**
   * The pool `poolVaultInteractor` scans. Enables the poolState check and the
   * shared tail coverage; both are skipped when omitted, and the root reads
   * refuse unless it is the chain config's pinned pool.
   */
  poolAddress?: string;
  staleAfterMs?: number;
}): OnChainNoteIndex {
  const { poolAddress, ...rest } = params;
  return new OnChainNoteIndex({
    ...rest,
    ...(poolAddress ? chainPoolStateWiring(params.chainId, poolAddress) : {}),
    loadEventSnapshot: async () => {
      // The copy the public feed grid keeps (services/snapshot-source.ts),
      // shared with the activity query. Reading it never sends a request.
      const { loadPoolEventSnapshot } = await import('@/services/snapshot-source');
      return loadPoolEventSnapshot(params.chainId);
    },
    // The tail's rows out of that same held copy, never a delta of its own:
    // this index used to fetch one on rebuild, and a rebuild follows whatever
    // the SDK is doing, a spend being prepared included, so the ASP saw that
    // request at that moment. The copy is at most one grid instant old, so only
    // the few blocks above it are left to the chain.
    loadEventSnapshotDelta: async (sinceBlock: bigint) => {
      const { loadPoolEventSnapshot } = await import('@/services/snapshot-source');
      return eventSnapshotRowsFrom(await loadPoolEventSnapshot(params.chainId), sinceBlock);
    },
  });
}

/**
 * Waits for a Transacted event that spends ALL `nullifiers` (and creates all
 * `outputCommitments`, when given) to appear in bulk chain data.
 *
 * Privacy-preserving replacement for `waitForTransactionReceipt(relayTxHash)`
 * on a relayed spend. Polling the relayer's transaction hash against the user's
 * own RPC provider tells that provider this client is the beneficiary of that
 * transaction, which is exactly the link the relayer exists to break. The
 * nullifiers and outputs of the spend are already known locally, and their
 * appearance in one Transacted event confirms the same thing from data every
 * client fetches identically.
 *
 * @returns the observed event, or `null` on timeout. `null` is INCONCLUSIVE,
 *   not a failure: the transaction may simply not be indexed yet.
 */
export async function waitForTransacted(
  index: OnChainNoteIndex,
  params: { nullifiers: readonly Hash[]; outputCommitments?: readonly Hash[] },
  opts?: { attempts?: number; intervalMs?: number; budgetMs?: number },
): Promise<ObservedTransact | null> {
  // Both a wall-clock budget and an attempt cap: a rebuild's duration depends
  // on the tail size, so attempts alone are not a predictable wait.
  const attempts = opts?.attempts ?? 40;
  const intervalMs = opts?.intervalMs ?? 4_000;
  const budgetMs = opts?.budgetMs ?? 180_000;
  if (params.nullifiers.length === 0) return null;
  const deadline = Date.now() + budgetMs;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await index.refresh({ force: true });
      const hit = index.findTransacted(params);
      if (hit) return hit;
    } catch {
      // Transient bulk-fetch failure; keep polling until the budget runs out.
    }
    if (Date.now() >= deadline) break;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return null;
}

/** Boolean form of {@link waitForTransacted} for callers that only need spent-ness. */
export async function waitForNullifiersSpent(
  index: OnChainNoteIndex,
  nullifiers: readonly Hash[],
  opts?: { attempts?: number; intervalMs?: number },
): Promise<boolean> {
  return (await waitForTransacted(index, { nullifiers }, opts)) !== null;
}

/**
 * Confirms a relayed spend without telling the RPC provider which transaction
 * this client cares about.
 *
 * Wraps the whole build-index-then-watch sequence so the three relayed flows
 * (withdraw, transfer, payment-request) share one implementation.
 *
 * @param inputCommitments - commitments of the notes being spent; their
 *   nullifiers are derived locally and watched for in bulk chain data.
 * @param outputCommitments - when the caller knows the outputs it created
 *   (change note, recipient notes), pass them so the match is exact: a
 *   different spend of the same inputs does not confirm this one.
 * @returns `observed` is the matching event (with its real txHash / block when
 *   the chain tail supplied them) or `null` when nothing matched in time.
 *   `null` is INCONCLUSIVE: the relayer accepted the transaction and returned
 *   a hash, so the caller must keep the flow in a submitted/unconfirmed state
 *   and let note sync settle it, never claim success. The built `index` is
 *   returned so callers read output-note timestamps from it instead of
 *   fetching the relayed transaction's block.
 */
export async function confirmRelayedSpend(params: {
  chainId: number;
  poolAddress: string;
  fromBlock: bigint | number;
  inputCommitments: readonly Hash[];
  outputCommitments?: readonly Hash[];
  privateNullifyingKey: Hex;
  attempts?: number;
  intervalMs?: number;
  budgetMs?: number;
}): Promise<{ confirmed: boolean; observed: ObservedTransact | null; index: OnChainNoteIndex }> {
  const { createNoteComputationService, createHashService, createPoolVaultInteractor, createRPCInteractor } =
    await import('@/services/sdk-runtime');

  const noteComp = await createNoteComputationService();
  const hashService = await createHashService();
  const rpc = createRPCInteractor(params.chainId, Number(params.fromBlock));
  const vault = createPoolVaultInteractor(
    rpc,
    params.poolAddress as `0x${string}`,
    hashService,
    BigInt(params.fromBlock),
  );

  const index = createOnChainNoteIndex({
    chainId: params.chainId,
    poolVaultInteractor: vault as never,
    hashService: hashService as never,
    poolAddress: params.poolAddress,
  });

  const nullifiers = params.inputCommitments.map(
    (commitment) => noteComp.computeNullifier(params.privateNullifyingKey, commitment) as Hash,
  );

  const observed = await waitForTransacted(
    index,
    { nullifiers, outputCommitments: params.outputCommitments },
    { attempts: params.attempts, intervalMs: params.intervalMs, budgetMs: params.budgetMs },
  );
  if (observed) {
    // These notes are spent now, whichever relay spent them: nothing of theirs is pending any more.
    try {
      const { settlePendingRelaysBySpends } = await import('@/services/pending-relays-store');
      settlePendingRelaysBySpends(params.chainId, [{ txHash: observed.txHash, nullifiers: observed.nullifierHashes }]);
    } catch { /* bookkeeping only */ }
  }
  return { confirmed: observed !== null, observed, index };
}
