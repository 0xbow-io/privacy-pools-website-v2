import { describe, expect, test } from 'bun:test';
import { hkdfSync } from 'node:crypto';
import {
  bytesToHex,
  parseEther,
  parseTransaction,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  PASSKEY_EOA_HKDF_INFO_LABEL,
  PASSKEY_EOA_HKDF_SALT_LABEL,
  PASSKEY_EOA_PRF_SALT_LABEL,
  __observeSecretBuffersForTest,
  derivePasskeyEoaKey,
  passkeyEoaAddressFromKey,
  passkeyEoaPrfSalt,
} from '@/services/passkey-eoa/derivation';
import { createPasskeyEoaSigner, type PasskeyPrfRequest } from '@/services/passkey-eoa/signer';
import { PasskeyEoaError } from '@/services/passkey-eoa/errors';
import { passkeyEoaSignIn } from '@/services/passkey-eoa/sign-in';

// Fixed PRF vector: bytes 0x00..0x1f.
const vector = () => new Uint8Array(32).map((_, i) => i);
const VECTOR_ADDRESS = '0xE956DC965dfe5a11f9F67cF2a6C5B865FA67E3ae';

const allZero = (b: Uint8Array) => b.every((x) => x === 0);

/** A PRF source that hands out a fresh copy and remembers it, so the test can check it was wiped. */
function trackedPrf(make: () => Uint8Array) {
  const handed: Uint8Array[] = [];
  const request: PasskeyPrfRequest = async () => {
    const b = make();
    handed.push(b);
    return b;
  };
  return { request, handed };
}

describe('passkey EOA derivation', () => {
  test('labels are frozen and versioned', () => {
    expect(PASSKEY_EOA_PRF_SALT_LABEL).toBe('ppv2-passkey-eoa:prf-salt:v1');
    expect(PASSKEY_EOA_HKDF_SALT_LABEL).toBe('ppv2-passkey-eoa:hkdf-salt');
    expect(PASSKEY_EOA_HKDF_INFO_LABEL).toBe('ppv2-passkey-eoa-v1');
    expect(new TextDecoder().decode(passkeyEoaPrfSalt())).toBe(PASSKEY_EOA_PRF_SALT_LABEL);
  });

  test('same PRF -> same key and address, and it matches an independent HKDF', () => {
    const a = derivePasskeyEoaKey(vector());
    const b = derivePasskeyEoaKey(vector());
    expect(bytesToHex(a)).toBe(bytesToHex(b));

    const reference = new Uint8Array(hkdfSync(
      'sha256',
      vector(),
      new TextEncoder().encode(PASSKEY_EOA_HKDF_SALT_LABEL),
      new TextEncoder().encode(PASSKEY_EOA_HKDF_INFO_LABEL),
      32,
    ));
    expect(bytesToHex(a)).toBe(bytesToHex(reference));
    // Address from our secp256k1 path equals viem's (reference only, in a test).
    expect(passkeyEoaAddressFromKey(a)).toBe(privateKeyToAccount(bytesToHex(reference)).address);
    expect(passkeyEoaAddressFromKey(a)).toBe(VECTOR_ADDRESS);
  });

  test('a different PRF gives a different address', () => {
    const other = new Uint8Array(32).fill(0xab);
    expect(passkeyEoaAddressFromKey(derivePasskeyEoaKey(other))).not.toBe(VECTOR_ADDRESS);
  });

  test('refuses a PRF that is not 32 bytes', () => {
    expect(() => derivePasskeyEoaKey(new Uint8Array(16))).toThrow();
  });
});

describe('passkey EOA signing wipes every buffer', () => {
  const tx = {
    chainId: 11155111,
    type: 'eip1559' as const,
    to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as const,
    value: parseEther('0.01'),
    data: '0x' as Hex,
    nonce: 3,
    gas: 21000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
  };

  test('transaction: signed by the passkey EOA, PRF + HKDF + key + digest zeroed', async () => {
    const seen: Uint8Array[] = [];
    __observeSecretBuffersForTest((b) => seen.push(b));
    try {
      const prf = trackedPrf(vector);
      const signer = createPasskeyEoaSigner(prf.request, VECTOR_ADDRESS);
      const signed = await signer.signTransaction(tx);
      expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(VECTOR_ADDRESS);
      expect(parseTransaction(signed).nonce).toBe(3);
      expect(prf.handed).toHaveLength(1);
      expect(allZero(prf.handed[0])).toBe(true);
      // PRF, PRK, OKM (= the key), digest copy.
      expect(seen.length).toBeGreaterThanOrEqual(4);
      for (const b of seen) expect(allZero(b)).toBe(true);
    } finally {
      __observeSecretBuffersForTest(null);
    }
  });

  test('signs a legacy (gasPrice) tx with a valid EIP-155 v', async () => {
    const signer = createPasskeyEoaSigner(trackedPrf(vector).request, VECTOR_ADDRESS);
    const signed = await signer.signTransaction({ type: 'legacy', chainId: 1, nonce: 0, gas: 21000n, gasPrice: 1n, to: VECTOR_ADDRESS, value: 1n });
    expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(VECTOR_ADDRESS);
    expect(parseTransaction(signed).type).toBe('legacy');
  });

  test('every operation prompts again: nothing is cached between signatures', async () => {
    const prf = trackedPrf(vector);
    const signer = createPasskeyEoaSigner(prf.request, VECTOR_ADDRESS);
    await signer.signMessage('0x68656c6c6f');
    await signer.signMessage('0x68656c6c6f');
    expect(prf.handed).toHaveLength(2);
    expect(prf.handed.every(allZero)).toBe(true);
  });

  test('typed data and personal_sign recover to the passkey EOA', async () => {
    const signer = createPasskeyEoaSigner(trackedPrf(vector).request, VECTOR_ADDRESS);
    const typed = {
      domain: { name: 'Privacy Pools', version: '1' },
      types: { Msg: [{ name: 'v', type: 'uint256' }] },
      primaryType: 'Msg' as const,
      message: { v: 1n },
    };
    const sig = await signer.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature: sig })).toBe(VECTOR_ADDRESS);
    const msgSig = await signer.signMessage('0x68656c6c6f');
    expect(await recoverMessageAddress({ message: { raw: '0x68656c6c6f' }, signature: msgSig })).toBe(VECTOR_ADDRESS);
  });

  test('a different passkey is refused, and its buffers are still zeroed', async () => {
    const seen: Uint8Array[] = [];
    __observeSecretBuffersForTest((b) => seen.push(b));
    try {
      const prf = trackedPrf(() => new Uint8Array(32).fill(7));
      const signer = createPasskeyEoaSigner(prf.request, VECTOR_ADDRESS);
      await expect(signer.signTransaction(tx)).rejects.toBeInstanceOf(PasskeyEoaError);
      expect(allZero(prf.handed[0])).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
      for (const b of seen) expect(allZero(b)).toBe(true);
    } finally {
      __observeSecretBuffersForTest(null);
    }
  });

  test('sign-in returns only the public address and wipes the PRF', async () => {
    const prf = trackedPrf(vector);
    const record = await passkeyEoaSignIn(
      { request: async () => ({ prf: await prf.request(), credentialId: 'abc' }), create: async () => { throw new Error('unused'); } },
      'existing',
      null,
    );
    expect(record).toEqual({ address: VECTOR_ADDRESS, credentialId: 'abc' });
    expect(allZero(prf.handed[0])).toBe(true);
  });

  test('sign-in falls back to any passkey when the remembered one is gone', async () => {
    const calls: (string | null)[] = [];
    const record = await passkeyEoaSignIn(
      {
        request: async (id) => {
          calls.push(id);
          if (id) throw new PasskeyEoaError('no-passkey');
          return { prf: vector(), credentialId: 'new' };
        },
        create: async () => { throw new Error('unused'); },
      },
      'existing',
      'old',
    );
    expect(calls).toEqual(['old', null]);
    expect(record.credentialId).toBe('new');
  });
});
