import { beforeAll, describe, expect, test } from 'bun:test';
import { CryptoService, NoteComputationService, PoseidonHashService } from '@privacy-pools-v2/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decryptBlindDepositBackup, splitNoteData, type BackupCryptoLike, type BackupNoteComputationLike } from '../blind-deposit-backup';
import { swapDepositRecipient } from '../swap-deposit-recipient';
import {
  claimRecoveryOutcome,
  claimsFromLoadedCiphertexts,
  openSwapSendClaim,
  parseSealedClaim,
  parseSealedClaims,
  rekeySealedClaim,
  sealSwapSendClaim,
  sealedClaimsForTx,
  upsertSealedClaim,
  type SwapSendClaim,
} from '../swap-send-claim';

/**
 * DEV-511. Real SDK crypto and note computation (the producer), and the real
 * blind recipient builder the reshield-transfer hands the SDK. The note the
 * builder is called with is computed by the SDK's own NoteComputationService,
 * exactly the fields its NoteDataBuilderInput carries.
 */
type Hex = `0x${string}`;
const RECIPIENT = '0x42bacd8d0c811a2ba95e5d44f9c71d984299e308' as Hex;
const PPUSDC = '0x1111111111111111111111111111111111111111' as Hex;

let crypto: CryptoService;
let ncs: NoteComputationService;
let senderPriv: string;
let senderPub: string;
const fill = (out: Uint8Array) => { globalThis.crypto.getRandomValues(out as unknown as Uint8Array<ArrayBuffer>); };

beforeAll(async () => {
  const hashService = await PoseidonHashService.create();
  crypto = new CryptoService();
  ncs = new NoteComputationService({ hashService, cryptoService: crypto });
  const pair = crypto.generateEphemeralKeyPair();
  senderPriv = pair.privateKey;
  senderPub = pair.publicKey;
});

/** Run the real builder the way the SDK does, return the claim it reports and the on-chain noteData. */
function buildViaSdkShape(value: Hex) {
  const noteSecret = crypto.generateSecret() as Hex;
  const depositSecret = crypto.generateSecret() as Hex;
  const noteAddressHash = ncs.computeNoteAddressHash(RECIPIENT, noteSecret) as Hex;
  let reported: { label: Hex; commitment: Hex; tokenId: Hex; value: Hex } | null = null;
  const spec = swapDepositRecipient({
    recipient: RECIPIENT,
    blind: {
      noteSecret, depositSecret, senderViewingPubKey: senderPub, noteAddressHash,
      noteComputation: ncs as unknown as BackupNoteComputationLike,
      crypto: crypto as unknown as BackupCryptoLike,
      randomFill: fill,
    },
    onNote: (_k, note) => { reported = note; },
  });
  if (!('noteData' in spec) || typeof spec.noteData !== 'function') throw new Error('expected the blind builder form');
  const precommitment = ncs.computePrecommitment(noteAddressHash, PPUSDC, value);
  const label = ncs.computeLabel(precommitment, depositSecret) as Hex;
  const commitment = ncs.computeFullCommitment({ noteAddressHash, tokenId: PPUSDC, value, label }) as Hex;
  const noteData = spec.noteData({ tokenId: PPUSDC, value, noteAddressHash, depositSecret, label, commitment });
  const r = reported as unknown as { label: Hex; commitment: Hex; tokenId: Hex; value: Hex };
  const claim: SwapSendClaim = { chainId: 10, commitment: r.commitment, ownerAddress: RECIPIENT, noteSecret, tokenId: r.tokenId, value: r.value, label: r.label };
  return { claim, noteData, commitment, label };
}

describe('swap-send claim material (DEV-511)', () => {
  test('the builder reports the label and commitment the proof commits to', () => {
    const { claim, commitment, label } = buildViaSdkShape('0x4c4b40');
    expect(BigInt(claim.commitment)).toBe(BigInt(commitment));
    expect(BigInt(claim.label)).toBe(BigInt(label));
  });

  test('sealed record round-trips with the sender key and holds no plaintext secret or recipient', () => {
    const { claim } = buildViaSdkShape('0x4c4b40');
    const sealed = sealSwapSendClaim({ claim, sourceChainId: 1, senderViewingPubKey: senderPub, crypto: crypto as unknown as BackupCryptoLike, now: 1 });
    const stored = JSON.stringify(sealed).toLowerCase();
    expect(stored).not.toContain(claim.noteSecret.slice(2).toLowerCase());
    expect(stored).not.toContain(RECIPIENT.slice(2));
    expect(openSwapSendClaim({ sealed, viewingPrivateKey: senderPriv, crypto: crypto as unknown as BackupCryptoLike })).toEqual(claim);
    const other = crypto.generateEphemeralKeyPair().privateKey;
    expect(openSwapSendClaim({ sealed, viewingPrivateKey: other, crypto: crypto as unknown as BackupCryptoLike })).toBeNull();
    // A record moved to another chain does not build a link for it.
    expect(openSwapSendClaim({ sealed: { ...sealed, chainId: 8453 }, viewingPrivateKey: senderPriv, crypto: crypto as unknown as BackupCryptoLike })).toBeNull();
  });

  test('the on-chain backup carries the same claim, decryptable by the sender', () => {
    const { claim, noteData } = buildViaSdkShape('0x4c4b40');
    const parts = splitNoteData(noteData.data)!;
    const payload = decryptBlindDepositBackup({ ...parts, viewingPrivateKey: senderPriv, crypto: crypto as unknown as BackupCryptoLike });
    expect(payload?.noteSecret).toBe(claim.noteSecret);
    expect(BigInt(payload!.label)).toBe(BigInt(claim.label));
  });

  test('stored before relay, re-keyed on broadcast, found by the row hash', () => {
    const { claim } = buildViaSdkShape('0x4c4b40');
    const sealed = sealSwapSendClaim({ claim, sourceChainId: 1, senderViewingPubKey: senderPub, crypto: crypto as unknown as BackupCryptoLike, now: 1 });
    let list = upsertSealedClaim([], sealed);
    expect(sealedClaimsForTx(list, '0xABC')).toEqual([]);
    list = rekeySealedClaim(list, sealed.id, '0xABC');
    expect(sealedClaimsForTx(list, '0xabc').map((r) => r.id)).toEqual([sealed.id]);
    expect(parseSealedClaims(JSON.stringify(list))).toEqual({ ok: true, list });
    expect(parseSealedClaims('{oops')).toEqual({ ok: false });
  });

  test('the claim link names one note, the recipient\'s, and no other note of the sender', () => {
    const src = readFileSync(join(new URL('.', import.meta.url).pathname, '..', '..', 'components/swap-modal-provider.tsx'), 'utf8');
    expect(src).toContain('setClaimUrl(buildSentReceiptUrl([{ ...b.claim, txHash: hash as Hex } as never]));');
    expect(src).not.toMatch(/noteSecretsMap/);
  });
});

describe('Recover claim link on another browser (no sealed record)', () => {
  test('same chain: rebuilt from ciphertexts already loaded for the row, nothing fetched', () => {
    const { claim, noteData } = buildViaSdkShape('0x4c4b40');
    const parts = splitNoteData(noteData.data)!;
    const unrelated = splitNoteData(buildViaSdkShape('0x01').noteData.data)!;
    const other = crypto.generateEphemeralKeyPair().privateKey;
    const open = (key: string) => (c: { ephemeralPubKey: string; encryptedPayload: string }) =>
      decryptBlindDepositBackup({ ...c, viewingPrivateKey: key, crypto: crypto as unknown as BackupCryptoLike });
    const got = claimsFromLoadedCiphertexts({ chainId: claim.chainId, txHash: '0xAA', ciphertexts: [parts], open: open(senderPriv) });
    expect(got).toHaveLength(1);
    expect(got[0].noteSecret).toBe(claim.noteSecret);
    expect(got[0].chainId).toBe(claim.chainId);
    expect(got[0].txHash).toBe('0xaa');
    // Not ours: nothing.
    expect(claimsFromLoadedCiphertexts({ chainId: claim.chainId, txHash: '0xaa', ciphertexts: [unrelated], open: open(other) })).toEqual([]);
    // A registered-recipient send: its ciphertexts are loaded, none is our backup.
    const registered = claimsFromLoadedCiphertexts({ chainId: claim.chainId, txHash: '0xaa', ciphertexts: [unrelated], open: open(other) });
    expect(claimRecoveryOutcome({ loadedCiphertexts: 1, claims: registered.length })).toBe('none-needed');
    expect(claimRecoveryOutcome({ loadedCiphertexts: 0, claims: 0 })).toBe('syncing');
    expect(claimRecoveryOutcome({ loadedCiphertexts: 1, claims: got.length })).toBe('found');
  });

  test('the click makes no request and there is no cross-chain guess', () => {
    const src = readFileSync(join(new URL('.', import.meta.url).pathname, '..', '..', 'components/pools/transactions.tsx'), 'utf8');
    const block = src.slice(src.indexOf("key: 'recover-swap-claim-link'"), src.indexOf("key: 'receipt-link'"));
    expect(block).toContain('const loaded = noteCiphertextsFor(tx.chainId, String(tx.txHash));');
    expect(block).not.toContain('recoverBlindDepositClaims');
    expect(block).not.toMatch(/getNoteEvents|fetch\(|getSwapDestinationChains/);
    const core = readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'swap-send-claim.ts'), 'utf8');
    expect(core).not.toContain('pickRecoveredSwapSendClaims');
  });

  test('per-claim records parse alone, so concurrent tabs never share a write', () => {
    const { claim } = buildViaSdkShape('0x4c4b40');
    const sealed = sealSwapSendClaim({ claim, sourceChainId: 1, senderViewingPubKey: senderPub, crypto: crypto as unknown as BackupCryptoLike, now: 1 });
    expect(parseSealedClaim(JSON.stringify(sealed))).toEqual(sealed);
    expect(parseSealedClaim('{oops')).toBeNull();
    const store = readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'swap-send-claim-store.ts'), 'utf8');
    expect(store).toContain('const claimKey = (id: string) => `${PREFIX}.c.${id}`;');
    expect(store).not.toMatch(/upsertSealedClaim|rekeySealedClaim\(list/);
  });
});
