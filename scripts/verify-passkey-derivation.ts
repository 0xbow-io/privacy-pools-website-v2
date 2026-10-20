// Equivalence check: prove services/passkey-derivation.ts mirrors the SDK's
// derivation tree byte-for-byte. The SDK's signature path is
//   r -> rootSecret = HKDF(r, salt=signerAddress) -> appSecret = HKDF(rootSecret, salt=APP_IDENTIFIER) -> deriveKeys(appSecret)
// Our passkey path is just deriveKeys(appSecret). So for a test signature we
// replicate the two pre-stages here, feed the resulting appSecret into our
// mirror, and assert the keys equal what the real SDK CryptoService produces
// from the same signature. Match ⇒ our mirror == the SDK tree.
//
// Run: safewrap bun run scripts/verify-passkey-derivation.ts

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak256, parseSignature, toBytes } from 'viem';
import type { Address, Hex } from 'viem';
import { CryptoService } from '@privacy-pools-v2/sdk';

import { derivePasskeyKeys } from '../services/passkey-derivation';

const ROOT_DERIVATION_INFO = 'Standardized-Secret-Derivation-v1-Root';
const APP_DERIVATION_INFO = 'Standardized-Secret-Derivation-v1-App';
const APP_IDENTIFIER = 'TODO-privacy-pools-v2';

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Replicate the SDK's two signature-only pre-stages to obtain the appSecret.
function appSecretFromSignature(signature: Hex, signerAddress: Address): Uint8Array {
  const r = parseSignature(signature).r; // 0x-hex
  const rBytes = toBytes(r);
  const rootSecret = hkdf(sha256, rBytes, toBytes(signerAddress), utf8(ROOT_DERIVATION_INFO), 32);
  return hkdf(sha256, rootSecret, utf8(APP_IDENTIFIER), utf8(APP_DERIVATION_INFO), 32);
}

const cases: { signature: Hex; signerAddress: Address }[] = [
  {
    signature: ('0x' + '11'.repeat(32) + '22'.repeat(32) + '1b') as Hex,
    signerAddress: '0x1111111111111111111111111111111111111111',
  },
  {
    signature: ('0x' + 'ab'.repeat(32) + 'cd'.repeat(32) + '1c') as Hex,
    signerAddress: '0x07F8000000000000000000000000000000003B65',
  },
];

const crypto = new CryptoService();
let allOk = true;

for (const [i, c] of cases.entries()) {
  const addressHash = keccak256(toBytes(c.signerAddress)) as Hex;
  const sdk = crypto.deriveKeysFromSignature({
    signature: c.signature,
    signerAddress: c.signerAddress,
    addressHash,
    revocableKeyIndex: '0x0' as Hex,
  });

  const appSecret = appSecretFromSignature(c.signature, c.signerAddress);
  const mine = derivePasskeyKeys(appSecret, 0n);

  const fields = ['privateNullifyingKey', 'privateRevocableKey', 'viewingPrivateKey', 'viewingPublicKey'] as const;
  let caseOk = true;
  for (const f of fields) {
    const a = String((sdk as unknown as Record<string, unknown>)[f]).toLowerCase();
    const b = String((mine as Record<string, unknown>)[f]).toLowerCase();
    if (a !== b) {
      caseOk = false;
      // Never print key values (spend-grade pattern). Field name is enough to
      // localize a divergence; re-run with a debugger if you need the bytes.
      console.log(`case ${i} MISMATCH on field "${f}" (values withheld)`);
    }
  }
  console.log(`case ${i} (${c.signerAddress}): ${caseOk ? 'OK — keys identical' : 'FAILED'}`);
  allOk = allOk && caseOk;
}

console.log(allOk ? '\nALL CASES MATCH — mirror is byte-identical to the SDK tree.' : '\nFAILED — mirror diverges from the SDK.');
if (!allOk) process.exit(1);
