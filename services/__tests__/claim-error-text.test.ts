import { describe, expect, test } from 'bun:test';

import { CLAIM_DECLINED, CLAIM_NOT_APPROVED, claimErrorApproval, claimErrorText } from '../claim-error-text';
import { LINK_APPROVAL_COPY } from '../link-approval-rules';

describe('a claim before the deposit is approved', () => {
  test('the SDK\'s "not ACTIVE" becomes plain approval wording', () => {
    // Verbatim from the vendored SDK's TransactNoteNotActive.
    expect(claimErrorText('Transact failed: note 0x1234 is not ACTIVE')).toBe(CLAIM_NOT_APPROVED);
    expect(claimErrorText('TransactNoteNotActive')).toBe(CLAIM_NOT_APPROVED);
  });

  test('a declined deposit gets its own state', () => {
    expect(claimErrorText('InvalidStatusTransitionError: note is REJECTED, not ACTIVE')).toBe(CLAIM_DECLINED);
  });

  test('the SDK error and the preflight refusal say the same thing', () => {
    const sdkError = 'Transact failed: note 0x1234 is not ACTIVE';
    expect(claimErrorApproval(sdkError)).toBe('pending');
    expect(claimErrorText(sdkError)).toBe(LINK_APPROVAL_COPY.pending.refusal);
    expect(claimErrorApproval('InvalidStatusTransitionError: note is REJECTED, not ACTIVE')).toBe('rejected');
    expect(claimErrorApproval('Insufficient value for transact')).toBeNull();
  });

  test('anything else keeps its own text', () => {
    expect(claimErrorText('Transaction cancelled in your wallet.')).toBeNull();
  });

  test('no raw status word, no em dash', () => {
    for (const line of [CLAIM_NOT_APPROVED, CLAIM_DECLINED]) {
      expect(line).not.toMatch(/\bACTIVE\b|\bactive\b/);
      expect(line).not.toContain('—');
    }
  });
});
