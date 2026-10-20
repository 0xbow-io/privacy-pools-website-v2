/**
 * The ASP's label decisions, read off the public-feed grid instead of fetched
 * when someone spends.
 *
 * WHY: `buildTransactWitness` used to call the decision routes with
 * `forceFresh`, so every withdraw, transfer and swap exit put two ASP requests
 * on the wire immediately before its relayed transaction. The payload is
 * pool-wide and says nothing about the caller, but the TRIGGER is the spend,
 * and when a request happens is part of what it reveals — the whole reason
 * services/public-feed-scheduler.ts exists.
 *
 * WHAT IS LOST, STATED PLAINLY: the answer used to be 0ms old at proof time.
 * Now it is at most one grid period old in the normal case. A label rejected
 * five seconds before a spend is honoured up to a tick later than it was. That
 * is acceptable because this check is a courtesy — it stops the user burning a
 * proof the ASP and relayer would refuse anyway — and because what replaces it
 * is strictly stronger in the direction that matters: a snapshot older than a
 * hard bound refuses to build the witness at all, where the old code silently
 * accepted a five-second-stale cache hit.
 *
 * Pure module, no imports beyond a type: bun tests import it directly.
 */
import type { FeedState } from '@/services/public-feed-scheduler';

export const feedLabelDecisions = (chainId: number | string) => `label-decisions:${chainId}`;

export type LabelDecisions = {
  rejected: readonly string[];
  poiRequired: readonly string[];
  entrypoint: string | null;
};

/**
 * Grid period. The two payloads measured 411 and 13 bytes on prod, but they
 * are two requests per chain per tick, which made them the largest share of
 * an idle tab's ASP traffic at 30s (12 of ~58 requests a minute on 2026-10-01).
 * They only gate spendability. Two minutes since 7 chains went live
 * (2026-10-15: 14 requests a minute at one minute): three ticks inside
 * LABEL_DECISIONS_MAX_AGE_MS, so one or two failed ticks still leave a usable
 * snapshot.
 */
export const LABEL_DECISIONS_INTERVAL_MS = 120_000;

/**
 * How stale a decision snapshot may be and still authorise a spend. Three
 * ticks: long enough to ride out a blip, short enough that a client whose feed
 * has genuinely stopped refuses rather than proving against old decisions.
 */
export const LABEL_DECISIONS_MAX_AGE_MS = 360_000;

export type LabelDecisionRead =
  | { ok: true; decisions: LabelDecisions; ageMs: number }
  | { ok: false; reason: 'missing' | 'stale'; ageMs: number | null };

/**
 * Read a decision snapshot, or say why it cannot be used. Never returns an
 * empty set for "don't know": an empty set means "nothing is blocked", which is
 * the one answer that must never be guessed.
 */
export function readLabelDecisions(
  state: FeedState<LabelDecisions>,
  now: number,
  maxAgeMs: number = LABEL_DECISIONS_MAX_AGE_MS,
): LabelDecisionRead {
  // An errored refresh keeps serving the last good value the scheduler held, so
  // a single failed tick does not stop the user spending — but it ages, and
  // once it is past the bound it stops being an answer.
  const data = state.status === 'ready' ? state.data : state.status === 'error' ? state.data : undefined;
  const at = state.status === 'ready' ? state.at : state.status === 'error' ? state.dataAt : undefined;
  if (!data || at === undefined) return { ok: false, reason: 'missing', ageMs: null };
  const ageMs = now - at;
  if (ageMs >= maxAgeMs) return { ok: false, reason: 'stale', ageMs };
  return { ok: true, decisions: data, ageMs };
}
