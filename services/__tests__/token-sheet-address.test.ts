import { describe, expect, test } from 'bun:test';
import { isListedTokenAddressOnChain } from '@/services/token-sheet-address';

describe('token sheet address identity', () => {
  test('a listed address on another chain does not block a custom token lookup', () => {
    const tokens = [{ address: '0xABC', chainId: 1 }];
    expect(isListedTokenAddressOnChain(tokens, '0xabc', 8453, 1)).toBe(false);
    expect(isListedTokenAddressOnChain(tokens, '0xabc', 1, 1)).toBe(true);
  });

  test('a row without a chain belongs to the sheet fallback chain', () => {
    const tokens = [{ address: '0xABC' }];
    expect(isListedTokenAddressOnChain(tokens, '0xabc', 1, 1)).toBe(true);
    expect(isListedTokenAddressOnChain(tokens, '0xabc', 8453, 1)).toBe(false);
  });
});
