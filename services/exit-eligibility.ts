/**
 * Which notes the exit (ragequit) modal offers, and when the activity list must
 * offer exit on its own (DEV-808: exit has to work while the ASP is down).
 *
 * Pure and request-free. Eligibility reads only the note's local status and the
 * chain-derived set of exits the chain never confirmed. Nothing here depends on
 * the ASP: a ragequit proof needs the note, the owner's keys and the keystore
 * tree, all of which the client holds or reads from the chain. The ASP's review
 * only moves a note between PENDING, ACTIVE and REJECTED, and all three can exit,
 * so a review the client could not fetch never hides a note from this list.
 */
import { NoteStatus } from '@/services/sdk-types';

export interface ExitCandidate {
  status: NoteStatus | string;
  commitment: string;
}

/**
 * PENDING, ACTIVE and REJECTED notes can exit (REJECTED -> EXITED is allowed:
 * exit is the escape hatch for exactly the deposit the ASP declined).
 * EXITED / EXIT_PENDING are offered only when the chain never confirmed that
 * exit (services/unconfirmed-exits.ts), so a claimed exit cannot hide a note
 * that is still spendable on chain.
 */
export function exitableNotes<N extends ExitCandidate>(
  notes: readonly N[],
  unconfirmedExitCommitments: ReadonlySet<string>,
): N[] {
  return notes.filter((note) => note.status === NoteStatus.PENDING
    || note.status === NoteStatus.ACTIVE
    || note.status === NoteStatus.REJECTED
    || ((note.status === NoteStatus.EXITED || note.status === NoteStatus.EXIT_PENDING)
      && unconfirmedExitCommitments.has(note.commitment)));
}

/**
 * True when the activity rows that carry the Exit action cannot be built: a feed
 * failed and nothing is held for it. A failed refresh over held data is not an
 * outage (the rows stay), and a feed still loading is not one either.
 */
export function activityFeedsUnavailable(state: {
  eventsLoaded: boolean;
  eventsFailed: boolean;
  snapshotLoaded: boolean;
  snapshotFailed: boolean;
}): boolean {
  return (!state.eventsLoaded && state.eventsFailed) || (!state.snapshotLoaded && state.snapshotFailed);
}
