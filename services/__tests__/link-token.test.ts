import { describe, expect, test } from 'bun:test';

import { ENVIRONMENTS } from '@/config/environments';
import { linkAmountText, resolveLinkToken, unknownTokenLabel } from '@/services/link-token';

// The shipped registries, prod first, as a page on Prod sees them.
const ON_PROD = [ENVIRONMENTS.prod.tokensByChain, ENVIRONMENTS.staging.tokensByChain];
const OP_USDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';

describe('a link token from another environment (DEV-484)', () => {
  test('OP USDC opened on Prod is 6-decimal USDC, not 18-decimal "0X0B2C"', () => {
    const token = resolveLinkToken(OP_USDC, 10, ON_PROD);
    expect(token).toEqual({ known: true, symbol: 'USDC', decimals: 6 });
    expect(linkAmountText(3_000_000n, token)).toBe('3 USDC');
  });

  test('a token no environment knows shows no amount at all', () => {
    const token = resolveLinkToken('0x1234567890abcdef1234567890abcdef12345678', 10, ON_PROD);
    expect(token).toEqual({ known: false, label: 'Unknown token 0x1234…' });
    expect(linkAmountText(3_000_000n, token)).toBe('Unknown token 0x1234…');
  });

  test('the chain still scopes the lookup when it is known', () => {
    // OP USDC's address on Ethereum is not USDC.
    expect(resolveLinkToken(OP_USDC, 1, ON_PROD).known).toBe(false);
  });

  test('a legacy receipt with no chain searches every chain', () => {
    expect(resolveLinkToken(OP_USDC, undefined, ON_PROD)).toEqual({ known: true, symbol: 'USDC', decimals: 6 });
  });

  test('a chainless lookup that disagrees on decimals is unknown, not the first guess', () => {
    const addr = '0x00000000000000000000000000000000000000aa';
    const registries = [{ 1: { [addr]: { symbol: 'A', decimals: 6 } }, 56: { [addr]: { symbol: 'A', decimals: 18 } } }];
    expect(resolveLinkToken(addr, undefined, registries).known).toBe(false);
    expect(resolveLinkToken(addr, 56, registries)).toEqual({ known: true, symbol: 'A', decimals: 18 });
  });

  test('the unknown label is the address prefix, named as an address', () => {
    expect(unknownTokenLabel(OP_USDC)).toBe('Unknown token 0x0b2C…');
  });
});
