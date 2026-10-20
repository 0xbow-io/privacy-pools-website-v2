import { expect, test } from 'bun:test';
import { isRangeDepthRefusal } from '../rpc-range-refusal';

// Every case is written as {text, expected} so the BASELINE is asserted before
// anything else is derived from it. The property test below then checks that
// wrapping cannot change a verdict — which is only meaningful because the bare
// verdict is pinned here first (codex: a row that matches neither list is
// false under every wrapper even with the bug present, and proves nothing).
const CASES: readonly { text: string; expected: boolean; why: string }[] = [
  // ── genuine range / size refusals ──────────────────────────────────────
  { text: 'eth_getLogs: block range too large, try with this block range [0x1, 0x3e8]', expected: true, why: 'range size' },
  { text: 'query returned more than 10000 results', expected: true, why: 'result size' },
  { text: 'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range', expected: true, why: 'result size' },
  // ── genuine pruning / archive depth ────────────────────────────────────
  { text: 'missing trie node 0xabc (path )', expected: true, why: 'pruned state' },
  { text: 'this historical state is not available on this endpoint; requires archive node', expected: true, why: 'archive depth' },
  { text: 'archive data not available', expected: true, why: 'archive depth' },
  { text: 'HTTP request failed. Status: 403. Details: Archive requests require a personal token.', expected: true, why: 'archive depth, Matthew PR #43' },
  // A transport word wearing an explicit range reason. Deny-first must not
  // swallow it, which bare 'aborted' used to do.
  { text: 'query aborted because block range is too large', expected: true, why: 'explicit range beats a vague transport word' },

  // ── transport and throttling: never a depth refusal ────────────────────
  { text: 'The request timed out.', expected: false, why: 'transport' },
  { text: 'rate limit exceeded', expected: false, why: 'throttle' },
  { text: 'rate limit exceeded for this block range', expected: false, why: 'a throttle that names a range is still a throttle' },
  { text: 'Too Many Requests', expected: false, why: 'throttle' },
  { text: 'fetch failed', expected: false, why: 'transport' },
  { text: 'socket hang up', expected: false, why: 'transport' },
  { text: 'ECONNRESET', expected: false, why: 'transport' },
  { text: 'The operation was aborted', expected: false, why: 'transport abort' },
  // Deny-first is load-bearing here and nowhere else: a throttle that helpfully
  // suggests a smaller range matches an ALLOW phrase, and only the deny-list
  // stops it buying a coverage gap.
  { text: 'rate limit exceeded. try with this block range [0x1, 0x3e8]', expected: false, why: 'a throttle wins even when it names a range' },

  // ── ordinary failures that USED to be read as refusals ─────────────────
  // Each of these is a false positive the flat signatures produced, and a
  // false positive is the expensive direction: it buys a shallower re-scan
  // and a silently incomplete index (codex, 2026-09-15).
  { text: 'invalid block range: fromBlock must not exceed toBlock', expected: false, why: 'bad parameters, not depth' },
  { text: 'request frequency exceeds the maximum allowed', expected: false, why: 'a throttle that never says "rate limit"' },
  { text: 'HTTP request failed. Status: 500. URL: https://archive-rpc.example/v1', expected: false, why: 'the word archive in a HOSTNAME' },
  // A lagging or forked backend says these about a block that is too NEW.
  // Retrying shallower would not help and would hide the gap.
  { text: 'header not found', expected: false, why: 'ambiguous: lagging backend, not necessarily pruning' },
  { text: 'block not found', expected: false, why: 'ambiguous: future block on a lagging backend' },

  // ── matches nothing ────────────────────────────────────────────────────
  { text: 'Unexpected token < in JSON at position 0', expected: false, why: 'decode failure' },
  { text: '', expected: false, why: 'nothing to judge' },
];

test('each reason is classified on its own merits', () => {
  for (const { text, expected, why } of CASES) {
    expect({ text, why, verdict: isRangeDepthRefusal(new Error(text)) }).toEqual({ text, why, verdict: expected });
  }
});

// THE INVARIANT, and the reason this module had a live bug within hours of
// shipping: a layer above the provider wraps the message, and the wrapper's own
// words landed in the deny-list. "Event log fetch failed:" contains "fetch
// failed", so EVERY wrapped error read as a transport failure and the fail-soft
// fallback was dead for the exact case it exists for.
//
// Enumerating shapes did not catch it. This property does.
test('wrapping a reason never changes the verdict on it', () => {
  const WRAPPERS = [
    (r: string) => `Event log fetch failed: ${r}`,
    (r: string) => `Contract call failed: Event log fetch failed: ${r}`,
    (r: string) => `RPC Request failed. ${r}`,
    (r: string) => `Contract call failed: ${r}`,
  ];
  for (const { text, expected, why } of CASES) {
    if (text === '') continue;
    for (const wrap of WRAPPERS) {
      expect({ text: wrap(text), why, verdict: isRangeDepthRefusal(new Error(wrap(text))) })
        .toEqual({ text: wrap(text), why, verdict: expected });
    }
    // And through a nested cause, which is how viem actually delivers it.
    expect(isRangeDepthRefusal(Object.assign(new Error('Contract call failed'), {
      cause: new Error(`Event log fetch failed: ${text}`),
    }))).toBe(expected);
  }
});

// A wrapper must be removed only where it is a WRAPPER. Replacing it globally
// spliced the seam: `block<wrapper>range` became `block range` and manufactured
// a signature that was never in the text (codex, 2026-09-15).
// A wrapper is removed only where it IS a wrapper — at the start of a field.
// A global replace splices the seam: with no spaces around it, `block<wrapper>
// range` collapses to `block range` and manufactures an ALLOW signature that
// was never in the text. (Written without surrounding spaces on purpose: with
// them, a space-replacement leaves a double space that matches nothing, and the
// test would pass against the broken implementation.)
test('a mid-string wrapper is not removed, so no signature is manufactured', () => {
  expect(isRangeDepthRefusal(new Error('blockEvent log fetch failed:range too large'))).toBe(false);
  expect(isRangeDepthRefusal(new Error('missing trieContract call failed:node 0xabc'))).toBe(false);
  // Both at once, which is what actually separates "strip the leading wrapper"
  // from "replace every occurrence": with a leading wrapper present, a global
  // replace also eats the mid-string one and splices `block` to `range too
  // large`. Leading-only leaves that seam alone and the text stays a transport
  // failure.
  expect(isRangeDepthRefusal(new Error('Event log fetch failed: blockEvent log fetch failed:range too large'))).toBe(false);
});

// Fields are joined with a newline, not a space, so a phrase cannot be formed
// across the boundary between two of them. Neither half matches alone.
test('a signature cannot be formed across the join between two fields', () => {
  const split = Object.assign(new Error('node 0xabc (path )'), { shortMessage: 'missing trie' });
  expect(isRangeDepthRefusal(split)).toBe(false);
  const splitCause = Object.assign(new Error('block'), { cause: new Error('range too large') });
  // The cause half DOES match on its own, so this one must stay true — the
  // join rule must not suppress a real signature either.
  expect(isRangeDepthRefusal(splitCause)).toBe(true);
});

test('the provider text is found through viem nesting', () => {
  const nested = Object.assign(new Error('HTTP request failed.'), {
    shortMessage: 'HTTP request failed.',
    cause: Object.assign(new Error('RPC Request failed'), {
      details: 'query returned more than 10000 results',
    }),
  });
  expect(isRangeDepthRefusal(nested)).toBe(true);
});

test('non-Error rejections do not crash the predicate', () => {
  expect(isRangeDepthRefusal(undefined)).toBe(false);
  expect(isRangeDepthRefusal(null)).toBe(false);
  expect(isRangeDepthRefusal('block range too large')).toBe(true);
  expect(isRangeDepthRefusal({ cause: { message: 'pruned' } })).toBe(true);
});

// This runs inside a catch. If it throws, it replaces the caller's real error
// with a confusing one from the classifier — and a getter or a proxy trap can
// throw (codex, 2026-09-15). "Not a refusal" is the safe answer: it propagates
// the original.
test('a throwing getter or a hostile proxy cannot make the classifier throw', () => {
  const hostile = {} as Record<string, unknown>;
  Object.defineProperty(hostile, 'message', { get() { throw new Error('boom'); }, enumerable: true });
  expect(isRangeDepthRefusal(hostile)).toBe(false);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  expect(isRangeDepthRefusal(revoked.proxy)).toBe(false);

  const trap = new Proxy({}, { get() { throw new Error('trap'); } });
  expect(isRangeDepthRefusal(trap)).toBe(false);

  // A cause cycle must terminate rather than recurse forever.
  const cyclic: Record<string, unknown> = { message: 'block range too large' };
  cyclic.cause = cyclic;
  expect(isRangeDepthRefusal(cyclic)).toBe(true);
});
