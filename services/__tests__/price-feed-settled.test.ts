import { expect, test } from 'bun:test';
import {
  PRICE_FEED_SETTLE_DEADLINE_MS,
  priceFeedsSettled,
  priceFeedsSettledBy,
  type PriceFeedStatus,
} from '@/services/price-feed-settled';

const S = (...statuses: PriceFeedStatus[]) => statuses;

test('THE BUG: a feed that answered with no prices is settled, not loading', () => {
  // This is the whole point. The dev ASP prices every Sepolia token at "0.00",
  // the merge drops non-positive rows, and the feed publishes a valid `{}`.
  // The old flag read that empty map as "still loading", the deposit modal's
  // auto-confirm waited on it, and a real payment never terminated.
  expect(priceFeedsSettled(S('ready'))).toBe(true);
  // Contents are irrelevant here by construction: this function never sees the
  // map, only the statuses, so an empty answer cannot be mistaken for silence.
});

test('nothing has run yet is the one case worth waiting on', () => {
  expect(priceFeedsSettled(S('empty'))).toBe(false);
  expect(priceFeedsSettled(S('empty', 'empty', 'empty'))).toBe(false);
});

test('an error is an answer: waiting cannot improve it', () => {
  expect(priceFeedsSettled(S('error'))).toBe(true);
  expect(priceFeedsSettled(S('empty', 'error'))).toBe(true);
});

test('ANY feed answering is enough, so one wedged chain cannot hold the UI', () => {
  expect(priceFeedsSettled(S('empty', 'empty', 'ready'))).toBe(true);
  // The maps are merged, so one chain answering already yields a usable map.
});

test('no feeds at all is settled, never an infinite wait', () => {
  expect(priceFeedsSettled([])).toBe(true);
});

test('the deadline bounds the wait when the scheduler never starts', () => {
  const never = S('empty', 'empty');
  expect(priceFeedsSettledBy(never, 0)).toBe(false);
  expect(priceFeedsSettledBy(never, PRICE_FEED_SETTLE_DEADLINE_MS - 1)).toBe(false);
  expect(priceFeedsSettledBy(never, PRICE_FEED_SETTLE_DEADLINE_MS)).toBe(true);
  // Past the deadline the caller's own no-price rule applies (for a deposit,
  // checkDepositCap fails closed with a message the user can see), which is a
  // refusal rather than a spinner that never ends.
});

test('an answer short-circuits the deadline', () => {
  expect(priceFeedsSettledBy(S('ready'), 0)).toBe(true);
});
