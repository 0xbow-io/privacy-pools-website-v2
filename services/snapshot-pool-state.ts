/**
 * Chain-verifiable proof that an ASP event snapshot is complete through its
 * advertised block. PURE module (no SDK / react-native imports, bun-testable).
 *
 * The note index normally starts its chain tail at the LOWER of the advertised
 * snapshot block and the newest block the snapshot proved with a row (the
 * 2026-08-27 defence, services/onchain-note-index.ts). On a quiet pool the
 * newest row can be months old, so every index build re-scanned the pool's
 * whole quiet stretch (Citrea: ~1.17M blocks, ~1,170 getLogs per build).
 *
 * asp-v2#150 adds `poolState` to the snapshot envelope, built only from the
 * ASP's indexed rows. Every Deposited, Transacted and Ragequit inserts leaves
 * into the PoolVault state tree and updates the root (PoolVault.sol deposit,
 * transact and ragequit all call _insertInStateTree + _updateRoot), so if the
 * root the ASP derived from its rows equals the root the chain holds at that
 * block, no insert below it is missing and the advertised cursor is safe to
 * trust. The check is pool-wide view calls at a historical block: they name
 * no note, so they carry nothing that links this client to one.
 *
 * Anything short of an exact match (field missing, malformed, inconsistent,
 * read failed, root differs) leaves the proven-bound behaviour in place.
 */

export type SnapshotPoolState = {
  blockNumber: bigint;
  stateRoot: bigint | null;
  stateLeafCount: bigint;
  lastLeafIndex: bigint | null;
  keystoreRoot: bigint | null;
  keystoreLeafCount: bigint;
  ragequitCount: bigint;
};

/** The two chain reads the check needs, both at `blockNumber`. */
export type PoolStateReader = {
  /** PoolVault.roots(PoolVault.currentRootIndex()) at `blockNumber`. */
  stateRootAt: (blockNumber: bigint) => Promise<bigint>;
  /** Keystore.currentRoot() at `blockNumber`. Only needed when the keystore is checked. */
  keystoreRootAt?: (blockNumber: bigint) => Promise<bigint>;
};

const DEC = /^\d+$/;

function dec(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !DEC.test(value)) return undefined;
  return BigInt(value);
}

function decOrNull(value: unknown): bigint | null | undefined {
  if (value === null) return null;
  return dec(value);
}

/**
 * The snapshot's `poolState`, or null when absent or malformed in any field.
 * Strict on purpose: a half-parsed claim must not buy any trust.
 */
export function parseSnapshotPoolState(raw: unknown): SnapshotPoolState | null {
  const ps = (raw as { poolState?: unknown } | null | undefined)?.poolState;
  if (!ps || typeof ps !== 'object' || Array.isArray(ps)) return null;
  const r = ps as Record<string, unknown>;
  const blockNumber = dec(r.blockNumber);
  const stateRoot = decOrNull(r.stateRoot);
  const stateLeafCount = dec(r.stateLeafCount);
  const lastLeafIndex = decOrNull(r.lastLeafIndex);
  const keystoreRoot = decOrNull(r.keystoreRoot);
  const keystoreLeafCount = dec(r.keystoreLeafCount);
  const ragequitCount = dec(r.ragequitCount);
  if (
    blockNumber === undefined || stateRoot === undefined || stateLeafCount === undefined
    || lastLeafIndex === undefined || keystoreRoot === undefined || keystoreLeafCount === undefined
    || ragequitCount === undefined
  ) return null;
  return { blockNumber, stateRoot, stateLeafCount, lastLeafIndex, keystoreRoot, keystoreLeafCount, ragequitCount };
}

/**
 * Why a parsed poolState cannot be checked against the chain, or null when it
 * is internally consistent and describes exactly the snapshot's own block.
 */
export function poolStateInconsistency(ps: SnapshotPoolState, snapshotBlock: bigint, checkKeystore = false): string | null {
  if (ps.blockNumber !== snapshotBlock) return `poolState block ${ps.blockNumber} != snapshot block ${snapshotBlock}`;
  if (ps.lastLeafIndex === null) {
    if (ps.stateLeafCount !== 0n) return 'poolState has leaves but no lastLeafIndex';
    if (ps.stateRoot !== null) return 'poolState has a root but no leaves';
  } else {
    if (ps.stateLeafCount !== ps.lastLeafIndex + 1n) return 'poolState stateLeafCount != lastLeafIndex + 1';
    if (ps.stateRoot === null) return 'poolState has leaves but no root';
  }
  if (checkKeystore && (ps.keystoreRoot === null) !== (ps.keystoreLeafCount === 0n)) return 'poolState keystore root and count disagree';
  return null;
}

/**
 * The on-chain root buffer holds 0 before the first insert, so a null root
 * matches only an empty tree. A 0 the ASP sends as a real root is never a
 * valid Poseidon tree root and matches nothing.
 */
function rootMatches(claimed: bigint | null, onChain: bigint): boolean {
  if (claimed === null) return onChain === 0n;
  return claimed !== 0n && claimed === onChain;
}

/** Verified results per chain+pool+block, kept for the session. Only matches are cached. */
const verified = new Set<string>();

export type PoolStateVerdict = { trusted: true } | { trusted: false; reason: string };

/**
 * Checks the snapshot's poolState against the chain at its block. Never
 * throws: every failure is a `trusted: false` with the reason, and the caller
 * keeps the proven bound.
 */
export async function verifySnapshotPoolState(params: {
  chainId: number;
  poolAddress: string;
  raw: unknown;
  snapshotBlock: bigint;
  reader: PoolStateReader;
  checkKeystore?: boolean;
}): Promise<PoolStateVerdict> {
  const ps = parseSnapshotPoolState(params.raw);
  if (ps === null) return { trusted: false, reason: 'no usable poolState' };
  const inconsistency = poolStateInconsistency(ps, params.snapshotBlock, params.checkKeystore);
  if (inconsistency) return { trusted: false, reason: inconsistency };
  const memoKey = [
    params.chainId,
    params.poolAddress.toLowerCase(),
    ps.blockNumber,
    ps.stateRoot ?? 'null',
    params.checkKeystore ? `ks:${ps.keystoreRoot ?? 'null'}` : '',
  ].join(':');
  if (verified.has(memoKey)) return { trusted: true };
  try {
    const onChainRoot = await params.reader.stateRootAt(ps.blockNumber);
    if (!rootMatches(ps.stateRoot, onChainRoot)) {
      return { trusted: false, reason: `state root at ${ps.blockNumber} differs from the chain` };
    }
    if (params.checkKeystore) {
      if (!params.reader.keystoreRootAt) return { trusted: false, reason: 'no keystore reader' };
      const onChainKs = await params.reader.keystoreRootAt(ps.blockNumber);
      if (!rootMatches(ps.keystoreRoot, onChainKs)) {
        return { trusted: false, reason: `keystore root at ${ps.blockNumber} differs from the chain` };
      }
    }
  } catch (error) {
    return { trusted: false, reason: `root read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  verified.add(memoKey);
  return { trusted: true };
}

/** Tests only. */
export function resetSnapshotPoolStateMemo(): void {
  verified.clear();
}
