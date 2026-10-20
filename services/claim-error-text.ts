// What a failed claim says to the person claiming.
//
// Claiming a link spends the received note in a self-transfer, and the SDK
// refuses a note that is not ACTIVE with "Transact failed: note 0x… is not
// ACTIVE". That reached the claim page verbatim, and nobody outside the code
// knows what "active" means. For a link it almost always means the sender's
// deposit is still waiting for the ASP. The wording itself lives with the rest
// of the approval copy in services/link-approval-rules.ts.

import { LINK_APPROVAL_COPY } from './link-approval-rules';

export const CLAIM_NOT_APPROVED = LINK_APPROVAL_COPY.pending.refusal;

export const CLAIM_DECLINED = LINK_APPROVAL_COPY.rejected.refusal;

/** The approval state an SDK claim error stands for, or null when it is about something else. */
export function claimErrorApproval(message: string): 'pending' | 'rejected' | null {
  if (/REJECTED|declined/i.test(message) && /not ACTIVE|NoteNotActive|InvalidStatusTransition/i.test(message)) {
    return 'rejected';
  }
  if (/TransactNoteNotActive|not ACTIVE/i.test(message)) return 'pending';
  return null;
}

/** The claim-facing sentence for an SDK error, or null to keep the caller's own. */
export function claimErrorText(message: string): string | null {
  const approval = claimErrorApproval(message);
  return approval ? LINK_APPROVAL_COPY[approval].refusal : null;
}
