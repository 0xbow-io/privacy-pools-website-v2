/**
 * One user-facing vocabulary for "what can I do with these funds right now".
 *
 * PURE module (no react-native imports) so it is bun-testable.
 *
 * The app juggles four independent protocol facts, each with its own spelling:
 *   - the ASP's review of a DEPOSIT event   (`pending | approved | declined | poi_required`,
 *     from GET /global/public/events; `declined` is the feed's word),
 *   - the ASP's label status the SDK reads  (`pending | approved | rejected | poi_required | unknown`),
 *   - the SDK note lifecycle                (`INACTIVE | PENDING | ACTIVE | SPENT | EXITED | REJECTED`),
 *   - keystore registration                 (`unknown | registered | unregistered`).
 * None of those is what a user needs to read. This module projects them onto
 * four states, and every badge, filter and action reads the projection:
 *
 *   ready     spendable now
 *   claim     discovered and approved, but the wallet is not registered yet
 *   at_risk   review declined, Proof of Innocence demanded, or the note was
 *             pulled from the ASP set (REJECTED). REJECTED is reversible in the
 *             pinned SDK (it can recover to ACTIVE), so it is NOT a failure and
 *             Exit stays available.
 *   invisible approved on-chain but not held on this device
 *
 * The transaction OUTCOME (`pending | completed | failed`) stays a separate,
 * historical fact: an approved deposit whose note was later rejected is still a
 * completed deposit, currently at risk.
 */

export type FundsState = 'ready' | 'claim' | 'at_risk' | 'invisible';

export type FundsStateReason =
  | 'spendable'
  | 'registration_required'
  | 'poi_required'
  | 'asp_declined'
  | 'note_rejected'
  | 'note_not_discovered';

export type FundsProjection = { state: FundsState; reason: FundsStateReason };

/** Historical outcome of the transaction itself. */
export type TransactionOutcome = 'pending' | 'completed' | 'failed';

export type RegistrationStatus = 'unknown' | 'registered' | 'unregistered';

/** The ASP feed's review vocabulary. `declined` is canonical; the label
 *  endpoint's `rejected` never reaches a Transaction row. */
export const DEPOSIT_REVIEW_STATUSES = ['pending', 'approved', 'declined', 'poi_required'] as const;
export type DepositReviewStatus = (typeof DEPOSIT_REVIEW_STATUSES)[number];

/** Review status → transaction outcome. Unknown spellings stay pending. */
export function reviewOutcome(reviewStatus: string | null | undefined): TransactionOutcome {
  switch (reviewStatus) {
    case 'approved':
      return 'completed';
    case 'declined':
      return 'failed';
    default:
      return 'pending';
  }
}

/**
 * Note status → transaction outcome, given the outcome the event already
 * established. ACTIVE/SPENT/EXITED are settled; PENDING/INACTIVE are not.
 * REJECTED keeps the event's outcome: the deposit happened and was reviewed,
 * only the note's current standing changed (that is the at_risk projection's
 * job). Before this branch existed a REJECTED note read "pending" forever and
 * dragged an approved event row back to pending.
 */
export function noteOutcome(noteStatus: string | null | undefined, eventOutcome: TransactionOutcome): TransactionOutcome {
  const s = String(noteStatus ?? '').toUpperCase();
  // EXIT_PENDING is settled for this purpose: the deposit happened and the user
  // has acted on it. Treating it as pending would drag an approved deposit row
  // back to Pending for as long as the exit awaits finality — the same bug
  // REJECTED used to cause.
  if (s === 'ACTIVE' || s === 'SPENT' || s === 'EXITED' || s === 'EXIT_PENDING') return 'completed';
  if (s === 'PENDING' || s === 'INACTIVE') return 'pending';
  if (s === 'REJECTED') return eventOutcome;
  return 'pending';
}

/**
 * Deposit row outcome: the local note refines the event's outcome, but the ASP
 * review is a CEILING the note can never raise.
 *
 * Why this exists: noteOutcome() promotes an ACTIVE note to 'completed', which
 * is right once the deposit is approved and wrong while the review is still
 * `pending`. A user's own deposit materialises an ACTIVE note locally within
 * seconds, but the funds are not spendable until the ASP approves it and its
 * association-set leaf is published - which is exactly why the balance card
 * counts them as pending. Letting the note win produced the contradiction Pat
 * reported on 2026-08-27: the transactions row showed a completed checkmark for
 * a 0.01 ETH deposit while the asset card showed "0.0100 ETH pending" (the ASP
 * feed still had reviewStatus=pending for that tx).
 *
 * A declined review is a ceiling too: an ACTIVE note must not read 'completed'
 * over a 'failed' event. So any non-completed event outcome clamps the row.
 */
export function depositRowOutcome(
  noteStatus: string | null | undefined,
  eventOutcome: TransactionOutcome,
): TransactionOutcome {
  const refined = noteOutcome(noteStatus, eventOutcome);
  if (refined === 'completed' && eventOutcome !== 'completed') return eventOutcome;
  return refined;
}

/** Statuses that still hold live value in a lineage (for "fully spent"). */
export function isLiveNoteStatus(noteStatus: string | null | undefined): boolean {
  const s = String(noteStatus ?? '').toUpperCase();
  return s === 'ACTIVE' || s === 'PENDING' || s === 'INACTIVE' || s === 'REJECTED';
}

/**
 * Candidate priority when several local notes could back one deposit row.
 * Lower wins. REJECTED sits right after ACTIVE: it is the lineage's current
 * live note and must not be hidden behind a SPENT/EXITED sibling.
 */
export function noteMatchPriority(noteStatus: string | null | undefined): number {
  switch (String(noteStatus ?? '').toUpperCase()) {
    case 'ACTIVE':
      return 0;
    case 'REJECTED':
      return 1;
    case 'SPENT':
      return 2;
    // Adjacent to EXITED, and ahead of it: a provisional exit is the lineage's
    // more current record, and it can still return to ACTIVE.
    case 'EXIT_PENDING':
      return 3;
    case 'EXITED':
      return 4;
    case 'PENDING':
      return 5;
    case 'INACTIVE':
      return 6;
    default:
      return 7;
  }
}

export type DepositFundsInput = {
  /** ASP review of the deposit event (feed spelling). */
  reviewStatus: string | null | undefined;
  /** Matched local note status, or null when no local note backs the row. */
  noteStatus: string | null | undefined;
  /** Association-set leaf gate: `ready` = the set has loaded; `confirmed` = this
   *  note's leaf is in it. Until ready, ACTIVE is trusted (today's behaviour). */
  leafReady: boolean;
  leafConfirmed: boolean;
  registration: RegistrationStatus;
  /** True once local discovery has run, so "no note" means something. */
  discoveryReady: boolean;
};

/**
 * Projects one deposit row. Returns null when nothing needs overlaying on the
 * plain outcome (an ordinary pending review, a pending note, a settled SPENT or
 * EXITED note): those rows keep reading Pending / Completed.
 *
 * Precedence: the ASP's negative review beats note state (a declined deposit
 * is at risk even if a stale ACTIVE note lingers); a REJECTED note beats
 * everything else about the note; Claim/Ready need a spendable note.
 */
export function projectDepositFunds(input: DepositFundsInput): FundsProjection | null {
  if (input.reviewStatus === 'declined') return { state: 'at_risk', reason: 'asp_declined' };
  if (input.reviewStatus === 'poi_required') return { state: 'at_risk', reason: 'poi_required' };

  const note = String(input.noteStatus ?? '').toUpperCase();
  if (note === 'REJECTED') return { state: 'at_risk', reason: 'note_rejected' };

  if (note === 'ACTIVE') {
    const spendable = !input.leafReady || input.leafConfirmed;
    if (!spendable) return null;
    if (input.registration === 'unregistered') return { state: 'claim', reason: 'registration_required' };
    return { state: 'ready', reason: 'spendable' };
  }

  if (!input.noteStatus && input.reviewStatus === 'approved' && input.discoveryReady) {
    return { state: 'invisible', reason: 'note_not_discovered' };
  }

  return null;
}

/**
 * Projects a RECEIVED note (a lineage row with no ASP review of its own: the
 * ASP reviewed the sender's deposit). Same note rules as a deposit.
 */
export function projectReceivedFunds(input: Omit<DepositFundsInput, 'reviewStatus' | 'discoveryReady'>): FundsProjection | null {
  return projectDepositFunds({ ...input, reviewStatus: 'approved', discoveryReady: true });
}

/** Short badge word per state. */
export const FUNDS_STATE_LABEL: Record<FundsState, string> = {
  ready: 'Ready',
  claim: 'Claim',
  at_risk: 'At risk',
  invisible: 'Syncing',
};

/** One-line explanation per reason (tooltips, detail chip, callouts). */
export const FUNDS_REASON_COPY: Record<FundsStateReason, string> = {
  spendable: 'Ready to spend',
  registration_required: 'Claim: register this wallet to spend these funds',
  poi_required: 'Proof required: the ASP asks for a Proof of Innocence for this deposit',
  asp_declined: 'Declined by the ASP. The note owner can still exit it',
  note_rejected: 'Removed from the ASP set. Exit is still available',
  note_not_discovered: 'Approved on-chain but not found on this device yet',
};

/** Short chip text for the detail view: the state, plus the reason when it
 *  adds something ("At risk · Proof required"). */
export function fundsChipText(p: FundsProjection): string {
  switch (p.reason) {
    case 'poi_required':
      return 'At risk · Proof required';
    case 'asp_declined':
      return 'At risk · Declined';
    case 'note_rejected':
      return 'At risk · Rejected';
    default:
      return FUNDS_STATE_LABEL[p.state];
  }
}

/** States that are worth a badge of their own (Ready is the quiet default). */
export function isOverlayState(p: FundsProjection | null | undefined): p is FundsProjection {
  return !!p && p.state !== 'ready';
}

/** Status-filter options offered by the activity list, in display order. */
export const STATUS_FILTER_OPTIONS = ['All', 'Completed', 'Pending', 'At risk', 'Claim', 'Failed', 'Exit'] as const;
export type StatusFilterOption = (typeof STATUS_FILTER_OPTIONS)[number];

/**
 * What a status-filter word means, for the (i) beside it.
 *
 * Two of these options are the app's own vocabulary rather than plain English,
 * and a reviewer who knows the product still asked what they were (Nathaniel,
 * QA 2026-09-21: "What is 'At Risk' and 'Claim'?"). FUNDS_REASON_COPY already
 * had the explanations but is keyed by REASON, and a filter names a STATE, so
 * nothing could reach them from here.
 *
 * The outcome words (Completed, Pending, Failed, Exit) explain themselves and
 * get no hint; the absence is the signal that the other two need one.
 */
export const STATUS_FILTER_HINTS: Partial<Record<StatusFilterOption, string>> = {
  'At risk': 'Flagged by the ASP. You can still exit these funds.',
  Claim: 'Register this wallet to spend these funds.',
};

/**
 * Does a row pass the Status filter? `Exit` matches on-chain Exit rows by TYPE
 * (no producer ever set `status: 'exit'`, so the old status comparison hid
 * every real exit) or a deposit whose lineage is fully spent. At risk / Claim
 * read the projection; the outcome options read `status`.
 */
export function matchesStatusFilter(
  filter: string,
  row: { status: string; type: string; fundsState?: FundsState | null },
  fullySpentDeposit: boolean,
): boolean {
  if (filter === 'All') return true;
  if (filter === 'Exit') return row.type === 'Exit' || fullySpentDeposit;
  if (filter === 'At risk') return row.fundsState === 'at_risk';
  if (filter === 'Claim') return row.fundsState === 'claim';
  return row.status === filter.toLowerCase();
}

/**
 * The My balances callout: the wallet holds spendable funds it cannot spend
 * until it registers. `hasSpendable` = some pool shows a positive balance.
 */
export function claimCalloutVisible(registration: RegistrationStatus, hasSpendable: boolean): boolean {
  return registration === 'unregistered' && hasSpendable;
}

/**
 * Review verdict for a deposit row we synthesise from our own note because the
 * ASP feed has no row for it (a swap's re-deposit). Only evidence already held
 * locally counts, never a per-label request: a SPENT note was spent privately,
 * which requires approval, and a confirmed association-set leaf is the approval
 * itself. Anything else stays pending.
 */
export function swapOutputReviewStatus(noteStatus: string | null | undefined, leafConfirmed: boolean): DepositReviewStatus {
  if (String(noteStatus ?? '').toUpperCase() === 'SPENT') return 'approved';
  return leafConfirmed ? 'approved' : 'pending';
}
