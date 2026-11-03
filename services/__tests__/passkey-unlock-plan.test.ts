import { describe, expect, test } from 'bun:test';
import { discoverablePickVerdict, ownerFromPasskeyHandle, passkeyDisplayName, passkeyOwnerHandle } from '@/services/passkey-unlock-plan';
import {
  normalizePasskeyPick,
  passkeyNotUsedMessage,
  passkeySecondaryChoice,
  resolvePasskeyUnlockPlan,
  PASSKEY_ANOTHER_NOT_USED_MESSAGE,
  PASSKEY_DISCOVERABLE_NOT_USED_MESSAGE,
  PASSKEY_TARGETED_NOT_USED_MESSAGE,
} from '@/services/passkey-unlock-plan';

describe('resolvePasskeyUnlockPlan', () => {
  test('a remembered passkey is a targeted sign-in, as before', () => {
    expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: 'abc' })).toEqual({ kind: 'targeted', credentialId: 'abc' });
  });
  test('"Use another passkey" lists every passkey even when one is remembered', () => {
    expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: 'abc', pick: 'any' })).toEqual({ kind: 'discoverable' });
    expect(resolvePasskeyUnlockPlan({ pick: 'any' })).toEqual({ kind: 'discoverable' });
  });
  test('nothing remembered never creates on its own: it offers the existing passkeys', () => {
    expect(resolvePasskeyUnlockPlan({})).toEqual({ kind: 'discoverable' });
    expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: null })).toEqual({ kind: 'discoverable' });
    expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: '' })).toEqual({ kind: 'discoverable' });
  });
  test('create runs only when the user asked for it and nothing is remembered', () => {
    expect(resolvePasskeyUnlockPlan({ pick: 'create' })).toEqual({ kind: 'create' });
  });
  test('create never mints a second credential while one is remembered', () => {
    expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: 'abc', pick: 'create' })).toEqual({ kind: 'targeted', credentialId: 'abc' });
  });
  test('a stray argument (a press event, a typo) is no pick', () => {
    expect(normalizePasskeyPick({ nativeEvent: {} })).toBeUndefined();
    expect(normalizePasskeyPick('Create')).toBeUndefined();
    expect(resolvePasskeyUnlockPlan({ pick: { type: 'press' } })).toEqual({ kind: 'discoverable' });
    expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: 'abc', pick: 'other' })).toEqual({ kind: 'targeted', credentialId: 'abc' });
  });
});

describe('passkeyNotUsedMessage', () => {
  test('a failed targeted prompt points at Use another passkey', () => {
    expect(passkeyNotUsedMessage({ kind: 'targeted', credentialId: 'abc' }, true)).toBe(PASSKEY_TARGETED_NOT_USED_MESSAGE);
    expect(PASSKEY_TARGETED_NOT_USED_MESSAGE).toContain('Use another passkey');
  });
  test('a failed discoverable prompt points at the choice the dialog shows', () => {
    expect(passkeyNotUsedMessage({ kind: 'discoverable' }, true)).toBe(PASSKEY_ANOTHER_NOT_USED_MESSAGE);
    expect(passkeyNotUsedMessage({ kind: 'discoverable' }, false)).toBe(PASSKEY_DISCOVERABLE_NOT_USED_MESSAGE);
    expect(PASSKEY_DISCOVERABLE_NOT_USED_MESSAGE).toContain('Create a passkey');
  });
  test('copy has no em dashes', () => {
    for (const m of [PASSKEY_TARGETED_NOT_USED_MESSAGE, PASSKEY_ANOTHER_NOT_USED_MESSAGE, PASSKEY_DISCOVERABLE_NOT_USED_MESSAGE]) {
      expect(m).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe('passkeySecondaryChoice', () => {
  test('remembered: switch passkeys; none remembered: create one', () => {
    expect(passkeySecondaryChoice(true)).toEqual({ pick: 'any', label: 'Use another passkey' });
    expect(passkeySecondaryChoice(false)).toEqual({ pick: 'create', label: 'Create a passkey' });
  });
  test('every secondary choice resolves to the ceremony its label names', () => {
    expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: 'abc', pick: passkeySecondaryChoice(true).pick }).kind).toBe('discoverable');
    expect(resolvePasskeyUnlockPlan({ pick: passkeySecondaryChoice(false).pick }).kind).toBe('create');
  });
});


const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

describe('a discoverable pick must belong to this wallet (review on PR #63)', () => {
  test('a new passkey names its owner in the handle', () => {
    expect(ownerFromPasskeyHandle(passkeyOwnerHandle(A.toUpperCase().replace('0X', '0x')))).toBe(A);
    expect(ownerFromPasskeyHandle(new Uint8Array(16).fill(7))).toBeNull();
    expect(ownerFromPasskeyHandle(null)).toBeNull();
    expect(passkeyDisplayName(A)).toBe('Privacy Pools 0x1111…1111');
  });
  test('another wallet\'s passkey is refused whatever the chain says', () => {
    expect(discoverablePickVerdict({ ownerAddress: B, userHandle: passkeyOwnerHandle(A), identityStatus: 'unregistered' })).toBe('wrong-wallet');
    expect(discoverablePickVerdict({ ownerAddress: B, userHandle: passkeyOwnerHandle(A), identityStatus: 'compatible' })).toBe('wrong-wallet');
    expect(discoverablePickVerdict({ ownerAddress: A, userHandle: passkeyOwnerHandle(A), identityStatus: 'unregistered' })).toBe('accept');
  });
  test('an older passkey is kept only when this wallet is registered with exactly its keys', () => {
    const legacy = new Uint8Array(16).fill(3);
    expect(discoverablePickVerdict({ ownerAddress: A, userHandle: legacy, identityStatus: 'compatible' })).toBe('accept');
    expect(discoverablePickVerdict({ ownerAddress: A, userHandle: legacy, identityStatus: 'partial' })).toBe('accept');
    for (const s of ['unregistered', 'incompatible', 'unknown']) {
      expect(discoverablePickVerdict({ ownerAddress: A, userHandle: legacy, identityStatus: s })).toBe('unproven');
    }
  });
});
