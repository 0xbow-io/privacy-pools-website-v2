import { getChainConfig } from '@/config/chains';
import { LEGACY_CONFIG } from '@/config/env';
import { NoteStatus } from '@/services/sdk-types';
import type { Address, Hash, Hex, IKeystoreManager, INoteManager, Note } from '@/services/sdk-types';

// Pure note-selection math lives in transfer-note-selection (no SDK/network
// imports, so it stays unit-testable under the bun runner); re-exported here
// so the money-path callers keep one import site for the whole preflight.
export {
  TRANSFER_MAX_INPUTS,
  TRANSFER_MAX_LABELS,
  maxCoverableTransfer,
  selectGreedyTransferInputs,
  topNValueSum,
} from '@/services/transfer-note-selection';
export type { GreedyTransferSelection } from '@/services/transfer-note-selection';
import { TRANSFER_MAX_INPUTS } from '@/services/transfer-note-selection';

// Must match the SDK witness leaf: Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp).
const COMMITMENT_LEAF_TAG =
  '0x086205d9d9e32ce53fc309585685ddb629e878ddd2dd04f575089c3a421342d9' as const;

// Deliberately does NOT include getCommitmentTimestamp / getNullifierTimestamp.
// Those are the targeted reads this module used to make on the spend path; the
// omission is what stops them coming back. See onchain-note-index.ts.
type PoolVaultSpendabilityInteractor = {
  getStateLeaves: () => Promise<Hash[]>;
};

export type TransferSpendabilityRejectCode =
  | 'note-not-in-manager'
  | 'note-not-owned'
  | 'note-owner-mismatch'
  | 'note-secret-missing'
  | 'note-not-active'
  | 'invalid-note-value'
  | 'non-positive-note-value'
  | 'nullifier-fetch-failed'
  | 'nullifier-already-spent'
  | 'timestamp-fetch-failed'
  | 'commitment-not-on-chain'
  | 'timestamp-unverified'
  | 'state-leaf-missing'
  | 'label-hash-failed'
  | 'asp-membership-missing';

export type TransferSpendabilityRejection = {
  code: TransferSpendabilityRejectCode;
  message: string;
  detail?: string;
};

export type TransferSpendabilityResult = {
  note: Note;
  commitment: Hash;
  spendable: boolean;
  rejectReasons: TransferSpendabilityRejection[];
  canonicalTimestamp: Hex | null;
  nullifierSpentAt: Hex | null;
  stateLeaf: Hash | null;
  labelHash: Hash | null;
};

export type TransferSpendabilityReport = {
  chainId: number;
  candidateCount: number;
  spendableNotes: Note[];
  results: TransferSpendabilityResult[];
  rejected: TransferSpendabilityResult[];
  stateLeavesCount: number;
  heal: { healed: number; removed: number; error: string | null };
};


export function formatTransferSpendabilityUnavailable(params: {
  requestedAmount: string;
  availableAmount: string;
  tokenSymbol: string;
  maxInputs?: number;
}): string {
  const maxInputs = params.maxInputs ?? TRANSFER_MAX_INPUTS;
  return `Private funds are not currently spendable, indexed, or approved for this transfer. Requested ${params.requestedAmount} ${params.tokenSymbol}; verified spendable balance within ${maxInputs} inputs is ${params.availableAmount} ${params.tokenSymbol}. Try syncing again in a few minutes or choose a smaller amount.`;
}

export { formatRelayedPaymentShortfall, formatShortfallAmount } from '@/services/relayed-payment-shortfall';

export async function verifyTransferSpendability(params: {
  notes: readonly Note[];
  chainId: number;
  noteManager: INoteManager;
  keystoreManager: Pick<IKeystoreManager, 'getPrivateNullifyingKey'>;
  ownerAddress: Address;
}): Promise<TransferSpendabilityReport> {
  const { notes, chainId, noteManager, keystoreManager, ownerAddress } = params;
  const {
    createASPClient,
    createHashService,
    createMerkleService,
    createNoteComputationService,
    createPoolVaultInteractor,
    createRPCInteractor,
    healNoteTimestamps,
  } = await import('@/services/sdk-runtime');
  const { createOnChainNoteIndex } = await import('@/services/onchain-note-index');

  const chainConfig = getChainConfig(chainId);
  if (!chainConfig?.contracts?.poolAddress) {
    throw new Error(`Missing pool contract configuration for chain ${chainId}.`);
  }

  // Legacy spend-out build pins the OLD PoolVault (and its leaves/timestamps)
  // from env — match the session and withdraw flows so legacy notes aren't
  // verified against the wrong pool. fromBlock stays from chains.ts (the
  // legacy build is deployed off a commit carrying the old pool's floor).
  const poolAddress = (LEGACY_CONFIG?.pool ?? chainConfig.contracts.poolAddress) as Address;

  const hashService = await createHashService();
  const merkleService = createMerkleService(hashService);
  const noteComputationService = await createNoteComputationService();
  const aspClient = await createASPClient(chainId, merkleService);
  const rpcInteractor = createRPCInteractor(chainId, Number(chainConfig.contracts.fromBlock));
  const poolVaultInteractor = createPoolVaultInteractor(
    rpcInteractor,
    poolAddress,
    hashService,
    chainConfig.contracts.fromBlock,
  ) as unknown as PoolVaultSpendabilityInteractor;

  // One bulk build, reused by healing and by every per-note check below. This
  // replaces two targeted eth_calls per note (spentNullifiers + commitments)
  // that ran on the submit path — see onchain-note-index.ts for why that
  // mattered.
  const noteIndex = createOnChainNoteIndex({
    chainId,
    poolVaultInteractor: poolVaultInteractor as never,
    hashService: hashService as never,
    poolAddress,
  });
  let indexError: string | null = null;
  try {
    await noteIndex.refresh();
  } catch (err) {
    indexError = err instanceof Error ? err.message : String(err);
  }

  const heal = { healed: 0, removed: 0, error: null as string | null };
  try {
    const healed = await healNoteTimestamps(
      noteManager as unknown as Parameters<typeof healNoteTimestamps>[0],
      noteIndex,
    );
    heal.healed = healed.healed;
    heal.removed = healed.removed;
  } catch (err) {
    heal.error = err instanceof Error ? err.message : String(err);
  }

  const managedNotes = readManagedNotes(noteManager);
  const stateLeaves = await poolVaultInteractor.getStateLeaves();
  const stateLeafSet = new Set(stateLeaves.map(normalizeHex));
  // ASP membership is tested against ONE fetch of the association set, not one
  // per note.
  //
  // This used to call aspClient.getMerkleProof(labelHash) inside the per-note
  // Promise.all and throw the proof away — it only wanted to know whether the
  // label was in the set. But every getMerkleProof re-downloads the whole
  // association set (376 KB / 4,726 leaves / ~4s as of 2026-08-23), recomputes
  // the LeanIMT root over all of it, AND reads latestASPRoot on-chain. With a
  // hundred notes that is a hundred concurrent copies of the same payload, which
  // is what a user reported seeing during a Send.
  //
  // getAssociationSetLeaves does the same verification once — it is the call
  // getMerkleProof makes internally, including the on-chain root check — so
  // testing membership against a Set built from its result keeps the safety
  // property and drops the N.
  const associationSetLabels = new Set<string>();
  let associationSetError: string | null = null;
  try {
    const leaves = await aspClient.getAssociationSetLeaves();
    for (const leaf of leaves) associationSetLabels.add(normalizeHex(leaf));
  } catch (err) {
    // Fail CLOSED, exactly as the per-note version did: if the set cannot be
    // fetched or its root does not match the chain, no note is provably a
    // member, so every note carries the same reject reason it used to.
    associationSetError = err instanceof Error ? err.message : String(err);
  }
  const timestampUpdates = new Map<string, Hex>();
  let stateLeafMissing = 0;
  const privateNullifyingKey = keystoreManager.getPrivateNullifyingKey();
  const expectedOwner = normalizeHex(ownerAddress);

  const results = await Promise.all(
    notes.map(async (candidate) => {
      const commitmentKey = normalizeHex(candidate.commitment);
      const managedNote = managedNotes.get(commitmentKey);
      const note = managedNote ?? candidate;
      const rejectReasons: TransferSpendabilityRejection[] = [];

      if (!managedNote) {
        rejectReasons.push({
          code: 'note-not-in-manager',
          message: 'note is no longer present in local note state',
        });
      }

      if (!note.isOwned) {
        rejectReasons.push({
          code: 'note-not-owned',
          message: 'note is not owned by the current account',
        });
      }

      if (normalizeHex(String(note.ownerAddress ?? '')) !== expectedOwner) {
        rejectReasons.push({
          code: 'note-owner-mismatch',
          message: 'note owner does not match the current account',
        });
      }

      if (!note.noteSecret || isZeroHex(String(note.noteSecret))) {
        rejectReasons.push({
          code: 'note-secret-missing',
          message: 'note secret is missing from local state',
        });
      }

      if (note.status !== NoteStatus.ACTIVE) {
        rejectReasons.push({
          code: 'note-not-active',
          message: `note status is ${String(note.status)}`,
        });
      }

      const noteValue = parseBigInt(note.value);
      if (noteValue == null) {
        rejectReasons.push({
          code: 'invalid-note-value',
          message: 'note value is not a valid integer',
          detail: String(note.value),
        });
      } else if (noteValue <= 0n) {
        rejectReasons.push({
          code: 'non-positive-note-value',
          message: 'note value is not positive',
        });
      }

      let canonicalTimestamp: Hex | null = null;
      let nullifierSpentAt: Hex | null = null;
      let stateLeaf: Hash | null = null;
      let labelHash: Hash | null = null;

      if (indexError != null) {
        // The bulk build is the single source for both facts below, so one
        // failure rejects the note rather than letting it through unchecked.
        rejectReasons.push({
          code: 'nullifier-fetch-failed',
          message: 'failed to load on-chain note index',
          detail: indexError,
        });
      } else {
        const nullifier = noteComputationService.computeNullifier(
          privateNullifyingKey,
          note.commitment,
        );
        // Spent-ness comes from the observed-nullifier SET (every Transacted /
        // Ragequit event), not from the timestamp map: a spend in a block whose
        // timestamp lookup failed is still a spend, and selecting it as an
        // input would revert on-chain.
        if (noteIndex.isNullifierSpent(nullifier as Hash)) {
          nullifierSpentAt = noteIndex.nullifierSpentAt(nullifier as Hash) ?? ('0x1' as Hex);
          rejectReasons.push({
            code: 'nullifier-already-spent',
            message: 'note nullifier is already spent on-chain',
            detail: nullifierSpentAt,
          });
        }

        canonicalTimestamp = noteIndex.commitmentTimestamp(note.commitment);
        if (canonicalTimestamp == null) {
          // Distinguish "not on-chain" from "on-chain but the timestamp could
          // not be verified against a state-tree leaf". Both block the spend,
          // but only the first means the note is phantom.
          rejectReasons.push(
            noteIndex.hasCommitment(note.commitment)
              ? {
                  code: 'timestamp-unverified',
                  message:
                    'commitment is on-chain but its timestamp did not reproduce a state-tree leaf',
                }
              : {
                  code: 'commitment-not-on-chain',
                  message: 'commitment is absent from on-chain event data',
                },
          );
        } else {
          stateLeaf = hashService.hash([COMMITMENT_LEAF_TAG, note.commitment, canonicalTimestamp]) as Hash;
          // The index serves a timestamp ONLY with chain-grade provenance
          // (see onchain-note-index.ts): read from the creation block, or
          // leaf-proven, or healed from the creating event. It deliberately
          // does NOT let the leaf set condemn a chain-derived value, because
          // getStateLeaves comes from eth_getLogs, which public RPCs drop
          // ranges from silently (2026-08-27). Re-checking that same lossy set
          // here undid the exemption: on BNB Chain (1000-block log windows)
          // real, approved notes were dropped as 'state-leaf-missing', and the
          // payment said the account held a fraction of its balance (QA
          // 2026-10-15). A missing leaf is therefore only logged, never a
          // rejection, and the timestamp is persisted only when it proved out.
          if (!stateLeafSet.has(normalizeHex(stateLeaf))) {
            stateLeafMissing += 1;
          } else if (normalizeHex(note.createdAtBlock) !== normalizeHex(canonicalTimestamp)) {
            // Persist the corrected timestamp ONLY when its leaf just proved
            // out. Recording it on the failure path stored a value the chain
            // rejected while the spend itself was refused (kimi review).
            timestampUpdates.set(commitmentKey, canonicalTimestamp);
          }
        }
      }

      try {
        labelHash = hashService.hash([note.label]) as Hash;
        if (associationSetError) {
          rejectReasons.push({
            code: 'asp-membership-missing',
            message: 'note label is missing from the ASP association set',
            detail: associationSetError,
          });
        } else if (!associationSetLabels.has(normalizeHex(labelHash))) {
          rejectReasons.push({
            code: 'asp-membership-missing',
            message: 'note label is missing from the ASP association set',
            detail: `label hash ${labelHash} not among ${associationSetLabels.size} association-set leaves`,
          });
        }
      } catch (err) {
        rejectReasons.push({
          code: 'label-hash-failed',
          message: 'failed to hash note label',
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      const spendable = rejectReasons.length === 0;
      const verifiedNote = canonicalTimestamp
        ? { ...note, createdAtBlock: canonicalTimestamp }
        : note;

      return {
        note: verifiedNote,
        commitment: note.commitment,
        spendable,
        rejectReasons,
        canonicalTimestamp,
        nullifierSpentAt,
        stateLeaf,
        labelHash,
      } satisfies TransferSpendabilityResult;
    }),
  );

  updateManagedNoteTimestamps(noteManager, timestampUpdates);
  if (stateLeafMissing > 0) {
    console.warn(`[TransferSpendability] ${stateLeafMissing} index-proven note(s) absent from the fetched leaf set; the leaf fetch is likely holed, notes kept`);
  }

  const spendableNotes = results
    .filter((entry) => entry.spendable)
    .map((entry) => entry.note);
  const rejected = results.filter((entry) => !entry.spendable);

  return {
    chainId,
    candidateCount: notes.length,
    spendableNotes,
    results,
    rejected,
    stateLeavesCount: stateLeaves.length,
    heal,
  };
}

export function toTransferSpendabilityLog(report: TransferSpendabilityReport) {
  // Top-level histogram of reject codes: the per-note array below is truncated
  // by the console, and "109 rejected" without a reason has cost a debugging
  // round before.
  const rejectCodes: Record<string, number> = {};
  for (const entry of report.results) {
    for (const reason of entry.rejectReasons) rejectCodes[reason.code] = (rejectCodes[reason.code] ?? 0) + 1;
  }
  const firstDetail = report.results.flatMap((e) => e.rejectReasons).find((r) => r.detail)?.detail;
  return {
    chainId: report.chainId,
    candidateCount: report.candidateCount,
    spendableCount: report.spendableNotes.length,
    rejectedCount: report.rejected.length,
    rejectCodes: JSON.stringify(rejectCodes),
    firstRejectDetail: firstDetail ? String(firstDetail).slice(0, 160) : undefined,
    stateLeavesCount: report.stateLeavesCount,
    heal: report.heal,
    notes: report.results.map((entry) => ({
      commitment: shortHex(entry.commitment),
      tokenId: entry.note.tokenId,
      status: String(entry.note.status),
      timestampMatched: entry.canonicalTimestamp === entry.note.createdAtBlock,
      nullifierSpent: parseBigInt(entry.nullifierSpentAt) != null && BigInt(entry.nullifierSpentAt ?? '0x0') > 0n,
      stateLeafComputed: entry.stateLeaf != null,
      labelHashComputed: entry.labelHash != null,
      spendable: entry.spendable,
      rejectReasonCodes: entry.rejectReasons.map((reason) => reason.code),
    })),
  };
}


function readManagedNotes(noteManager: INoteManager): Map<string, Note> {
  const exported = noteManager.exportState() as unknown as { notes?: Note[] };
  const byCommitment = new Map<string, Note>();
  for (const note of exported.notes ?? []) {
    byCommitment.set(normalizeHex(note.commitment), note);
  }
  return byCommitment;
}

function updateManagedNoteTimestamps(noteManager: INoteManager, updates: Map<string, Hex>): void {
  if (updates.size === 0) return;

  const exported = noteManager.exportState() as unknown as { notes?: Note[]; [key: string]: unknown };
  if (!Array.isArray(exported.notes)) return;

  let changed = false;
  const nextNotes = exported.notes.map((note) => {
    const nextTimestamp = updates.get(normalizeHex(note.commitment));
    if (!nextTimestamp || normalizeHex(note.createdAtBlock) === normalizeHex(nextTimestamp)) {
      return note;
    }
    changed = true;
    return { ...note, createdAtBlock: nextTimestamp };
  });

  if (changed) {
    noteManager.importState({
      ...exported,
      notes: nextNotes,
    } as Parameters<INoteManager['importState']>[0]);
  }
}

function normalizeHex(value: string): string {
  return value.toLowerCase();
}

function isZeroHex(value: string): boolean {
  return /^0x0*$/i.test(value);
}

function shortHex(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function normalizeBigIntHex(value: string): Hex {
  const parsed = BigInt(value);
  return `0x${parsed.toString(16)}` as Hex;
}

function parseBigInt(value: unknown): bigint | null {
  try {
    return BigInt(String(value ?? ''));
  } catch {
    return null;
  }
}
