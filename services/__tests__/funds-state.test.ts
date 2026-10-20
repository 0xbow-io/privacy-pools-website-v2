import { describe, expect, test } from 'bun:test';
import {
  claimCalloutVisible,
  fundsChipText,
  isLiveNoteStatus,
  isOverlayState,
  matchesStatusFilter,
  noteMatchPriority,
  noteOutcome,
  depositRowOutcome,
  projectDepositFunds,
  projectReceivedFunds,
  reviewOutcome,
  STATUS_FILTER_HINTS,
  STATUS_FILTER_OPTIONS,
} from '../funds-state';

const base = {
  reviewStatus: 'approved',
  noteStatus: 'ACTIVE',
  leafReady: true,
  leafConfirmed: true,
  registration: 'registered' as const,
  discoveryReady: true,
};

describe('reviewOutcome (ASP feed spelling)', () => {
  test('maps the four feed values; declined (not rejected) is the failure', () => {
    expect(reviewOutcome('pending')).toBe('pending');
    expect(reviewOutcome('approved')).toBe('completed');
    expect(reviewOutcome('declined')).toBe('failed');
    expect(reviewOutcome('poi_required')).toBe('pending');
  });

  test('never manufactures a settled outcome from an unknown spelling', () => {
    expect(reviewOutcome('rejected')).toBe('pending');
    expect(reviewOutcome(undefined)).toBe('pending');
    expect(reviewOutcome(null)).toBe('pending');
  });
});

describe('depositRowOutcome (the ASP review is a ceiling)', () => {
  test('keeps a deposit row pending while the ASP review is still pending, even with an ACTIVE note', () => {
    // Pat, 2026-08-27: own 0.01 ETH deposit materialises an ACTIVE note within
    // seconds, but the ASP feed still read reviewStatus=pending, so the balance
    // card showed "0.0100 ETH pending" while the row showed a completed check.
    expect(depositRowOutcome('ACTIVE', 'pending')).toBe('pending');
    expect(depositRowOutcome('active', 'pending')).toBe('pending');
  });

  test('never lets a note outrank a failed (declined) review', () => {
    expect(depositRowOutcome('ACTIVE', 'failed')).toBe('failed');
    expect(depositRowOutcome('SPENT', 'failed')).toBe('failed');
  });

  test('still completes once the review has approved the deposit', () => {
    expect(depositRowOutcome('ACTIVE', 'completed')).toBe('completed');
    expect(depositRowOutcome('SPENT', 'completed')).toBe('completed');
    expect(depositRowOutcome('EXITED', 'completed')).toBe('completed');
  });

  test('still lets the note settle a row DOWN, which the ceiling never blocks', () => {
    expect(depositRowOutcome('PENDING', 'completed')).toBe('pending');
    expect(depositRowOutcome('INACTIVE', 'completed')).toBe('pending');
  });

  test('leaves a REJECTED note reading the event outcome, as before', () => {
    expect(depositRowOutcome('REJECTED', 'completed')).toBe('completed');
    expect(depositRowOutcome('REJECTED', 'pending')).toBe('pending');
  });
});

describe('noteOutcome', () => {
  test('settles ACTIVE/SPENT/EXITED, holds PENDING/INACTIVE, case-insensitive', () => {
    for (const s of ['ACTIVE', 'active', 'SPENT', 'EXITED']) expect(noteOutcome(s, 'pending')).toBe('completed');
    for (const s of ['PENDING', 'pending', 'INACTIVE']) expect(noteOutcome(s, 'completed')).toBe('pending');
  });

  test('REJECTED keeps the event outcome instead of reading pending forever', () => {
    expect(noteOutcome('REJECTED', 'completed')).toBe('completed');
    expect(noteOutcome('REJECTED', 'failed')).toBe('failed');
  });

  test('unknown statuses stay pending', () => {
    expect(noteOutcome('WHATEVER', 'completed')).toBe('pending');
    expect(noteOutcome(undefined, 'completed')).toBe('pending');
  });
});

describe('isLiveNoteStatus / noteMatchPriority', () => {
  test('REJECTED still holds live value; SPENT/EXITED do not', () => {
    expect(isLiveNoteStatus('REJECTED')).toBe(true);
    expect(isLiveNoteStatus('ACTIVE')).toBe(true);
    expect(isLiveNoteStatus('SPENT')).toBe(false);
    expect(isLiveNoteStatus('EXITED')).toBe(false);
  });

  test('REJECTED outranks SPENT/EXITED/PENDING as the row-backing note', () => {
    expect(noteMatchPriority('ACTIVE')).toBeLessThan(noteMatchPriority('REJECTED'));
    expect(noteMatchPriority('REJECTED')).toBeLessThan(noteMatchPriority('SPENT'));
    expect(noteMatchPriority('SPENT')).toBeLessThan(noteMatchPriority('PENDING'));
    expect(noteMatchPriority('bogus')).toBeGreaterThan(noteMatchPriority('INACTIVE'));
  });
});

describe('projectDepositFunds matrix', () => {
  test('declined review is at risk regardless of a lingering ACTIVE note', () => {
    expect(projectDepositFunds({ ...base, reviewStatus: 'declined' })).toEqual({ state: 'at_risk', reason: 'asp_declined' });
  });

  test('poi_required review is at risk with its own reason', () => {
    expect(projectDepositFunds({ ...base, reviewStatus: 'poi_required', noteStatus: 'PENDING' })).toEqual({
      state: 'at_risk',
      reason: 'poi_required',
    });
  });

  test('REJECTED note on an approved deposit is at risk, not failed, not pending', () => {
    expect(projectDepositFunds({ ...base, noteStatus: 'REJECTED' })).toEqual({ state: 'at_risk', reason: 'note_rejected' });
    expect(projectDepositFunds({ ...base, noteStatus: 'rejected', registration: 'unregistered' })).toEqual({
      state: 'at_risk',
      reason: 'note_rejected',
    });
  });

  test('ACTIVE + leaf confirmed + unregistered wallet is Claim', () => {
    expect(projectDepositFunds({ ...base, registration: 'unregistered' })).toEqual({
      state: 'claim',
      reason: 'registration_required',
    });
  });

  test('ACTIVE + leaf confirmed + registered is Ready; unknown registration is Ready too (fail-open)', () => {
    expect(projectDepositFunds(base)).toEqual({ state: 'ready', reason: 'spendable' });
    expect(projectDepositFunds({ ...base, registration: 'unknown' })).toEqual({ state: 'ready', reason: 'spendable' });
  });

  test('ACTIVE before the leaf set loads is trusted (Ready/Claim); after it loads an unconfirmed leaf is plain pending', () => {
    expect(projectDepositFunds({ ...base, leafReady: false, leafConfirmed: false })).toEqual({ state: 'ready', reason: 'spendable' });
    expect(projectDepositFunds({ ...base, leafReady: true, leafConfirmed: false })).toBeNull();
  });

  test('approved with no local note is Invisible only once discovery has run', () => {
    expect(projectDepositFunds({ ...base, noteStatus: null, discoveryReady: true })).toEqual({
      state: 'invisible',
      reason: 'note_not_discovered',
    });
    expect(projectDepositFunds({ ...base, noteStatus: null, discoveryReady: false })).toBeNull();
  });

  test('ordinary pending review / pending note / settled notes need no overlay', () => {
    expect(projectDepositFunds({ ...base, reviewStatus: 'pending', noteStatus: null })).toBeNull();
    expect(projectDepositFunds({ ...base, noteStatus: 'PENDING' })).toBeNull();
    expect(projectDepositFunds({ ...base, noteStatus: 'SPENT' })).toBeNull();
    expect(projectDepositFunds({ ...base, noteStatus: 'EXITED' })).toBeNull();
  });
});

describe('projectReceivedFunds', () => {
  test('a received ACTIVE note on an unregistered wallet is Claim', () => {
    expect(projectReceivedFunds({ noteStatus: 'ACTIVE', leafReady: true, leafConfirmed: true, registration: 'unregistered' })).toEqual({
      state: 'claim',
      reason: 'registration_required',
    });
  });

  test('a received REJECTED note is at risk', () => {
    expect(projectReceivedFunds({ noteStatus: 'REJECTED', leafReady: true, leafConfirmed: false, registration: 'registered' })).toEqual({
      state: 'at_risk',
      reason: 'note_rejected',
    });
  });
});

describe('presentation helpers', () => {
  test('chip text names the reason when it adds information', () => {
    expect(fundsChipText({ state: 'at_risk', reason: 'poi_required' })).toBe('At risk · Proof required');
    expect(fundsChipText({ state: 'at_risk', reason: 'asp_declined' })).toBe('At risk · Declined');
    expect(fundsChipText({ state: 'claim', reason: 'registration_required' })).toBe('Claim');
    expect(fundsChipText({ state: 'invisible', reason: 'note_not_discovered' })).toBe('Syncing');
  });

  test('Ready is the quiet default and never an overlay', () => {
    expect(isOverlayState({ state: 'ready', reason: 'spendable' })).toBe(false);
    expect(isOverlayState({ state: 'claim', reason: 'registration_required' })).toBe(true);
    expect(isOverlayState(null)).toBe(false);
  });
});

describe('matchesStatusFilter', () => {
  const dep = (status: string, fundsState?: 'ready' | 'claim' | 'at_risk' | 'invisible') => ({ status, type: 'Deposit', fundsState });

  test('offers the four-state options alongside the outcomes', () => {
    expect([...STATUS_FILTER_OPTIONS]).toEqual(['All', 'Completed', 'Pending', 'At risk', 'Claim', 'Failed', 'Exit']);
  });

  test('the two options that are app vocabulary carry an explanation, and the plain ones do not', () => {
    // A reviewer who knows the product still had to ask what these two were.
    expect(STATUS_FILTER_HINTS['At risk']).toBe('Flagged by the ASP. You can still exit these funds.');
    expect(STATUS_FILTER_HINTS.Claim).toBe('Register this wallet to spend these funds.');
    for (const plain of ['All', 'Completed', 'Pending', 'Failed', 'Exit'] as const) {
      expect(STATUS_FILTER_HINTS[plain]).toBeUndefined();
    }
  });

  test('every hint is one short line, and none of them reaches for an em dash', () => {
    for (const hint of Object.values(STATUS_FILTER_HINTS)) {
      expect(hint.length).toBeLessThanOrEqual(60);
      expect(hint).not.toContain('\u2014');
    }
  });

  test('Exit matches real on-chain Exit rows by type, and fully spent deposits', () => {
    expect(matchesStatusFilter('Exit', { status: 'completed', type: 'Exit' }, false)).toBe(true);
    expect(matchesStatusFilter('Exit', dep('completed'), true)).toBe(true);
    expect(matchesStatusFilter('Exit', dep('completed'), false)).toBe(false);
  });

  test('At risk / Claim read the projection; outcomes read status', () => {
    expect(matchesStatusFilter('At risk', dep('completed', 'at_risk'), false)).toBe(true);
    expect(matchesStatusFilter('At risk', dep('failed'), false)).toBe(false);
    expect(matchesStatusFilter('Claim', dep('completed', 'claim'), false)).toBe(true);
    expect(matchesStatusFilter('Completed', dep('completed', 'claim'), false)).toBe(true);
    expect(matchesStatusFilter('Failed', dep('failed'), false)).toBe(true);
    expect(matchesStatusFilter('Pending', dep('completed'), false)).toBe(false);
    expect(matchesStatusFilter('All', dep('failed'), false)).toBe(true);
  });
});

describe('claimCalloutVisible', () => {
  test('shows only for an unregistered wallet holding spendable value', () => {
    expect(claimCalloutVisible('unregistered', true)).toBe(true);
    expect(claimCalloutVisible('unregistered', false)).toBe(false);
    expect(claimCalloutVisible('registered', true)).toBe(false);
    expect(claimCalloutVisible('unknown', true)).toBe(false);
  });
});
