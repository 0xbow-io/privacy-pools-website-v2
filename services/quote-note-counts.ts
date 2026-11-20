// The note counts a relayer prices a quote on (v2-monorepo#539).
//
// The relayer charges gas per input note spent and per output note created,
// and since #537 it refuses a relay whose proof spends more than the quote
// priced. The SDK's own session methods (`prepareWithdraw`, `prepareTransfer`)
// send the counts themselves. Quotes this app requests directly from a
// RelayerInteractor do not, so they pass them from here.
//
// Pure functions over the notes a spend will use: no React, no SDK session, no
// network. `outputCount` mirrors `TransactOrchestrator.previewOutputCount`,
// which the SDK keeps private to its sessions; if it is ever exported, call
// that and drop this copy.
import type { Note } from '@/services/sdk-types';

/** `inputs` and `outputs` as the quote body names them. */
export type QuoteNoteCounts = { inputs: number; outputs: number };

type CountNote = Pick<Note, 'label' | 'value'>;

/** Notes grouped by label, in the order each label first appears among the inputs. */
function groupByLabel<T extends CountNote>(notes: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const note of notes) {
    const key = String(note.label);
    const group = groups.get(key);
    if (group) group.push(note);
    else groups.set(key, [note]);
  }
  return [...groups.values()];
}

/**
 * Counts for a withdrawal: every input, and one change note per distinct input
 * label (always, even when its change is zero).
 */
export function withdrawQuoteCounts(notes: readonly CountNote[]): QuoteNoteCounts {
  return { inputs: notes.length, outputs: groupByLabel(notes).length };
}

/**
 * Counts for a shielded transfer of `amount`: the withdrawal counts, plus one
 * recipient note per label needed, in label order, until `amount` is covered.
 * The fee only changes note values, never the count, so `amount` excludes it.
 */
export function transferQuoteCounts(notes: readonly CountNote[], amount: bigint): QuoteNoteCounts {
  const groups = groupByLabel(notes);
  let remaining = amount;
  let recipientNotes = 0;
  for (const group of groups) {
    if (remaining <= 0n) break;
    const total = group.reduce((sum, note) => sum + BigInt(note.value), 0n);
    remaining -= total >= remaining ? remaining : total;
    recipientNotes += 1;
  }
  return { inputs: notes.length, outputs: groups.length + recipientNotes };
}

/** Whether two counts price the same gas, so a quote for one is valid for the other. */
export function sameQuoteCounts(a: QuoteNoteCounts, b: QuoteNoteCounts): boolean {
  return a.inputs === b.inputs && a.outputs === b.outputs;
}
