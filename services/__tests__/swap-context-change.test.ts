// The swap form's reset notice (services/swap-context-change.ts): a toast that
// says what moved where, instead of the old red "Network or account changed".
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeSwapContextChange } from '@/services/swap-context-change';

const names: Record<number, string> = { 1: 'Ethereum', 56: 'BNB Chain' };
const name = (id: number) => names[id] ?? `chain ${id}`;
const ctx = (chainId: number, sessionChainId = chainId, noteIdentity = '0xa') => ({ chainId, sessionChainId, noteIdentity });

describe('describeSwapContextChange', () => {
  test('an app network change names both networks', () => {
    expect(describeSwapContextChange(ctx(1), ctx(56), name)).toBe('Network changed from Ethereum to BNB Chain. The swap form was reset.');
  });

  test('a wallet-only move names the wallet networks', () => {
    expect(describeSwapContextChange(ctx(1, 1), ctx(1, 56), name)).toBe('Your wallet moved from Ethereum to BNB Chain. The swap form was reset.');
  });

  test('a network and account change together says both', () => {
    expect(describeSwapContextChange(ctx(1, 1, '0xa'), ctx(56, 56, '0xb'), name)).toBe(
      'Network changed from Ethereum to BNB Chain and the account changed. The swap form was reset.',
    );
  });

  test('an account change says so', () => {
    expect(describeSwapContextChange(ctx(1, 1, '0xa'), ctx(1, 1, '0xb'), name)).toBe('Account changed. The swap form was reset.');
  });

  test('no em dashes in the copy', () => {
    for (const text of [describeSwapContextChange(ctx(1), ctx(56), name), describeSwapContextChange(ctx(1), ctx(1, 56), name), describeSwapContextChange(ctx(1), ctx(1, 1, '0xb'), name)]) {
      expect(text).not.toContain('—');
    }
  });
});

test('the swap modal toasts the change instead of setting the red form error', () => {
  const src = readFileSync(join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'swap-modal-provider.tsx'), 'utf8');
  expect(src).not.toContain('Network or account changed. The form was reset for the new context.');
  expect(src).toMatch(/title: describeSwapContextChange\(prev, next,/);
  expect(src).toMatch(/variant: 'warning',/);
});
