/**
 * The /verify checks for a Stellar disclosure: the Stellar half of
 * services/audit-receipt.ts, which hands a bundle or proof here when its chain
 * is Stellar. Same verdicts, same rules, Stellar's own primitives:
 *
 *  - the commitment is recomputed with the Stellar field conversions the SDK
 *    uses for its notes (`StellarAddressFieldConverter`: the owner's G… StrKey
 *    and the asset's C… StrKey become field elements), so a forged amount,
 *    owner or token cannot reproduce the claimed commitment;
 *  - "is it on chain" is answered from the pool's WHOLE event history, read in
 *    bulk by contract id from the ASP's Stellar event archive (the same request
 *    note discovery makes). Nothing sent names the disclosed note;
 *  - a proof of origin's ASP status is classified locally from the pool's bulk
 *    label and leaf sets (StellarTestnetAspProvider), never asked per label.
 *
 * The chain reads are injectable so the rules are testable without a network.
 */
import type { Hash, Hex } from '@/services/sdk-types';
import type {
  AspStatus,
  OriginProofV1,
  OriginVerifyResult,
  PartialViewingKeyV1,
  VerifyResult,
} from '@/services/audit-receipt';
import { looksLikeRealWithdrawalFromArity } from '@/services/transact-shape';

/** The pool's history as the verifier needs it, decoded. */
export type StellarPoolHistory = {
  deposits: readonly { txHash: string; outputCommitment: string }[];
  transacts: readonly { txHash: string; outputCommitments: readonly string[]; withdrawnValue: string }[];
  ragequits: readonly { txHash: string; commitment: string }[];
  /** Where and when each tx landed, by tx hash (ledger, unix seconds; 0 when unknown). */
  txAt: ReadonlyMap<string, { ledger: number; time: number }>;
};

/** The disclosed preimage a Stellar commitment is recomputed from. */
export type StellarNotePreimage = { ownerAddress: string; noteSecret: string; tokenId: string; value: string; label: string };

export type StellarVerifyDeps = {
  recompute: (note: StellarNotePreimage) => Promise<Hash>;
  labelHash: (label: string) => Promise<Hash>;
  loadHistory: () => Promise<StellarPoolHistory>;
  labelStatus: (labelHash: Hash) => Promise<AspStatus>;
};

/** One spelling for a tx hash: Stellar hashes come with and without 0x. */
export function stellarTxKey(value: string): string {
  return String(value ?? '').toLowerCase().replace(/^0x/, '');
}

function sameCommitment(a: string, b: string): boolean {
  try { return BigInt(a) === BigInt(b); } catch { return String(a).toLowerCase() === String(b).toLowerCase(); }
}

/** Whether a commitment was minted on chain (a deposit or a transact output), in which tx, and when. */
export function stellarCommitmentOnChain(history: StellarPoolHistory, commitment: string): { onChain: boolean; txHash: string | null; timestampSec: number | null } {
  let txHash: string | null = null;
  for (const d of history.deposits) {
    if (sameCommitment(d.outputCommitment, commitment)) { txHash = d.txHash; break; }
  }
  if (!txHash) {
    for (const t of history.transacts) {
      if (t.outputCommitments.some((c) => sameCommitment(c, commitment))) { txHash = t.txHash; break; }
    }
  }
  if (!txHash) return { onChain: false, txHash: null, timestampSec: null };
  const time = history.txAt.get(stellarTxKey(txHash))?.time ?? 0;
  return { onChain: true, txHash, timestampSec: time > 0 ? time : null };
}

/**
 * Ties a disclosed note to a public withdrawal or exit, by the same rules as
 * the EVM verifier: an exit's Ragequit names exactly this commitment; a
 * withdrawal took value out of the pool and this note is one of its outputs.
 */
export function stellarOriginLink(
  history: StellarPoolHistory,
  target: { type: 'withdraw' | 'exit'; txHash: string },
  commitment: string,
): { targetLinked: boolean; withdrawnValue: string | null; withdrawnBlock: string | null } {
  const key = stellarTxKey(target.txHash);
  if (target.type === 'exit') {
    const ev = history.ragequits.find((r) => stellarTxKey(r.txHash) === key);
    return { targetLinked: !!ev && sameCommitment(ev.commitment, commitment), withdrawnValue: null, withdrawnBlock: null };
  }
  const ev = history.transacts.find((t) => stellarTxKey(t.txHash) === key);
  if (!ev) return { targetLinked: false, withdrawnValue: null, withdrawnBlock: null };
  let withdrew = false;
  try { withdrew = BigInt(ev.withdrawnValue) > 0n; } catch { withdrew = false; }
  // The arity rule is "consistent with", not proof; see services/transact-shape.ts.
  const isRealWithdrawal = looksLikeRealWithdrawalFromArity(ev.outputCommitments.length, withdrew);
  const ownsOutput = ev.outputCommitments.some((c) => sameCommitment(c, commitment));
  const ledger = history.txAt.get(key)?.ledger ?? 0;
  return {
    targetLinked: isRealWithdrawal && ownsOutput,
    withdrawnValue: String(ev.withdrawnValue),
    withdrawnBlock: ledger > 0 ? String(ledger) : null,
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function verifyStellarPartialViewingKey(bundle: PartialViewingKeyV1, deps: StellarVerifyDeps = defaultDeps()): Promise<VerifyResult> {
  const base: VerifyResult = { hashMatch: false, recomputedCommitment: null, onChain: false, onChainTimestampSec: null, verified: false };
  let recomputed: Hash;
  try {
    recomputed = await deps.recompute(bundle);
  } catch (err) {
    return { ...base, error: `Could not recompute commitment: ${message(err)}` };
  }
  const hashMatch = sameCommitment(recomputed, bundle.commitment);
  try {
    // The recomputed commitment, never the claimed one: a forged commitment
    // field cannot borrow another note's presence on chain.
    const minted = stellarCommitmentOnChain(await deps.loadHistory(), recomputed);
    // The receipt names its transaction: the note must have been minted in
    // exactly that one, or a real note could vouch for an unrelated tx.
    const sameTx = minted.txHash !== null && stellarTxKey(minted.txHash) === stellarTxKey(String(bundle.txHash ?? ''));
    const onChain = minted.onChain && sameTx;
    return {
      hashMatch,
      recomputedCommitment: recomputed,
      onChain,
      onChainTimestampSec: onChain ? minted.timestampSec : null,
      verified: hashMatch && onChain,
      ...(minted.onChain && !sameTx ? { error: 'This note was created in a different transaction than the one this receipt names.' } : {}),
    };
  } catch (err) {
    return { ...base, recomputedCommitment: recomputed, hashMatch, error: `On-chain check failed: ${message(err)}` };
  }
}

export async function verifyStellarOriginProof(p: OriginProofV1, deps: StellarVerifyDeps = defaultDeps()): Promise<OriginVerifyResult> {
  const base: OriginVerifyResult = {
    noteCommitment: null, noteOnChain: false, targetLinked: false,
    withdrawnValue: null, withdrawnBlock: null, aspStatus: 'unavailable', verified: false,
  };
  let commitment: Hash;
  let labelHash: Hash;
  try {
    commitment = await deps.recompute(p.note);
    labelHash = await deps.labelHash(p.note.label);
  } catch (err) {
    return { ...base, error: `Could not recompute the note: ${message(err)}` };
  }
  base.noteCommitment = commitment;
  try {
    const history = await deps.loadHistory();
    base.noteOnChain = stellarCommitmentOnChain(history, commitment).onChain;
    const link = stellarOriginLink(history, p.target, commitment);
    base.targetLinked = link.targetLinked;
    base.withdrawnValue = link.withdrawnValue;
    base.withdrawnBlock = link.withdrawnBlock;
  } catch (err) {
    return { ...base, error: `On-chain check failed: ${message(err)}` };
  }
  // Best effort, as on EVM: it never decides ownership.
  try {
    base.aspStatus = await deps.labelStatus(labelHash);
  } catch {
    base.aspStatus = 'unavailable';
  }
  base.verified = base.noteOnChain && base.targetLinked;
  return base;
}

// ------------------------------------------------------------------ live deps

/** Recomputes a Stellar note commitment the way the SDK binds a Stellar note. */
export async function recomputeStellarCommitment(note: StellarNotePreimage): Promise<Hash> {
  const { computation, converter } = await stellarComputation();
  const noteAddressHash = computation.computeNoteAddressHash(converter.toField(note.ownerAddress), note.noteSecret as Hex);
  return computation.computeFullCommitment({
    noteAddressHash,
    tokenId: converter.toTokenIdField(note.tokenId),
    value: note.value as Hex,
    label: note.label as Hex,
  }) as Hash;
}

async function stellarComputation() {
  const { loadStellarSdk } = await import('@/services/stellar/stellar-runtime');
  const sdk = await loadStellarSdk();
  const hashService = await sdk.PoseidonHashService.create();
  const computation = new sdk.NoteComputationService({ hashService, cryptoService: new sdk.StellarCryptoService() } as never);
  return { sdk, computation, converter: new sdk.StellarAddressFieldConverter() as unknown as { toField(a: string): Hex; toTokenIdField(a: string): Hex } };
}

/** The pool's whole event history: one bulk read by contract id, decoded by the SDK's own adapter. */
export async function loadStellarPoolHistory(): Promise<StellarPoolHistory> {
  const [{ loadStellarSdk, createIndexedRpcInteractor }, { STELLAR_TESTNET_CONTRACTS }, { ASP_URL }] = await Promise.all([
    import('@/services/stellar/stellar-runtime'),
    import('@/config/stellar-deployment'),
    import('@/config/env'),
  ]);
  const sdk = await loadStellarSdk();
  const contractId = STELLAR_TESTNET_CONTRACTS.poolContractId;
  const page = await createIndexedRpcInteractor(sdk, ASP_URL).getEvents({ contractId } as never);
  // Fed the page already in hand, so decoding makes no request of its own.
  const adapter = new sdk.StellarPoolVaultChainAdapter({
    rpcInteractor: { getEvents: async () => page } as never,
    contractId,
    readSourcePublicKey: sdk.STELLAR_NEUTRAL_READ_SOURCE,
  });
  const [deposits, transacts, ragequits] = await Promise.all([
    adapter.fetchDepositedEvents(),
    adapter.fetchTransactedEvents(),
    adapter.fetchRagequitEvents(),
  ]);
  const txAt = new Map<string, { ledger: number; time: number }>();
  for (const e of page.events) {
    const key = stellarTxKey(String(e.transactionHash));
    if (!key || txAt.has(key)) continue;
    const parsed = e.ledgerClosedAt ? Date.parse(e.ledgerClosedAt) : NaN;
    txAt.set(key, { ledger: Number(e.ledger) || 0, time: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0 });
  }
  return {
    deposits: deposits.map((d) => ({ txHash: String(d.txHash), outputCommitment: String(d.outputCommitment) })),
    transacts: transacts.map((t) => ({ txHash: String(t.txHash), outputCommitments: t.outputCommitments.map(String), withdrawnValue: String(t.withdrawnValue) })),
    ragequits: ragequits.map((r) => ({ txHash: String(r.txHash), commitment: String(r.commitment) })),
    txAt,
  };
}

function defaultDeps(): StellarVerifyDeps {
  return {
    recompute: recomputeStellarCommitment,
    labelHash: async (label) => {
      const { computation } = await stellarComputation();
      return computation.computeLabelHash(label as Hex) as Hash;
    },
    loadHistory: loadStellarPoolHistory,
    labelStatus: async (labelHash) => {
      const [{ loadStellarSdk, StellarTestnetAspProvider }, { ASP_URL }] = await Promise.all([
        import('@/services/stellar/stellar-runtime'),
        import('@/config/env'),
      ]);
      const res = await new StellarTestnetAspProvider(await loadStellarSdk(), ASP_URL).getLabelStatus(labelHash);
      return (res?.status as AspStatus) ?? 'unknown';
    },
  };
}
