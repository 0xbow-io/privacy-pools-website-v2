import { describe, expect, test } from 'bun:test';

import {
  recomputeStellarCommitment,
  stellarCommitmentOnChain,
  stellarOriginLink,
  verifyStellarOriginProof,
  verifyStellarPartialViewingKey,
  type StellarPoolHistory,
  type StellarVerifyDeps,
} from '@/services/stellar/stellar-audit-verify';
import type { OriginProofV1, PartialViewingKeyV1 } from '@/services/audit-receipt';

const ME = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const BOB = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const DEPOSIT_TX = `0x${'d1'.repeat(32)}`;
const SEND_TX = `0x${'5e'.repeat(32)}`;
const WITHDRAW_TX = `0x${'77'.repeat(32)}`;
const EXIT_TX = `0x${'e0'.repeat(32)}`;

// A note as the SDK binds it on Stellar (the same derivation importReceivedNote
// re-runs: StellarAddressFieldConverter for the owner and the asset).
async function sdkCommitment(owner: string, noteSecret: string, value: string, label: string): Promise<string> {
  const sdk = await import('@privacy-pools-v2/stellar-sdk');
  const hashService = await sdk.PoseidonHashService.create();
  const converter = new sdk.StellarAddressFieldConverter();
  const computation = new sdk.NoteComputationService({ hashService, cryptoService: new sdk.StellarCryptoService() } as never);
  const noteAddressHash = computation.computeNoteAddressHash(converter.toField(owner as never), noteSecret as `0x${string}`);
  return String(computation.computeFullCommitment({ noteAddressHash, tokenId: converter.toTokenIdField(XLM as never), value: value as `0x${string}`, label: label as `0x${string}` }));
}

const bundle = (commitment: string, over: Partial<PartialViewingKeyV1> = {}): PartialViewingKeyV1 => ({
  v: 1, kind: 'sent', chainId: 202, txHash: SEND_TX as never, commitment: commitment as never,
  ownerAddress: BOB as never, noteSecret: '0x1234' as never, tokenId: XLM as never,
  value: '0x989680' as never, label: '0xabc' as never, ...over,
});

function history(commitments: { deposit?: string; sendOut?: string; withdrawChange?: string; exited?: string }): StellarPoolHistory {
  return {
    deposits: commitments.deposit ? [{ txHash: DEPOSIT_TX, outputCommitment: commitments.deposit }] : [],
    transacts: [
      ...(commitments.sendOut ? [{ txHash: SEND_TX, outputCommitments: ['0x777', commitments.sendOut], withdrawnValue: '0' }] : []),
      // Events may spell the hash without 0x; a relayed withdrawal leaves one change note.
      ...(commitments.withdrawChange ? [{ txHash: WITHDRAW_TX.slice(2), outputCommitments: [commitments.withdrawChange], withdrawnValue: '10300000' }] : []),
    ],
    ragequits: commitments.exited ? [{ txHash: EXIT_TX, commitment: commitments.exited }] : [],
    txAt: new Map([
      [DEPOSIT_TX.slice(2), { ledger: 5_460_001, time: 1_790_000_000 }],
      [SEND_TX.slice(2), { ledger: 5_460_100, time: 1_790_000_500 }],
      [WITHDRAW_TX.slice(2), { ledger: 5_460_200, time: 1_790_001_000 }],
    ]),
  };
}

function deps(h: StellarPoolHistory, over: Partial<StellarVerifyDeps> = {}): StellarVerifyDeps {
  return {
    recompute: recomputeStellarCommitment,
    labelHash: async (label) => label as never,
    loadHistory: async () => h,
    labelStatus: async () => 'approved',
    ...over,
  };
}

describe('Stellar partial viewing key', () => {
  test('recomputes the commitment exactly as the SDK binds a Stellar note', async () => {
    const commitment = await sdkCommitment(BOB, '0x1234', '0x989680', '0xabc');
    expect(BigInt(await recomputeStellarCommitment(bundle(commitment)))).toBe(BigInt(commitment));
  });

  test('a sent note found among the pool outputs verifies, with the chain time', async () => {
    const commitment = await sdkCommitment(BOB, '0x1234', '0x989680', '0xabc');
    // Events carry commitments unpadded; the bundle carries them padded.
    const padded = `0x${BigInt(commitment).toString(16).padStart(64, '0')}`;
    const res = await verifyStellarPartialViewingKey(bundle(padded), deps(history({ sendOut: commitment })));
    expect(res).toMatchObject({ hashMatch: true, onChain: true, verified: true, onChainTimestampSec: 1_790_000_500 });
  });

  test('a forged amount does not reproduce the commitment, and is not borrowed from the real note', async () => {
    const commitment = await sdkCommitment(BOB, '0x1234', '0x989680', '0xabc');
    const res = await verifyStellarPartialViewingKey(bundle(commitment, { value: '0x1312d00' as never }), deps(history({ sendOut: commitment })));
    expect(res.hashMatch).toBe(false);
    expect(res.onChain).toBe(false);
    expect(res.verified).toBe(false);
  });

  test('a receipt naming another transaction than the one that minted its note fails', async () => {
    const commitment = await sdkCommitment(BOB, '0x1234', '0x989680', '0xabc');
    // Minted by SEND_TX; the receipt claims WITHDRAW_TX.
    const res = await verifyStellarPartialViewingKey(bundle(commitment, { txHash: WITHDRAW_TX as never }), deps(history({ sendOut: commitment })));
    expect(res).toMatchObject({ hashMatch: true, onChain: false, verified: false, onChainTimestampSec: null });
    expect(res.error).toContain('different transaction');
    // The minting tx matches whatever its spelling.
    const ok = await verifyStellarPartialViewingKey(bundle(commitment, { txHash: SEND_TX.slice(2).toUpperCase() as never }), deps(history({ sendOut: commitment })));
    expect(ok.verified).toBe(true);
  });

  test('a consistent bundle that was never minted is not verified', async () => {
    const commitment = await sdkCommitment(ME, '0x99', '0x989680', '0xabc');
    const res = await verifyStellarPartialViewingKey(bundle(commitment, { ownerAddress: ME as never, noteSecret: '0x99' as never }), deps(history({})));
    expect(res).toMatchObject({ hashMatch: true, onChain: false, verified: false });
  });

  test('an unreadable history is an error, never a verdict', async () => {
    const commitment = await sdkCommitment(BOB, '0x1234', '0x989680', '0xabc');
    const res = await verifyStellarPartialViewingKey(bundle(commitment), deps(history({}), { loadHistory: async () => { throw new Error('ASP down'); } }));
    expect(res.verified).toBe(false);
    expect(res.error).toContain('ASP down');
  });
});

describe('Stellar history lookups', () => {
  test('deposit outputs count as on chain', () => {
    expect(stellarCommitmentOnChain(history({ deposit: '0x5' }), `0x${'0'.repeat(63)}5`)).toEqual({ onChain: true, txHash: DEPOSIT_TX, timestampSec: 1_790_000_000 });
  });

  test('an exit is tied only to the exact exited note', () => {
    const h = history({ exited: '0x9' });
    expect(stellarOriginLink(h, { type: 'exit', txHash: EXIT_TX }, '0x9').targetLinked).toBe(true);
    expect(stellarOriginLink(h, { type: 'exit', txHash: EXIT_TX }, '0x8').targetLinked).toBe(false);
  });

  test('a withdrawal ties to its change note whatever the hash spelling, with what left and the ledger', () => {
    const link = stellarOriginLink(history({ withdrawChange: '0x42' }), { type: 'withdraw', txHash: WITHDRAW_TX }, '0x42');
    expect(link).toEqual({ targetLinked: true, withdrawnValue: '10300000', withdrawnBlock: '5460200' });
  });

  test('a transfer output is not a withdrawal', () => {
    expect(stellarOriginLink(history({ sendOut: '0x42' }), { type: 'withdraw', txHash: SEND_TX }, '0x42').targetLinked).toBe(false);
  });
});

describe('Stellar proof of origin', () => {
  const proof = async (target: OriginProofV1['target']) => {
    const commitment = await sdkCommitment(ME, '0x55', '0x0', '0xabc');
    const p: OriginProofV1 = {
      v: 1, kind: 'origin', chainId: 202,
      note: { ownerAddress: ME as never, noteSecret: '0x55' as never, tokenId: XLM as never, value: '0x0' as never, label: '0xabc' as never },
      target,
    };
    return { p, commitment };
  };

  test('a relayed withdrawal proven from its change note, with the ASP status', async () => {
    const { p, commitment } = await proof({ type: 'withdraw', txHash: WITHDRAW_TX as never });
    const res = await verifyStellarOriginProof(p, deps(history({ withdrawChange: commitment })));
    expect(res).toMatchObject({ noteOnChain: true, targetLinked: true, withdrawnValue: '10300000', aspStatus: 'approved', verified: true });
  });

  test('an unreachable ASP leaves the ownership verdict standing', async () => {
    const { p, commitment } = await proof({ type: 'withdraw', txHash: WITHDRAW_TX as never });
    const res = await verifyStellarOriginProof(p, deps(history({ withdrawChange: commitment }), { labelStatus: async () => { throw new Error('down'); } }));
    expect(res.aspStatus).toBe('unavailable');
    expect(res.verified).toBe(true);
  });

  test('an exit of a different note is not proven', async () => {
    const { p } = await proof({ type: 'exit', txHash: EXIT_TX as never });
    const res = await verifyStellarOriginProof(p, deps(history({ exited: '0x1' })));
    expect(res.verified).toBe(false);
  });
});
