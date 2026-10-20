import { afterEach, describe, expect, test } from 'bun:test';
import { smartWalletPasskeyEnabled } from '../../config/smart-wallet-passkey-flag';

const g = globalThis as { window?: unknown };
const hadWindow = 'window' in g;
const prevEnv = process.env.EXPO_PUBLIC_PASSKEY_PREVIEW;

afterEach(() => {
  if (!hadWindow) delete g.window;
  if (prevEnv === undefined) delete process.env.EXPO_PUBLIC_PASSKEY_PREVIEW;
  else process.env.EXPO_PUBLIC_PASSKEY_PREVIEW = prevEnv;
});

describe('smart-wallet passkey unlock', () => {
  test('on by default in the browser, with no URL flag', () => {
    g.window = g.window ?? {};
    delete process.env.EXPO_PUBLIC_PASSKEY_PREVIEW;
    expect(smartWalletPasskeyEnabled()).toBe(true);
  });
  test('EXPO_PUBLIC_PASSKEY_PREVIEW=0 still turns it off for a build', () => {
    g.window = g.window ?? {};
    process.env.EXPO_PUBLIC_PASSKEY_PREVIEW = '0';
    expect(smartWalletPasskeyEnabled()).toBe(false);
  });
});
