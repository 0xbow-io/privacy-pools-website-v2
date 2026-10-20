import { describe, expect, test } from 'bun:test';

import { isRelayerRateLimited, isRelayerUnreachable, relayerRateLimitedMessage } from '@/services/transfer-outcome';

// The exact text the SDK raised on prod (Mike's recording, 2026-10-01).
const THROTTLED = 'All configured relayers failed to quote: Fast Relay: HTTP 429: {"statusCode":429,"message":"ThrottlerException: Too Many Requests"}';

describe('relayer rate limit', () => {
  test('a 429 from the relayer is a rate limit, not an outage', () => {
    expect(isRelayerRateLimited(THROTTLED)).toBe(true);
    // Both match, which is why callers must check the rate limit first.
    expect(isRelayerUnreachable(THROTTLED)).toBe(true);
  });

  test('an unreachable relayer is not a rate limit', () => {
    expect(isRelayerRateLimited('All configured relayers failed to quote: 0xbow Relayer: Failed to fetch')).toBe(false);
    expect(isRelayerRateLimited('Relayer returned 4290 units')).toBe(false);
  });

  test('the copy says nothing was sent and to wait', () => {
    const copy = relayerRateLimitedMessage('transfer');
    expect(copy).toContain('rate limiting');
    expect(copy).toContain('was not sent');
    expect(copy).not.toContain('—');
  });
});
