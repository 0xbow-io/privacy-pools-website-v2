import { classifyTransactShape, type TransactShape } from '@/services/transact-shape';
import type { Note, Secret, Hex } from '@/services/sdk-types';
import type { SnapshotTransact } from '@/services/api-types';
import type { NoteCounts } from '@/services/self-transfer-row';

/** Minimal structural type for the SDK hash service (Poseidon), to avoid a
 *  cross-package type import. Matches IHashService.hash(inputs: Hex[]): Hex. */
type HashFn = { hash(inputs: Hex[]): Hex };

/**
 * Cross-device reconstruction of the connected user's OUTGOING spends
 * (private transfers AND withdrawals) from on-chain Transacted events + their
 * own notes. No contract change is required and it works on any device (no
 * local per-device sender-stamp), unlike the legacy stamp-based heuristic in
 * services/transfer-direction.ts.
 *
 * Rationale + codex confirmation:
 *   https://gist.github.com/patcito/cc4d361de86e35efaf53b11a67398971
 *
 * This is a temporary SDK WRAPPER. The intent is to fold it into the SDK so the
 * wrapper can be retired — see the matching v2-monorepo PR.
 *
 * For each Transacted tx, using the user's notes (incl. SPENT) + their keys:
 *   - spent inputs  = owned notes whose nullifier Poseidon(nullifyingKey, commitment)
 *                     appears in tx.nullifierHashes,
 *   - sender change = owned notes whose commitment is in tx.outputCommitments,
 *   - non-owned outputs = outputCommitments with no matching owned note (recipient).
 *
 * A spend is classified per tx (user spent >= 1 input):
 *   - 'transfer'   >= 1 non-owned output (a real recipient). Recipient-facing
 *                  amount is `gross - withdrawnValue`, where
 *                  `gross = Σ(spent inputs) - Σ(sender change)` is total value
 *                  leaving the sender's shielded notes and `withdrawnValue` is
 *                  the public relay fee (0 for a direct, unrelayed transfer).
 *   - 'withdrawal' all outputs owned, `withdrawnValue > 0`, and as many outputs
 *                  as distinct INPUT labels — the SDK's withdrawal builder emits
 *                  one change note per label, so that arity is its signature;
 *                  amount = withdrawnValue. A confirmed local anchor stamp can
 *                  still override this: the gasless claim path deliberately uses
 *                  relayWithdraw, which has this same shape even though the
 *                  outflow is the relayer fee.
 *   - 'fee'        all outputs owned and `withdrawnValue > 0`, but MORE outputs
 *                  than input labels (a self-transfer: anchor, dust
 *                  consolidation), OR a confirmed local anchor stamp says this
 *                  withdrawal-shaped tx was the gasless claim path. The outflow
 *                  is a fee, not a payout, so amount = 0 and fee =
 *                  withdrawnValue. Render it neutrally; do not say the user
 *                  withdrew it. The rule itself lives in
 *                  services/transact-shape.ts.
 *   - 'swap'       a private swap (the Swap tab's reshield): no recipient
 *                  output, and the same tx created a note of mine ON THE
 *                  SPEND'S CHAIN that starts a new lineage (a label no input
 *                  carries) and is not one of the Transacted's outputs. That
 *                  note is the swap's output, deposited by the swap route in
 *                  the same transaction. amount = withdrawnValue (the gross
 *                  that went into the swap) or, when none was recorded, the
 *                  gross that left the notes. A note on another chain never
 *                  qualifies: a cross-chain swap's destination note is stored
 *                  under the SOURCE hash on the destination chain.
 *   - 'internal'   everything else (self merge/split, or a value-conservation
 *                  sanity failure) — no user-facing amount, but the tx is
 *                  still the user's own spend, which matters for classifying
 *                  its change notes (issue #215: an own-spend change note must
 *                  not render as a received transfer).
 *
 * All amounts are exact and multi-input-correct (every owned input is found
 * via the nullifier match, not a single parent).
 *
 * Caveat: assumes viewing-key continuity. A note encrypted to a rotated/old
 * viewing key is only re-discoverable with that old key, so a device holding
 * only a new viewing key can't reconstruct pre-rotation sends.
 */
export type UserSpendKind = 'transfer' | 'withdrawal' | 'internal' | 'fee' | 'claim' | 'swap';

/** One note a 'swap' spend deposited: the swap's output. */
export interface SwapOutputNote {
  /** As the note stores it (the leaf gate keys on this spelling). */
  commitment: string;
  value: bigint;
  tokenId: string;
  label: string;
  /** The note's local status (ACTIVE / PENDING / SPENT ...), when known. */
  status?: string;
}

export interface UserSpend {
  /** The transact tx that spent the user's notes. */
  txHash: string;
  /** Asset (token address) of the spend. */
  tokenId: string;
  kind: UserSpendKind;
  /** 'transfer': recipient-facing amount (gross outflow minus the public
   *  relay fee); 'withdrawal': value that left the pool (withdrawnValue);
   *  'fee' and 'internal': 0 — neither moved money TO the user, so there is no
   *  amount to state, and stating one is the bug this kind was added for.
   *  'claim': the value of the received note(s) the claim anchored. */
  amount: bigint;
  /** Total value that left the user's shielded notes in this tx. */
  grossOutflow: bigint;
  /** Public relay fee for a relayed transfer (0 for a direct transfer). */
  fee: bigint;
  /** How many of the user's notes the tx spent. */
  inputCount: number;
  /** How many output commitments the tx created. */
  outputCount: number;
  /** 'fee' only, when the spend has the Consolidate action's shape: the notes
   *  it spent and the notes it created. Absent on every other self-transfer. */
  consolidation?: NoteCounts;
  /** Total value of the tx's outputs that are the user's own notes. */
  ownOutputValue: bigint;
  /** On-chain block timestamp string from the Transacted event. */
  blockTimestamp: string;
  /** The chain the transact is on, when the snapshot row names it. */
  chainId?: number;
  /** 'claim' only: the tx that delivered the claimed note(s), lowercase. That
   *  is the payment; `txHash` is the claim. Absent when the inputs do not
   *  share one known creating tx. */
  receivedTxHash?: string;
  /** 'claim' only: a registration rode along in the claim's transaction
   *  (registerAndRelay), so its cost includes setting up the account. */
  withRegistration?: boolean;
  /** 'claim' only, after mergeClaimsByPayment: every claim tx of the payment
   *  (the self-funded path claims one note per tx). */
  claimTxHashes?: string[];
  /** 'swap' only: the output note(s) the swap deposited, on the spend's chain. */
  swapOutputs?: SwapOutputNote[];
  /** 'swap' and 'withdrawal': the labels of the notes it spent, lowercase,
   *  which name its own feed row among others sharing a batch hash. */
  inputLabels?: string[];
  /** 'withdrawal' only: the caller is a RelaySwaps contract, so the value went
   *  through a swap route (a cross-chain swap or a receive-as payout). */
  swapRoute?: boolean;
}

/** A note as the classifier reads it. `chainId` names the chain whose store
 *  holds it; without one the note is treated as being on every chain, which
 *  is what single-chain callers have always meant. */
export type SpendNoteInput = Pick<Note, 'commitment' | 'value' | 'tokenId'>
  & Partial<Pick<Note, 'label' | 'txHash'>>
  & { chainId?: number; status?: unknown };

export type ReconstructUserSpendsOptions = {
  /**
   * Confirmed local anchor tx hashes for this owner/chain. Shape alone catches
   * self-funded anchors (relayTransfer, M > labels), but gasless claims use
   * relayWithdraw and are withdrawal-shaped (M === labels). The stamp is the
   * only local-positive intent signal for that case.
   */
  anchorTxHashes?: ReadonlySet<string>;
  /** config/relayer.ts isTransferRouteCaller, injected to keep this module config-free. */
  isTransferRouteCaller?: (caller: string | null | undefined, chainId: number | undefined) => boolean;
  /** config/relayer.ts isSwapRouteCaller (current and past RelaySwaps), injected likewise. */
  isSwapRouteCaller?: (caller: string | null | undefined, chainId: number | undefined) => boolean;
  /** Commitments this device recorded as a cross-chain swap's destination
   *  note (services/swap-records-core.ts). Never a same-chain swap output,
   *  whatever chain store holds them. */
  crossChainOutputCommitments?: ReadonlySet<string>;
  /**
   * Input commitments this device recorded as received notes it claimed
   * (services/claim-records-core.ts), with whether a registration rode along.
   * A spend whose every input is one of them is the claim, whatever its shape
   * says (DEV-574): before the viewing key is set the claim's own output does
   * not read as mine, so the shape rule saw a recipient and said Transfer Out.
   */
  claimedInputs?: ReadonlyMap<string, { withRegistration: boolean }>;
};

/**
 * Snapshot `blockTimestamp` is a string that can be a unix value (seconds or
 * ms) OR an ISO datetime (e.g. "2026-04-29T21:41:12.000Z"). A plain Number()
 * cast makes ISO strings NaN, which then collapses to epoch 0 (1970), sorting
 * reconstructed spend rows to the bottom and dropping them from date filters.
 * Returns milliseconds since epoch (0 when unparseable).
 */
export function snapshotTimestampToMs(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const str = String(value).trim();
  if (str === '') return 0;
  const numeric = Number(str);
  if (Number.isFinite(numeric)) {
    // Seconds -> ms; values already in ms pass through (matches the ASP feed).
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeHashValue(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return `0x${BigInt(value).toString(16).padStart(64, '0')}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

export function reconstructUserSpends(
  notes: readonly SpendNoteInput[],
  transacts: ReadonlyArray<SnapshotTransact & { chainId?: number }>,
  nullifyingKey: Secret,
  hashService: HashFn,
  options: ReconstructUserSpendsOptions = {},
): UserSpend[] {
  if (notes.length === 0 || transacts.length === 0) return [];
  // Keyed by the same spelling as the notes' commitments below.
  const claimedInputs = new Map<string, { withRegistration: boolean }>();
  for (const [c, v] of options.claimedInputs ?? []) {
    const key = normalizeHashValue(c);
    if (key) claimedInputs.set(key, v);
  }

  // owned commitment -> value (for change matching) and nullifier -> {value, tokenId}
  // (for spent-input matching). The nullifier is the same Poseidon the circuit +
  // the SDK's NoteComputationService.computeNullifier use.
  const ownedValueByCommitment = new Map<string, bigint>();
  const spentByNullifier = new Map<string, { value: bigint; tokenId: string; label: string; txHash: string; commitment: string }>();
  // Notes of mine created by a DEPOSIT in a given tx (a new lineage: a label no
  // spent input carries, and a commitment the Transacted did not output). A
  // reshield spends my notes and re-deposits the swapped value in the same tx,
  // so its Transacted looks like a pure self-spend (one owned change note, no
  // recipient); this is what tells it apart (Pat, 2026-08-30).
  const depositNotesByTx = new Map<string, Array<SwapOutputNote & { key: string; chainId?: number }>>();
  for (const note of notes) {
    const commitment = normalizeHashValue(String(note.commitment));
    if (!commitment) continue;
    let value: bigint;
    try {
      value = BigInt(note.value);
    } catch {
      continue;
    }
    ownedValueByCommitment.set(commitment, value);
    const nullifier = normalizeHashValue(String(hashService.hash([nullifyingKey, note.commitment as Hex])));
    const label = String(note.label ?? '').toLowerCase();
    if (nullifier) spentByNullifier.set(nullifier, { value, tokenId: String(note.tokenId), label, txHash: String(note.txHash ?? '').toLowerCase(), commitment });
    if (note.txHash && label) {
      const txKey = String(note.txHash).toLowerCase();
      const list = depositNotesByTx.get(txKey) ?? [];
      list.push({
        key: commitment,
        commitment: String(note.commitment),
        label,
        value,
        tokenId: String(note.tokenId),
        ...(note.status !== undefined && note.status !== null ? { status: String(note.status) } : {}),
        ...(note.chainId !== undefined ? { chainId: note.chainId } : {}),
      });
      depositNotesByTx.set(txKey, list);
    }
  }

  // Batch withdrawal awareness: PrivacyPoolRelay.relayBatch calls
  // PoolVault.transact once per item, and the vault emits one Transacted log
  // per call — so ONE on-chain tx surfaces as N SnapshotTransact rows sharing
  // a txHash. Bucket by txHash and fold each bucket into a single UserSpend
  // (union inputs/outputs, sum values) so a batch reports as one spend with
  // the aggregate amount — never N partial rows (codex finding 4). A single
  // withdrawal/transfer is a one-element bucket, so its result is unchanged.
  const buckets = new Map<string, Array<SnapshotTransact & { chainId?: number }>>();
  const order: string[] = [];
  for (const tx of transacts) {
    const key = String(tx.txHash);
    const existing = buckets.get(key);
    if (existing) existing.push(tx);
    else {
      buckets.set(key, [tx]);
      order.push(key);
    }
  }

  const out: UserSpend[] = [];
  for (const key of order) {
    const bucket = buckets.get(key)!;
    const stampedAnchor = options.anchorTxHashes?.has(key.toLowerCase()) === true;
    let inputSum = 0n;
    // The creating tx of every input, for a claim's receipt (see 'claim').
    const inputTxHashes = new Set<string>();
    let changeSum = 0n;
    let nonOwnedOutputs = 0;
    let withdrawn = 0n;
    let tokenId = '';
    let spentCount = 0;
    let asset = '';
    let blockTimestamp = '';
    let swapCaller = false;
    let claimedCount = 0;
    let claimWithRegistration = false;
    const spentLabels = new Set<string>();
    const outputCommitments = new Set<string>();
    // Shape is decided PER LOG, never per bucket.
    //
    // A batch relays several transacts under one tx hash (PrivacyPoolRelay
    // calls PoolVault.transact once per item), so comparing the bucket's TOTAL
    // outputs against its TOTAL labels is wrong: two batched withdrawals that
    // happen to share an input label aggregate to 2 outputs against 1 label and
    // read as a self-transfer, which would blank a real withdrawal's amount.
    // Found by codex on review of the first cut of this change, which did
    // exactly that.
    const logShapes: TransactShape[] = [];

    for (const tx of bucket) {
      const logLabels = new Set<string>();
      let logNonOwned = 0;
      let logSpent = 0;
      for (const nf of tx.nullifierHashes ?? []) {
        const nfKey = normalizeHashValue(nf);
        const hit = nfKey ? spentByNullifier.get(nfKey) : undefined;
        if (hit) {
          inputSum += hit.value;
          inputTxHashes.add(hit.txHash);
          const claimed = claimedInputs.get(hit.commitment);
          if (claimed) {
            claimedCount += 1;
            if (claimed.withRegistration) claimWithRegistration = true;
          }
          if (!tokenId) tokenId = hit.tokenId;
          spentCount += 1;
          logSpent += 1;
          if (hit.label) { spentLabels.add(hit.label); logLabels.add(hit.label); }
        }
      }
      for (const commitment of tx.outputCommitments ?? []) {
        const cKey = normalizeHashValue(commitment);
        if (cKey) outputCommitments.add(cKey);
        const ownedValue = cKey ? ownedValueByCommitment.get(cKey) : undefined;
        if (ownedValue !== undefined) changeSum += ownedValue;
        else { nonOwnedOutputs += 1; logNonOwned += 1; }
      }
      let logWithdrawn = 0n;
      try {
        logWithdrawn = BigInt(tx.withdrawnValue ?? '0');
        withdrawn += logWithdrawn;
      } catch {
        /* ignore an unparseable item */
      }
      // Only logs this user actually spent into say anything about their spend.
      if (logSpent > 0) {
        logShapes.push(classifyTransactShape({
          outputCount: (tx.outputCommitments ?? []).length,
          nonOwnedOutputs: logNonOwned,
          withdrawnValue: logWithdrawn,
          distinctInputLabels: logLabels.size > 0 ? logLabels.size : null,
          transferRoute: options.isTransferRouteCaller?.(tx.caller, tx.chainId) === true,
        }));
      }
      if (logSpent > 0 && options.isSwapRouteCaller?.(tx.caller, tx.chainId) === true) swapCaller = true;
      if (!asset && tx.asset) asset = String(tx.asset);
      // Earliest non-empty timestamp in the bucket (one tx → one time anyway).
      if (!blockTimestamp && tx.blockTimestamp) blockTimestamp = tx.blockTimestamp;
    }

    if (spentCount === 0) continue; // not the user's spend

    const gross = inputSum - changeSum;
    // A same-chain swap: the same tx created a note of mine that is NOT a
    // Transacted output and starts a new lineage, on the spend's own chain.
    // The value that left my notes went through the swap route and came back
    // as that deposit. Chain-qualified: a cross-chain swap's destination note
    // is stored under the source hash too, but on the other chain, and it is
    // a delivery that has not been proven here.
    const spendChainId = bucket[0].chainId;
    const swapOutputs = (depositNotesByTx.get(key.toLowerCase()) ?? [])
      .filter((n) => !outputCommitments.has(n.key) && !spentLabels.has(n.label))
      .filter((n) => n.chainId === undefined || spendChainId === undefined || n.chainId === spendChainId)
      .filter((n) => !options.crossChainOutputCommitments?.has(n.key))
      .map(({ chainId: _chainId, key: _key, ...n }) => n);
    const redepositedInTx = swapOutputs.length > 0;

    // One shared rule, in services/transact-shape.ts. This used to be decided
    // here, and the "all outputs owned and value left the pool => withdrawal"
    // branch was wrong for every SELF-transfer: an anchor and a dust
    // consolidation both own all their outputs, so the relayer's fee was
    // reported as an amount the user withdrew, with fee = 0.
    //
    // spentLabels is the discriminator that actually works. The SDK emits one
    // change note per distinct INPUT label, so a plain withdrawal has as many
    // outputs as labels while a self-transfer has one more (the recipient
    // note). Raw output count alone cannot do this: mixed-label withdrawals
    // legitimately carry 2-5 outputs.
    // Fold the per-log shapes into one verdict for the row.
    //
    // Precedence is ordered by what it would cost to be wrong, not by what is
    // most likely. 'withdrawal' outranks 'anchor-shaped' so that a batch mixing
    // a real withdrawal with a self-transfer leg still reports the value that
    // left the pool: the amount is then slightly overstated (it includes the
    // anchor's fee), which is a visible inaccuracy, whereas demoting it to a
    // fee row would silently blank money the user genuinely withdrew. A pure
    // anchor has no withdrawal leg, so it is unaffected.
    const shape: TransactShape =
      logShapes.includes('transfer') ? 'transfer'
        : logShapes.includes('withdrawal') ? 'withdrawal'
          : logShapes.includes('anchor-shaped') ? 'anchor-shaped'
            : logShapes.includes('ambiguous-outflow') ? 'ambiguous-outflow'
              : 'internal';

    let kind: UserSpendKind;
    let amount: bigint;
    let fee: bigint;
    // Every input is a received note this device claimed: the claim, known
    // from the local record of its commitments, not from the tx hash, which
    // is only stamped once the claim is confirmed (DEV-574).
    const claimedByRecord = claimedCount > 0 && claimedCount === spentCount;
    if (stampedAnchor || claimedByRecord) {
      // Positive LOCAL intent beats the SDK-shape heuristic. Stamps are only
      // written by the note-import claim (hooks/use-note-import.ts), so the
      // inputs are notes this user RECEIVED. The gasless branch anchors them
      // through relayWithdraw and looks like a plain withdrawal; the
      // self-funded one looks internal. Either way the row is the receipt:
      // the anchored note's value, with what the claim cost (relayer fee plus
      // any gas top-up) as the fee. The change note it created is skipped by
      // the received-rows loop, so without this the payment had no row and
      // the claim cost showed up as a lone relayer fee (DEV-450).
      kind = 'claim';
      amount = inputSum;
      fee = withdrawn;
    } else if (shape === 'transfer') {
      // A recipient note exists — a transfer. withdrawnValue is the public
      // relay fee on this route.
      amount = gross - withdrawn;
      fee = withdrawn;
      // Value-conservation sanity: a real transfer sends > 0. Keep the spend
      // (its change notes are still the user's own), but emit no amount.
      kind = amount > 0n ? 'transfer' : 'internal';
      if (kind === 'internal') amount = 0n;
    } else if (redepositedInTx && (shape === 'withdrawal' || shape === 'ambiguous-outflow' || gross > 0n)) {
      // A private swap: the value left through the swap route and came back
      // as the output note this tx deposited. Not a withdrawal (nothing left
      // the account) and not internal (the asset changed).
      kind = 'swap';
      amount = withdrawn > 0n ? withdrawn : gross;
      fee = 0n;
    } else if (shape === 'withdrawal' || shape === 'ambiguous-outflow') {
      // One change note per input label and value out: the SDK's withdrawal
      // builder's own shape. amount is the aggregate value that left the pool.
      //
      // 'ambiguous-outflow' - no input label matched, so the arity test cannot
      // run - deliberately lands here too, keeping the previous behaviour. The
      // temptation is to treat unknown as "not a withdrawal", but that erases a
      // REAL withdrawal's amount whenever label data is missing, and hiding
      // money the user did take out is no better than inventing money they did
      // not. So the claim is only ever DOWNGRADED on positive evidence (labels
      // present AND arity inconsistent with the withdrawal builder), never on
      // an absence.
      kind = 'withdrawal';
      amount = withdrawn;
      fee = 0n;
    } else if (shape === 'anchor-shaped') {
      // Labels ARE known and there are more outputs than labels: the withdrawal
      // builder cannot produce this, a self-transfer can. The outflow is a fee,
      // not a payout, so claim no amount. Callers must render it neutrally -
      // saying "you withdrew" here is the original bug.
      kind = 'fee';
      amount = 0n;
      fee = withdrawn;
    } else {
      kind = 'internal'; // self merge/split
      amount = 0n;
      fee = 0n;
    }

    // The Consolidate action sends a zero amount (services/consolidate-notes.ts
    // planConsolidation), so it creates one owned note per deposit and nothing
    // else, from more notes than that. Any other self-transfer (a claim's
    // anchor, a send to my own address) also creates a recipient note, so it
    // has more outputs than deposits, however many notes it merged.
    const consolidation = kind === 'fee' && outputCommitments.size === spentLabels.size && spentCount > outputCommitments.size
      ? { spent: spentCount, created: outputCommitments.size }
      : undefined;

    out.push({
      txHash: bucket[0].txHash,
      tokenId: tokenId || asset,
      kind,
      amount,
      grossOutflow: gross,
      fee,
      inputCount: spentCount,
      outputCount: outputCommitments.size,
      ownOutputValue: changeSum,
      ...(consolidation ? { consolidation } : {}),
      blockTimestamp,
      ...(bucket[0].chainId !== undefined ? { chainId: bucket[0].chainId } : {}),
      // An all-zero hash is a placeholder, not a payment.
      ...(kind === 'claim' && inputTxHashes.size === 1 && !/^(0x)?0*$/.test([...inputTxHashes][0])
        ? { receivedTxHash: [...inputTxHashes][0] }
        : {}),
      ...(kind === 'claim' && claimWithRegistration ? { withRegistration: true } : {}),
      ...(kind === 'swap' ? { swapOutputs } : {}),
      ...(kind === 'swap' || kind === 'withdrawal' ? { inputLabels: [...spentLabels] } : {}),
      ...(kind === 'withdrawal' && swapCaller ? { swapRoute: true } : {}),
    });
  }
  return out;
}

/**
 * Fold claims of the SAME payment into one spend. The self-funded claim
 * anchors one note per transaction, so a multi-lineage payment (one note per
 * contributing lineage, e.g. 14 + 14) yields a claim spend per note, all
 * naming the same `receivedTxHash`. Its row is keyed by that hash, so without
 * this only the first note's amount survived the dedupe. The merged spend
 * keeps the first claim's tx hash; amounts, fees and counts are summed.
 */
export function mergeClaimsByPayment(spends: readonly UserSpend[]): UserSpend[] {
  const out: UserSpend[] = [];
  const byPayment = new Map<string, UserSpend>();
  for (const s of spends) {
    if (s.kind !== 'claim' || !s.receivedTxHash) {
      out.push(s);
      continue;
    }
    const merged = byPayment.get(s.receivedTxHash);
    if (!merged) {
      const copy = { ...s };
      byPayment.set(s.receivedTxHash, copy);
      out.push(copy);
      continue;
    }
    merged.amount += s.amount;
    merged.grossOutflow += s.grossOutflow;
    merged.fee += s.fee;
    merged.inputCount += s.inputCount;
    merged.outputCount += s.outputCount;
    merged.ownOutputValue += s.ownOutputValue;
    if (s.withRegistration) merged.withRegistration = true;
    merged.claimTxHashes = [...(merged.claimTxHashes ?? [merged.txHash]), s.txHash];
  }
  return out;
}
