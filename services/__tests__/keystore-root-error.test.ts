import { describe, expect, test } from 'bun:test';
import { toFunctionSelector } from 'viem';
import { isUnknownKeystoreRoot, keystoreRootRefreshingMessage } from '../keystore-root-error';

describe('unknown keystore root copy', () => {
  test('recognises the relayer 400 dump, the bare name and the raw selector', () => {
    expect(isUnknownKeystoreRoot('HTTP 400 {"statusCode":400,"message":"PoolVault transact failed: reverted (PoolVault_UnknownKeystoreRoot)"}')).toBe(true);
    expect(isUnknownKeystoreRoot('execution reverted: PoolVault_UnknownKeystoreRoot()')).toBe(true);
    expect(isUnknownKeystoreRoot(`reverted with ${toFunctionSelector('error PoolVault_UnknownKeystoreRoot()')}`)).toBe(true);
    expect(isUnknownKeystoreRoot('PoolVault_NullifierAlreadySpent')).toBe(false);
  });

  test('user copy says retry, says exit for an exit, and names no internals', () => {
    for (const flow of ['withdrawal', 'exit', 'transfer'] as const) {
      const text = keystoreRootRefreshingMessage(flow);
      expect(text).toMatch(/refreshing/);
      expect(text).toMatch(/again in a minute/);
      expect(text).not.toMatch(/ragequit|asp|keystore|http|400|root|\u2014/i);
    }
    expect(keystoreRootRefreshingMessage('exit')).toContain('exit');
  });
});
