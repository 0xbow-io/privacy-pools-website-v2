// The claim side against a REAL vendored Stellar PoolSession (memory storage,
// no network): a link note built like sendOneTime imports through the SDK's
// own importReceivedNote, which re-derives noteAddressHash and commitment and
// refuses another owner's note.
import { describe, expect, test } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';

import {
  STELLAR_KEY_APP_IDENTIFIER,
  STELLAR_TESTNET_CONTRACTS,
  STELLAR_TESTNET_NETWORK,
} from '@/config/stellar-deployment';
import { decodeStellarClaim, encodeStellarClaim, toImportableNote, type StellarClaimNote } from '@/services/stellar/stellar-claim';

async function sessionFor(owner: string) {
  const sdk = await import('@privacy-pools-v2/stellar-sdk');
  const signature = `0x${'ab'.repeat(64)}`;
  const derived = new sdk.StellarCryptoService().deriveKeysFromSignature({
    signature: signature as never,
    appIdentifier: STELLAR_KEY_APP_IDENTIFIER,
    revocableKeyIndex: '0x0' as never,
  });
  const session = await sdk.StellarPoolSessionBuilder.create({
    chainId: 202,
    ownerAddress: owner,
    rpcUrl: 'http://unused.invalid',
    networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase,
    poolContractId: STELLAR_TESTNET_CONTRACTS.poolContractId,
    keystoreContractId: STELLAR_TESTNET_CONTRACTS.keystoreContractId,
    aspRegistryContractId: STELLAR_TESTNET_CONTRACTS.aspRegistryContractId,
    ipfsGatewayUrl: 'http://unused.invalid',
    protocolKeys: { ...derived, revocableKeyIndex: '0x0' },
    persistentStorage: { type: 'memory' },
    circuitArtifactsDir: '/nonexistent',
  } as never);
  return { sdk, session };
}

async function claimNoteFor(owner: string): Promise<StellarClaimNote> {
  const sdk = await import('@privacy-pools-v2/stellar-sdk');
  const hashService = await sdk.PoseidonHashService.create();
  const converter = new sdk.StellarAddressFieldConverter();
  const computation = new sdk.NoteComputationService({ hashService, cryptoService: new sdk.StellarCryptoService() } as never);
  const noteSecret = '0x2b' as `0x${string}`;
  const noteAddressHash = computation.computeNoteAddressHash(converter.toField(owner as never), noteSecret);
  const value = '0x989680' as `0x${string}`;
  const label = '0x77' as `0x${string}`;
  const tokenId = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;
  const commitment = computation.computeFullCommitment({ noteAddressHash, tokenId: converter.toTokenIdField(tokenId as never), value, label });
  return { commitment: String(commitment), noteAddressHash: String(noteAddressHash), noteSecret, value, tokenId, label, ownerAddress: owner, txHash: '0x0' };
}

describe('Stellar claim import (real SDK session)', () => {
  test('the named account imports it as a PENDING note it owns', async () => {
    const owner = Keypair.random().publicKey();
    const { session } = await sessionFor(owner);
    const [n] = decodeStellarClaim(encodeStellarClaim([await claimNoteFor(owner)])).notes;
    await session.importReceivedNote(toImportableNote(n) as never);
    const { notes } = await session.exportAccount();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ status: 'PENDING', isOwned: true, ownerAddress: owner });
    expect(BigInt(notes[0].commitment)).toBe(BigInt(n.commitment));
  }, 30_000);

  test('another account cannot import it, and a tampered value is refused', async () => {
    const owner = Keypair.random().publicKey();
    const n = await claimNoteFor(owner);
    const { session: other } = await sessionFor(Keypair.random().publicKey());
    await expect(other.importReceivedNote(toImportableNote(n) as never)).rejects.toThrow();
    const { session } = await sessionFor(owner);
    await expect(session.importReceivedNote(toImportableNote({ ...n, value: '0x989681' }) as never)).rejects.toThrow();
  }, 30_000);
});
