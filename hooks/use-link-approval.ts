import { useEffect, useMemo, useState } from 'react';

import { LEGACY_CONFIG } from '@/config/env';
import { usePoolSession } from '@/hooks/use-pool-session';
import { usePublicFeed } from '@/hooks/use-public-feed';
import { feedLabelDecisions, type LabelDecisions } from '@/services/label-decision-feed';
import { feedData } from '@/services/public-feed-scheduler';
import { classifyLinkApproval, type LinkApprovalCheck } from '@/services/link-approval-rules';

type LabelledNote = { label?: unknown };

/**
 * The ASP approval state of a claim link's notes, or `null` while it cannot be
 * read yet.
 *
 * A pure read: the association-set leaves come from the session's own
 * root-polled query and the decisions from the public-feed grid, so opening a
 * link or waiting on this page never puts a request on the wire. Both refresh
 * on their own cadence, so a pending link turns claimable without a reload.
 * Neither needs a signed-in session.
 */
export function useLinkApproval(notes: readonly LabelledNote[], chainId: number, enabled: boolean): LinkApprovalCheck | null {
  // blockedLabelHashes is defined only while the session's decision snapshot is
  // inside its age bound; the feed below splits it into its two kinds.
  const { associationSetLeaves, associationSetLeavesReady, associationSetLeavesScopeKey, blockedLabelHashes } = usePoolSession();
  const decisionsFeed = usePublicFeed<LabelDecisions>(feedLabelDecisions(chainId));

  const labels = notes.map((n) => (typeof n.label === 'string' ? n.label : null));
  const labelsKey = labels.join(',');
  const hasAllLabels = labels.length > 0 && labels.every((l) => l !== null);

  // Local hashing only. Tagged with the labels it was computed for, so a
  // different link never reads another link's hashes.
  const [hashed, setHashed] = useState<{ key: string; hashes: string[] } | null>(null);
  useEffect(() => {
    if (!enabled || !hasAllLabels || LEGACY_CONFIG) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ createHashService }, { normalizeHashString }] = await Promise.all([
          import('@/services/sdk-runtime'),
          import('@/services/public-asp-cache'),
        ]);
        const hashService = await createHashService();
        const hashes = labelsKey.split(',').map((label) => normalizeHashString(hashService.hash([label as `0x${string}`])));
        if (!cancelled) setHashed({ key: labelsKey, hashes });
      } catch {
        if (!cancelled) setHashed({ key: labelsKey, hashes: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, hasAllLabels, labelsKey]);

  const leavesChainId = useMemo(() => {
    try {
      return Number((JSON.parse(associationSetLeavesScopeKey) as unknown[])[0]);
    } catch {
      return NaN;
    }
  }, [associationSetLeavesScopeKey]);
  const approved = useMemo(() => new Set(associationSetLeaves), [associationSetLeaves]);

  if (!enabled) return null;
  // Same override as the claim's own check (services/link-approval.ts).
  if (LEGACY_CONFIG) return 'approved';
  if (!hasAllLabels) return 'unknown';
  // Leaves for another chain say nothing about this link.
  if (!associationSetLeavesReady || leavesChainId !== chainId) return null;
  if (hashed?.key !== labelsKey) return null;
  const decisions = blockedLabelHashes !== undefined ? feedData(decisionsFeed) : undefined;
  return classifyLinkApproval({
    labelHashes: hashed.hashes,
    approved,
    decisions: decisions
      ? { rejected: new Set(decisions.rejected), poiRequired: new Set(decisions.poiRequired) }
      : null,
  });
}
