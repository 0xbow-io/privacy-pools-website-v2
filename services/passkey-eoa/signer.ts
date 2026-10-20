// One passkey prompt per signature. Rules: see ./derivation.ts.
//
// Each method asks for a fresh PRF, derives the key inside withPasskeyEoaKey,
// checks the key is the account the user signed in with, signs, and returns
// only the public signature. Nothing about the key leaves the call.

import {
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  serializeSignature,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializable,
  type TypedDataDefinition,
} from 'viem';

import { passkeyEoaAddressFromKey, signDigestWithKey, withPasskeyEoaKey } from './derivation';
import { PasskeyWrongAccountError } from './errors';

/** Prompts the passkey and resolves to a fresh 32-byte PRF output the caller now owns. */
export type PasskeyPrfRequest = () => Promise<Uint8Array>;

export type PasskeyEoaSigner = {
  address: Address;
  signTransaction: (tx: TransactionSerializable) => Promise<Hex>;
  signTypedData: (typed: TypedDataDefinition) => Promise<Hex>;
  signMessage: (raw: Hex) => Promise<Hex>;
};

/** Sign one digest: prompt, derive, verify the account, sign, zero. */
export async function signDigestWithPasskey(
  requestPrf: PasskeyPrfRequest,
  expectedAddress: Address,
  digest: Hex,
): Promise<{ r: Hex; s: Hex; yParity: 0 | 1 }> {
  const prf = await requestPrf();
  return withPasskeyEoaKey(prf, (key) => {
    if (passkeyEoaAddressFromKey(key).toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new PasskeyWrongAccountError();
    }
    const digestBytes = hexToBytes(digest);
    try {
      const sig = signDigestWithKey(key, digestBytes);
      return {
        r: `0x${sig.r.toString(16).padStart(64, '0')}` as Hex,
        s: `0x${sig.s.toString(16).padStart(64, '0')}` as Hex,
        yParity: sig.yParity,
      };
    } finally {
      digestBytes.fill(0);
    }
  });
}

export function createPasskeyEoaSigner(requestPrf: PasskeyPrfRequest, address: Address): PasskeyEoaSigner {
  return {
    address,
    async signTransaction(tx) {
      const digest = keccak256(serializeTransaction(tx));
      const sig = await signDigestWithPasskey(requestPrf, address, digest);
      // Legacy txs take EIP-155 v from signature.v; typed txs use yParity.
      return serializeTransaction(tx, { ...sig, v: 27n + BigInt(sig.yParity) });
    },
    async signTypedData(typed) {
      const sig = await signDigestWithPasskey(requestPrf, address, hashTypedData(typed));
      return serializeSignature(sig);
    },
    async signMessage(raw) {
      const sig = await signDigestWithPasskey(requestPrf, address, hashMessage({ raw }));
      return serializeSignature(sig);
    },
  };
}
