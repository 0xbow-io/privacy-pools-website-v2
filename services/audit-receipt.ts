// Partial viewing key — a per-transaction "audit receipt" the user can
// hand to an accountant/auditor to prove the contents (amount, token,
// owner) of ONE shielded note WITHOUT exposing their master viewing
// key (which would decrypt every transaction they ever made).
//
// A note's on-chain commitment is a Poseidon hash chain over its
// preimage:
//
//   noteAddressHash = Poseidon(ownerAddress, noteSecret)
//   precommitment   = Poseidon(noteAddressHash, tokenId, value, METADATA_STANDARD)
//   commitment      = Poseidon(precommitment, label)
//
// `noteSecret` is an independent random value per note, so revealing
// one note's secret leaks nothing about any other note and is not
// derivable back to the master viewing key. The disclosure bundle
// carries exactly the preimage fields. A verifier (see the /verify
// route) recomputes the commitment from the bundle and confirms the
// commitment actually exists in bulk on-chain event data
// — so a forged bundle (made-up amount) can't pass: either the hash
// won't match the claimed commitment, or that commitment was never
// minted on-chain.
//
// This is a thin wrapper over the SDK's NoteComputationService and
// PoolVaultInteractor — no SDK changes required.

import type { Address, Hash, Hex, Secret, Note } from '@/services/sdk-types';
import { getPayUrlBase } from '@/config/env';
import { looksLikeRealWithdrawalFromArity } from '@/services/transact-shape';

const PREFIX = 'pvk1.';

export interface PartialViewingKeyV1 {
  v: 1;
  /** Whether this note is one the user sent (recipient's note) or owns. */
  kind: 'sent' | 'owned';
  chainId: number;
  txHash: Hash;
  /** The on-chain commitment this bundle attests to. */
  commitment: Hash;
  /** Note owner — the recipient (sent) or the user themselves (owned). */
  ownerAddress: Address;
  noteSecret: Secret;
  tokenId: Address;
  /** Token amount in smallest units (hex). */
  value: Hex;
  label: Hash;
  /** Optional human memo, e.g. "May 2026 salary — Bob". */
  memo?: string;
  /** Informational only (not part of verification). Unix ms. */
  createdAt?: number;
}

// --- base64url codec (shared shape with services/note-receipt.ts) ---

function toBase64Url(value: string): string {
  if (typeof Buffer !== 'undefined') {
    // The RN/web `buffer` polyfill doesn't support the 'base64url' encoding
    // ("Unknown encoding: base64url") — use 'base64' and url-safe it manually.
    return Buffer.from(value, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  if (typeof btoa === 'function') {
    // btoa only accepts Latin1, so UTF-8-encode first — memos can carry
    // em-dashes, accented names, emoji, etc. (a plain btoa(value) throws
    // InvalidCharacterError on any code point > 255).
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  throw new Error('Base64 encoding is unavailable in this environment.');
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf8');
  }
  if (typeof atob === 'function') {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  throw new Error('Base64 decoding is unavailable in this environment.');
}

export function encodePartialViewingKey(bundle: PartialViewingKeyV1): string {
  return `${PREFIX}${toBase64Url(JSON.stringify(bundle))}`;
}

// --- batch (multiple disclosures in one shareable bundle) ---

const BATCH_PREFIX = 'pvkb1.';

export function isBatchEncoded(encoded: string): boolean {
  return encoded.trim().startsWith(BATCH_PREFIX);
}

export function encodePartialViewingKeyBatch(bundles: PartialViewingKeyV1[]): string {
  return `${BATCH_PREFIX}${toBase64Url(JSON.stringify(bundles))}`;
}

export function decodePartialViewingKeyBatch(encoded: string): PartialViewingKeyV1[] | null {
  try {
    const trimmed = encoded.trim();
    if (!trimmed.startsWith(BATCH_PREFIX)) return null;
    const arr = JSON.parse(fromBase64Url(trimmed.slice(BATCH_PREFIX.length))) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const out: PartialViewingKeyV1[] = [];
    for (const item of arr) {
      // Reuse single-bundle validation by re-encoding each entry. Any invalid
      // entry rejects the WHOLE batch — a partial decode would make a
      // tampered/corrupted accounting export silently look complete.
      const one = decodePartialViewingKey(encodePartialViewingKey(item as PartialViewingKeyV1));
      if (!one) return null;
      out.push(one);
    }
    return out;
  } catch {
    return null;
  }
}

export function decodePartialViewingKey(encoded: string): PartialViewingKeyV1 | null {
  try {
    const trimmed = encoded.trim();
    const body = trimmed.startsWith(PREFIX) ? trimmed.slice(PREFIX.length) : trimmed;
    const parsed = JSON.parse(fromBase64Url(body)) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const b = parsed as Partial<PartialViewingKeyV1>;
    if (
      b.v !== 1
      || (b.kind !== 'sent' && b.kind !== 'owned')
      || typeof b.chainId !== 'number'
      || typeof b.commitment !== 'string'
      || typeof b.ownerAddress !== 'string'
      || typeof b.noteSecret !== 'string'
      || typeof b.tokenId !== 'string'
      || typeof b.value !== 'string'
      || typeof b.label !== 'string'
      || typeof b.txHash !== 'string'
    ) {
      return null;
    }
    return b as PartialViewingKeyV1;
  } catch {
    return null;
  }
}

// --- builders ---

/** Build a disclosure bundle for a note the user owns (deposit / received / change). */
export function buildOwnedNoteKey(note: Note, chainId: number, memo?: string): PartialViewingKeyV1 {
  return {
    v: 1,
    kind: 'owned',
    chainId,
    txHash: note.txHash,
    commitment: note.commitment,
    ownerAddress: note.ownerAddress,
    noteSecret: note.noteSecret,
    tokenId: note.tokenId,
    value: note.value,
    label: note.label,
    memo,
    createdAt: Date.now(),
  };
}

/** Fields captured at send time for an outgoing payment's recipient note. */
export interface SentNoteDisclosure {
  chainId: number;
  txHash: Hash;
  commitment: Hash;
  ownerAddress: Address; // recipient
  noteSecret: Secret;
  tokenId: Address;
  value: Hex;
  label: Hash;
}

/** Build a disclosure bundle for a payment the user sent. */
export function buildSentPaymentKey(d: SentNoteDisclosure, memo?: string): PartialViewingKeyV1 {
  return {
    v: 1,
    kind: 'sent',
    chainId: d.chainId,
    txHash: d.txHash,
    commitment: d.commitment,
    ownerAddress: d.ownerAddress,
    noteSecret: d.noteSecret,
    tokenId: d.tokenId,
    value: d.value,
    label: d.label,
    memo,
    createdAt: Date.now(),
  };
}

// --- shareable link ---

export function buildVerifyUrl(encoded: string): string {
  const payUrlBase = getPayUrlBase();
  if (payUrlBase) return `${payUrlBase}/verify/${encoded}`;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/verify/${encoded}`;
  }
  return `/verify/${encoded}`;
}

// --- verification ---

export interface VerifyResult {
  /** Recomputed commitment === bundle.commitment (the bundle is internally consistent). */
  hashMatch: boolean;
  /** The recomputed commitment, regardless of match (for diagnostics). */
  recomputedCommitment: Hash | null;
  /** The commitment appears in bulk on-chain event data — it is really on-chain. */
  onChain: boolean;
  /** On-chain insertion timestamp (unix seconds) when present. */
  onChainTimestampSec: number | null;
  /** True only when both the hash matches AND the commitment is on-chain. */
  verified: boolean;
  error?: string;
}

/**
 * Recompute a note's commitment from the disclosed preimage using the
 * SDK's Poseidon chain (the exact functions the SDK uses to mint notes).
 * Lazy-imports the SDK setup so importing this module stays cheap.
 * Exported so the offline smoke test can exercise the real path.
 */
export async function recomputeCommitment(bundle: PartialViewingKeyV1): Promise<Hash> {
  const { createNoteComputationService } = await import('@/services/sdk-runtime');
  const ncs = await createNoteComputationService();
  const noteAddressHash = ncs.computeNoteAddressHash(bundle.ownerAddress, bundle.noteSecret);
  return ncs.computeFullCommitment({
    noteAddressHash,
    tokenId: bundle.tokenId,
    value: bundle.value,
    label: bundle.label,
  }) as Hash;
}

/**
 * Recompute the note commitment from the disclosed preimage and confirm
 * it exists on-chain. Lazy-imports the SDK setup so the verify page
 * doesn't pull snarkjs/Poseidon until it actually runs.
 */
export async function verifyPartialViewingKey(bundle: PartialViewingKeyV1): Promise<VerifyResult> {
  const base: VerifyResult = {
    hashMatch: false,
    recomputedCommitment: null,
    onChain: false,
    onChainTimestampSec: null,
    verified: false,
  };

  let recomputed: Hash;
  try {
    recomputed = await recomputeCommitment(bundle);
  } catch (err) {
    return { ...base, error: `Could not recompute commitment: ${err instanceof Error ? err.message : String(err)}` };
  }

  const hashMatch = recomputed.toLowerCase() === bundle.commitment.toLowerCase();

  let onChain = false;
  let onChainTimestampSec: number | null = null;
  try {
    const sdkSetup = await import('@/services/sdk-runtime');
    const { getChainConfig } = await import('@/config/chains');
    const chain = getChainConfig(bundle.chainId);
    if (!chain?.contracts) {
      return { ...base, recomputedCommitment: recomputed, hashMatch, error: `Unsupported chain ${bundle.chainId}.` };
    }
    const rpc = sdkSetup.createRPCInteractor(bundle.chainId, Number(chain.contracts.fromBlock));
    const hashSvc = await sdkSetup.createHashService();
    const poolVault = sdkSetup.createPoolVaultInteractor(
      rpc,
      chain.contracts.poolAddress as Address,
      hashSvc,
      chain.contracts.fromBlock,
    );
    // Verify against the bundle's claimed commitment AND the one we just
    // recomputed — they're equal when hashMatch is true; using the
    // recomputed one means a forged commitment field can't smuggle an
    // on-chain hit that doesn't correspond to the disclosed amounts.
    // Bulk index rather than commitments(recomputed): a targeted read would
    // disclose the audited commitment to the verifier's RPC provider. See
    // services/onchain-note-index.ts.
    const { createOnChainNoteIndex } = await import('@/services/onchain-note-index');
    const noteIndex = createOnChainNoteIndex({
      chainId: bundle.chainId,
      poolVaultInteractor: poolVault as never,
      hashService: hashSvc as never,
      poolAddress: chain.contracts.poolAddress,
    });
    await noteIndex.refresh();
    // Presence, not timestamp: a commitment can be on-chain while its
    // timestamp fails leaf verification, and "is this note real" must not
    // hinge on the latter.
    onChain = noteIndex.hasCommitment(recomputed);
    const tsRaw = noteIndex.commitmentTimestamp(recomputed);
    onChainTimestampSec = tsRaw ? Number(BigInt(tsRaw)) : null;
  } catch (err) {
    return {
      ...base,
      recomputedCommitment: recomputed,
      hashMatch,
      error: `On-chain check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    hashMatch,
    recomputedCommitment: recomputed,
    onChain,
    onChainTimestampSec,
    verified: hashMatch && onChain,
  };
}
// ===========================================================================
// Proof of origin — for a PUBLIC withdrawal/exit, prove the funds are clean
// (ASP-approved) and that you control them, by disclosing a note you hold in
// the same lineage.
//
// What this DOES prove: "these funds belong to a clean, ASP-approved deposit
// lineage that I control, and this is my withdrawal/exit."
// What it does NOT prove: that you were literally the original depositor — that
// needs the deposit-time `depositSecret`, which the SDK generates fresh and the
// app doesn't persist. (A transfer recipient also holds notes in the lineage.)
//
//   • disclose a note you own in the lineage (the change output of a withdrawal,
//     or any owned note for an exit) → recompute its commitment, confirm it's
//     on-chain (you hold it);
//   • tie it to the tx:  withdraw → the note is one of the tx's output
//     commitments AND withdrawnValue > 0;  exit → the Ragequit event's label
//     matches the note's lineage label;
//   • report the lineage label's ASP status (approved = clean).
// ===========================================================================

const ORIGIN_PREFIX = 'pvo1.';

export type AspStatus = 'pending' | 'approved' | 'rejected' | 'poi_required' | 'unknown' | 'unavailable';

export interface OriginProofV1 {
  v: 1;
  kind: 'origin';
  chainId: number;
  /** A note the user holds in the withdrawal/exit's lineage. */
  note: {
    ownerAddress: Address;
    noteSecret: Secret;
    tokenId: Address;
    value: Hex;
    label: Hash;
  };
  target: {
    type: 'withdraw' | 'exit';
    txHash: Hash;
    /** Public, informational. value is smallest-units (decimal or hex). */
    recipient?: Address;
    value?: string;
    tokenId?: Address;
  };
  memo?: string;
  createdAt?: number;
}

export function isOriginEncoded(encoded: string): boolean {
  return encoded.trim().startsWith(ORIGIN_PREFIX);
}

export function encodeOriginProof(p: OriginProofV1): string {
  return `${ORIGIN_PREFIX}${toBase64Url(JSON.stringify(p))}`;
}

export function decodeOriginProof(encoded: string): OriginProofV1 | null {
  try {
    const t = encoded.trim();
    if (!t.startsWith(ORIGIN_PREFIX)) return null;
    const p = JSON.parse(fromBase64Url(t.slice(ORIGIN_PREFIX.length))) as Partial<OriginProofV1>;
    if (p.v !== 1 || p.kind !== 'origin' || typeof p.chainId !== 'number') return null;
    const n = p.note as OriginProofV1['note'] | undefined;
    if (!n || typeof n.ownerAddress !== 'string' || typeof n.noteSecret !== 'string'
      || typeof n.tokenId !== 'string' || typeof n.value !== 'string' || typeof n.label !== 'string') return null;
    const tg = p.target;
    if (!tg || (tg.type !== 'withdraw' && tg.type !== 'exit') || typeof tg.txHash !== 'string') return null;
    return p as OriginProofV1;
  } catch {
    return null;
  }
}

/** Whether a withdrawal/exit can be proven from the given notes (sync, no chain). */
export function canProveOrigin(
  notes: Note[],
  target: { type: 'withdraw' | 'exit'; txHash: Hash; label?: Hash | null },
): boolean {
  if (target.type === 'withdraw') {
    return notes.some((n) => n.isOwned && String(n.txHash || '').toLowerCase() === target.txHash.toLowerCase());
  }
  const lbl = target.label?.toLowerCase();
  return !!lbl && notes.some((n) => n.isOwned && n.label.toLowerCase() === lbl);
}

/**
 * Build an origin proof for a withdrawal/exit from the user's notes, or null
 * when the user holds no note in that lineage (e.g. funds received then
 * withdrawn — not provable from this device).
 */
export function buildOriginProofForTarget(args: {
  chainId: number;
  notes: Note[];
  target: { type: 'withdraw' | 'exit'; txHash: Hash; label?: Hash | null; recipient?: Address; value?: string; tokenId?: Address };
  memo?: string;
}): OriginProofV1 | null {
  const { notes, target, chainId, memo } = args;
  let note: Note | undefined;
  if (target.type === 'withdraw') {
    // The change output of the withdrawal — a note we own emitted by that tx.
    note = notes.find((n) => n.isOwned && String(n.txHash || '').toLowerCase() === target.txHash.toLowerCase());
  } else {
    const lbl = target.label?.toLowerCase();
    if (lbl) {
      const lineage = notes.filter((n) => n.isOwned && n.label.toLowerCase() === lbl);
      // Prefer the actually-exited note so its commitment matches the Ragequit
      // event (a transfer can leave other lineage notes). Ragequit marks the
      // note EXITED; fall back to SPENT, then any lineage note.
      const byStatus = (s: string) => lineage.find((n) => String(n.status).toUpperCase() === s);
      note = byStatus('EXITED') ?? byStatus('SPENT') ?? lineage[0];
    }
  }
  if (!note) return null;
  return {
    v: 1, kind: 'origin', chainId,
    note: { ownerAddress: note.ownerAddress, noteSecret: note.noteSecret, tokenId: note.tokenId, value: note.value, label: note.label },
    target, memo, createdAt: Date.now(),
  };
}

export interface OriginVerifyResult {
  noteCommitment: Hash | null;
  /** The disclosed note's commitment exists on-chain (you hold this note). */
  noteOnChain: boolean;
  /** The withdrawal/exit ties to this lineage (and, for withdraw, you own its output). */
  targetLinked: boolean;
  /** Public amount that left the pool (withdraw), for display. */
  withdrawnValue: string | null;
  /** Block of the withdrawal, from the same bulk event read. */
  withdrawnBlock: string | null;
  /** ASP cleanliness of the lineage label. */
  aspStatus: AspStatus;
  /** True when you provably hold a note in the lineage AND it ties to the tx. */
  verified: boolean;
  error?: string;
}

export async function verifyOriginProof(p: OriginProofV1): Promise<OriginVerifyResult> {
  const base: OriginVerifyResult = {
    noteCommitment: null, noteOnChain: false, targetLinked: false,
    withdrawnValue: null, withdrawnBlock: null, aspStatus: 'unavailable', verified: false,
  };

  let commitment: Hash;
  let labelHash: Hash;
  try {
    const { createNoteComputationService } = await import('@/services/sdk-runtime');
    const ncs = await createNoteComputationService();
    const noteAddressHash = ncs.computeNoteAddressHash(p.note.ownerAddress, p.note.noteSecret);
    commitment = ncs.computeFullCommitment({
      noteAddressHash, tokenId: p.note.tokenId, value: p.note.value, label: p.note.label,
    }) as Hash;
    labelHash = ncs.computeLabelHash(p.note.label) as Hash;
  } catch (err) {
    return { ...base, error: `Could not recompute the note: ${err instanceof Error ? err.message : String(err)}` };
  }
  base.noteCommitment = commitment;

  try {
    const sdkSetup = await import('@/services/sdk-runtime');
    const { getChainConfig } = await import('@/config/chains');
    const chain = getChainConfig(p.chainId);
    if (!chain?.contracts) return { ...base, error: `Unsupported chain ${p.chainId}.` };
    const rpc = sdkSetup.createRPCInteractor(p.chainId, Number(chain.contracts.fromBlock));
    const hashSvc = await sdkSetup.createHashService();
    const poolVault = sdkSetup.createPoolVaultInteractor(rpc, chain.contracts.poolAddress as Address, hashSvc, chain.contracts.fromBlock);
    const fromBlockHex = `0x${chain.contracts.fromBlock.toString(16)}` as Hex;

    // 1. You hold this note: its commitment is on-chain. Answered from bulk
    //    event data so the commitment is never sent to the RPC provider as a
    //    call argument. See services/onchain-note-index.ts.
    const { createOnChainNoteIndex } = await import('@/services/onchain-note-index');
    const noteIndex = createOnChainNoteIndex({
      chainId: p.chainId,
      poolVaultInteractor: poolVault as never,
      hashService: hashSvc as never,
      poolAddress: chain.contracts.poolAddress,
    });
    await noteIndex.refresh();
    base.noteOnChain = noteIndex.hasCommitment(commitment);

    // 2. Tie to the withdrawal/exit. We require the disclosed note to BE the
    //    note involved in that exact tx — not merely share its lineage label
    //    (multiple parties can hold notes with the same label after a transfer).
    const txHash = p.target.txHash.toLowerCase();
    if (p.target.type === 'exit') {
      const events = await poolVault.getRagequitEvents(fromBlockHex);
      const ev = events.find((e) => String(e.txHash).toLowerCase() === txHash);
      // The Ragequit event's commitment must equal the disclosed note's
      // commitment — i.e. THIS is the note that was exited.
      if (ev) base.targetLinked = String(ev.commitment).toLowerCase() === commitment.toLowerCase();
    } else {
      const events = await poolVault.getTransactedEvents(fromBlockHex);
      const ev = events.find((e) => String(e.txHash).toLowerCase() === txHash);
      if (ev) {
        base.withdrawnValue = ev.withdrawnValue;
        base.withdrawnBlock = ev.blockNumber ? String(ev.blockNumber) : null;
        // Arity-only withdraw-vs-transfer heuristic. It reads as authoritative
        // and is NOT: the rule, and the counterexamples that break it in both
        // directions, now live in services/transact-shape.ts. Two that matter
        // here - a mixed-label withdrawal emits one change note per label and so
        // has 2..5 outputs, and Transact.t.sol:531-548 shows Alice creating the
        // SOLE output for Bob while withdrawing publicly, which makes
        // "one output + value left + I own an output" attribute Alice's
        // withdrawal to Bob. Behaviour is unchanged here on purpose; this path
        // has no access to the spender's input labels, which is what the sound
        // rule needs. Treat a true result as "consistent with", not as proof.
        let withdrew = false;
        try { withdrew = BigInt(ev.withdrawnValue) > 0n; } catch { withdrew = false; }
        const isRealWithdrawal = looksLikeRealWithdrawalFromArity(ev.outputCommitments.length, withdrew);
        const ownsOutput = ev.outputCommitments.some((c) => String(c).toLowerCase() === commitment.toLowerCase());
        base.targetLinked = isRealWithdrawal && ownsOutput;
      }
    }
  } catch (err) {
    return { ...base, error: `On-chain check failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 3. ASP status (best-effort — doesn't block the ownership verdict). The ASP
  //    endpoint expects the label hash in DECIMAL (matches the SDK provider).
  try {
    const apiClient = (await import('@/services/api-client')).default;
    const { resolveConfiguredEntrypoint } = await import('@/services/pool-entrypoint');
    const entrypoint = await resolveConfiguredEntrypoint(p.chainId);
    const res = await apiClient.getLabelStatus(
      BigInt(labelHash).toString(),
      String(p.chainId),
      entrypoint,
      // The user opened ONE origin proof and asked us to verify it. This is
      // the only per-label lookup the policy admits as a decision rather
      // than a debt: it cannot be reached from a sync path.
      'user-initiated-audit',
    );
    base.aspStatus = (res?.status as AspStatus) ?? 'unknown';
  } catch {
    base.aspStatus = 'unavailable';
  }

  base.verified = base.noteOnChain && base.targetLinked;
  return base;
}
