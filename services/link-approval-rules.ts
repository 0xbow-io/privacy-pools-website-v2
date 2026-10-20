/**
 * Whether a claim link's notes are approved by the ASP, and what to tell the
 * recipient when they are not.
 *
 * A note is only spendable once its label is in the ASP association set, so a
 * link opened before the sender's deposit is approved cannot be claimed yet.
 * The SDK refuses such a claim deep inside the transact with a raw
 * "note 0x… is not ACTIVE"; these rules let the claim surfaces say so first,
 * and services/claim-error-text.ts maps that raw error onto the same copy.
 *
 * Pure module: bun tests import it directly. services/link-approval.ts wires
 * the pool-wide leaves and the scheduled label decisions in.
 */

export type LinkApproval = 'approved' | 'pending' | 'poi_required' | 'rejected';

/** `unknown`: the inputs cannot prove approval, but nothing proves otherwise. */
export type LinkApprovalCheck = LinkApproval | 'unknown';

export type LabelDecisionSets = {
  rejected: ReadonlySet<string>;
  poiRequired: ReadonlySet<string>;
};

// Most blocking first: one declined note blocks the whole link.
const SEVERITY: readonly LinkApprovalCheck[] = ['rejected', 'poi_required', 'pending', 'unknown', 'approved'];

/**
 * Same rule as the SDK sync's label status (services/sdk-setup.ts
 * getLabelStatus): a decision vetoes membership, and a label outside the set is
 * pending. Without the decision snapshot a member label is only `unknown`,
 * because the sync would not promote it either.
 */
export function classifyLinkApproval(input: {
  labelHashes: readonly string[];
  approved: ReadonlySet<string>;
  decisions: LabelDecisionSets | null;
}): LinkApprovalCheck {
  if (input.labelHashes.length === 0) return 'unknown';
  let worst = SEVERITY.length - 1;
  for (const raw of input.labelHashes) {
    const hash = raw.toLowerCase();
    const verdict: LinkApprovalCheck = input.decisions?.rejected.has(hash) ? 'rejected'
      : input.decisions?.poiRequired.has(hash) ? 'poi_required'
      : !input.approved.has(hash) ? 'pending'
      : input.decisions ? 'approved'
      : 'unknown';
    worst = Math.min(worst, SEVERITY.indexOf(verdict));
  }
  return SEVERITY[worst];
}

export type BlockedLinkApproval = Exclude<LinkApproval, 'approved'>;

export function isBlockedApproval(value: LinkApprovalCheck | null | undefined): value is BlockedLinkApproval {
  return value === 'pending' || value === 'poi_required' || value === 'rejected';
}

export const LINK_APPROVAL_COPY: Record<BlockedLinkApproval, {
  status: string;
  title: string;
  body: string;
  button: string;
  refusal: string;
}> = {
  pending: {
    status: 'Waiting for approval',
    title: 'Waiting for approval',
    body: "The sender's deposit is still being reviewed. This page updates once it's approved, and you can claim it then. Keep this link until then.",
    button: 'Waiting for approval',
    refusal: "This payment is still waiting for approval. Nothing was sent. Try again once it's approved.",
  },
  poi_required: {
    status: 'Waiting for approval',
    title: 'Waiting for approval',
    body: "The sender's deposit needs extra review before it can be approved. This page updates once it's approved, and you can claim it then. Keep this link until then.",
    button: 'Waiting for approval',
    refusal: "This payment is still waiting for approval. Nothing was sent. Try again once it's approved.",
  },
  rejected: {
    status: 'Declined',
    title: 'This payment was declined',
    body: "The sender's deposit was not approved, so it can't be claimed. Contact the sender about it.",
    button: "Can't be claimed",
    refusal: "This payment was not approved, so it can't be claimed. Nothing was sent.",
  },
};

/** Thrown by the claim before anything is signed, quoted or proved. */
export class LinkNotApprovedError extends Error {
  readonly approval: BlockedLinkApproval;
  constructor(approval: BlockedLinkApproval) {
    super(LINK_APPROVAL_COPY[approval].refusal);
    this.name = 'LinkNotApprovedError';
    this.approval = approval;
  }
}
