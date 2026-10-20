// Which notes a withdrawal spends, plus the round-amount suggestions offered
// beside it. Pure functions over note values: no React, no SDK session, no
// network. Lifted out of the withdraw modal so these rules can be read and
// tested without scrolling through four thousand lines of UI.
//
// The bodies and comments below are the originals, moved verbatim — only the
// `export` keywords are new.
import type { Note } from '@/services/sdk-types';
import { tokenKey } from '@/services/note-token-id';

/**
 * "Blend in" candidates: nearby ROUND amounts to withdraw instead of an oddly
 * specific one. The ASP counts deposits >= the requested amount, so only a
 * LOWER amount can land in a busier set — every candidate is strictly below the
 * entered amount:
 *   A) the entered amount truncated to one significant digit (0.0374 → 0.03)
 *   B) the next 1 / 2 / 5 "nice number" step below A          (0.03   → 0.02)
 * Two guards keep it from nagging:
 *   - an amount that is ALREADY one significant digit (0.03, 0.1, 7) is round
 *     enough — no suggestions at all;
 *   - "nearby" means within a factor of two, so a suggestion never asks the
 *     user to withdraw a small fraction of what they typed.
 * Exact base-unit bigint math only (no float anywhere near an amount), and the
 * caller still checks each candidate's REAL set size before showing it.
 */
export function roundBlendCandidatesWei(amountWei: bigint): bigint[] {
  if (amountWei <= 0n) return [];
  let pow = 1n;
  while (pow * 10n <= amountWei) pow *= 10n;
  const lead = amountWei / pow; // 1..9
  const oneSigDigit = lead * pow;
  if (oneSigDigit === amountWei) return []; // already a round amount
  const nextStepDown = lead > 5n
    ? 5n * pow
    : lead > 2n
      ? 2n * pow
      : lead > 1n
        ? pow
        : 5n * (pow / 10n); // 0n below the smallest base unit. Filtered out
  const out: bigint[] = [];
  for (const candidate of [oneSigDigit, nextStepDown]) {
    const nearby = candidate * 2n >= amountWei;
    if (candidate > 0n && candidate < amountWei && nearby && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

export function compareNoteValueDesc(a: Note, b: Note): number {
  const aValue = BigInt(a.value);
  const bValue = BigInt(b.value);
  if (aValue === bValue) return 0;
  return aValue > bValue ? -1 : 1;
}

export function compareNoteValueAsc(a: Note, b: Note): number {
  return -compareNoteValueDesc(a, b);
}

// Withdraw input selection (manager spec): the circuit supports up to 5 inputs
// (transact_NxM artifacts are bundled for N≤5), so we no longer ask the user to
// pick notes — we auto-select. Preference: spend the SMALLEST notes first to
// consolidate, but SKIP dust (notes below a per-asset threshold) so we don't
// burn input slots / proving time on tiny notes. If the smallest non-dust notes
// can't cover the target within the input cap, fall back to largest-first over
// ALL notes so a large withdrawal still succeeds and funds aren't stranded.
export const WITHDRAW_MAX_INPUTS = 5;

// Per-asset dust floor in whole token units. 0.01 ETH per the spec; a $1-ish
// floor for stablecoins. Notes below this are skipped unless nothing else can
// fund the withdrawal.
export const DUST_THRESHOLD: Record<string, number> = {
  ETH: 0.01,
  WETH: 0.01,
  USDC: 1,
  USDT: 1,
  DAI: 1,
};
export const DEFAULT_DUST_THRESHOLD = 0.01;

function selectWithdrawInputsWithinToken(
  notes: Note[],
  targetWei: bigint,
  dustWei: bigint,
): { notes: Note[]; total: bigint } {
  const accumulate = (sorted: Note[]) => {
    const picked: Note[] = [];
    let total = 0n;
    for (const note of sorted) {
      if (picked.length >= WITHDRAW_MAX_INPUTS) break;
      picked.push(note);
      total += BigInt(note.value);
      if (total >= targetWei) break;
    }
    return { notes: picked, total };
  };
  const nonDust = notes.filter((n) => BigInt(n.value) >= dustWei);
  // Primary: smallest non-dust first (consolidate small notes, skip dust).
  const smallestFirst = accumulate([...(nonDust.length > 0 ? nonDust : notes)].sort(compareNoteValueAsc));
  if (smallestFirst.total >= targetWei) return smallestFirst;
  // Fallback: largest-first over ALL notes (incl. dust) — maximizes coverage
  // within the input cap so big withdrawals succeed and funds aren't stranded.
  const largestFirst = accumulate([...notes].sort(compareNoteValueDesc));
  return largestFirst.total > smallestFirst.total ? largestFirst : smallestFirst;
}

function preferSelection(
  best: { notes: Note[]; total: bigint },
  next: { notes: Note[]; total: bigint },
  targetWei: bigint,
): { notes: Note[]; total: bigint } {
  const nextCovers = next.total >= targetWei;
  const bestCovers = best.total >= targetWei;
  if (nextCovers && !bestCovers) return next;
  if (nextCovers && bestCovers) {
    if (next.notes.length < best.notes.length) return next;
    if (next.notes.length === best.notes.length && next.total < best.total) return next;
  } else if (!nextCovers && !bestCovers && next.total > best.total) {
    return next;
  }
  return best;
}

/**
 * Select a mixed-label input set from one token.
 *
 * Grouped by the address case-insensitively (services/note-token-id.ts): notes
 * that spell one token two ways are one token, and grouping by the raw string
 * left the second spelling unspendable.
 */
export function selectWithdrawInputs(
  notes: Note[],
  targetWei: bigint,
  dustWei: bigint,
): { notes: Note[]; total: bigint } {
  const byTokenId = new Map<string, Note[]>();
  for (const note of notes) {
    const key = tokenKey(note);
    const group = byTokenId.get(key);
    if (group) group.push(note);
    else byTokenId.set(key, [note]);
  }

  let best: { notes: Note[]; total: bigint } = { notes: [], total: 0n };
  for (const group of byTokenId.values()) {
    best = preferSelection(
      best,
      selectWithdrawInputsWithinToken(group, targetWei, dustWei),
      targetWei,
    );
  }
  return best;
}

