/**
 * Sui spend-input selection — lineage-first, artifact-capped.
 *
 * A Sui transact keeps value conservation per label (lineage), so every input
 * of a spend must share one label. A naive greedy accumulation over ALL active
 * notes can mix lineages and then fail the single-label guard even though one
 * lineage alone covers the amount (e.g. [1 SUI label A, 10 SUI label B] with a
 * 5 SUI spend). Select by lineage instead: group active notes by
 * (label, tokenId), pick a group that covers the amount, and accumulate
 * largest-first within that group only.
 *
 * INPUT CAP: only the transact_1x1 / transact_1x2 circuit artifacts ship with
 * the app (see config/sui-circuits.ts), so a spend can use at most ONE input
 * note today — `maxInputs` defaults to 1 and selection succeeds only when a
 * lineage's single largest note covers the amount. Raise the default in
 * lockstep with shipping more transact_NxM artifacts.
 *
 * Shared by the transfer/withdraw/payment-request submit paths AND their
 * review displays so preview and execution always agree.
 */
import type { StoredSuiNote } from './note-store';

export interface SuiNoteSelection {
  /** The chosen input notes (all sharing one label + tokenId). */
  notes: StoredSuiNote[];
  /** Total value of the chosen notes (>= the requested amount). */
  sum: bigint;
  /** The shared lineage label. */
  label: bigint;
}

/**
 * Pick active notes covering `want` from a SINGLE lineage, using at most
 * `maxInputs` notes (largest-first within the lineage). Returns null when no
 * single lineage covers the amount within the cap.
 */
export function selectSuiNotes(
  notes: StoredSuiNote[],
  want: bigint,
  maxInputs = 1,
): SuiNoteSelection | null {
  if (want <= 0n || maxInputs < 1) return null;
  for (const group of groupActiveByLineage(notes)) {
    const sorted = sortByValueDesc(group);
    const chosen: StoredSuiNote[] = [];
    let sum = 0n;
    for (const n of sorted) {
      if (chosen.length >= maxInputs || sum >= want) break;
      chosen.push(n);
      sum += BigInt(n.value);
    }
    if (sum >= want) return { notes: chosen, sum, label: BigInt(group[0].label) };
  }
  return null;
}

/**
 * The most a one-proof Sui spend can move under the same `maxInputs` cap: the
 * largest sum of the top `maxInputs` active notes of any single lineage (with
 * the default cap of 1, the largest single active note). Balance
 * displays/validation should use this — not the cross-lineage total — so the
 * UI never green-lights an amount the submit path must reject.
 */
export function maxSuiLineageTotal(notes: StoredSuiNote[], maxInputs = 1): bigint {
  let max = 0n;
  for (const group of groupActiveByLineage(notes)) {
    let total = 0n;
    for (const n of sortByValueDesc(group).slice(0, Math.max(1, maxInputs))) {
      total += BigInt(n.value);
    }
    if (total > max) max = total;
  }
  return max;
}

/** Surface this when selection fails under the default single-input cap. */
export const SUI_SINGLE_NOTE_ERROR =
  'Amount exceeds the largest single deposit. Withdraw or transfer in smaller amounts.';

/** Surface this when no single lineage covers (relevant once maxInputs > 1). */
export const SUI_LINEAGE_ERROR =
  'No single deposit lineage covers this amount. Withdraw or transfer per lineage.';

/**
 * Group ACTIVE notes by (label, tokenId), preserving storage order.
 * Known-unapproved notes (aspApproved === false) are excluded: the transact
 * proof needs ASP membership, so they aren't spendable yet. Unchecked notes
 * (undefined) stay included, matching the balance gate's not-ready fallback.
 */
function groupActiveByLineage(notes: StoredSuiNote[]): StoredSuiNote[][] {
  const groups = new Map<string, StoredSuiNote[]>();
  for (const n of notes) {
    if (n.status !== 'active') continue;
    if (n.aspApproved === false) continue;
    const key = `${n.label}:${n.tokenId}`;
    const group = groups.get(key);
    if (group) group.push(n);
    else groups.set(key, [n]);
  }
  return Array.from(groups.values());
}

/** Stable largest-first copy (equal values keep storage order). */
function sortByValueDesc(notes: StoredSuiNote[]): StoredSuiNote[] {
  return [...notes].sort((a, b) => {
    const av = BigInt(a.value);
    const bv = BigInt(b.value);
    return av > bv ? -1 : av < bv ? 1 : 0;
  });
}
