import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { relaunchReady } from '../deposit-relaunch';

const ok = { pending: { chainId: 1, gen: 3 }, currentGen: 3, chainId: 1, walletChainId: 1, keysReady: true, tokenCount: 2 };

describe('relaunchReady', () => {
  test('relaunches when nothing superseded it and everything is home and loaded', () => {
    expect(relaunchReady(ok)).toBe(true);
  });

  test('each missing condition waits', () => {
    expect(relaunchReady({ ...ok, pending: null })).toBe(false);
    expect(relaunchReady({ ...ok, currentGen: 4 })).toBe(false);
    expect(relaunchReady({ ...ok, chainId: 56 })).toBe(false);
    expect(relaunchReady({ ...ok, walletChainId: 56 })).toBe(false);
    expect(relaunchReady({ ...ok, walletChainId: undefined })).toBe(false);
    expect(relaunchReady({ ...ok, keysReady: false })).toBe(false);
    expect(relaunchReady({ ...ok, tokenCount: 0 })).toBe(false);
  });
});

describe('a landed registration that did not come home is reported', () => {
  test('the registration modal tells the caller it registered, and the deposit says what to do', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
    expect(read('components/keystore-registration-modal-provider.tsx')).toContain('else runOnCancel?.({ registered: true });');
    const deposit = read('components/deposit-modal-provider.tsx');
    expect(deposit).toContain('onCancel: ({ registered }) => {');
    expect(deposit).toContain('if (registered && crossChainRegistration && inlineLaunchGenRef.current === handoffGen) {');
    expect(deposit).toContain('relaunchReady({');
  });
});
