import { describe, expect, test } from 'bun:test';
import { passkeyUnlockDefault } from '@/services/passkey-policy';

const base = { enabled: true, isSmartWallet: true, hasKeyIdentity: false, supportedChain: true, hasAddress: true };

describe('passkeyUnlockDefault', () => {
  test('a connected smart-contract wallet on a supported chain unlocks with a passkey', () => {
    expect(passkeyUnlockDefault(base)).toBe(true);
  });
  test('an EOA never gets the passkey option', () => {
    expect(passkeyUnlockDefault({ ...base, isSmartWallet: false })).toBe(false);
  });
  test('an EOA that PROVED it signs non-deterministically gets the passkey', () => {
    // A hardware wallet that returns a different signature each time cannot
    // derive a stable account, so the signature path is a dead end for it.
    // That is the same predicament a contract wallet is in.
    expect(passkeyUnlockDefault({ ...base, isSmartWallet: false, signerRefusedDerivation: true })).toBe(true);
  });
  test('the refusal is observed, not assumed: absent or false changes nothing', () => {
    expect(passkeyUnlockDefault({ ...base, isSmartWallet: false, signerRefusedDerivation: false })).toBe(false);
    expect(passkeyUnlockDefault({ ...base, isSmartWallet: false })).toBe(false);
  });
  test('a refusal does not outrank the other gates', () => {
    const refused = { ...base, isSmartWallet: false, signerRefusedDerivation: true };
    expect(passkeyUnlockDefault({ ...refused, enabled: false })).toBe(false);
    expect(passkeyUnlockDefault({ ...refused, hasKeyIdentity: true })).toBe(false);
    expect(passkeyUnlockDefault({ ...refused, supportedChain: false })).toBe(false);
    expect(passkeyUnlockDefault({ ...refused, hasAddress: false })).toBe(false);
  });
  test('an account-key session, an unsupported chain, no wallet, or a disabled build never do', () => {
    expect(passkeyUnlockDefault({ ...base, hasKeyIdentity: true })).toBe(false);
    expect(passkeyUnlockDefault({ ...base, supportedChain: false })).toBe(false);
    expect(passkeyUnlockDefault({ ...base, hasAddress: false })).toBe(false);
    expect(passkeyUnlockDefault({ ...base, enabled: false })).toBe(false);
  });
});
