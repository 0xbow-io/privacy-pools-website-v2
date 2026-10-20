/**
 * A THIRD opinion on the balance, from the chain itself.
 *
 * WHY. The balance and My transactions are two derivations of the same two
 * inputs: the ASP event feed and the local note store. They disagree only when
 * an approved deposit has no local note — which is what
 * services/balance-reconcile.ts watches. Feed either surface a bad input and
 * they agree, are both wrong, and nothing notices: one account's notes sitting
 * in another's cache were counted as balance AND rendered as received
 * transfers, in perfect agreement, until a second browser proved otherwise
 * (Pat, 2026-08-28). A consistency check between two readers of one source can
 * never catch that. Only an independent source can, and there is exactly one:
 * the pool contract.
 *
 * TWO POLICIES OVER ONE SET OF FACTS, and the difference is what each kind of
 * evidence can prove — the same split services/leaf-gate.ts draws:
 *
 *   - PROVEN SPENT is positive evidence from a bulk RPC Transacted/Ragequit
 *     event (not merely the ASP-backed index union), at or below the chain's
 *     finalized block. A nullifier is consumed exactly once. We computed it
 *     locally from our key over our commitment, so a finalized hit is proof
 *     this note is gone. Ragequit maps to EXITED, not SPENT.
 *   - NOT OBSERVED is an absence, and absence here is routinely wrong. The
 *     index can trail the chain by the ASP snapshot cadence plus one log scan,
 *     and services/sdk-setup.ts records answering 0 from that absence dropping
 *     a payee's just-received note. Report it, never act on it.
 *
 * SCOPE. One chain — the index is built per pool. A report says nothing about
 * the other chains' rows, so callers must name the chain when they log it.
 *
 * PRIVACY. This module asks its questions through injected predicates. The
 * report keeps commitments and amounts only for local healing/accounting;
 * `balanceCrossCheckLogPayload` is the sole exportable-log shape and contains
 * counts only. Nullifiers stay inside the RPC evidence closure.
 *
 * PURE module: the chain facts are injected, so the policy is testable without
 * an RPC, the SDK, or React.
 */

import type { Hash, Hex } from '@/services/sdk-types';

type BlockScoped = { blockNumber: Hex; txHash?: Hash };

/** Bulk event surface already consumed by OnChainNoteIndex.refresh(). */
export interface BulkPoolEventSource {
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
}

export interface RpcNullifierProof {
  terminalStatus: 'SPENT' | 'EXITED';
  blockNumber: Hex;
  txHash?: Hash;
}

/**
 * Capture nullifier provenance returned by the existing bulk RPC event scan.
 *
 * OnChainNoteIndex intentionally unions structurally-valid ASP snapshot rows
 * with its RPC tail. That union is appropriate for fail-open filtering, but an
 * ASP row is not independent enough to drive an irreversible ACTIVE -> SPENT
 * transition. This forwarding wrapper records the chain-returned subset while
 * the index performs the refresh it already needed; constructing it makes no
 * request, and querying it is an in-memory Map lookup. Block provenance is
 * retained so callers can reject head-level events that are still reorgable.
 */
export function captureRpcProvenSpent(source: BulkPoolEventSource): {
  interactor: BulkPoolEventSource;
  proofOf: (nullifier: string) => RpcNullifierProof | null;
  isProvenSpent: (nullifier: string) => boolean;
} {
  // `false` means two contradictory chain rows claimed the same nullifier.
  // Since the contract consumes one exactly once, conflict is no evidence.
  const proofs = new Map<string, RpcNullifierProof | false>();
  // Canonical form for a nullifier used as a Map key, matching the `key()` the
  // bulk index itself uses (services/onchain-note-index.ts). Chain logs, the
  // SDK's hash service and the ASP each render the same value differently —
  // padded 0x hex, unpadded 0x hex, decimal — so a raw `.toLowerCase()` key
  // makes the lookup miss and the whole cross-check silently become a no-op.
  // The same "two normalisers wearing one name" bug is documented in
  // services/leaf-gate.ts and is why services/hex-format.ts carries a warning.
  const nullifierKey = (value: unknown): string => {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    try {
      return `0x${BigInt(raw).toString(16).padStart(64, '0')}`;
    } catch {
      return raw.toLowerCase();
    }
  };
  const record = (nullifier: unknown, proof: RpcNullifierProof): void => {
    let blockNumber: Hex;
    try {
      blockNumber = `0x${BigInt(proof.blockNumber).toString(16)}` as Hex;
    } catch {
      return;
    }
    const key = nullifierKey(nullifier);
    if (!key) return;
    const normalized: RpcNullifierProof = {
      terminalStatus: proof.terminalStatus,
      blockNumber,
      ...(proof.txHash ? { txHash: String(proof.txHash).toLowerCase() as Hash } : {}),
    };
    const previous = proofs.get(key);
    if (previous === false) return;
    if (!previous) {
      proofs.set(key, normalized);
      return;
    }
    const conflicting = previous.terminalStatus !== normalized.terminalStatus
      || previous.blockNumber !== normalized.blockNumber
      || !!(previous.txHash && normalized.txHash && previous.txHash !== normalized.txHash);
    if (conflicting) {
      proofs.set(key, false);
      return;
    }
    if (!previous.txHash && normalized.txHash) proofs.set(key, normalized);
  };
  const proofOf = (nullifier: string): RpcNullifierProof | null => {
    const proof = proofs.get(nullifierKey(nullifier));
    return proof === false || proof === undefined ? null : proof;
  };
  const interactor: BulkPoolEventSource = {
    getStateLeaves: () => source.getStateLeaves(),
    getDepositedEvents: (fromBlock, toBlock) => source.getDepositedEvents(fromBlock, toBlock),
    getTransactedEvents: async (fromBlock, toBlock) => {
      const events = await source.getTransactedEvents(fromBlock, toBlock);
      for (const event of events) {
        for (const nullifier of event.nullifierHashes) {
          record(nullifier, {
            terminalStatus: 'SPENT',
            blockNumber: event.blockNumber,
            ...(event.txHash ? { txHash: event.txHash } : {}),
          });
        }
      }
      return events;
    },
    getRagequitEvents: async (fromBlock, toBlock) => {
      const events = await source.getRagequitEvents(fromBlock, toBlock);
      for (const event of events) {
        record(event.nullifierHash, {
          terminalStatus: 'EXITED',
          blockNumber: event.blockNumber,
          ...(event.txHash ? { txHash: event.txHash } : {}),
        });
      }
      return events;
    },
  };
  return {
    interactor,
    proofOf,
    isProvenSpent: (nullifier) => proofOf(nullifier) !== null,
  };
}

/** A head-level event is diagnostic only until the chain declares its block final. */
export function finalizedRpcProof(
  proof: RpcNullifierProof | null,
  finalizedBlock: bigint | null,
): RpcNullifierProof | null {
  if (!proof || finalizedBlock === null) return null;
  try {
    return BigInt(proof.blockNumber) <= finalizedBlock ? proof : null;
  } catch {
    return null;
  }
}

export interface CrossCheckNote {
  commitment: string;
  /** Note value, hex or decimal. Unparseable values are counted, not summed. */
  value: string;
  /** Token id, used only to keep sums from mixing assets. */
  tokenId?: string;
}

export interface BalanceCrossCheckReport {
  /** Notes examined — the ones the balance counts as spendable. */
  checked: number;
  /** Notes the chain proves are already spent. The balance overstates by these. */
  provenSpent: number;
  /** Their total value per token id, decimal strings (bigints are not JSON-safe). */
  provenSpentValueByToken: Record<string, string>;
  /**
   * Commitments of the proven-spent notes, for the caller to heal.
   * NEVER LOG THIS. See the privacy note above.
   */
  provenSpentCommitments: string[];
  /**
   * Notes no bulk chain data has seen. Informational ONLY — the index lags,
   * and absence has already been the wrong thing to act on here.
   */
  unobserved: number;
  /** Notes whose evidence could not be gathered at all (nullifier failed). */
  indeterminate: number;
}

export function crossCheckBalance(input: {
  /** The notes the balance counts as spendable, on ONE chain. */
  notes: readonly CrossCheckNote[];
  /**
   * Is this note's nullifier proven in finalized chain-returned bulk terminal data?
   * `null` means the question could not be answered (nullifier not derivable),
   * which is distinct from a confident `false`.
   */
  isSpentOnChain: (commitment: string) => boolean | null;
  /** Has this commitment ever been seen in bulk chain data? */
  isObservedOnChain: (commitment: string) => boolean;
}): BalanceCrossCheckReport {
  const { notes, isSpentOnChain, isObservedOnChain } = input;

  const provenSpentCommitments: string[] = [];
  const valueByToken = new Map<string, bigint>();
  let unobserved = 0;
  let indeterminate = 0;

  for (const note of notes) {
    let spent: boolean | null;
    try {
      spent = isSpentOnChain(note.commitment);
    } catch {
      // A predicate that throws is no evidence, never evidence of a spend.
      spent = null;
    }

    if (spent === null) {
      indeterminate += 1;
      continue;
    }

    if (spent) {
      provenSpentCommitments.push(note.commitment);
      const token = (note.tokenId ?? '').toLowerCase();
      try {
        valueByToken.set(token, (valueByToken.get(token) ?? 0n) + BigInt(note.value));
      } catch {
        // Counted above; a value we cannot parse must not abort the pass.
      }
      continue;
    }

    try {
      if (!isObservedOnChain(note.commitment)) unobserved += 1;
    } catch {
      indeterminate += 1;
    }
  }

  const provenSpentValueByToken: Record<string, string> = {};
  for (const [token, total] of valueByToken) provenSpentValueByToken[token] = total.toString();

  return {
    checked: notes.length,
    provenSpent: provenSpentCommitments.length,
    provenSpentValueByToken,
    provenSpentCommitments,
    unobserved,
    indeterminate,
  };
}

/** True when the report says the displayed balance is provably overstated. */
export function balanceIsOverstated(report: BalanceCrossCheckReport): boolean {
  return report.provenSpent > 0;
}

/** The exact safe payload passed to the exportable debug buffer. */
export function balanceCrossCheckLogPayload(
  report: BalanceCrossCheckReport,
  context: { chainId: number; markedSpent: number; markedExited: number },
): {
  chainId: number;
  checked: number;
  provenSpent: number;
  unobserved: number;
  indeterminate: number;
  markedSpent: number;
  markedExited: number;
} {
  return {
    chainId: context.chainId,
    checked: report.checked,
    provenSpent: report.provenSpent,
    unobserved: report.unobserved,
    indeterminate: report.indeterminate,
    markedSpent: context.markedSpent,
    markedExited: context.markedExited,
  };
}
