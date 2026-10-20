// Who does a deposit actually belong to?
//
// THE PROBLEM. On-chain, a deposit names only its SUBMITTER. "Pay via Wallet"
// on a payment request is an ordinary Entrypoint.deposit sent by the payer, with
// the payee hidden inside noteAddressHash — unlinkable by design. So every
// surface that answers "is this deposit mine?" by comparing the depositor
// address to the connected wallet says YES to money the user gave away. That is
// one bug reported three times: an inflated pending balance, an inflated
// deposit count, and a tax export that books the payment as income.
//
// THE SIGNALS, strongest first. This module picks the best one available rather
// than letting each call site invent its own heuristic:
//
//   1. COMMITMENT OWNERSHIP — the deposit's output commitment is one of my
//      notes. Definitive and cross-device; needs discovery to have found it.
//   2. LOCAL PAYMENT STAMP — this device recorded paying a request with that
//      tx hash (services/paid-requests-store). Definitive, but per-device.
//   3. VIEWING-KEY DECRYPT — the on-chain Note payload for that tx decrypts
//      with my viewing key. Own deposits are encrypted to my own key
//      (PoolSessionDeposit passes viewingKeyPair.publicKey); a payment to
//      someone else is encrypted to THEIRS. Definitive AND cross-device, which
//      is why it supersedes the stamp — it needs no bookkeeping and also
//      catches deposits somebody else made FOR me.
//   4. DEPOSITOR ADDRESS — the old heuristic. Only when nothing above can
//      answer, because it is the one that is wrong for payments.
//
// WHY UNKNOWN IS NOT "NOT MINE". The ciphertexts come from the Note events
// discovery already downloaded (services/note-ciphertexts.ts), so a tx it has
// not seen, or one with no Note payload at all, has no verdict. That must fall
// through to (4) and keep today's behaviour, never silently drop a deposit out
// of a balance — hiding real money is worse than the over-count this module
// exists to fix.

/** How confident we are, and on what basis — carried so callers can log it. */
export type DepositOwnershipBasis =
  | 'owned-commitment'
  | 'paid-request-stamp'
  | 'outgoing-deposit-stamp'
  | 'viewing-key-match'
  | 'viewing-key-mismatch'
  | 'depositor-fallback';

export interface DepositOwnership {
  mine: boolean;
  basis: DepositOwnershipBasis;
  /** False when we fell back to the depositor heuristic. */
  definitive: boolean;
}

export interface DepositCandidate {
  txHash?: string | null;
  /** The deposit's output commitment, when the source carries one. */
  commitment?: string | null;
  /** Address that submitted the deposit. */
  depositor?: string | null;
}

export interface DepositOwnershipInputs {
  /** Commitments of notes this account holds, preferably via normalizeCommitment. */
  ownedCommitments: ReadonlySet<string>;
  /** Tx hashes this device recorded as payments to someone else, lowercase. */
  paidRequestTxHashes: ReadonlySet<string>;
  /**
   * Tx hashes this device recorded as plain deposits FOR another address
   * ("Deposit to another address", services/outgoing-deposits-store), lowercase.
   * Same certainty and same per-device caveat as the payment stamp.
   */
  outgoingDepositTxHashes?: ReadonlySet<string>;
  /** The connected wallet, lowercase, or null when there is none. */
  connectedAddress: string | null;
  /**
   * Viewing-key verdict per tx hash: true = the Note payload decrypted with my
   * key, false = it did not, absent = could not be read. Absent must not be
   * read as false — see the module note.
   */
  viewingKeyMatches?: ReadonlyMap<string, boolean>;
}

const lower = (v: string | null | undefined): string | null =>
  typeof v === 'string' && v.length > 0 ? v.toLowerCase() : null;

/**
 * One representation for a commitment, whichever side it came from.
 *
 * Signal 1 (commitment ownership) is the strongest test in this module and it
 * was DEAD: the ASP's snapshot writes commitments in DECIMAL
 * ("11200345852414246528...", verified live 2026-08-28) while notes carry
 * 0x-HEX, and every comparison here and at the call sites used `.toLowerCase()`
 * — which equalises case but can never bridge two number bases. So the exact
 * cross-device join always missed and every deposit fell through to the
 * depositor heuristic, which is the one this module exists to avoid. It is
 * also why deposit rows were left matching notes by amount, producing the
 * accepted->pending flap and the pending double-count Artem reported.
 *
 * Normalising through BigInt handles both bases and strips leading zeroes. Only
 * non-negative decimal and 0x-hex are accepted: commitments are field elements,
 * and treating BigInt's extra syntaxes (negative, binary, octal) as canonical
 * would let malformed values collide with valid commitment keys.
 *
 * A value BigInt cannot read falls back to the lowercased string rather than
 * to null. A commitment is a field element and is always numeric in practice,
 * but "unparseable" must not mean "not mine": null would silently downgrade
 * ownership to the depositor heuristic, which is the failure this module
 * exists to prevent (and would hide real money — see the module note). The
 * fallback is exactly the old `.toLowerCase()` behaviour (including surrounding
 * whitespace), so nothing that matched before stops matching.
 */
export function normalizeCommitment(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  if (v.length === 0) return null;
  const trimmed = v.trim();
  if (!/^(?:[0-9]+|0[xX][0-9a-fA-F]+)$/.test(trimmed)) return v.toLowerCase();
  try {
    // The grammar above admits exactly the two representations we join.
    return `0x${BigInt(trimmed).toString(16)}`;
  } catch {
    return v.toLowerCase();
  }
}

/**
 * Probe the canonical key first, then the old raw-lowercase key. The second
 * check preserves the exported service's previous behaviour for callers that
 * still hold an already-lowercased set; canonical producers remain necessary
 * for decimal-vs-hex joins.
 */
function hasOwnedCommitment(
  candidate: string | null | undefined,
  ownedCommitments: ReadonlySet<string>,
): boolean {
  const canonical = normalizeCommitment(candidate);
  if (canonical && ownedCommitments.has(canonical)) return true;
  const legacy = lower(candidate);
  return legacy !== null && legacy !== canonical && ownedCommitments.has(legacy);
}

/**
 * Resolve ownership for ONE deposit, using the strongest signal available.
 *
 * Deliberately ordered so a definitive answer always beats the heuristic, and
 * so the two cross-device signals (1 and 3) beat the per-device stamp.
 */
export function resolveDepositOwnership(
  candidate: DepositCandidate,
  inputs: DepositOwnershipInputs,
): DepositOwnership {
  if (hasOwnedCommitment(candidate.commitment, inputs.ownedCommitments)) {
    return { mine: true, basis: 'owned-commitment', definitive: true };
  }

  const txHash = lower(candidate.txHash);

  // The viewing-key verdict outranks the local stamp: same certainty, but it
  // holds on a device that never saw the payment.
  if (txHash && inputs.viewingKeyMatches?.has(txHash)) {
    const matched = inputs.viewingKeyMatches.get(txHash) === true;
    return {
      mine: matched,
      basis: matched ? 'viewing-key-match' : 'viewing-key-mismatch',
      definitive: true,
    };
  }

  if (txHash && inputs.paidRequestTxHashes.has(txHash)) {
    return { mine: false, basis: 'paid-request-stamp', definitive: true };
  }
  if (txHash && inputs.outgoingDepositTxHashes?.has(txHash)) {
    return { mine: false, basis: 'outgoing-deposit-stamp', definitive: true };
  }

  const depositor = lower(candidate.depositor);
  return {
    mine: depositor !== null && depositor === inputs.connectedAddress,
    basis: 'depositor-fallback',
    definitive: false,
  };
}

/** Convenience for the common "just tell me yes or no" call site. */
export function isMyDeposit(candidate: DepositCandidate, inputs: DepositOwnershipInputs): boolean {
  return resolveDepositOwnership(candidate, inputs).mine;
}

/**
 * Which of these deposits still need a viewing-key verdict?
 *
 * Only the ones no cheaper signal has settled — so the trial decryption stays
 * bounded to the handful of deposits that are genuinely ambiguous, rather than
 * every event in the feed.
 */
export function depositsNeedingViewingKeyCheck(
  candidates: readonly DepositCandidate[],
  inputs: DepositOwnershipInputs,
): string[] {
  const needed = new Set<string>();
  for (const candidate of candidates) {
    const txHash = lower(candidate.txHash);
    if (!txHash) continue;
    if (hasOwnedCommitment(candidate.commitment, inputs.ownedCommitments)) continue;
    if (inputs.viewingKeyMatches?.has(txHash)) continue;
    if (inputs.paidRequestTxHashes.has(txHash)) continue;
    if (inputs.outgoingDepositTxHashes?.has(txHash)) continue;
    // Only deposits we SUBMITTED are ambiguous. Someone else's deposit that
    // isn't ours is already correctly excluded by the depositor fallback.
    const depositor = lower(candidate.depositor);
    if (depositor === null || depositor !== inputs.connectedAddress) continue;
    needed.add(txHash);
  }
  return [...needed];
}

/**
 * Whether a deposit this wallet submitted is still waiting for its signal-3
 * answer. While it is, nothing may be claimed about whose it is: no pending
 * balance, no "not found on this device", no count, no spend action. The
 * deposit itself still happened, and that much can be shown.
 *
 * True only while an answer is actually coming: the snapshot that carries the
 * ciphertexts is loading, or this deposit is not settled yet. A failed
 * snapshot holds nothing past the next verdict pass, which settles every
 * deposit on the failed chain (discovery's ciphertexts can still give some of
 * them a verdict in that pass). A session without keys, or a deposit this
 * device recorded itself, never waits. So nothing can stay held for good.
 */
export function ownershipVerdictPending(input: {
  txHash: string | null | undefined;
  /** Only a deposit this wallet submitted is in question. */
  depositorIsMe: boolean;
  /** Wallet mode with the account's keys held: the only state a verdict comes from. */
  keysHeld: boolean;
  /** This device recorded the deposit as its own (a shield stamp, the local ledger). */
  locallyKnown: boolean;
  snapshot: 'loading' | 'loaded' | 'failed';
  verdicts: ReadonlyMap<string, boolean>;
  /** Deposits nothing more can come for, by the last verdict pass: with or without a verdict. */
  settled: ReadonlySet<string>;
}): boolean {
  const txHash = lower(input.txHash);
  if (!txHash || !input.depositorIsMe || !input.keysHeld || input.locallyKnown) return false;
  if (input.verdicts.has(txHash)) return false;
  return input.snapshot === 'loading' || !input.settled.has(txHash);
}

/**
 * Whether a verdict pass may settle a deposit this wallet submitted, verdict or
 * not: nothing more can come for it. A deposit only the activity feed has seen
 * is newer than the snapshot, and its ciphertext arrives with the next refresh
 * or discovery's next pass. Settling it first would count it by depositor and
 * then take it back.
 */
export function ownershipSettled(input: {
  /** The snapshot holds the deposit, so its Note section covered the block. */
  inSnapshot: boolean;
  /** Its Note ciphertexts are recorded, from the snapshot or from discovery. */
  hasCiphertexts: boolean;
  /** Its chain's snapshot is loaded. A failed one has nothing more to bring. */
  chainSnapshotLoaded: boolean;
}): boolean {
  return input.inSnapshot || input.hasCiphertexts || !input.chainSnapshotLoaded;
}

/** What a trial decryption needs: ICryptoService's ECDH and AEAD, and the note codec. */
export interface NoteDecrypter {
  ecdh(privateKey: `0x${string}`, publicKey: `0x${string}`): `0x${string}`;
  decrypt(ciphertext: `0x${string}`, secret: `0x${string}`): Uint8Array;
  decodeNotePayload(bytes: Uint8Array): unknown;
}

/**
 * Whether a Note ciphertext is a note for this viewing key, by discovery's own
 * test: it opens AND decodes as a note payload. Opening is not enough. A blind
 * deposit's claim backup (services/blind-deposit-backup.ts) is sealed to the
 * SENDER's key on purpose, and the note it describes is the recipient's.
 */
export function isNoteForViewingKey(
  decrypter: NoteDecrypter,
  viewingPrivateKey: `0x${string}`,
): (ciphertext: { ephemeralPubKey: string; encryptedPayload: string }) => boolean {
  return (ciphertext) => {
    try {
      const shared = decrypter.ecdh(viewingPrivateKey, ciphertext.ephemeralPubKey as `0x${string}`);
      decrypter.decodeNotePayload(decrypter.decrypt(ciphertext.encryptedPayload as `0x${string}`, shared));
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Signal 3 for each tx: true when any of its Note ciphertexts is a note for my
 * viewing key, false when it has some and none is, and no entry when it has
 * none to try. A tx that also carries a note for me (a batch) is mine.
 */
export function viewingKeyVerdicts<C>(
  txHashes: readonly string[],
  ciphertextsFor: (txHash: string) => readonly C[],
  opensWithMyKey: (ciphertext: C) => boolean,
): Map<string, boolean> {
  const verdicts = new Map<string, boolean>();
  for (const raw of txHashes) {
    const txHash = raw.toLowerCase();
    const ciphertexts = ciphertextsFor(txHash);
    if (ciphertexts.length === 0) continue;
    verdicts.set(txHash, ciphertexts.some(opensWithMyKey));
  }
  return verdicts;
}

/**
 * Identity of a deposit row as MY notes see it.
 *
 * A deposit is not always sent from the owner's wallet. A cross-chain shield
 * (ETH on mainnet -> USDC pool on Optimism) is executed on the destination by
 * LiFi's executor contract, so the PoolVault's `Deposited` event — and the ASP
 * row built from it — names the executor as depositor (Pat, 2026-08-29: his
 * 23.29 USDC sat in the per-pool balance but "My transactions" and the Mine
 * filter did not list it; Explore/All did, under 0xc9e6…). Ownership by
 * depositor address is therefore necessary but not sufficient: a row whose
 * label or tx hash matches one of my notes is mine whoever paid the gas.
 *
 * Labels are safe to compare here: a deposit's label is published in the
 * `Deposited` event itself, so matching it against my own notes reveals
 * nothing that is not already on-chain. Pure.
 */
export interface NoteIdentitySets {
  txHashes: Set<string>;
  labels: Set<string>;
  commitments: Set<string>;
  /**
   * The EVM token(s) of my notes per tx hash. A swap-send's tx holds my
   * change note (source token) AND the recipient's deposit (output token), so
   * a hash match alone would make their deposit mine (DEV-512). Optional:
   * sets built without it keep the hash-only rule.
   */
  txHashTokens?: Map<string, Set<string>>;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

export function noteIdentitySets(
  notes: readonly { txHash?: unknown; label?: unknown; commitment?: unknown; tokenId?: unknown }[],
): NoteIdentitySets {
  const txHashes = new Set<string>();
  const labels = new Set<string>();
  const commitments = new Set<string>();
  const txHashTokens = new Map<string, Set<string>>();
  for (const n of notes) {
    const commitment = typeof n.commitment === 'string' ? normalizeCommitment(n.commitment) : null;
    if (commitment) commitments.add(commitment);
    if (typeof n.txHash === 'string' && n.txHash && !/^0x0*$/i.test(n.txHash)) {
      const hash = n.txHash.toLowerCase();
      txHashes.add(hash);
      const token = typeof n.tokenId === 'string' ? n.tokenId.toLowerCase() : '';
      const tokens = txHashTokens.get(hash) ?? new Set<string>();
      // Anything but an EVM address is "unknown", which keeps the hash match.
      tokens.add(EVM_ADDRESS.test(token) ? token : '*');
      txHashTokens.set(hash, tokens);
    }
    // Canonical, as commitments are: notes carry hex labels, the ASP's rows
    // decimal ones, and a lowercase string compare never joins the two.
    const label = typeof n.label === 'string' ? normalizeCommitment(n.label) : null;
    if (label) labels.add(label);
  }
  return { txHashes, labels, commitments, txHashTokens };
}

/** Fold `from` into `into` (every field, the per-hash tokens included). */
export function mergeNoteIdentitySets(into: NoteIdentitySets, from: NoteIdentitySets): void {
  for (const h of from.txHashes) into.txHashes.add(h);
  for (const l of from.labels) into.labels.add(l);
  for (const c of from.commitments) into.commitments.add(c);
  if (from.txHashTokens && into.txHashTokens) {
    for (const [h, tokens] of from.txHashTokens) {
      const kept = into.txHashTokens.get(h) ?? new Set<string>();
      for (const t of tokens) kept.add(t);
      into.txHashTokens.set(h, kept);
    }
  }
}

/** Does a tx-hash match also hold for this row's token? */
function hashMatchHoldsForToken(sets: NoteIdentitySets, hash: string, tokenAddress: string | null | undefined): boolean {
  const token = tokenAddress?.toLowerCase() ?? '';
  const tokens = sets.txHashTokens?.get(hash);
  if (!tokens || !EVM_ADDRESS.test(token) || tokens.has('*')) return true;
  return tokens.has(token);
}

/**
 * True when a deposit row matches one of my notes by tx hash or label, or,
 * for a row built from the event snapshot, by its exact commitment. A hash
 * match counts only when one of my notes from that tx is in the row's token:
 * a private swap-send's tx also holds my change note, and the recipient's
 * deposit in it is not mine (DEV-512).
 */
export function depositMatchesMyNotes(
  row: { txHash?: string | null; label?: string | null; commitment?: string | null; tokenAddress?: string | null },
  sets: NoteIdentitySets,
): boolean {
  const commitment = normalizeCommitment(row.commitment);
  if (commitment && sets.commitments.has(commitment)) return true;
  const hash = row.txHash?.toLowerCase();
  if (hash && sets.txHashes.has(hash) && hashMatchHoldsForToken(sets, hash, row.tokenAddress)) return true;
  const label = normalizeCommitment(row.label);
  if (label && sets.labels.has(label)) return true;
  return false;
}
