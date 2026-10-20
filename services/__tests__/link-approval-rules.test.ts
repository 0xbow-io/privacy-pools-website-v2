import { describe, expect, test } from 'bun:test';

import {
  classifyLinkApproval,
  isBlockedApproval,
  LINK_APPROVAL_COPY,
  LinkNotApprovedError,
} from '../link-approval-rules';

const H = (b: string) => `0x${b.repeat(32)}`;
const decisions = (rejected: string[] = [], poiRequired: string[] = []) => ({
  rejected: new Set(rejected),
  poiRequired: new Set(poiRequired),
});

describe('classifyLinkApproval', () => {
  test('a label in the association set with no decision is approved', () => {
    expect(classifyLinkApproval({ labelHashes: [H('aa')], approved: new Set([H('aa')]), decisions: decisions() })).toBe('approved');
  });

  test('a label outside the association set is pending', () => {
    expect(classifyLinkApproval({ labelHashes: [H('aa')], approved: new Set([H('bb')]), decisions: decisions() })).toBe('pending');
  });

  test('a decision vetoes membership', () => {
    const approved = new Set([H('aa')]);
    expect(classifyLinkApproval({ labelHashes: [H('aa')], approved, decisions: decisions([H('aa')]) })).toBe('rejected');
    expect(classifyLinkApproval({ labelHashes: [H('aa')], approved, decisions: decisions([], [H('aa')]) })).toBe('poi_required');
  });

  test('without the decision snapshot a member label is unknown, a non-member still pending', () => {
    expect(classifyLinkApproval({ labelHashes: [H('aa')], approved: new Set([H('aa')]), decisions: null })).toBe('unknown');
    expect(classifyLinkApproval({ labelHashes: [H('aa')], approved: new Set(), decisions: null })).toBe('pending');
  });

  test('the most blocking note decides the whole link', () => {
    const approved = new Set([H('aa'), H('cc')]);
    expect(classifyLinkApproval({ labelHashes: [H('aa'), H('bb')], approved, decisions: decisions() })).toBe('pending');
    expect(classifyLinkApproval({ labelHashes: [H('bb'), H('cc')], approved, decisions: decisions([H('cc')]) })).toBe('rejected');
  });

  test('matches hashes case-insensitively and treats an empty link as unknown', () => {
    expect(classifyLinkApproval({ labelHashes: [H('AA')], approved: new Set([H('aa')]), decisions: decisions() })).toBe('approved');
    expect(classifyLinkApproval({ labelHashes: [], approved: new Set(), decisions: decisions() })).toBe('unknown');
  });
});

describe('claim refusal copy', () => {
  test('only pending, poi_required and rejected block a claim', () => {
    expect(isBlockedApproval('pending')).toBe(true);
    expect(isBlockedApproval('poi_required')).toBe(true);
    expect(isBlockedApproval('rejected')).toBe(true);
    expect(isBlockedApproval('approved')).toBe(false);
    expect(isBlockedApproval('unknown')).toBe(false);
    expect(isBlockedApproval(null)).toBe(false);
  });

  test('refusals never carry a hex value', () => {
    for (const approval of ['pending', 'poi_required', 'rejected'] as const) {
      const err = new LinkNotApprovedError(approval);
      expect(err.approval).toBe(approval);
      expect(err.message).toBe(LINK_APPROVAL_COPY[approval].refusal);
      expect(err.message).not.toMatch(/0x[0-9a-f]/i);
    }
  });
});
