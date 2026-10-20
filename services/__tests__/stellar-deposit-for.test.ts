// Stellar deposit-for: the recipient field takes a Stellar account (checksum
// checked, so a typo is refused in the form), and the vendored Stellar SDK's
// own address schema (what prepareDepositFor validates the recipient with on
// Stellar) agrees with it.
import { describe, expect, test } from 'bun:test';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

import { isStellarAccountAddress } from '@/services/stellar/stellar-request';

// A real testnet account (valid checksum) and a one-character typo of it.
const ACCOUNT = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR';
const TYPO = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSA';

describe('Stellar deposit-for recipient', () => {
  test('the field accepts a G account and refuses typos, EVM and lowercased input', () => {
    expect(isStellarAccountAddress(ACCOUNT)).toBe(true);
    expect(isStellarAccountAddress(TYPO)).toBe(false);
    expect(isStellarAccountAddress(ACCOUNT.toLowerCase())).toBe(false);
    expect(isStellarAccountAddress('0x' + '1'.repeat(40))).toBe(false);
    expect(isStellarAccountAddress(`G${'A'.repeat(55)}`)).toBe(false);
    expect(isStellarAccountAddress('')).toBe(false);
  });

  test('agrees with the Stellar SDK checksum on random accounts and their typos', () => {
    for (let i = 0; i < 50; i++) {
      const key = Keypair.random().publicKey();
      expect(isStellarAccountAddress(key)).toBe(true);
      const at = 1 + (i % 55);
      const typo = key.slice(0, at) + (key[at] === 'A' ? 'B' : 'A') + key.slice(at + 1);
      expect(isStellarAccountAddress(typo)).toBe(StrKey.isValidEd25519PublicKey(typo));
    }
  });

  test('the SDK schema and the pool session deposit-for agree', async () => {
    const sdk = await import('@privacy-pools-v2/stellar-sdk');
    expect(sdk.StellarAddressSchema.safeParse(ACCOUNT).success).toBe(true);
    expect(sdk.StellarAddressSchema.safeParse(TYPO).success).toBe(false);
    expect(typeof sdk.PoolSession.prototype.prepareDepositFor).toBe('function');
    expect(typeof sdk.PoolSessionDeposit.prototype.prepareDepositFor).toBe('function');
  });
});
