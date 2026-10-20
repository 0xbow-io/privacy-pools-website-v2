import { LEGACY_CONFIG } from '@/config/env';
import type { Hex } from '@/services/sdk-types';
import {
  getPoolAssociationSetLeaves,
  getPoolLabelDecisions,
  normalizeHashString,
} from '@/services/public-asp-cache';
import { classifyLinkApproval, type LabelDecisionSets, type LinkApprovalCheck } from '@/services/link-approval-rules';

/**
 * The ASP approval state of a claim link's notes, from pool-wide data only:
 * the association-set leaves (shared, root-gated cache) and the scheduled
 * label-decision snapshot. No request names a label.
 */
export async function resolveLinkApproval(
  notes: readonly { label?: unknown }[],
  chainId: number,
): Promise<LinkApprovalCheck> {
  if (LEGACY_CONFIG) return 'approved';
  const labels = notes.map((n) => (typeof n.label === 'string' ? n.label : null));
  if (labels.length === 0 || labels.some((l) => l === null)) return 'unknown';
  const [{ createHashService }, leaves] = await Promise.all([
    import('@/services/sdk-runtime'),
    getPoolAssociationSetLeaves(chainId),
  ]);
  const hashService = await createHashService();
  const labelHashes = (labels as string[]).map((label) => normalizeHashString(hashService.hash([label as Hex])));
  let decisions: LabelDecisionSets | null = null;
  try {
    decisions = getPoolLabelDecisions(chainId);
  } catch {
    decisions = null;
  }
  return classifyLinkApproval({ labelHashes, approved: new Set(leaves), decisions });
}
