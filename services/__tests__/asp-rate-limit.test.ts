import { describe, expect, test } from 'bun:test';

import { isRateLimitError } from '@/services/rpc-log-chunking';

describe('isRateLimitError', () => {
  test('the ASP throttle: 403 with "Rate limit exceeded" (2026-09-25)', () => {
    expect(isRateLimitError(new Error('API request failed: 403 Forbidden: Rate limit exceeded (https://api-v2.0xbow.io/labels/rejected)'))).toBe(true);
  });

  test('a plain 429', () => {
    expect(isRateLimitError('API request failed: 429 Too Many Requests (https://api-v2.0xbow.io/association-set/leaves)')).toBe(true);
    expect(isRateLimitError('Fast Relay: HTTP 429: {"statusCode":429}')).toBe(true);
  });

  test('not a rate limit', () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError('API request failed: 403 Forbidden (https://api-v2.0xbow.io/x)')).toBe(false);
    expect(isRateLimitError('API request failed: 500 Internal Server Error (https://api-v2.0xbow.io/x?sinceBlock=26097429)')).toBe(false);
  });
});
