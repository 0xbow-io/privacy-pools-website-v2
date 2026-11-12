// DEV-499: a Stellar deposit for an account with no viewing key goes blind
// (the SDK's noteAddressHash-only prepareDepositFor) and the recipient gets a
// claim link. Checked against the REAL vendored SDK: the hash we commit to is
// the one the SDK derives, and the link note imports into the recipient's own
// session through importReceivedNote, which re-derives every field.
import { describe, expect, test } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';

import {
  STELLAR_KEY_APP_IDENTIFIER,
  STELLAR_TESTNET_CONTRACTS,
  STELLAR_TESTNET_NETWORK,
} from '@/config/stellar-deployment';
import {
  blindClaimNote,
  blindNoteAddressHash,
  decodeStellarClaim,
  encodeStellarClaim,
  isUnregisteredRecipientError,
  toImportableNote,
} from '@/services/stellar/stellar-claim';
import { readSentClaims, saveSentClaim, setSentClaimTx } from '@/services/stellar/stellar-sent-claims';

async function sessionFor(owner: string) {
  const sdk = await import('@privacy-pools-v2/stellar-sdk');
  const derived = new sdk.StellarCryptoService().deriveKeysFromSignature({
    signature: `0x${'cd'.repeat(64)}` as never,
    appIdentifier: STELLAR_KEY_APP_IDENTIFIER,
    revocableKeyIndex: '0x0' as never,
  });
  return sdk.StellarPoolSessionBuilder.create({
    chainId: 202,
    ownerAddress: owner,
    rpcUrl: 'http://unused.invalid',
    networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase,
    poolContractId: STELLAR_TESTNET_CONTRACTS.poolContractId,
    deploymentLedger: '1',
    keystoreContractId: STELLAR_TESTNET_CONTRACTS.keystoreContractId,
    aspRegistryContractId: STELLAR_TESTNET_CONTRACTS.aspRegistryContractId,
    ipfsGatewayUrl: 'http://unused.invalid',
    protocolKeys: { ...derived, revocableKeyIndex: '0x0' },
    persistentStorage: { type: 'memory' },
    circuitArtifactsDir: '/nonexistent',
  } as never);
}

/** What prepareDepositFor's pendingNote carries for a blind deposit. */
async function blindDeposit(recipient: string) {
  const sdk = await import('@privacy-pools-v2/stellar-sdk');
  const hash = await sdk.PoseidonHashService.create();
  const converter = new sdk.StellarAddressFieldConverter();
  const noteSecret = new sdk.StellarCryptoService().generateSecret() as `0x${string}`;
  const noteAddressHash = blindNoteAddressHash(hash, converter.toField(recipient as never) as `0x${string}`, noteSecret);
  const computation = new sdk.NoteComputationService({ hashService: hash, cryptoService: new sdk.StellarCryptoService() } as never);
  const value = '0x1312d00';
  const label = '0x1234';
  const tokenId = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;
  const commitment = computation.computeFullCommitment({ noteAddressHash, tokenId: converter.toTokenIdField(tokenId as never), value, label } as never);
  return { sdk, computation, converter, noteSecret, noteAddressHash, pending: { commitment, value, tokenId, label, noteAddressHash } };
}

describe('Stellar blind deposit claim (DEV-499)', () => {
  test('the noteAddressHash is the one the SDK computes for that owner and secret', async () => {
    const recipient = Keypair.random().publicKey();
    const { computation, converter, noteSecret, noteAddressHash } = await blindDeposit(recipient);
    expect(BigInt(noteAddressHash)).toBe(BigInt(computation.computeNoteAddressHash(converter.toField(recipient as never), noteSecret)));
    expect(noteAddressHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('the claim link note imports into the recipient session, and only theirs', async () => {
    const recipient = Keypair.random().publicKey();
    const { noteSecret, noteAddressHash, pending } = await blindDeposit(recipient);
    const note = blindClaimNote(pending, { noteAddressHash, noteSecret, recipient });
    const [decoded] = decodeStellarClaim(encodeStellarClaim([note])).notes;
    const session = await sessionFor(recipient);
    await session.importReceivedNote(toImportableNote(decoded) as never);
    const { notes } = await session.exportAccount();
    expect(notes).toHaveLength(1);
    expect(BigInt(notes[0].commitment)).toBe(BigInt(String(pending.commitment)));
    const other = await sessionFor(Keypair.random().publicKey());
    await expect(other.importReceivedNote(toImportableNote(decoded) as never)).rejects.toThrow();
  }, 30_000);

  test('a pending note that names another hash is refused before signing', async () => {
    const recipient = Keypair.random().publicKey();
    const { noteSecret, noteAddressHash, pending } = await blindDeposit(recipient);
    expect(() => blindClaimNote({ ...pending, noteAddressHash: '0x01' }, { noteAddressHash, noteSecret, recipient })).toThrow();
  });

  test('only the SDK unregistered-recipient refusal turns the deposit blind', async () => {
    const sdk = await import('@privacy-pools-v2/stellar-sdk');
    expect(isUnregisteredRecipientError(new sdk.DepositRecipientViewingKeyUnregistered('GABC'))).toBe(true);
    expect(isUnregisteredRecipientError(new Error('User declined'))).toBe(false);
    expect(isUnregisteredRecipientError(new Error('below minimum'))).toBe(false);
  });

  test('the sender backup keeps the claim and its tx', async () => {
    const recipient = Keypair.random().publicKey();
    const { noteSecret, noteAddressHash, pending } = await blindDeposit(recipient);
    const note = blindClaimNote(pending, { noteAddressHash, noteSecret, recipient });
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
    saveSentClaim(storage, 'k', { id: 'a', sender: Keypair.random().publicKey(), recipient, amount: '20000000', notes: [note], txHash: null, createdAt: 1 });
    setSentClaimTx(storage, 'k', 'a', '0xabc');
    const [saved] = readSentClaims(storage, 'k');
    expect(saved.txHash).toBe('0xabc');
    expect(saved.notes[0].noteSecret).toBe(noteSecret);
  });
});

describe('Stellar blind deposit row (DEV-499 review)', () => {
  const ME = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
  const THEM = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
  const CTX = { chainId: 202, chainName: 'Stellar Testnet', symbol: 'XLM', decimals: 7, priceUsd: 0, ownAddress: ME };
  const origins = { byCommitment: {}, complete: true, spends: [], exits: [] };

  test('a confirmed blind deposit is an outgoing Deposit row the menu can find by tx', async () => {
    const { deriveStellarActivity } = await import('@/services/stellar-activity');
    const tokenId = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;
    const { rows, depositCount } = deriveStellarActivity([], origins, {
      ...CTX,
      sentDeposits: [
        { txHash: 'ab'.repeat(32), recipient: THEM, amount: '20000000', tokenId, createdAt: 1_760_000_000_000 },
        { txHash: null, recipient: THEM, amount: '1', tokenId, createdAt: 1 },
      ],
    });
    expect(depositCount).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'Deposit', direction: 'out', txHash: 'ab'.repeat(32), fullAddress: THEM, rawAmount: '20000000', status: 'completed' });
  });

  for (const eventHash of ['ab'.repeat(32), `0x${'AB'.repeat(32)}`]) {
    test(`indexed blind deposit keeps claim recovery without duplicating the row (${eventHash})`, async () => {
      const { deriveStellarActivity } = await import('@/services/stellar-activity');
      const { depositMineByAddress } = await import('@/services/deposit-ownership');
      const { rows, depositCount } = deriveStellarActivity([], {
        ...origins,
        authored: [{ txHash: eventHash, amount: '20000000', ledger: 123, time: 1_760_000_000 }],
      }, {
        ...CTX,
        depositsFor: [{ txHash: 'ab'.repeat(32) }],
        sentDeposits: [{ txHash: 'ab'.repeat(32), recipient: THEM, amount: '20000000', tokenId: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId, createdAt: 1 }],
      });
      expect(rows).toHaveLength(1);
      // The menu requires outgoing direction to offer Recover claim link.
      expect(rows[0]).toMatchObject({ type: 'Deposit', direction: 'out', depositFor: true, fullAddress: ME, rawAmount: '20000000', status: 'completed' });
      expect(depositCount).toBe(0);
      expect(depositMineByAddress(rows[0], ME, { outgoing: new Set(), notMine: new Set(), pending: new Set() })).toBe(false);
    });

  }

  test('a claim saved before the tab died is matched to its deposit by the output', async () => {
    const { findSentClaim } = await import('@/services/stellar/stellar-sent-claims');
    const recipient = Keypair.random().publicKey();
    const { noteSecret, noteAddressHash, pending } = await blindDeposit(recipient);
    const note = blindClaimNote(pending, { noteAddressHash, noteSecret, recipient });
    const claim = { id: 'x', kind: 'deposit' as const, sender: ME, recipient, amount: '1', notes: [note], txHash: null, createdAt: 1 };
    // What healSentClaims feeds it for a Deposited event: its one output commitment.
    const padded = `0x${BigInt(note.commitment).toString(16).padStart(64, '0')}`;
    expect(findSentClaim([claim], ME, { txHash: '0xdead', outputCommitments: [padded] })?.id).toBe('x');
    expect(findSentClaim([claim], ME, { txHash: '0xdead', outputCommitments: ['0x1'] })).toBeNull();
  });
});
