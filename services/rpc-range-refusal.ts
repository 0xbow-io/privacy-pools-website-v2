/**
 * "The provider refused this block range" — told apart from every other way an
 * RPC read can fail.
 *
 * WHY THIS IS ITS OWN MODULE: services/onchain-note-index.ts falls back to a
 * shallower scan when a deep historical read is refused, and that fallback
 * KNOWINGLY leaves a gap in coverage. That is the right trade for a pruning
 * provider, and the wrong one for a timeout: a transient failure would make the
 * retry succeed while silently skipping blocks, and the index it publishes then
 * answers `isNullifierSpent` false for a nullifier that was spent in the gap.
 *
 * SO THE DANGEROUS DIRECTION IS A FALSE POSITIVE. Saying "refused" about an
 * ordinary failure buys a coverage gap; saying "not refused" about a real
 * refusal only fails the build, which is loud and safe. Every judgement call
 * below is resolved that way, which is why the signatures are phrases rather
 * than words: bare 'archive' matched `https://archive-rpc.example` in a 500,
 * bare 'block range' matched `invalid block range: fromBlock must not exceed
 * toBlock`, and bare 'exceeds the maximum' matched a throttle that never says
 * 'rate limit' (codex, 2026-09-15).
 *
 * Pure, no imports: bun tests import it directly.
 */

/**
 * Phrases that mean a range was too deep, too wide, or pruned away.
 *
 * Each one must be unusable as a fragment of an ordinary error. That is the
 * whole selection rule: if a phrase could appear in a 500, a bad-parameter
 * rejection or a throttle, it does not belong here, because the cost of being
 * wrong is a silently incomplete note index.
 */
const REFUSAL_SIGNATURES: readonly string[] = [
  // Range size.
  'block range too large',
  'block range is too large',
  'range is too large',
  'range too large',
  'too many blocks',
  'exceeds the maximum block range',
  'exceed maximum block range',
  'try with this block range',
  // Result size — the range is more than the provider will serve at once.
  'query returned more than',
  'log response size exceeded',
  'response size exceeded',
  // Pruning and archive depth.
  'missing trie node',
  'state is not available',
  'is not available on this endpoint',
  'archive requests require',
  'archive data not available',
  'archive state required',
  'archive node required',
  'requires archive',
  'requires an archive',
  'pruned',
  'cannot query unfinalized',
];

/**
 * Text added by layers ABOVE the provider, removed before either list is
 * consulted — and only from the START of a field, never mid-string.
 *
 * THE BUG THIS EXISTS FOR (Matthew, 2026-09-15, hours after this module
 * shipped): the SDK prefixes every log error with "Event log fetch failed:",
 * and that phrase CONTAINS "fetch failed", a transport signature below. So
 * every wrapped error — including a genuine archive or block-range refusal —
 * read as a transport failure and was rethrown, which disabled the fail-soft
 * fallback for exactly the case it was written for.
 *
 * Leading-only, because a global replace splices seams: `block<wrapper>range`
 * would become `block range` and manufacture a signature that was never there
 * (codex, 2026-09-15).
 */
const WRAPPER_PREFIXES: readonly string[] = [
  'event log fetch failed:',
  'contract call failed:',
  'rpc request failed.',
  'rpc request failed:',
];

/**
 * Transport and throttling failures. These WIN over the list above for the
 * unambiguous cases: a rate limit is not evidence about depth, however it is
 * phrased.
 *
 * Deliberately specific. Bare 'aborted' denied `query aborted because block
 * range is too large`, which is an explicit range refusal wearing a transport
 * word (codex, 2026-09-15).
 */
const NEVER_A_REFUSAL: readonly string[] = [
  'rate limit',
  'too many requests',
  'request timed out',
  'fetch failed',
  'socket hang up',
  'econnreset',
  'econnrefused',
  'network error',
  'aborterror',
  'request aborted',
  'operation was aborted',
];

function stripWrappers(value: string): string {
  let text = value.trim();
  // A chain: "Contract call failed: Event log fetch failed: <reason>".
  for (let i = 0; i < WRAPPER_PREFIXES.length * 2; i += 1) {
    const wrapper = WRAPPER_PREFIXES.find((prefix) => text.startsWith(prefix));
    if (!wrapper) break;
    text = text.slice(wrapper.length).trim();
  }
  return text;
}

/** message / shortMessage / details / cause, to a bounded depth. */
function partsOf(error: unknown, depth = 0): string[] {
  if (depth > 4 || error == null) return [];
  if (typeof error === 'string') return [error];
  if (typeof error !== 'object') return [String(error)];
  const e = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['shortMessage', 'details', 'message', 'reason', 'name'] as const) {
    const value = e[key];
    if (typeof value === 'string') parts.push(value);
  }
  parts.push(...partsOf(e.cause, depth + 1));
  return parts;
}

/**
 * Never throws. This runs inside a `catch`, so an exception here would replace
 * the caller's real error with a confusing one from the classifier — and a
 * getter or proxy trap on `message` can throw (codex, 2026-09-15). Any failure
 * reads as "not a refusal", which propagates the original error: the safe
 * direction.
 */
export function isRangeDepthRefusal(error: unknown): boolean {
  try {
    // Wrappers are stripped PER FIELD, then joined with a newline so no phrase
    // can be formed across the seam between two fields.
    const text = partsOf(error)
      .map((part) => stripWrappers(part.toLowerCase()))
      .join('\n');
    if (text.trim() === '') return false;
    if (NEVER_A_REFUSAL.some((signature) => text.includes(signature))) return false;
    return REFUSAL_SIGNATURES.some((signature) => text.includes(signature));
  } catch {
    return false;
  }
}
