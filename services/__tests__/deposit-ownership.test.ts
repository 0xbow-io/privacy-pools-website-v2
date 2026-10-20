import { beforeAll, describe, expect, test } from 'bun:test';
import { CryptoService, NoteComputationService, PoseidonHashService } from '@privacy-pools-v2/sdk';
import { buildBlindDepositBackup, splitNoteData, type BackupCryptoLike, type BackupNoteComputationLike } from '@/services/blind-deposit-backup';
import { noteIdentitySets, depositMatchesMyNotes } from '../deposit-ownership';

import {
  depositsNeedingViewingKeyCheck,
  isMyDeposit,
  resolveDepositOwnership,
  normalizeCommitment,
  isNoteForViewingKey,
  ownershipSettled,
  ownershipVerdictPending,
  viewingKeyVerdicts,
  type DepositOwnershipInputs,
} from '@/services/deposit-ownership';

const ME = '0xd3581763f41fc0763a49e9ab53f2d3d425870a3d';
const SOMEONE = '0x1111111111111111111111111111111111111111';

const inputs = (over: Partial<DepositOwnershipInputs> = {}): DepositOwnershipInputs => ({
  ownedCommitments: new Set<string>(),
  paidRequestTxHashes: new Set<string>(),
  connectedAddress: ME,
  ...over,
});

describe('resolveDepositOwnership. Signal precedence', () => {
  // 1. Owning the commitment is the strongest signal: it survives any device
  //    and any missing stamp.
  test('owned commitment wins over everything, even a payment stamp', () => {
    const r = resolveDepositOwnership(
      { txHash: '0xtx', commitment: '0xCOMMIT', depositor: SOMEONE },
      inputs({
        ownedCommitments: new Set(['0xcommit']),
        paidRequestTxHashes: new Set(['0xtx']),
        viewingKeyMatches: new Map([['0xtx', false]]),
      }),
    );
    expect(r).toEqual({ mine: true, basis: 'owned-commitment', definitive: true });
  });

  // 2. The viewing-key verdict outranks the per-device stamp — same certainty,
  //    but it holds on a device that never saw the payment.
  test('viewing-key match beats a stale local stamp', () => {
    const r = resolveDepositOwnership(
      { txHash: '0xtx', depositor: ME },
      inputs({
        paidRequestTxHashes: new Set(['0xtx']),
        viewingKeyMatches: new Map([['0xtx', true]]),
      }),
    );
    expect(r.mine).toBe(true);
    expect(r.basis).toBe('viewing-key-match');
  });

  // THE BUG THIS EXISTS FOR: I submitted it, so the old heuristic said mine,
  // but the payload is encrypted to someone else's key.
  test('viewing-key mismatch marks my own submission as NOT mine', () => {
    const r = resolveDepositOwnership(
      { txHash: '0xtx', depositor: ME },
      inputs({ viewingKeyMatches: new Map([['0xtx', false]]) }),
    );
    expect(r).toEqual({ mine: false, basis: 'viewing-key-mismatch', definitive: true });
  });

  test('the local stamp settles it when there is no viewing-key verdict', () => {
    const r = resolveDepositOwnership(
      { txHash: '0xTX', depositor: ME },
      inputs({ paidRequestTxHashes: new Set(['0xtx']) }),
    );
    expect(r).toEqual({ mine: false, basis: 'paid-request-stamp', definitive: true });
  });

  test('falls back to the depositor heuristic, flagged non-definitive', () => {
    expect(resolveDepositOwnership({ txHash: '0xtx', depositor: ME }, inputs()))
      .toEqual({ mine: true, basis: 'depositor-fallback', definitive: false });
    expect(resolveDepositOwnership({ txHash: '0xtx', depositor: SOMEONE }, inputs()).mine).toBe(false);
  });
});

describe('resolveDepositOwnership. Safety of the unknown case', () => {
  // An RPC failure leaves no entry in the map. Treating that as "not mine"
  // would hide real money, which is worse than the over-count being fixed.
  test('an ABSENT viewing-key entry is not a negative verdict', () => {
    const r = resolveDepositOwnership(
      { txHash: '0xtx', depositor: ME },
      inputs({ viewingKeyMatches: new Map() }),
    );
    expect(r.mine).toBe(true);
    expect(r.basis).toBe('depositor-fallback');
    expect(r.definitive).toBe(false);
  });

  test('a verdict for a DIFFERENT tx does not leak onto this one', () => {
    const r = resolveDepositOwnership(
      { txHash: '0xtx', depositor: ME },
      inputs({ viewingKeyMatches: new Map([['0xother', false]]) }),
    );
    expect(r.basis).toBe('depositor-fallback');
    expect(r.mine).toBe(true);
  });
});

describe('resolveDepositOwnership. Normalization and missing fields', () => {
  test('case-insensitive on hash, commitment and depositor', () => {
    expect(isMyDeposit({ commitment: '0xABC' }, inputs({ ownedCommitments: new Set(['0xabc']) }))).toBe(true);
    expect(isMyDeposit({ txHash: '0xAB' }, inputs({ paidRequestTxHashes: new Set(['0xab']) }))).toBe(false);
    expect(isMyDeposit({ depositor: ME.toUpperCase() }, inputs())).toBe(true);
  });

  test('no depositor and no signals => not mine, never a crash', () => {
    expect(isMyDeposit({}, inputs())).toBe(false);
    expect(isMyDeposit({ txHash: null, commitment: null, depositor: null }, inputs())).toBe(false);
  });

  test('a disconnected wallet cannot claim a deposit by the fallback', () => {
    expect(isMyDeposit({ depositor: ME }, inputs({ connectedAddress: null }))).toBe(false);
  });

  test('empty strings are treated as absent, not as a match', () => {
    expect(isMyDeposit({ commitment: '', depositor: '' }, inputs({ ownedCommitments: new Set(['']) }))).toBe(false);
  });

  test('raw lowercase commitment sets keep every match they had before canonicalisation', () => {
    const paddedHexInputs = inputs({ ownedCommitments: new Set(['0x00ab']) });
    expect(isMyDeposit({ commitment: '0x00AB' }, paddedHexInputs)).toBe(true);
    expect(depositsNeedingViewingKeyCheck(
      [{ txHash: '0xtx', commitment: '0x00AB', depositor: ME }],
      paddedHexInputs,
    )).toEqual([]);

    expect(isMyDeposit(
      { commitment: '000171' },
      inputs({ ownedCommitments: new Set(['000171']) }),
    )).toBe(true);
  });
});

describe('depositsNeedingViewingKeyCheck', () => {
  // The RPC read must stay bounded: only ambiguous deposits I submitted.
  test('asks only about my own submissions that nothing cheaper settled', () => {
    const need = depositsNeedingViewingKeyCheck(
      [
        { txHash: '0xa', depositor: ME },                              // ambiguous -> ask
        { txHash: '0xb', depositor: ME, commitment: '0xmine' },        // owned -> skip
        { txHash: '0xc', depositor: ME },                              // stamped -> skip
        { txHash: '0xd', depositor: SOMEONE },                         // not mine anyway -> skip
        { txHash: '0xe', depositor: ME },                              // already judged -> skip
        { depositor: ME },                                             // no hash -> skip
      ],
      inputs({
        ownedCommitments: new Set(['0xmine']),
        paidRequestTxHashes: new Set(['0xc']),
        viewingKeyMatches: new Map([['0xe', true]]),
      }),
    );
    expect(need).toEqual(['0xa']);
  });

  test('dedupes repeated hashes and lowercases them', () => {
    expect(depositsNeedingViewingKeyCheck(
      [{ txHash: '0xAA', depositor: ME }, { txHash: '0xaa', depositor: ME }],
      inputs(),
    )).toEqual(['0xaa']);
  });

  test('asks nothing when disconnected', () => {
    expect(depositsNeedingViewingKeyCheck(
      [{ txHash: '0xa', depositor: ME }],
      inputs({ connectedAddress: null }),
    )).toEqual([]);
  });
});

describe('outgoing deposit-for stamp', () => {
  test('a stamped plain depositFor is not mine, definitively, even though I submitted it', () => {
    const r = resolveDepositOwnership(
      { txHash: '0xTX', depositor: ME },
      inputs({ outgoingDepositTxHashes: new Set(['0xtx']) }),
    );
    expect(r).toEqual({ mine: false, basis: 'outgoing-deposit-stamp', definitive: true });
  });

  test('owning the commitment still wins (self-recipient normalised elsewhere, but be safe)', () => {
    const r = resolveDepositOwnership(
      { txHash: '0xtx', commitment: '0xc', depositor: ME },
      inputs({ ownedCommitments: new Set(['0xc']), outgoingDepositTxHashes: new Set(['0xtx']) }),
    );
    expect(r.mine).toBe(true);
  });

  test('stamped deposits need no viewing-key check', () => {
    const need = depositsNeedingViewingKeyCheck(
      [{ txHash: '0xtx', depositor: ME }, { txHash: '0xother', depositor: ME }],
      inputs({ outgoingDepositTxHashes: new Set(['0xtx']) }),
    );
    expect(need).toEqual(['0xother']);
  });
});

describe('normalizeCommitment (the decimal-vs-hex join)', () => {
  // Real values: the ASP snapshot writes DECIMAL, notes carry 0x-HEX.
  // Verified live against api-dev.0xbow.io on 2026-08-28.
  const SNAPSHOT_DECIMAL = '11200345852414246528603263393471031257587159217805756822686788904378779799531';
  const NOTE_HEX = '0x18c32bcd418a0cd7c10c4124e9509ea4037a7f6b0e18957d23577f58eaa38feb';

  test('the two representations of ONE commitment normalise to the same key', () => {
    // This is the whole bug: .toLowerCase() left these unequal, so the
    // strongest ownership signal never fired and deposits fell through to the
    // depositor heuristic (and rows fell back to amount-matching).
    expect(SNAPSHOT_DECIMAL.toLowerCase()).not.toBe(NOTE_HEX.toLowerCase());
    expect(normalizeCommitment(SNAPSHOT_DECIMAL)).toBe(NOTE_HEX);
    expect(normalizeCommitment(NOTE_HEX)).toBe(NOTE_HEX);
    expect(normalizeCommitment('172')).not.toBe(normalizeCommitment('171'));
  });

  test('ownership by commitment now matches a snapshot deposit against a note', () => {
    const inputs = {
      ownedCommitments: new Set([normalizeCommitment(NOTE_HEX)!]),
      paidRequestTxHashes: new Set<string>(),
      connectedAddress: null,
    };
    const owned = resolveDepositOwnership(
      { txHash: '0xabc', commitment: SNAPSHOT_DECIMAL, depositor: '0xsomeone-else' },
      inputs,
    );
    expect(owned.mine).toBe(true);
    expect(owned.basis).toBe('owned-commitment');
    expect(owned.definitive).toBe(true);
  });

  test('case and leading zeroes do not create distinct keys', () => {
    expect(normalizeCommitment('0x00AB')).toBe(normalizeCommitment('0xab'));
    expect(normalizeCommitment('0XAB')).toBe(normalizeCommitment('0xab'));
    expect(normalizeCommitment(' 171 ')).toBe(normalizeCommitment('0xab'));
  });

  test('empty input is null; UNPARSEABLE input keeps the exact old lowercase behaviour', () => {
    for (const empty of ['', null, undefined]) {
      expect(normalizeCommitment(empty as string)).toBeNull();
    }
    // Not null: null would downgrade ownership to the depositor heuristic and
    // hide real money. The fallback is exactly what .toLowerCase() did, so a
    // non-numeric value still matches itself.
    expect(normalizeCommitment('0xCOMMIT')).toBe('0xcommit');
    expect(normalizeCommitment('not-a-number')).toBe('not-a-number');
    expect(normalizeCommitment('  not-a-number  ')).toBe('  not-a-number  ');
    expect(normalizeCommitment('   ')).toBe('   ');
  });

  test('negative and unsupported BigInt syntaxes stay on the legacy fallback path', () => {
    expect(normalizeCommitment('-171')).toBe('-171');
    expect(normalizeCommitment('-0xAB')).toBe('-0xab');
    expect(normalizeCommitment('0x-AB')).toBe('0x-ab');
    expect(normalizeCommitment('0b10101011')).toBe('0b10101011');
    expect(normalizeCommitment('0o253')).toBe('0o253');
  });

  test('huge decimal values normalise without precision loss', () => {
    const huge = `1${'0'.repeat(1000)}`;
    expect(normalizeCommitment(huge)).toBe(`0x${BigInt(huge).toString(16)}`);
  });
});

describe("depositMatchesMyNotes — ownership when someone else paid the gas (Pat's cross-chain shield, 2026-08-29)", () => {
  const LABEL = '0x00000000000000000000000000000000000000000000000000000000000000ab';
  const sets = noteIdentitySets([
    { txHash: '0xDEAD', label: LABEL },
    { txHash: '0x0', label: undefined },      // placeholder hash: never an identity
    { txHash: undefined, label: '0xCC' },
  ]);

  test("LiFi's executor is the depositor, but the row's label is my note's: mine", () => {
    expect(depositMatchesMyNotes({ txHash: '0xc9e6…', label: LABEL.toUpperCase() }, sets)).toBe(true);
  });

  test('a tx hash my note carries is mine, case-insensitively', () => {
    expect(depositMatchesMyNotes({ txHash: '0xdead', label: null }, sets)).toBe(true);
  });

  test("someone else's deposit with a foreign label is not mine", () => {
    expect(depositMatchesMyNotes({ txHash: '0xbeef', label: '0x99' }, sets)).toBe(false);
  });

  test("the SDK's 0x0 placeholder hash never makes a row mine", () => {
    expect(sets.txHashes.has('0x0')).toBe(false);
    expect(depositMatchesMyNotes({ txHash: '0x0', label: null }, sets)).toBe(false);
  });

  test('labels compare case-insensitively', () => {
    expect(depositMatchesMyNotes({ txHash: null, label: '0xcc' }, sets)).toBe(true);
  });

  test('a snapshot row is mine by its exact commitment, in either encoding', () => {
    const owned = noteIdentitySets([{ txHash: undefined, label: undefined, commitment: '0xab' }]);
    expect(depositMatchesMyNotes({ txHash: '0xbeef', label: null, commitment: String(0xab) }, owned)).toBe(true);
    expect(depositMatchesMyNotes({ txHash: '0xbeef', label: null, commitment: '0xac' }, owned)).toBe(false);
  });

  test('labels compare across encodings: the ASP sends decimal, notes carry hex', () => {
    expect(depositMatchesMyNotes({ txHash: null, label: String(0xab) }, sets)).toBe(true);
    expect(depositMatchesMyNotes({ txHash: null, label: String(0xcc) }, sets)).toBe(true);
    expect(depositMatchesMyNotes({ txHash: null, label: String(0x99) }, sets)).toBe(false);
  });
});

describe('viewing-key verdicts (signal 3) over harvested Note ciphertexts', () => {
  type Hex = `0x${string}`;
  const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  let crypto: CryptoService;
  let ncs: NoteComputationService;
  let mine: { privateKey: Hex; publicKey: Hex };
  let theirs: { privateKey: Hex; publicKey: Hex };
  let isMine: (c: { ephemeralPubKey: string; encryptedPayload: string }) => boolean;

  beforeAll(async () => {
    crypto = new CryptoService();
    ncs = new NoteComputationService({ hashService: await PoseidonHashService.create(), cryptoService: crypto });
    mine = crypto.generateEphemeralKeyPair() as typeof mine;
    theirs = crypto.generateEphemeralKeyPair() as typeof theirs;
    isMine = isNoteForViewingKey(
      { ecdh: (a, b) => crypto.ecdh(a, b), decrypt: (c, s) => crypto.decrypt(c, s), decodeNotePayload: (b) => ncs.decodeNotePayload(b) },
      mine.privateKey,
    );
  });

  // The announcement the SDK itself builds for a deposit's note.
  const noteSealedTo = (viewingPublicKey: Hex) => {
    const { data } = ncs.generateNoteData(
      { noteSecret: crypto.generateSecret(), value: '0x2386f26fc10000', tokenId: ETH, label: crypto.generateSecret() },
      viewingPublicKey,
    );
    const split = splitNoteData(data);
    if (!split) throw new Error('unsplittable note data');
    return split;
  };

  test("a real note sealed to my viewing key is mine; one sealed to another account's is not", () => {
    expect(isMine(noteSealedTo(mine.publicKey))).toBe(true);
    expect(isMine(noteSealedTo(theirs.publicKey))).toBe(false);
  });

  test("a blind deposit's claim backup opens with MY key but is the recipient's note, so not mine", () => {
    const backup = buildBlindDepositBackup({
      recipient: '0x42bacd8d0c811a2ba95e5d44f9c71d984299e308',
      tokenId: ETH,
      value: '0xb5e620f48000',
      noteSecret: crypto.generateSecret(),
      depositSecret: crypto.generateSecret(),
      senderViewingPubKey: mine.publicKey,
      noteComputation: ncs as unknown as BackupNoteComputationLike,
      crypto: crypto as unknown as BackupCryptoLike,
      randomFill: (out) => { globalThis.crypto.getRandomValues(out as unknown as Uint8Array<ArrayBuffer>); },
    });
    const split = splitNoteData(backup.noteData.data);
    if (!split) throw new Error('unsplittable backup');
    // It does open with the sender's key: that is the point of the backup.
    expect(() => crypto.decrypt(split.encryptedPayload, crypto.ecdh(mine.privateKey, split.ephemeralPubKey))).not.toThrow();
    expect(isMine(split)).toBe(false);
  });

  test('garbage never throws, it is simply not mine', () => {
    expect(isMine({ ephemeralPubKey: '0x00', encryptedPayload: '0x00' })).toBe(false);
  });

  test('my wallet paid, another account owns it: definitively NOT mine, ahead of the depositor fallback', () => {
    const ciphertexts = new Map([['0xpaid', [noteSealedTo(theirs.publicKey)]]]);
    const verdicts = viewingKeyVerdicts(['0xPAID'], (h) => ciphertexts.get(h) ?? [], isMine);
    expect(verdicts.get('0xpaid')).toBe(false);
    expect(resolveDepositOwnership({ txHash: '0xpaid', depositor: ME }, inputs({ viewingKeyMatches: verdicts })))
      .toEqual({ mine: false, basis: 'viewing-key-mismatch', definitive: true });
  });

  test('a batch that also carries a note for me is mine', () => {
    const ciphertexts = new Map([['0xbatch', [noteSealedTo(theirs.publicKey), noteSealedTo(mine.publicKey)]]]);
    expect(viewingKeyVerdicts(['0xbatch'], (h) => ciphertexts.get(h) ?? [], isMine).get('0xbatch')).toBe(true);
  });

  test('a tx discovery has not seen gets NO verdict, so the depositor fallback stands', () => {
    const verdicts = viewingKeyVerdicts(['0xunseen'], () => [], isMine);
    expect(verdicts.has('0xunseen')).toBe(false);
    expect(resolveDepositOwnership({ txHash: '0xunseen', depositor: ME }, inputs({ viewingKeyMatches: verdicts })).basis)
      .toBe('depositor-fallback');
  });
});

describe('ownershipVerdictPending: hold a guess only while its answer is coming', () => {
  const TX = '0xA45C';
  const pending = (over: Partial<Parameters<typeof ownershipVerdictPending>[0]> = {}) => ownershipVerdictPending({
    txHash: TX,
    depositorIsMe: true,
    keysHeld: true,
    locallyKnown: false,
    snapshot: 'loaded',
    verdicts: new Map(),
    settled: new Set(),
    ...over,
  });

  test('held while the snapshot that carries the ciphertexts is still loading', () => {
    expect(pending({ snapshot: 'loading', settled: new Set(['0xa45c']) })).toBe(true);
  });

  test('held once loaded until a verdict pass has covered this deposit', () => {
    expect(pending()).toBe(true);
  });

  test('released by a verdict, either way', () => {
    expect(pending({ verdicts: new Map([['0xa45c', false]]) })).toBe(false);
    expect(pending({ verdicts: new Map([['0xa45c', true]]), snapshot: 'loading' })).toBe(false);
  });

  test('released once a pass settled it without a verdict: the depositor fallback stands', () => {
    expect(pending({ settled: new Set(['0xa45c']) })).toBe(false);
  });

  test('a failed snapshot never holds past the pass that settles what it can', () => {
    expect(pending({ snapshot: 'failed', settled: new Set(['0xa45c']) })).toBe(false);
  });

  test('never held when no answer can come, or none is needed', () => {
    expect(pending({ keysHeld: false })).toBe(false);
    expect(pending({ depositorIsMe: false })).toBe(false);
    expect(pending({ locallyKnown: true })).toBe(false);
    expect(pending({ txHash: null })).toBe(false);
  });
});

describe('ownershipSettled: settle a deposit only once nothing more can come for it', () => {
  const settled = (over: Partial<Parameters<typeof ownershipSettled>[0]> = {}) => ownershipSettled({
    inSnapshot: false,
    hasCiphertexts: false,
    chainSnapshotLoaded: true,
    ...over,
  });

  test('a deposit only the activity feed has seen waits for the snapshot or discovery to carry it', () => {
    expect(settled()).toBe(false);
  });

  test('settled once the snapshot holds it, or its ciphertexts are here', () => {
    expect(settled({ inSnapshot: true })).toBe(true);
    expect(settled({ hasCiphertexts: true })).toBe(true);
  });

  test("settled when its chain's snapshot failed: the depositor fallback stands", () => {
    expect(settled({ chainSnapshotLoaded: false })).toBe(true);
  });
});
