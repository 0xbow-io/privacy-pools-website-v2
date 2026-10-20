import { useEffect, useRef, useState } from 'react';
import { usePoolSession } from '@/hooks/use-pool-session';
import {
  buildLeafGateNotesKey,
  confirmSpendableCommitments,
  failedLeafGate,
  LOADING_GATE,
  resolveLeafGateForInputs,
  type GateNote,
  type LeafGate,
  type LeafGateResolution,
} from '@/services/leaf-gate';

/**
 * The one association-set gate every surface reads.
 *
 * Both the balance surfaces and the withdraw flow used to compute this
 * separately — and, worse, from DIFFERENT SOURCES: the hub hashed against the
 * session's `associationSetLeaves`, while the withdraw modal fired its own
 * `aspClient.getAssociationSetLeaves()` on every notes change. Two fetches at
 * two moments could report two different truths on one screen, which is what
 * produced the contradicting balance figures (see services/leaf-gate.ts).
 *
 * This hook takes the SESSION's leaves as the single source. They are already
 * fetched, cached and shared, so this also removes the withdraw modal's
 * duplicate download of the whole set (376 KB at last measure) on every notes
 * change.
 *
 * Consumers apply their own policy to `status` — fail-open for display,
 * fail-closed for spending — via the helpers in services/leaf-gate.ts.
 */
export function useLeafGate(
  notes: readonly GateNote[],
  options: { topologyKey?: string; enabled?: boolean } = {},
): LeafGate {
  const {
    associationSetLeaves,
    blockedLabelHashes,
    blockedLabelsError,
    associationSetLeavesReady,
    associationSetLeavesScopeKey,
    associationSetLeavesError,
  } = usePoolSession();
  const enabled = options.enabled ?? true;
  // Content, not array identity, drives the work. `topologyKey` adds consumer
  // scope (withdraw's chain/session/status key); it never replaces the note key.
  const computationKey = JSON.stringify([
    associationSetLeavesScopeKey,
    blockedLabelHashes,
    options.topologyKey ?? '',
    buildLeafGateNotesKey(notes),
  ]);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const [resolution, setResolution] = useState<LeafGateResolution | null>(null);

  const error = associationSetLeavesError ?? blockedLabelsError;
  const ready = associationSetLeavesReady && blockedLabelHashes !== undefined;
  const gate = !enabled
    ? LOADING_GATE
    : error
      ? failedLeafGate(error)
      : !ready
        ? LOADING_GATE
        : resolveLeafGateForInputs(resolution, computationKey, associationSetLeaves);

  useEffect(() => {
    // Not loaded yet: 'loading', NOT "nothing is spendable". The distinction is
    // the whole point — display trusts ACTIVE here, spending does not.
    if (!enabled || error || !ready) return;
    // An empty set or no notes confirms nothing. Neither needs a hash service,
    // but both still wait for the verified public set above.
    if (associationSetLeaves.length === 0 || notesRef.current.length === 0) {
      setResolution({
        key: computationKey,
        leaves: associationSetLeaves,
        gate: { status: 'ready', confirmed: new Set<string>() },
      });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { createHashService } = await import('@/services/sdk-runtime');
        const hashService = await createHashService();
        if (cancelled) return;
        const confirmed = confirmSpendableCommitments({
          notes: notesRef.current,
          leaves: associationSetLeaves,
          blockedLabelHashes,
          hashLabel: (label) => String(hashService.hash([label as `0x${string}`])),
        });
        if (!cancelled) {
          setResolution({
            key: computationKey,
            leaves: associationSetLeaves,
            gate: { status: 'ready', confirmed },
          });
        }
      } catch (error) {
        if (!cancelled) {
          setResolution({
            key: computationKey,
            leaves: associationSetLeaves,
            gate: failedLeafGate(error instanceof Error ? error.message : String(error)),
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, computationKey, associationSetLeaves, ready, error, blockedLabelHashes]);

  return gate;
}
