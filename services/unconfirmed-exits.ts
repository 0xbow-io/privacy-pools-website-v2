/**
 * Exits the operator reported but the chain has not proven.
 *
 * THE FINDING. A note's `EXITED` status can arrive from an unauthenticated row in
 * the ASP's event snapshot. `EXITED` is terminal and has no outgoing edge in the
 * SDK's status matrix, so one such row is enough to make a note the user still
 * holds disappear: its value leaves the recoverable total, and
 * `components/ragequit-modal-provider.tsx` filters the exit list to
 * PENDING/ACTIVE/REJECTED, so the note vanishes from the one screen that exists to
 * get funds out. Silently, permanently, while the note stays perfectly spendable
 * on chain.
 *
 * This module is the client-side half of the answer, and it is deliberately NOT a
 * status fix. Three reasons it only ever reports:
 *
 *   - `EXITED` has no legal outgoing edge. Flipping it back means writing a
 *     transition the SDK forbids, or reaching into the notes map behind its back
 *     and corrupting invariants the rest of the SDK relies on.
 *   - Absence of a chain event is weak evidence. Public-RPC `getLogs` drops
 *     ranges silently (see `services/onchain-note-index.ts`), so "no ragequit
 *     event found" routinely means "we did not look hard enough".
 *   - The status gate that blocks the exit lives in the SDK's `prepareRageQuit`,
 *     not in the witness builder. Surfacing the note is enough to let the user
 *     act; nothing needs to lie about its status to make that work.
 *
 * ## The set is built by POSITIVE EXCLUSION, and that is the whole design
 *
 * A note is offered unless a finalized chain proof says it is gone. Not: offered
 * when we managed to prove it is still there.
 *
 * The difference decides whether the fix works. Proving a note is still there
 * means proving a ragequit event does NOT exist, and nothing available here can
 * do that. An underivable nullifier, an unavailable finality boundary, an event
 * still short of finality, a throwing probe, a `getLogs` range the provider
 * quietly truncated — each is a failure to look, and each would have hidden the
 * note again under an "offer only what we confirmed" rule. That rule reproduces
 * the finding every time the evidence is merely missing.
 *
 * Presence in the bulk index is not a coverage certificate either, and leaning on
 * it was circular: `OnChainNoteIndex.hasCommitment` unions ASP snapshot rows with
 * its RPC tail, so the very ragequit row that poisoned the note also marks its
 * commitment "observed on chain". The event kinds are fetched independently too,
 * so a complete Deposited response and a lossy Ragequit one leave `hasCommitment`
 * true with the exit unseen.
 *
 * So only a finalized proof excludes, and it excludes both ways: `EXITED`
 * confirms the row, `SPENT` contradicts it, and either means the note is gone and
 * must not be offered. Everything else is offered. The failure direction is on
 * purpose: a note wrongly offered costs a ragequit attempt that reverts, while a
 * note wrongly omitted is the finding itself.
 */

export interface ExitProof {
  terminalStatus: 'SPENT' | 'EXITED';
  blockNumber: string;
  txHash?: string;
}

export interface ExitedNote {
  commitment: string;
  /** Note value, hex or decimal. Unparseable values are counted, not summed. */
  value: string;
  /** Token id, used only to keep sums from mixing assets. */
  tokenId?: string;
}

export interface UnconfirmedExitReport {
  /** Notes examined — the ones local state calls EXITED. */
  checked: number;
  /**
   * Commitments to keep offering: every examined note that no finalized chain
   * proof excluded. This is the field the UI consumes.
   *
   * NEVER LOG THIS. A commitment identifies a note; a log line pairing several
   * of them reconstructs a portfolio, which is the linkage this whole app is
   * built to avoid.
   */
  offerableCommitments: string[];
  /** Their total value per token id, decimal strings (bigints are not JSON-safe). */
  offerableValueByToken: Record<string, string>;
  /**
   * Of the offered notes, those the chain was actually consulted about and shown
   * to have no ragequit. Diagnostic only — the UI does not distinguish these
   * from the merely unproven, because acting on that distinction is what hid the
   * note in the first place.
   */
  unconfirmed: number;
  /** Exits a finalized chain ragequit event confirms. Excluded from the set. */
  confirmed: number;
  /**
   * Notes the chain answered about with a SPEND, not an exit. The local status
   * is wrong but the funds really are gone, so these are excluded too: the note
   * is unrecoverable either way and offering it would promise an exit that
   * cannot succeed.
   */
  spentNotExited: number;
  /**
   * Offered notes for which no verdict could be reached at all — nullifier
   * underivable, commitment never observed by the bulk index, a probe that
   * threw, or an event still short of finality. Counted so the condition is
   * visible, and offered anyway.
   */
  indeterminate: number;
}

/**
 * @param notes Notes local state calls EXITED, on ONE chain.
 * @param exitProofOf FINALIZED chain evidence for a commitment, or `null`/`undefined`
 *   when there is none. The two are kept distinct for the counters only: `null`
 *   records that the chain was consulted and showed nothing, `undefined` that no
 *   verdict was reached. Neither excludes the note — only a returned proof does.
 * @param isObservedOnChain Whether the bulk index has seen this commitment.
 *   Diagnostic only, and deliberately not a gate: the index unions ASP rows, so a
 *   fabricated ragequit row makes its own commitment "observed".
 */
export function findUnconfirmedExits(input: {
  notes: readonly ExitedNote[];
  exitProofOf: (commitment: string) => ExitProof | null | undefined;
  isObservedOnChain: (commitment: string) => boolean;
}): UnconfirmedExitReport {
  const { notes, exitProofOf, isObservedOnChain } = input;

  const report: UnconfirmedExitReport = {
    checked: notes.length,
    offerableCommitments: [],
    offerableValueByToken: {},
    unconfirmed: 0,
    confirmed: 0,
    spentNotExited: 0,
    indeterminate: 0,
  };

  const totals = new Map<string, bigint>();

  for (const note of notes) {
    let proof: ExitProof | null | undefined;
    let probeThrew = false;
    try {
      proof = exitProofOf(note.commitment);
    } catch {
      // A throwing probe is not a verdict, and specifically not a verdict of
      // "gone". It must not be able to hide the note.
      proof = undefined;
      probeThrew = true;
    }

    if (proof) {
      // The only thing that excludes. An EXITED proof confirms the row; a SPENT
      // proof contradicts it, but either way the note is gone.
      if (proof.terminalStatus === 'EXITED') report.confirmed += 1;
      else report.spentNotExited += 1;
      continue;
    }

    // Offered. The counters below only describe WHY, and change nothing.
    let observed = false;
    if (!probeThrew) {
      try {
        observed = isObservedOnChain(note.commitment);
      } catch {
        observed = false;
      }
    }
    if (proof === null && observed && !probeThrew) report.unconfirmed += 1;
    else report.indeterminate += 1;

    report.offerableCommitments.push(note.commitment);

    // Value is additive per token. An unparseable value still counts as an
    // offered note — it is the note that matters, not our ability to sum it.
    // Token ids are canonicalized: the same EVM asset arrives in checksum and
    // lowercase forms, and keying verbatim splits one asset across two buckets
    // (the same normalisation `services/balance-crosscheck.ts` applies).
    const tokenId = (note.tokenId ?? 'unknown').toLowerCase();
    try {
      const value = BigInt(note.value);
      totals.set(tokenId, (totals.get(tokenId) ?? 0n) + value);
    } catch {
      // Counted above; deliberately not summed.
    }
  }

  for (const [tokenId, total] of totals) {
    report.offerableValueByToken[tokenId] = total.toString();
  }

  return report;
}
