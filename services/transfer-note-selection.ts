import type { Note } from '@/services/sdk-types';

export const TRANSFER_MAX_INPUTS = 5;
// A transact emits one change note per input lineage plus up to one recipient
// note per lineage, against a 5-output circuit cap (SDK
// getTransactOutputNotes + validateTransactDimensions). So a single relayed
// transfer spans at most two deposit lineages (2 change + up to 2 recipient
// ≤ 5). The Max ceiling and the note selection both size against this so the
// UI never green-lights an amount the circuit rejects as
// InvalidTransactDimensions.
export const TRANSFER_MAX_LABELS = 2;
// Enumerating lineage subsets is O(choose(L, k)); this caps L so a pathological
// number of distinct lineages can't blow up the exact search. Never approached
// by the ≤2-lineage money-path callers (choose(90, 2) ≈ 4k); beyond it the
// search switches to the exact bounded DP below — the lineage cap is NEVER
// abandoned (a label-blind bound is an upper bound, not a feasible selection).
const MAX_LABEL_SUBSET_COMBOS = 4096;

export type GreedyTransferSelection = {
  selectedNotes: Note[];
  accumulated: bigint;
  covered: boolean;
};

function groupNotesByLabel(notes: readonly Note[]): Map<string, Note[]> {
  const byLabel = new Map<string, Note[]>();
  for (const note of notes) {
    const label = String(note.label ?? '');
    const group = byLabel.get(label) ?? [];
    group.push(note);
    byLabel.set(label, group);
  }
  return byLabel;
}

/** choose(n, k), short-circuiting to `limit + 1` once it provably exceeds it so
 *  a huge lineage count can't overflow before the caller's guard trips. */
function chooseCount(n: number, k: number, limit: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) {
    result = (result * (n - i)) / (i + 1);
    if (result > limit) return limit + 1;
  }
  return Math.round(result);
}

/** Invoke `cb` with each size-`k` combination of `items` (as a fresh array). */
function forEachCombination<T>(items: readonly T[], k: number, cb: (chosen: T[]) => void): void {
  const n = items.length;
  if (k <= 0 || k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    cb(idx.map((i) => items[i]));
    let p = k - 1;
    while (p >= 0 && idx[p] === n - k + p) p -= 1;
    if (p < 0) return;
    idx[p] += 1;
    for (let j = p + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
  }
}

/** The sum of the largest-value `maxInputs` note values. */
export function topNValueSum(notes: readonly Note[], maxInputs: number): bigint {
  return [...notes]
    .sort(compareNoteValueDesc)
    .slice(0, maxInputs)
    .reduce((sum, note) => sum + BigInt(note.value), 0n);
}

/** The largest-value `maxInputs` notes (largest first). Companion to
 *  {@link topNValueSum}, returning the notes rather than just their sum. */
function topNNotes(notes: readonly Note[], maxInputs: number): Note[] {
  return [...notes].sort(compareNoteValueDesc).slice(0, maxInputs);
}

/** Per-lineage descending-sorted notes and value prefix sums (prefix[j] = sum
 *  of the lineage's top j notes, j capped at maxInputs). */
function lineagePrefixes(
  groups: readonly Note[][],
  maxInputs: number,
): Array<{ sorted: Note[]; prefix: bigint[] }> {
  return groups.map((group) => {
    const sorted = [...group].sort(compareNoteValueDesc).slice(0, maxInputs);
    const prefix: bigint[] = [0n];
    for (const note of sorted) prefix.push(prefix[prefix.length - 1] + BigInt(note.value));
    return { sorted, prefix };
  });
}

type DpCell = { sum: bigint; group: number; take: number; prev: DpCell | null } | null;

/**
 * Exact bounded search via DP over (lineages used, inputs used). The top-i
 * notes of any lineage union are per-lineage descending prefixes, so
 * dp[l][i] = the maximum total value choosing exactly `l` lineages and `i`
 * notes (each chosen lineage contributing its top-j, j >= 1) is exact.
 * O(L * maxLabels * maxInputs^2) — no combinatorial blowup, so it replaces the
 * subset enumeration whenever choose(L, k) would exceed the combos guard.
 */
function boundedDp(
  lineages: ReadonlyArray<{ sorted: Note[]; prefix: bigint[] }>,
  maxInputs: number,
  maxLabels: number,
): DpCell[][] {
  const L = Math.min(maxLabels, lineages.length);
  // dp[l][i]; dp[0][0] is the empty root.
  const dp: DpCell[][] = Array.from({ length: L + 1 }, () =>
    Array.from({ length: maxInputs + 1 }, () => null as DpCell),
  );
  dp[0][0] = { sum: 0n, group: -1, take: 0, prev: null };
  lineages.forEach((lineage, g) => {
    const maxTake = Math.min(lineage.sorted.length, maxInputs);
    if (maxTake === 0) return;
    // Iterate l downward so each lineage is used at most once.
    for (let l = Math.min(L - 1, g); l >= 0; l -= 1) {
      for (let i = maxInputs; i >= 0; i -= 1) {
        const base = dp[l][i];
        if (!base) continue;
        for (let take = 1; take <= maxTake && i + take <= maxInputs; take += 1) {
          const sum = base.sum + lineage.prefix[take];
          const cell = dp[l + 1][i + take];
          if (!cell || sum > cell.sum) {
            dp[l + 1][i + take] = { sum, group: g, take, prev: base };
          }
        }
      }
    }
  });
  return dp;
}

/** Walk a DP cell's parent chain back into the concrete note selection. */
function dpNotes(
  cell: NonNullable<DpCell>,
  lineages: ReadonlyArray<{ sorted: Note[]; prefix: bigint[] }>,
): Note[] {
  const picked: Note[] = [];
  for (let cur: DpCell = cell; cur && cur.group >= 0; cur = cur.prev) {
    picked.push(...lineages[cur.group].sorted.slice(0, cur.take));
  }
  return picked;
}

/**
 * The most-valuable selection of at most `maxInputs` notes spanning at most
 * `maxLabels` distinct lineages: the top-`maxInputs` notes of the best union of
 * up to `maxLabels` label groups. When the label cap doesn't bind (>= the label
 * count) it's simply the top-N over everything; when the cap binds it's exact —
 * subset enumeration for small lineage counts, the bounded DP beyond the combos
 * guard. Never a label-blind upper bound.
 */
function bestBoundedTopN(
  notes: readonly Note[],
  maxInputs: number,
  maxLabels: number,
): { selectedNotes: Note[]; accumulated: bigint } {
  const groups = [...groupNotesByLabel(notes).values()];
  const k = Math.min(maxLabels, groups.length);
  if (k >= groups.length) {
    return { selectedNotes: topNNotes(notes, maxInputs), accumulated: topNValueSum(notes, maxInputs) };
  }
  if (chooseCount(groups.length, k, MAX_LABEL_SUBSET_COMBOS) > MAX_LABEL_SUBSET_COMBOS) {
    // Too many lineages to enumerate subsets: exact bounded DP instead.
    const lineages = lineagePrefixes(groups, maxInputs);
    const dp = boundedDp(lineages, maxInputs, k);
    let best: DpCell = dp[0][0];
    for (let l = 1; l <= k; l += 1) {
      for (let i = 1; i <= maxInputs; i += 1) {
        const cell = dp[l][i];
        if (cell && (!best || cell.sum > best.sum)) best = cell;
      }
    }
    if (!best || best.sum === 0n) return { selectedNotes: [], accumulated: 0n };
    return { selectedNotes: dpNotes(best, lineages), accumulated: best.sum };
  }
  // More labels never lower the union's top-N sum, so the optimum uses exactly
  // `k` lineages; enumerate size-`k` subsets and keep the richest.
  let best = { selectedNotes: [] as Note[], accumulated: 0n };
  forEachCombination(groups, k, (chosen) => {
    const union = chosen.flat();
    const sum = topNValueSum(union, maxInputs);
    if (sum > best.accumulated) best = { selectedNotes: topNNotes(union, maxInputs), accumulated: sum };
  });
  return best;
}

/**
 * The most a single transfer can move from these notes within the input and
 * lineage caps — the per-transaction ceiling the amount entry surfaces. Unlike
 * a bare top-`maxInputs` sum, this respects the ≤`maxLabels`-lineage limit the
 * confirm-time selection enforces, so the shown maximum can't overstate what
 * one transaction actually covers.
 */
export function maxCoverableTransfer(
  notes: readonly Note[],
  maxInputs = TRANSFER_MAX_INPUTS,
  maxLabels = TRANSFER_MAX_LABELS,
): bigint {
  return bestBoundedTopN(notes, maxInputs, maxLabels).accumulated;
}

export type TransferSelectionOptions = {
  /** Consolidate on the way: once the target is covered, fill the remaining
   *  input slots with the other notes of the already-selected lineages. Only
   *  for confirm-time selections that are about to be spent. */
  sweepSelectedLabels?: boolean;
};

/**
 * Selects inputs to cover `targetAmount` within the input and lineage caps,
 * preferring the FEWEST distinct lineages (privacy: link as few deposits as the
 * amount requires), then the fewest inputs, then the smallest change. The
 * transact emits one change note per input lineage plus the recipient output(s)
 * against a 5-output circuit cap, so keeping lineages minimal keeps dimensions
 * valid and discloses no more linkage than necessary.
 *
 * Each lineage-count tier is searched EXACTLY (all size-k label subsets), not
 * greedily: a label-blind largest-first pick can lock into one lineage and miss
 * a fundable pair (e.g. a big note in A forces A+B, when B+C would have
 * covered). When nothing covers, `accumulated` reports the exact maximum
 * coverable so the shortfall message states the true available figure.
 *
 * `maxLabels` defaults to unbounded for any pure-helper callers that predate
 * the lineage cap; the transfer money path passes TRANSFER_MAX_LABELS.
 *
 * With `sweepSelectedLabels`, a covering selection then also spends the spare
 * notes of the lineages it already uses (see {@link sweepSelectedLabels}).
 */
export function selectGreedyTransferInputs(
  notes: readonly Note[],
  targetAmount: bigint,
  maxInputs = TRANSFER_MAX_INPUTS,
  maxLabels = Number.POSITIVE_INFINITY,
  options: TransferSelectionOptions = {},
): GreedyTransferSelection {
  const selection = selectCoveringInputs(notes, targetAmount, maxInputs, maxLabels);
  if (!options.sweepSelectedLabels || !selection.covered) return selection;
  return assertLabelCap(sweepSelectedLabels(notes, selection, maxInputs), maxLabels);
}

/**
 * Fills the free input slots of a covering selection with the spare notes of
 * the lineages it already spends, smallest first. Each lineage's unspent
 * remainder returns as one change note, so every send merges fragments that
 * would otherwise sit below the top-`maxInputs` cut and cap "Max spendable".
 * Notes of an unselected lineage are never added: a new lineage adds outputs
 * against the 5-output cap and links one more deposit to the recipient.
 * Zero-value notes are skipped since spending them merges nothing.
 *
 * `covered` keeps describing the original target; `accumulated` becomes the
 * swept total, which is what the inputs actually hold.
 */
function sweepSelectedLabels(
  notes: readonly Note[],
  selection: GreedyTransferSelection,
  maxInputs: number,
): GreedyTransferSelection {
  const free = maxInputs - selection.selectedNotes.length;
  if (free <= 0) return selection;
  const labels = new Set(selection.selectedNotes.map((n) => String(n.label ?? '')));
  const chosen = new Set(selection.selectedNotes);
  const extra = notes
    .filter((n) => !chosen.has(n) && labels.has(String(n.label ?? '')) && BigInt(n.value) > 0n)
    .sort((a, b) => compareNoteValueDesc(b, a))
    .slice(0, free);
  if (extra.length === 0) return selection;
  return {
    selectedNotes: [...selection.selectedNotes, ...extra],
    accumulated: extra.reduce((sum, n) => sum + BigInt(n.value), selection.accumulated),
    covered: selection.covered,
  };
}

function selectCoveringInputs(
  notes: readonly Note[],
  targetAmount: bigint,
  maxInputs: number,
  maxLabels: number,
): GreedyTransferSelection {
  if (targetAmount <= 0n) return { selectedNotes: [], accumulated: 0n, covered: true };

  const byLabel = groupNotesByLabel(notes);
  const labels = [...byLabel.keys()];
  const labelCap = Math.min(maxLabels, labels.length);

  // Exact tiers up to TRANSFER_MAX_LABELS cover the binding caller (transfer
  // = 2); beyond that only the unbounded default reaches, and those callers
  // read only `covered`, so a label-blind greedy fallback suffices there.
  const exactTierMax = Math.min(labelCap, TRANSFER_MAX_LABELS);
  for (let k = 1; k <= exactTierMax; k += 1) {
    if (chooseCount(labels.length, k, MAX_LABEL_SUBSET_COMBOS) > MAX_LABEL_SUBSET_COMBOS) {
      // Too many lineages to enumerate size-k subsets: exact bounded DP.
      // dp[k][i] is the maximum sum over exactly k lineages and i inputs, so
      // the smallest i with dp[k][i] >= target is the fewest-input coverage at
      // this tier. (Tie-break differs from the enumeration path — max rather
      // than min accumulated at that input count — but the lineage/input caps
      // and the fewest-lineages preference hold exactly.)
      const lineages = lineagePrefixes([...byLabel.values()], maxInputs);
      const dp = boundedDp(lineages, maxInputs, exactTierMax);
      for (let tier = k; tier <= exactTierMax; tier += 1) {
        for (let i = tier; i <= maxInputs; i += 1) {
          const cell = dp[tier][i];
          if (cell && cell.sum >= targetAmount) {
            return assertLabelCap({ selectedNotes: dpNotes(cell, lineages), accumulated: cell.sum, covered: true }, maxLabels);
          }
        }
      }
      break; // no coverage at any remaining exact tier
    }
    let best: GreedyTransferSelection | null = null;
    forEachCombination(labels, k, (labelSubset) => {
      const union = labelSubset.flatMap((label) => byLabel.get(label) ?? []);
      const selection = greedyLargestFirst(union, targetAmount, maxInputs);
      if (!selection.covered) return;
      if (
        !best
        || selection.selectedNotes.length < best.selectedNotes.length
        || (selection.selectedNotes.length === best.selectedNotes.length
          && selection.accumulated < best.accumulated)
      ) {
        best = selection;
      }
    });
    // Found coverage at `k` lineages: never widen to more (privacy).
    if (best) return assertLabelCap(best, maxLabels);
  }
  // More lineages are allowed than the exact tiers searched (only the unbounded
  // default): a label-blind largest-first pick bounded to `maxLabels` may cover.
  if (labelCap > TRANSFER_MAX_LABELS) {
    const spanning = greedyLargestFirst(notes, targetAmount, maxInputs, maxLabels);
    if (spanning.covered) return assertLabelCap(spanning, maxLabels);
  }
  // Nothing covers within the caps: report the exact maximum coverable.
  const partial = bestBoundedTopN(notes, maxInputs, maxLabels);
  return assertLabelCap({ ...partial, covered: partial.accumulated >= targetAmount }, maxLabels);
}

function greedyLargestFirst(
  notes: readonly Note[],
  targetAmount: bigint,
  maxInputs: number,
  maxLabels = Number.POSITIVE_INFINITY,
): GreedyTransferSelection {
  const selectedNotes: Note[] = [];
  const usedLabels = new Set<string>();
  let accumulated = 0n;

  const sorted = [...notes].sort(compareNoteValueDesc);
  for (const note of sorted) {
    if (accumulated >= targetAmount) break;
    if (selectedNotes.length >= maxInputs) break;
    const label = String(note.label ?? '');
    // Skip a note that would introduce a label beyond the cap; keep scanning
    // for more notes within the labels already in play.
    if (!usedLabels.has(label) && usedLabels.size >= maxLabels) continue;
    selectedNotes.push(note);
    usedLabels.add(label);
    accumulated += BigInt(note.value);
  }

  return {
    selectedNotes,
    accumulated,
    covered: accumulated >= targetAmount,
  };
}


/** Invariant guard: a selection must never span more lineages than the cap.
 *  Failing fast here beats submitting a proof the circuit rejects. */
function assertLabelCap(sel: GreedyTransferSelection, maxLabels: number): GreedyTransferSelection {
  if (!Number.isFinite(maxLabels)) return sel;
  const labels = new Set(sel.selectedNotes.map((n) => String(n.label ?? '')));
  if (labels.size > maxLabels) {
    throw new Error(`internal: note selection spans ${labels.size} lineages, cap is ${maxLabels}`);
  }
  return sel;
}

function compareNoteValueDesc(a: Note, b: Note): number {
  const av = BigInt(a.value);
  const bv = BigInt(b.value);
  if (av > bv) return -1;
  if (av < bv) return 1;
  return 0;
}
