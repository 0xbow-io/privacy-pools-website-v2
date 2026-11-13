import type { Note } from '@/services/sdk-types';
import { relayerFeeJitterAllowance, transferFeeBudget } from '@/services/relayer-fee-jitter';
import { selectGreedyTransferInputs, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS } from '@/services/transfer-note-selection';
import { selectWithdrawInputs } from '@/services/withdraw-note-selection';

export type StellarFeeFor = (inputs: number, amount: bigint) => bigint | null;
export const stellarFeeReserve = (fee: bigint) => fee + relayerFeeJitterAllowance(fee);

/** Try each supported shape locally: adding an input can also increase its fee. */
export function selectStellarInputs(notes: Note[], amount: bigint, feeFor: StellarFeeFor, withdrawal = false) {
  const reserve = withdrawal ? stellarFeeReserve : transferFeeBudget;
  let best = { selectedNotes: [] as Note[], accumulated: 0n, covered: false, fee: feeFor(1, amount) };
  if (amount <= 0n) return best;
  for (let count = 1; count <= TRANSFER_MAX_INPUTS; count++) {
    const estimate = feeFor(count, amount);
    if (estimate === null) continue;
    const target = amount + reserve(estimate);
    const selected = withdrawal ? selectWithdrawInputs(notes, target, 0n) : null;
    const selectedFee = selected ? feeFor(selected.notes.length, amount) : null;
    const pick = selected && selectedFee !== null && selected.total >= amount + reserve(selectedFee)
      ? { selectedNotes: selected.notes, accumulated: selected.total }
      : selectGreedyTransferInputs(notes, target, count, withdrawal ? Infinity : TRANSFER_MAX_LABELS);
    const fee = feeFor(pick.selectedNotes.length, amount);
    if (fee === null || pick.accumulated < amount + reserve(fee)) continue;
    const labels = (items: Note[]) => new Set(items.map(n => n.label)).size;
    if (best.covered) {
      const labelDifference = withdrawal ? 0 : labels(pick.selectedNotes) - labels(best.selectedNotes);
      if (labelDifference > 0) continue;
      if (labelDifference === 0 && (pick.selectedNotes.length > best.selectedNotes.length
        || (pick.selectedNotes.length === best.selectedNotes.length && pick.accumulated >= best.accumulated))) continue;
    }
    best = { ...pick, covered: true, fee };
  }
  return best;
}

/** Max uses the same shape fee and allowance as selection, including withdrawal's amount fee. */
export function maxStellarAmount(notes: Note[], feeFor: StellarFeeFor, withdrawal = false): bigint {
  const reserve = withdrawal ? stellarFeeReserve : transferFeeBudget;
  const total = notes.reduce((sum, note) => sum + BigInt(note.value), 0n);
  let best = 0n;
  for (let count = 1; count <= TRANSFER_MAX_INPUTS; count++) {
    const pick = selectGreedyTransferInputs(notes, total + 1n, count, withdrawal ? Infinity : TRANSFER_MAX_LABELS);
    let low = 0n;
    let high = pick.accumulated;
    while (low < high) {
      const amount = (low + high + 1n) / 2n;
      const fee = feeFor(pick.selectedNotes.length, amount);
      if (fee !== null && amount + reserve(fee) <= pick.accumulated) low = amount;
      else high = amount - 1n;
    }
    if (low > best) best = low;
  }
  return best;
}

/** EVM's Confirm-time selection: a fresh fee budget, then the unpadded fee if funds are tight. */
export async function selectStellarTransferForRelay(
  notes: Note[], amount: bigint, quoteFee: (inputs: number) => Promise<bigint>,
) {
  const initial = selectGreedyTransferInputs(notes, amount, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS);
  if (!initial.covered) return initial;
  let best = { ...initial, covered: false };
  const labels = (pick: typeof initial) => new Set(pick.selectedNotes.map(n => n.label)).size;
  const preferredLabels = labels(initial);
  const counts = Array.from({ length: Math.min(notes.length, TRANSFER_MAX_INPUTS) }, (_, i) => i + 1);
  // Prefer the original lineage choice, then try cheaper shapes if its fee cannot fit.
  const first = initial.selectedNotes.length - 1;
  for (const count of [...counts.slice(first), ...counts.slice(0, first)]) {
    const fee = await quoteFee(count);
    for (const budget of [transferFeeBudget(fee), fee]) {
      const pick = selectGreedyTransferInputs(notes, amount + budget, count, TRANSFER_MAX_LABELS);
      if (!pick.covered) continue;
      if (!best.covered || labels(pick) < labels(best)
        || (labels(pick) === labels(best) && pick.selectedNotes.length < best.selectedNotes.length)) best = pick;
      if (labels(pick) === preferredLabels) return pick;
      break;
    }
  }
  return best;
}
