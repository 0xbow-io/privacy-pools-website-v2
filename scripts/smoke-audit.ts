/**
 * Offline smoke test for the partial-viewing-key (audit receipt) feature.
 *
 *   bun run scripts/smoke-audit.ts
 *
 * No wallet, no RPC. Validates the parts that don't need the chain:
 *   1. encode → decode round-trips losslessly (pvk1.<base64url>).
 *   2. decode rejects garbage / wrong-shape input.
 *   3. The verifier's commitment recomputation (the SHIPPING
 *      recomputeCommitment(), backed by the SDK's Poseidon chain)
 *      reproduces a commitment derived independently from the same
 *      fields — i.e. an honest receipt verifies.
 *   4. Tampering with any disclosed field (amount / owner / token /
 *      label) changes the recomputed commitment — i.e. a forged
 *      receipt is detected.
 *
 * The on-chain half of verifyPartialViewingKey() (PoolVault
 * getCommitmentTimestamp) needs a live RPC + a real note and is covered
 * by manual testing, not here.
 *
 * Exit code is non-zero if any assertion fails, so this is CI-friendly.
 */

// config/env throws at import time without an ASP URL; the audit code
// only needs it for the (here-unused) PAY_URL_BASE fallback. Set a
// dummy BEFORE the dynamic imports below so the module loads.
process.env.EXPO_PUBLIC_ASP_URL ??= 'https://example.invalid';

import type { Address, Hash, Hex, Secret } from '@/services/sdk-types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const audit = await import('@/services/audit-receipt');
  const sdk = await import('@privacy-pools-v2/sdk');

  // --- Ground-truth commitment, derived directly from the SDK service,
  // exactly the way a real note is minted. ---
  const hashService = await sdk.PoseidonHashService.create();
  const cryptoService = new sdk.CryptoService();
  const ncs = new sdk.NoteComputationService({ hashService, cryptoService });

  const ownerAddress = '0x1234567890abcdef1234567890abcdef12345678' as Address;
  const noteSecret = (`0x${'aa'.repeat(32)}`) as Secret;
  const tokenId = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address;
  const value = (`0x${(5n * 10n ** 18n).toString(16)}`) as Hex; // 5 ETH
  const label = (`0x${'dd'.repeat(32)}`) as Hash;

  const noteAddressHash = ncs.computeNoteAddressHash(ownerAddress, noteSecret);
  const groundTruthCommitment = ncs.computeFullCommitment({
    noteAddressHash,
    tokenId,
    value,
    label,
  }) as Hash;

  const bundle = audit.buildSentPaymentKey({
    chainId: 11155111,
    txHash: (`0x${'ab'.repeat(32)}`) as Hash,
    commitment: groundTruthCommitment,
    ownerAddress,
    noteSecret,
    tokenId,
    value,
    label,
  }, 'May 2026 salary — test');

  console.log('1. encode/decode round-trip');
  const encoded = audit.encodePartialViewingKey(bundle);
  check('prefix is pvk1.', encoded.startsWith('pvk1.'));
  const decoded = audit.decodePartialViewingKey(encoded);
  check('decodes to a bundle', decoded !== null);
  check('round-trip is lossless', JSON.stringify(decoded) === JSON.stringify(bundle));

  console.log('2. decode rejects bad input');
  check('plain garbage → null', audit.decodePartialViewingKey('not a key') === null);
  check('empty → null', audit.decodePartialViewingKey('') === null);
  check(
    'wrong-shape JSON → null',
    audit.decodePartialViewingKey('pvk1.' + Buffer.from('{"v":1}', 'utf8').toString('base64url')) === null,
  );

  console.log('3. honest receipt: recompute matches');
  const recomputed = await audit.recomputeCommitment(decoded!);
  check('recompute === ground truth', recomputed.toLowerCase() === groundTruthCommitment.toLowerCase(),
    `recomputed=${recomputed} expected=${groundTruthCommitment}`);
  check('recompute === bundle.commitment', recomputed.toLowerCase() === bundle.commitment.toLowerCase());

  console.log('4. tampering is detected');
  const tamperedValue = await audit.recomputeCommitment({ ...decoded!, value: (`0x${(50n * 10n ** 18n).toString(16)}`) as Hex });
  check('changed amount → different commitment', tamperedValue.toLowerCase() !== groundTruthCommitment.toLowerCase());
  const tamperedOwner = await audit.recomputeCommitment({ ...decoded!, ownerAddress: '0x000000000000000000000000000000000000dead' as Address });
  check('changed owner → different commitment', tamperedOwner.toLowerCase() !== groundTruthCommitment.toLowerCase());
  const tamperedToken = await audit.recomputeCommitment({ ...decoded!, tokenId: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address });
  check('changed token → different commitment', tamperedToken.toLowerCase() !== groundTruthCommitment.toLowerCase());
  const tamperedLabel = await audit.recomputeCommitment({ ...decoded!, label: (`0x${'ee'.repeat(32)}`) as Hash });
  check('changed label → different commitment', tamperedLabel.toLowerCase() !== groundTruthCommitment.toLowerCase());

  console.log('');
  if (failures > 0) {
    console.log(`SMOKE FAILED: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('SMOKE OK: all audit-receipt assertions passed');
}

main().catch((err) => {
  console.error('SMOKE ERRORED:', err);
  process.exit(1);
});
