// Stellar one-time claim links: the link codec (attacker-controlled input) and
// the sender's saved copy that lets the activity row rebuild the link.
import { describe, expect, test } from 'bun:test';

import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import {
  decodeStellarClaim,
  encodeStellarClaim,
  isStellarClaimLink,
  stellarClaimTotal,
  toImportableNote,
  type StellarClaimNote,
} from '@/services/stellar/stellar-claim';
import { findSentClaim, readSentClaims, saveSentClaim, setSentClaimTx, type StellarSentClaim } from '@/services/stellar/stellar-sent-claims';

const ME = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR';
const XLM = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;
const note = (i: number, over: Partial<StellarClaimNote> = {}): StellarClaimNote => ({
  commitment: `0x${(100 + i).toString(16).padStart(64, '0')}`,
  noteAddressHash: `0x${(200 + i).toString(16).padStart(64, '0')}`,
  noteSecret: `0x${(300 + i).toString(16).padStart(64, '0')}`,
  value: '0x989680',
  tokenId: XLM,
  label: '0xabc',
  ownerAddress: ME,
  txHash: '0x0',
  ...over,
});

function forge(payload: unknown): string {
  return `xlmn.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

describe('Stellar claim link', () => {
  test('round trip, total, and the note the session imports', () => {
    const encoded = encodeStellarClaim([note(1), note(2)]);
    expect(isStellarClaimLink(encoded)).toBe(true);
    const claim = decodeStellarClaim(encoded);
    expect(claim.notes).toHaveLength(2);
    expect(stellarClaimTotal(claim)).toBe(20_000_000n);
    expect(toImportableNote(claim.notes[0])).toMatchObject({ status: 'PENDING', isOwned: true, createdAtBlock: '0x0', spentAtBlock: null, ownerAddress: ME });
  });

  test('refuses forged or broken links', () => {
    const base = { kind: 'ppv2-stellar-claim', version: 1, chainId: 202 };
    expect(() => decodeStellarClaim('xlmn.@@@')).toThrow('damaged');
    expect(() => decodeStellarClaim(forge({ ...base, chainId: 1, notes: [note(1)] }))).toThrow('not valid');
    expect(() => decodeStellarClaim(forge({ ...base, notes: [] }))).toThrow('not valid');
    expect(() => decodeStellarClaim(forge({ ...base, notes: [note(1, { tokenId: 'CAAAA' })] }))).toThrow('not valid');
    expect(() => decodeStellarClaim(forge({ ...base, notes: [note(1, { ownerAddress: `G${'A'.repeat(55)}` })] }))).toThrow('not valid');
    // Two recipients in one link.
    const other = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
    expect(() => decodeStellarClaim(forge({ ...base, notes: [note(1), note(2, { ownerAddress: other })] }))).toThrow('not valid');
    // A value at or above the field modulus aliases a smaller amount.
    const r = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    expect(() => decodeStellarClaim(forge({ ...base, notes: [note(1, { value: `0x${r.toString(16)}` })] }))).toThrow('not valid');
    expect(() => decodeStellarClaim(forge({ ...base, notes: [note(1, { value: '0x0' })] }))).toThrow('not valid');
    // The same note twice.
    expect(() => decodeStellarClaim(forge({ ...base, notes: [note(1), note(1)] }))).toThrow('not valid');
  });
});

function memory() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
}

describe('Stellar sent claims', () => {
  const KEY = 'k';
  const record = (over: Partial<StellarSentClaim> = {}): StellarSentClaim => ({
    id: 'a', sender: ME, recipient: 'GX', amount: '10000000', notes: [note(1)], txHash: null, createdAt: 1, ...over,
  });

  test('saved before broadcast, found by tx hash in any spelling once confirmed', () => {
    const s = memory();
    saveSentClaim(s, KEY, record());
    setSentClaimTx(s, KEY, 'a', '0xABCDEF');
    const all = readSentClaims(s, KEY);
    expect(findSentClaim(all, ME, { txHash: 'abcdef' })?.id).toBe('a');
    expect(findSentClaim(all, 'GOTHER', { txHash: 'abcdef' })).toBeNull();
  });

  test('an unconfirmed send is matched by its recipient output', () => {
    const s = memory();
    saveSentClaim(s, KEY, record());
    const all = readSentClaims(s, KEY);
    expect(findSentClaim(all, ME, { txHash: 'ff', outputCommitments: ['0x65', '0x1'] })?.id).toBe('a');
    expect(findSentClaim(all, ME, { txHash: 'ff', outputCommitments: ['0x1'] })).toBeNull();
  });

  test('an unreadable store is left alone, not overwritten', () => {
    const s = memory();
    s.setItem(KEY, '{broken');
    expect(() => saveSentClaim(s, KEY, record())).toThrow('could not be read');
    setSentClaimTx(s, KEY, 'a', '0x1');
    expect(s.getItem(KEY)).toBe('{broken');
  });

  test('no storage, or a refused write, refuses the send', () => {
    expect(() => saveSentClaim(null, KEY, record())).toThrow('Nothing was sent');
    const refusing = { getItem: () => null, setItem: () => { /* dropped */ } };
    expect(() => saveSentClaim(refusing, KEY, record())).toThrow('Nothing was sent');
  });
});

describe('Stellar claim notes against the vendored SDK', () => {
  test('a claim note built like sendOneTime passes the SDK note schema and binds its commitment', async () => {
    const sdk = await import('@privacy-pools-v2/stellar-sdk');
    const hashService = await sdk.PoseidonHashService.create();
    const converter = new sdk.StellarAddressFieldConverter();
    const computation = new sdk.NoteComputationService({ hashService, cryptoService: new sdk.StellarCryptoService() } as never);
    const noteSecret = '0x1234' as `0x${string}`;
    const noteAddressHash = computation.computeNoteAddressHash(converter.toField(ME as never), noteSecret);
    const value = '0x989680' as `0x${string}`;
    const label = '0xabc' as `0x${string}`;
    const commitment = computation.computeFullCommitment({ noteAddressHash, tokenId: converter.toTokenIdField(XLM as never), value, label });
    const claimNote: StellarClaimNote = {
      commitment: String(commitment), noteAddressHash: String(noteAddressHash), noteSecret, value, tokenId: XLM, label, ownerAddress: ME, txHash: '0x0',
    };
    // Survives the link.
    const [back] = decodeStellarClaim(encodeStellarClaim([claimNote])).notes;
    // The Note schema importReceivedNote applies: hex fields, Stellar addresses.
    const imported = toImportableNote(back);
    for (const f of ['commitment', 'noteAddressHash', 'noteSecret', 'value', 'label', 'txHash', 'createdAtBlock'] as const) {
      expect(sdk.HexSchema.safeParse(imported[f]).success).toBe(true);
    }
    expect(sdk.StellarAddressSchema.safeParse(imported.ownerAddress).success).toBe(true);
    expect(sdk.StellarAddressSchema.safeParse(imported.tokenId).success).toBe(true);
    // The same derivation importReceivedNote re-runs.
    expect(BigInt(computation.computeNoteAddressHash(converter.toField(back.ownerAddress as never), back.noteSecret as `0x${string}`))).toBe(BigInt(back.noteAddressHash));
  });

});

describe('Stellar claim noteAddressHash width', () => {
  test('a short noteAddressHash is refused at decode', () => {
    const payload = { kind: 'ppv2-stellar-claim', version: 1, chainId: 202, notes: [note(1, { noteAddressHash: '0x1234' })] };
    expect(() => decodeStellarClaim(forge(payload))).toThrow('not valid');
  });
});
