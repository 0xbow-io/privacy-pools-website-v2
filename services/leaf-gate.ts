/**
 * ONE answer to "which of my notes are provably spendable".
 *
 * WHY THIS MODULE EXISTS. Three surfaces used to answer that question
 * independently, and they could disagree on one screen (Artem, QA 2026-08-28:
 * a hub reading "Shielded balance 0.02 ETH" beside a withdraw error naming
 * 0.0100 ETH). The divergence was not one bug but three:
 *
 *   1. DIFFERENT DATA. The hub hashed note labels against the SESSION's
 *      association-set leaves; the withdraw modal fired its OWN
 *      `aspClient.getAssociationSetLeaves()` on every notes change. Two
 *      fetches, two moments, two answers — a lagging ASP replica or a failed
 *      request moved one and not the other.
 *   2. DIFFERENT NORMALISATION. Two functions named `normalizeHashValue`
 *      disagreed: one padded the hash to 64 hex characters, the other left
 *      `0x` values untouched. services/hex-format.ts already warned that they
 *      "are different functions wearing the same name". The padded form is the
 *      one the SDK stores leaves in, so it is the one kept here.
 *   3. DIFFERENT FAILURE POLICY, applied invisibly. The hub failed OPEN (trust
 *      ACTIVE until the set loads) so a balance appears promptly; the withdraw
 *      modal failed CLOSED (nothing is spendable until proven) so you cannot
 *      attempt a spend you cannot prove.
 *
 * Only (3) was ever intentional, and it stays — a display surface and a
 * spending surface SHOULD answer differently while the truth is unknown. What
 * changes is that they now differ in POLICY over shared FACTS, instead of
 * disagreeing about the facts themselves. `status` is what each consumer
 * applies its policy to, and both are named at the call site rather than
 * buried in an effect.
 *
 * PURE module: hashing is injected, so the membership rule is testable without
 * the SDK.
 */

/** What the gate knows right now. */
export type LeafGate =
  /** The association set has not answered yet. NOT the same as "nothing is spendable". */
  | { status: 'loading'; confirmed: ReadonlySet<string> }
  /** The set is known; `confirmed` is complete and authoritative. */
  | { status: 'ready'; confirmed: ReadonlySet<string> }
  /** The set could not be verified. Distinct from both loading and a verified empty set. */
  | { status: 'error'; confirmed: ReadonlySet<string>; error: string };

export const LOADING_GATE: LeafGate = { status: 'loading', confirmed: new Set<string>() };

export function failedLeafGate(error: string): LeafGate {
  return { status: 'error', confirmed: new Set<string>(), error };
}

/**
 * The SDK's label-hash format: lowercase 0x, padded to 64 hex characters.
 *
 * Leaves are stored already normalised this way, so a hash compared in any
 * other shape silently fails to match — which is exactly how the withdraw
 * modal's unpadded variant could miss a leaf the hub found.
 */
export function normalizeLeafHash(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return `0x${BigInt(value).toString(16).padStart(64, '0')}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

export interface GateNote {
  commitment: string;
  label?: unknown;
}

/** Stable membership topology: array identity and ordering are deliberately irrelevant. */
export function buildLeafGateNotesKey(notes: readonly GateNote[]): string {
  const topology = notes
    .map((note) => [note.commitment, note.label ? String(note.label) : null] as const)
    .sort(([commitmentA, labelA], [commitmentB, labelB]) => {
      const commitmentOrder = commitmentA.localeCompare(commitmentB);
      if (commitmentOrder !== 0) return commitmentOrder;
      return String(labelA).localeCompare(String(labelB));
    });
  return JSON.stringify(topology);
}

export type LeafGateResolution = {
  key: string;
  leaves: readonly string[];
  gate: LeafGate;
};

/** Never expose a result computed for another topology or leaf-query generation. */
export function resolveLeafGateForInputs(
  resolution: LeafGateResolution | null,
  currentKey: string,
  currentLeaves: readonly string[],
): LeafGate {
  return resolution?.key === currentKey && resolution.leaves === currentLeaves
    ? resolution.gate
    : LOADING_GATE;
}

/**
 * Commitments whose label is in the published set.
 *
 * `hashLabel` is injected (the SDK's Poseidon), so callers share one rule and
 * tests need no SDK. Notes without a label are skipped rather than guessed at.
 */
export function confirmSpendableCommitments(input: {
  notes: readonly GateNote[];
  /** Association-set leaves, already in the SDK's stored form. */
  leaves: readonly string[];
  blockedLabelHashes?: readonly string[];
  hashLabel: (label: unknown) => string;
}): Set<string> {
  const { notes, leaves, hashLabel } = input;
  const leafSet = new Set(leaves.map((l) => normalizeLeafHash(l) ?? l));
  const blocked = new Set((input.blockedLabelHashes ?? []).map(normalizeLeafHash));
  const confirmed = new Set<string>();
  for (const note of notes) {
    if (!note.label) continue;
    const labelHash = normalizeLeafHash(String(hashLabel(note.label)));
    if (labelHash && !blocked.has(labelHash) && leafSet.has(labelHash)) confirmed.add(note.commitment);
  }
  return confirmed;
}

/**
 * Is this note spendable, for a surface that must not overstate funds?
 *
 * FAIL-CLOSED: while the gate is loading or failed the answer is "not proven",
 * so a withdraw cannot select a note it may be unable to prove. The caller
 * distinguishes loading from retryable failure rather than rendering either as
 * a zero balance (components/withdraw-modal-provider.tsx).
 */
export function isProvablySpendable(gate: LeafGate, commitment: string): boolean {
  if (gate.status !== 'ready') return false;
  return gate.confirmed.has(commitment);
}

/**
 * Is this note spendable, for a surface that must not hide funds?
 *
 * FAIL-OPEN: while the gate is loading or failed an ACTIVE note counts, so a
 * balance appears promptly and a transient read failure does not erase it.
 * Once the gate is ready both policies agree exactly — the difference exists
 * only while the facts are unknown.
 */
export function countsAsSpendableForDisplay(gate: LeafGate, commitment: string): boolean {
  if (gate.status !== 'ready') return true;
  return gate.confirmed.has(commitment);
}
