/** Same-asset consolidation preserves a separate output for each deposit lineage. */

export type ConsolidatableNote = {
  commitment: string;
  label: string | null | undefined;
  tokenId: string | null | undefined;
  value: string;
  status: string;
};

export type ConsolidationCandidate = {
  label: string;
  tokenId: string;
  /** Smallest-first; candidates are capped, modal groups retain every note. */
  notes: ConsolidatableNote[];
  /** Sum of the selected notes' values in wei. */
  total: bigint;
  /** How many spendable notes the lineage holds in total (may exceed the pick). */
  lineageNoteCount: number;
};

/** Transact input cap on EVM (same as the transfer path). */
export const MAX_CONSOLIDATION_INPUTS = 5;
/** Fewer than this and there is nothing to consolidate. */
export const MIN_CONSOLIDATION_INPUTS = 2;

function positiveValue(note: ConsolidatableNote): bigint | null {
  try {
    const v = BigInt(note.value);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * A note below this share of its lineage's largest note is dust for the
 * purpose of offering a consolidation (2%, in basis points).
 */
export const CONSOLIDATION_DUST_BPS = 200n;

/**
 * How many notes in one lineage count toward offering a consolidation: all of
 * them except ONE dust note next to the largest. The one may be change left by the
 * earlier self-transfer consolidation path. More dust than that is exactly what
 * consolidating is for, so it counts (1 ETH beside four 0.001 ETH notes is
 * still offered).
 */
export function countableNoteCount(notes: readonly ConsolidatableNote[]): number {
  const values = notes.map((n) => positiveValue(n) ?? 0n);
  const largest = values.reduce((m, v) => (v > m ? v : m), 0n);
  if (largest === 0n) return 0;
  const dust = values.filter((v) => v * 10_000n < largest * CONSOLIDATION_DUST_BPS).length;
  return values.length - Math.min(dust, 1);
}

function isSpendable(note: ConsolidatableNote, spendable?: ReadonlySet<string>): boolean {
  if (String(note.status).toUpperCase() !== 'ACTIVE') return false;
  if (spendable && !spendable.has(note.commitment.toLowerCase())) return false;
  return positiveValue(note) !== null;
}

/**
 * Group spendable notes by (tokenId, label) and return every lineage with at
 * least MIN inputs, best candidates first: most notes, then largest total.
 * `spendable`, when given, is the set of commitments the association set
 * currently proves (lowercase); without it ACTIVE is trusted.
 */
export function consolidationGroups(
  notes: readonly ConsolidatableNote[],
  spendable?: ReadonlySet<string>,
  tokenId?: string,
): ConsolidationCandidate[] {
  const groups = new Map<string, ConsolidatableNote[]>();
  for (const note of notes) {
    if (!note.label || !note.tokenId) continue;
    if (tokenId && note.tokenId.toLowerCase() !== tokenId.toLowerCase()) continue;
    if (!isSpendable(note, spendable)) continue;
    const key = `${note.tokenId.toLowerCase()}|${note.label.toLowerCase()}`;
    const g = groups.get(key) ?? [];
    g.push(note);
    groups.set(key, g);
  }
  const out: ConsolidationCandidate[] = [];
  for (const g of groups.values()) {
    if (g.length < MIN_CONSOLIDATION_INPUTS) continue;
    // One dust note next to the lineage's largest does not count. A
    // legacy self-transfer consolidation could leave small change when the
    // final fee differed from the quote used to prepare its recipient amount.
    // Counted, that pair re-offered "Consolidate 2 small notes" right after
    // the user had just consolidated (Mike, 2026-09-24). Any further dust
    // counts, and all of it is swept into the pick.
    if (countableNoteCount(g) < MIN_CONSOLIDATION_INPUTS) continue;
    const sorted = [...g].sort((a, b) => {
      const d = (positiveValue(a) ?? 0n) - (positiveValue(b) ?? 0n);
      return d < 0n ? -1 : d > 0n ? 1 : a.commitment.localeCompare(b.commitment);
    });
    out.push({
      label: String(sorted[0].label).toLowerCase(),
      tokenId: String(sorted[0].tokenId).toLowerCase(),
      notes: sorted,
      total: sorted.reduce((s, n) => s + (positiveValue(n) ?? 0n), 0n),
      lineageNoteCount: g.length,
    });
  }
  return out.sort(rankCandidates);
}

function rankCandidates(a: ConsolidationCandidate, b: ConsolidationCandidate): number {
  return b.notes.length - a.notes.length || (b.total > a.total ? 1 : b.total < a.total ? -1 : 0);
}

/** Prefer small notes; use the largest permitted set when needed to cover the fee. */
export function suggestConsolidation(group: ConsolidationCandidate, fee: bigint | null): ConsolidationCandidate {
  let notes = group.notes.slice(0, MAX_CONSOLIDATION_INPUTS);
  let total = notes.reduce((sum, note) => sum + BigInt(note.value), 0n);
  if (!consolidationWorthIt(total, fee)) {
    notes = group.notes.slice(-MAX_CONSOLIDATION_INPUTS);
    total = notes.reduce((sum, note) => sum + BigInt(note.value), 0n);
  }
  return { ...group, notes, total };
}

/** Suggested inputs preserve the smallest-first dust sweep, within the proof cap. */
export function consolidationCandidates(
  notes: readonly ConsolidatableNote[],
  spendable?: ReadonlySet<string>,
  tokenId?: string,
): ConsolidationCandidate[] {
  return consolidationGroups(notes, spendable, tokenId)
    .map((group) => suggestConsolidation(group, 0n)).sort(rankCandidates);
}

/** Best candidate whose value exceeds the estimated fee. */
export function bestConsolidation(
  notes: readonly ConsolidatableNote[],
  tokenId: string,
  feeWei: bigint | null,
  spendable?: ReadonlySet<string>,
): ConsolidationCandidate | null {
  return consolidationGroups(notes, spendable, tokenId)
    .map((group) => suggestConsolidation(group, feeWei))
    .sort(rankCandidates)
    .find((candidate) => consolidationWorthIt(candidate.total, feeWei)) ?? null;
}

/** Consolidation is economical exactly when the selected value exceeds its fee. */
export function consolidationWorthIt(total: bigint, feeWei: bigint | null): boolean {
  return feeWei !== null && feeWei >= 0n && total > feeWei;
}

/** Exact base units: display rounding must not discard a small positive remainder. */
export function consolidationNet(total: bigint, feeWei: bigint | null): bigint | null {
  return consolidationWorthIt(total, feeWei) ? total - feeWei! : null;
}

/** Shared by form validation and both pre-submit fee checks. */
export function consolidationFeeError(total: bigint, feeWei: bigint | null): string | null {
  if (feeWei === null) return 'The relayer fee is unavailable. Please try again later.';
  return consolidationWorthIt(total, feeWei)
    ? null
    : 'The selected notes must be worth more than the relayer fee.';
}

export function assertConsolidationWorthIt(total: bigint, feeWei: bigint | null): void {
  const error = consolidationFeeError(total, feeWei);
  if (error) throw new Error(error);
}

/** Keep transient verification failures retryable; hide only proven unavailable inputs. */
export function unavailableConsolidationCommitments(rejected: readonly {
  commitment: string; rejectReasons: readonly { code: string }[];
}[]): string[] {
  return rejected.filter(({ rejectReasons }) => rejectReasons.some(({ code }) =>
    ['nullifier-already-spent', 'commitment-not-on-chain', 'note-not-active'].includes(code)))
    .map(({ commitment }) => commitment.toLowerCase());
}

/**
 * Validate a forced input set against the live spendable notes: every
 * commitment must still be present, ACTIVE, same token, with 2+ per label, and
 * within the input cap. Returns the notes in the forced order, or null.
 */
export function resolveForcedInputs<T extends ConsolidatableNote>(
  forced: readonly string[],
  notes: readonly T[],
): T[] | null {
  if (forced.length < MIN_CONSOLIDATION_INPUTS || forced.length > MAX_CONSOLIDATION_INPUTS) return null;
  if (new Set(forced.map((c) => c.toLowerCase())).size !== forced.length) return null;
  const byCommitment = new Map(notes.map((n) => [n.commitment.toLowerCase(), n] as const));
  const picked: T[] = [];
  for (const c of forced) {
    const n = byCommitment.get(c.toLowerCase());
    if (!n || !isSpendable(n)) return null;
    picked.push(n);
  }
  const tokenId = String(picked[0].tokenId ?? '').toLowerCase();
  if (!tokenId) return null;
  const counts = new Map<string, number>();
  for (const n of picked) {
    const label = String(n.label ?? '').toLowerCase();
    if (!label) return null;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (String(n.tokenId ?? '').toLowerCase() !== tokenId) return null;
  }
  if ([...counts.values()].some((count) => count < MIN_CONSOLIDATION_INPUTS)) return null;
  return picked;
}

/** Largest selected lineage pays the fee; the SDK deducts it in input-label order.
 * A zero recipient amount produces exactly one owned change output per label.
 * Keep every output positive: consolidation must never consume an entire group.
 */
export function planConsolidation<T extends ConsolidatableNote>(notes: readonly T[], fee: bigint | null) {
  if (!resolveForcedInputs(notes.map((note) => note.commitment), notes)) {
    throw new Error('Choose at least two notes per group, up to five notes in total.');
  }
  const grouped = new Map<string, T[]>();
  for (const note of notes) {
    const label = String(note.label).toLowerCase();
    grouped.set(label, [...(grouped.get(label) ?? []), note]);
  }
  const groups = [...grouped].map(([label, notes]) => ({
    label, notes, total: notes.reduce((sum, note) => sum + BigInt(note.value), 0n),
  })).sort((a, b) => a.total === b.total ? a.label.localeCompare(b.label) : a.total > b.total ? -1 : 1);
  const total = groups.reduce((sum, group) => sum + group.total, 0n);
  assertConsolidationWorthIt(total, fee);
  if (groups[0].total <= fee!) {
    throw new Error('One selected group must cover the relayer fee and leave a positive balance. Select more value in that group.');
  }
  return {
    notes: groups.flatMap((group) => group.notes), total, net: total - fee!, fee: fee!,
    outputs: groups.map((group, index) => ({ label: group.label, inputCount: group.notes.length,
      value: group.total - (index === 0 ? fee! : 0n), fee: index === 0 ? fee! : 0n })),
  };
}

/**
 * A transfer's change outputs are this consolidation: one per group, each with
 * the planned label and value. Change notes are always the sender's own.
 */
export function consolidationOutputsMatch(
  change: readonly { label: string; value: bigint }[],
  expected: readonly { label: string; value: bigint }[],
): boolean {
  return change.length === expected.length
    && expected.every((e) => change.some((c) => String(c.label).toLowerCase() === e.label && c.value === e.value));
}

export function consolidationSelectionError(notes: readonly ConsolidatableNote[], fee: bigint | null): string | null {
  try { planConsolidation(notes, fee); return null; }
  catch (error) { return error instanceof Error ? error.message : 'These notes cannot be consolidated.'; }
}

/** Group controls never displace another group's selection or exceed the proof cap. */
export function selectConsolidationGroup(
  group: ConsolidationCandidate, selected: readonly string[], action: 'include' | 'fill' | 'clear',
): { selected: string[]; error: string | null } {
  const ids = new Set(group.notes.map((note) => note.commitment));
  const current = selected.filter((id) => ids.has(id));
  if (action === 'clear') return { selected: selected.filter((id) => !ids.has(id)), error: null };
  const free = Math.max(0, MAX_CONSOLIDATION_INPUTS - selected.length);
  const remaining = group.notes.filter((note) => !selected.includes(note.commitment));
  const count = Math.min(free, remaining.length, action === 'include' ? Math.max(0, 2 - current.length) : free);
  if (current.length + count < MIN_CONSOLIDATION_INPUTS) {
    return { selected: [...selected], error: 'Deselect notes in another group first to make room for at least two notes.' };
  }
  return { selected: [...selected, ...remaining.slice(0, count).map((note) => note.commitment)], error: null };
}
