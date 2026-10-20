import { describe, expect, test } from 'bun:test';

import { checkWalletScreening } from '../wallet-screening';

const ADDRESS = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0';

describe('checkWalletScreening', () => {
  test('signs the ASP message verbatim and posts the proof for the same address', async () => {
    const calls: unknown[] = [];
    const result = await checkWalletScreening(ADDRESS, {
      getNonce: async (address) => {
        calls.push(['nonce', address]);
        return { nonce: 'abc', message: 'privacypools.com wants you to sign in', expiresAt: '' };
      },
      signMessage: async (message) => {
        calls.push(['sign', message]);
        return '0xsig';
      },
      check: async (body) => {
        calls.push(['check', body]);
        return { denied: true };
      },
    });
    expect(result).toEqual({ denied: true });
    expect(calls).toEqual([
      ['nonce', ADDRESS],
      ['sign', 'privacypools.com wants you to sign in'],
      ['check', { address: ADDRESS, nonce: 'abc', message: 'privacypools.com wants you to sign in', signature: '0xsig' }],
    ]);
  });

  test('a refused signature never reaches the check', async () => {
    let checked = false;
    await expect(checkWalletScreening(ADDRESS, {
      getNonce: async () => ({ nonce: 'abc', message: 'm', expiresAt: '' }),
      signMessage: async () => { throw new Error('User rejected the request'); },
      check: async () => { checked = true; return { denied: false }; },
    })).rejects.toThrow('User rejected');
    expect(checked).toBe(false);
  });

  test('a malformed answer is an error, not a pass', async () => {
    await expect(checkWalletScreening(ADDRESS, {
      getNonce: async () => ({ nonce: 'abc', message: 'm', expiresAt: '' }),
      signMessage: async () => '0xsig',
      check: async () => ({}) as never,
    })).rejects.toThrow('Unexpected screening response');
  });
});
