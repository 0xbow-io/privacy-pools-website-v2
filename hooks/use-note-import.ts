import { useCallback, useRef, useState } from 'react';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { useAccount, usePublicClient, useSendTransaction, useSignTypedData, useSwitchChain } from 'wagmi';

import { usePoolSession } from '@/hooks/use-pool-session';
import { useRelayerQuote } from '@/hooks/use-relayer';
import { useDebug } from '@/components/debug-provider';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { getChainConfig, isSupportedEvmChainId } from '@/config/chains';
import { LEGACY_CONFIG } from '@/config/env';
import { registrationTopUpEnabled, supportsColdStartClaim } from '@/config/cold-start';
import { decodeGasTopUpWei } from '@/services/gas-top-up';
import { receiveSetupFromIdentity, setReceiveSetup } from '@/services/receive-setup';
import { getWithdrawalProcessorAddress } from '@/config/relayer';
import {
  buildRegistrationDeadline,
  convergeFeeOnlyQuote,
  feeOnlyQuoteFits,
  isAmountRejection,
  planFeeOnlyClaim,
  readRegistrationPath,
  type RegistrationPathReason,
} from '@/services/cold-start-claim';
import { mergeImportedNote } from '@/services/payment-requests';
import {
  CLAIM_FEE_EXCEEDS_PAYMENT,
  CLAIM_PROVING,
  RELAY_WAITING_BLOCK,
  RELAY_WAITING_RELAYER,
  claimRelayFailureText,
  isClaimRelayMethod,
  quoteWithFreshRetry,
} from '@/services/relay-step-copy';
import { onRelayedTxHash, onRelayCalled } from '@/services/relayed-receipt';
import {
  clearUnanchoredNotes,
  recordUnanchoredNotes,
} from '@/services/unanchored-notes-store';
import { recordAnchorStamps } from '@/services/anchor-stamps-store';
import { recordClaimInputs } from '@/services/claim-records-store';
import { recordWithdrawFee } from '@/services/withdraw-fees-store';
import { probeTransferFee } from '@/services/transfer-fee-quote';
import { NoteStatus } from '@/services/sdk-types';
import { linkImportRefusal, unanchoredLinkNotes } from '@/services/note-receipt-shape';
import {
  isBlockedApproval,
  LinkNotApprovedError,
  type BlockedLinkApproval,
  type LinkApprovalCheck,
} from '@/services/link-approval-rules';
import { claimErrorApproval, claimErrorText } from '@/services/claim-error-text';
import type { Address as SdkAddress, Hash, Hex, Note, TxReceiptLike } from '@/services/sdk-types';
import {
  buildTransferRecipient,
  loadTransferRecipientDeps,
  plainTransferRelayError,
  planTransferOutputs,
  relayerTransferQuotes,
  relayTransferParams,
  requestTransferQuote,
  transferRelayExpectation,
  transferRelayFee,
} from '@/services/relayed-transfer';
import { expectTransferRelay } from '@/services/transfer-relay-outputs';

export type NoteImportStatus =
  | 'idle'
  | 'importing'
  | 'imported'
  | 'anchoring'
  | 'anchored'
  | 'error';

/**
 * How a wallet that cannot pay gas will claim, when it can at all.
 *
 * - `register-and-withdraw`: the account has no auth policy yet, so the relayer
 *   registers it AND relays the claim in one `PrivacyPoolRelay.registerAndRelay`
 *   transaction. Needs a relay that carries that selector (config/cold-start.ts).
 * - `withdraw`: the auth policy is already on-chain (an earlier cold-start claim
 *   set it) but the wallet still cannot afford the `setViewingKey` transaction
 *   today's path would send. A plain relayed claim needs no registration leg and
 *   no allow-list — every relay the app talks to relays withdrawals.
 */
export type GaslessClaimMode = 'register-and-withdraw' | 'withdraw';

/**
 * Who pays for the on-chain claim.
 *
 * `unfunded` is the honest third answer, and the reason this is a union rather
 * than a nullable plan: a wallet with no gas on a chain whose relay has no
 * `registerAndRelay` can neither pay nor be carried. The claim is still ATTEMPTED
 * (the affordability estimate is a heuristic and must not veto a claim that would
 * have worked), but the page warns first instead of letting the wallet reject the
 * transaction with a raw "insufficient funds for gas * price + value".
 */
export type ClaimFunding =
  /** `walletGasWei`: the registration gas estimate, set only when the balance read showed the wallet covers it (DEV-493). */
  | { kind: 'self-funded'; walletGasWei?: bigint }
  | { kind: 'relayed'; mode: GaslessClaimMode; reason: RegistrationPathReason }
  | { kind: 'unfunded'; reason: RegistrationPathReason };

/**
 * The transact circuit's input ceiling, mirrored from the SDK's `MAX_INPUTS`.
 * A relayed claim spends the whole receipt in one transact (the bundled
 * registration is one-shot), so it cannot exceed this the way the self-funded
 * path — one transact per note — could.
 */
const RELAYED_CLAIM_MAX_INPUTS = 5;

/** When each claim (chain + its unanchored commitments) was first tried in this page. */
const claimFirstTriedAt = new Map<string, number>();

// A recovered claim's commitment was derived from the claimant's own address a
// moment ago, with createdAtBlock forced to the stub, so the snapshot MUST date
// it before anything is written. A wrong claimant's commitment is simply not in
// the tree; importing it anyway would leave a phantom "owned" note that nothing
// later purges, reported to the user as a successful claim (codex round 3).
// Only a COMPLETE lookup proves the mismatch; an incomplete one says "not yet".
/**
 * Every note this link carries must be on chain before anything is written,
 * not only the recovered claims.
 *
 * A link is attacker-controllable, and a FULL receipt names its own commitment
 * and stamps its own status, so a crafted one used to be merged verbatim and
 * read as ACTIVE balance with no chain read at all (audit finding F-01). The
 * anchor path did run this check, but AFTER the merge, which leaves the same
 * note on the device. Both paths now ask first and write second.
 */
function assertLinkNotesAnchored(
  healed: readonly Note[],
  recovered: ReadonlySet<string>,
  verifiedAbsent: boolean,
): void {
  const refusal = linkImportRefusal(
    unanchoredLinkNotes(healed.map((n) => ({
      commitment: n.commitment,
      createdAtBlock: (n as { createdAtBlock?: string }).createdAtBlock,
      recovered: recovered.has(String(n.commitment).toLowerCase()),
    }))),
    verifiedAbsent,
  );
  if (refusal) throw new Error(refusal);
}

/**
 * What a link may claim about a note's status: nothing. The receipt writes
 * ACTIVE because the sender knew it was spendable, but the reader cannot tell
 * a real receipt from a crafted one, and the discovery sync is what promotes a
 * note once its commitment is on chain and its label approved. Storing PENDING
 * costs a legitimate claim one sync and denies a crafted one its whole point.
 */
function asPendingImport(note: Note): Note {
  return { ...note, status: NoteStatus.PENDING } as Note;
}

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user rejected|user denied|user cancel/i.test(msg)) {
    return 'Transaction cancelled in your wallet.';
  }
  // "note 0x… is not ACTIVE" means nothing to the person claiming.
  return claimErrorText(msg) ?? msg;
}

async function checkLinkApproval(notes: readonly Note[], chainId: number): Promise<LinkApprovalCheck> {
  try {
    const { resolveLinkApproval } = await import('@/services/link-approval');
    return await resolveLinkApproval(notes, chainId);
  } catch {
    return 'unknown';
  }
}

/**
 * Shared import-a-received-note state machine used by both the
 * /import-note receipt page and the paste-to-import modal.
 *
 * Deliberately NOTHING here persists across a page reload beyond what the
 * SDK already caches per session: notes are device-local convenience
 * state, and the durable record is the chain (the on-chain anchor) or an
 * explicit backup. `importOnChain` is the recoverable path; `importToDevice`
 * is faster but lives only in this browser.
 */
export function useNoteImport() {
  const { address } = useAccount();
  // The chain this flow ACTS ON — the app's selection, not the wallet's.
  //
  // This was useChainId(), which returns wagmi's config state = the WALLET's
  // chain. Every wagmi hook already defaults its chainId to exactly that, so
  // reads here silently followed the wallet while the display surfaces
  // (pools-provider, action-hub) followed the app selection. The two agree
  // only while ChainProvider can keep them in sync — a wallet parked on an
  // unsupported chain with the switch prompt dismissed leaves them split, and
  // then the form showed "Wallet balance 446.4 USDT" beside "Insufficient
  // balance (0.0000 USDT available)".
  //
  // Sourcing it from the app selection also makes the `walletChainId !==
  // chainId` switch guard below meaningful: it used to compare the wallet's
  // chain against itself and could never fire.
  const chainId = useActiveEvmChain().id;
  // The chain of the SDK session the import actually mutates (connector-first).
  // Stamped receipts are rechecked against THIS immediately before merging —
  // the surfaces' UI gate alone can pass while the display selection and the
  // session chain split (codex).
  const sessionChainId = useSessionChainId();
  const publicClient = usePublicClient({ chainId });
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const { getQuote } = useRelayerQuote();
  // The PrivacyPoolRelay the claim is relayed through. It is BOTH the on-chain
  // msg.sender the proof must bind as its processor and half the cold-start
  // allow-list key — an older relay on the same chain has no registerAndRelay.
  const withdrawalProcessorAddress = getWithdrawalProcessorAddress(chainId);
  const {
    exportAccount,
    importAccount,
    ensureInitialized,
    refreshNotes,
    keystoreManager,
    getCommittedManagers,
    identityMode,
    // The identity the account export is FILED under (= effectiveAddress, where
    // a key identity outranks a connected wallet). Every per-owner record about
    // these notes must use this and not wagmi's `address`: they diverge in a key
    // session, and with no wallet connected `address` is undefined entirely,
    // which is the normal state for someone claiming from a receipt link.
    sessionAddress,
    keystoreStatusForChain,
  } = usePoolSession();
  const { log } = useDebug();
  // The Claim callout reads this status; it is fetched once per session, so a
  // claim that registers the wallet has to say so or the callout outlives it.
  const { markRegistered } = useKeystoreRegistrationModal();

  const [status, setStatus] = useState<NoteImportStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [errMessage, setErrMessage] = useState<string | null>(null);
  // Generation guard: reset()/a new run invalidates any in-flight run's
  // completion, so a claim finished after the modal closed (or after another
  // note was imported) can never label the NEW note claimed/failed.
  const runIdRef = useRef(0);
  // Synchronous re-entrancy guard — `busy` state only flips on the next
  // render, so a same-tick double-tap would start two anchors.
  const runningRef = useRef(false);
  // Durable "a note is merged locally but not anchored on-chain" flag for the
  // tab-close guard. Unlike `status`, it survives a later error (the on-chain
  // anchor path imports locally FIRST, then does fallible registration/relay
  // work — a failure there must not silently drop the warning) and survives
  // `reset()`/modal close. Cleared only when anchoring succeeds.
  const [hasUnanchoredLocalNote, setHasUnanchoredLocalNote] = useState(false);
  // Advisory copy for the claim surface: who will pay if the claim is pressed
  // now. `null` = not probed yet. The submit re-probes from the live balance, so
  // this value never decides anything — it only lets the page promise the right
  // thing before the user commits.
  const [claimFunding, setClaimFunding] = useState<ClaimFunding | null>(null);
  // Native gas the relayed claim forwarded to the wallet; null if none.
  const [claimGasTopUpWei, setClaimGasTopUpWei] = useState<bigint | null>(null);
  // DEV-482: how the confirmed relayed claim split the payment (fee, public
  // payout to the wallet as gas money, change that stays shielded); null if none.
  const [claimSplit, setClaimSplit] = useState<{ feeWei: bigint; payoutWei: bigint; changeWei: bigint } | null>(null);
  // Set when the last claim was refused because the link is not approved yet,
  // so the surface can show the waiting state instead of a retry hint.
  const [approvalBlock, setApprovalBlock] = useState<BlockedLinkApproval | null>(null);
  // DEV-493: a claim refused as too small, from a wallet that holds gas, can
  // still register the wallet so FUTURE payments arrive directly. Registering
  // claims nothing: the small payment stays saved on this device.
  const [registerOffer, setRegisterOffer] = useState<{ gasCostWei: bigint; chainId: number } | null>(null);
  const [registerState, setRegisterState] = useState<{ status: 'idle' | 'registering' | 'registered' | 'error'; error?: string }>({ status: 'idle' });
  // `chainId:account` the advisory probe has already answered for — see
  // probeClaimFunding.
  const probedFundingRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setStatus('idle');
    setStatusMessage('');
    setErrMessage(null);
    setApprovalBlock(null);
    // A prior run's top-up must not survive to describe a later claim that
    // received none — only that run's own confirmed quote may set this again.
    setClaimGasTopUpWei(null);
    setClaimSplit(null);
    setRegisterOffer(null);
    setRegisterState({ status: 'idle' });
    // Deliberately NOT clearing hasUnanchoredLocalNote — the local note is
    // still unanchored regardless of the UI being dismissed.
  }, []);

  // The transact witness's state leaf is TIMESTAMPED — Poseidon(commitment,
  // createdAtBlock) — so a receipt whose createdAtBlock is the '0x0' stub (a
  // pre-confirmation base receipt, or a payment link rebuilt from the audit
  // store) computes a leaf that does not exist on-chain and the anchor dies
  // with "Leaf … not found in tree" (QA 2026-08-17). Heal the stub from the
  // note's txHash before merging: the tx's block timestamp is exactly what
  // the enriched receipt would have stamped.
  //
  // Bound to `targetChainId` (the receipt's own chain, falling back to the
  // session chain) — NOT the display selection, which can diverge from the
  // session and made both paths query the wrong chain (GLM review C2).
  // `verifiedAbsent` is true ONLY when a complete snapshot lookup ran and the
  // commitment was genuinely missing; infrastructure failures leave it false
  // so the caller can say "couldn't verify" instead of "not on-chain" (C3).
  const resolveCreatedAtBlocks = useCallback(async (
    notes: Note[],
    targetChainId: number,
  ): Promise<{ notes: Note[]; verifiedAbsent: boolean }> => {
    const isStub = (raw: string | undefined) => {
      if (!raw) return true;
      try { return BigInt(raw) === 0n; } catch { return true; }
    };
    const needsFix = (n: Note) => isStub((n as { createdAtBlock?: string }).createdAtBlock);
    if (!notes.some(needsFix)) return { notes, verifiedAbsent: false };
    console.log('[ImportNote][heal] notes needing createdAtBlock', notes.filter(needsFix).map((n) => ({
      commitment: n.commitment, txHash: (n as { txHash?: string }).txHash, createdAtBlock: (n as { createdAtBlock?: string }).createdAtBlock,
    })), 'targetChainId', targetChainId);
    // A "Path 1" used to sit here: getTransactionReceipt on the note's txHash,
    // then getBlock on the resulting block number, to read the leaf timestamp.
    // It is DELETED, and it must not come back.
    //
    // That txHash is the SENDER'S relayed transfer. Asking a public RPC about it
    // by hash, from the recipient's browser, on every single claim, lets the
    // provider join "this client asked about transfer X" against "transfer X's
    // output commitment", which it separately sees on chain. That links this
    // device to the note it now owns, and to whoever sent it. Recipient-side
    // unlinkability is the property the pool exists to provide.
    //
    // It is the case named verbatim in CLAUDE.md and
    // docs/privacy-request-discipline.md: waitForTransactionReceipt / getBlock on
    // a RELAYED tx hash.
    //
    // Deleting it costs nothing. The snapshot path below already resolves the
    // same timestamp for the same note - in bulk, over every transact, sharing
    // the copy note discovery has already downloaded - and hands back the txHash
    // as well. Path 1 was only ever a shortcut past a lookup that already had the
    // answer. The one behavioural difference is that a stale or unreachable
    // snapshot now fails to heal where the targeted read would have succeeded;
    // that is the safe direction, since the caller reports "couldn't verify"
    // rather than "not on-chain" (verifiedAbsent stays false).
    let out: Note[] = [...notes];
    // Path 2 — no usable txHash (a pre-confirmation base receipt): find the
    // commitment in the ASP event snapshot's Transacted outputs. Full-history
    // per pool, so absence in a COMPLETE lookup means the payment never
    // landed on-chain. Filtered to transacts only — the claim path doesn't
    // need the leaves/keystore/notes bulk.
    let verifiedAbsent = false;
    if (out.some(needsFix)) {
      try {
        const { loadPoolEventSnapshot, poolEventSnapshotHeldAt } = await import('@/services/snapshot-source');
        const { snapshotTimestampToMs } = await import('@/services/outgoing-transfers');
        // The copy the feed grid keeps, never a fetch of our own. Asking the
        // ASP for a fresh one the moment a claim is pasted told it when this
        // device took the payment, which ties the recipient to it by timing
        // just as the deleted receipt read did by hash.
        //
        // So `verifiedAbsent` below, which turns "not in this snapshot" into
        // "the payment never landed on-chain", needs a copy brought up to date
        // AFTER this claim was first tried: the first try reads "couldn't
        // verify yet", and a retry past the grid's next instant gets a real
        // answer either way.
        const triedKey = `${targetChainId}:${out.filter(needsFix).map((n) => String(n.commitment).toLowerCase()).sort().join(',')}`;
        const firstTried = claimFirstTriedAt.get(triedKey) ?? Date.now();
        claimFirstTriedAt.set(triedKey, firstTried);
        // Stamp first: a refresh landing between the two reads would date this
        // copy by a newer one.
        const heldAt = await poolEventSnapshotHeldAt(targetChainId);
        const snapshot = await loadPoolEventSnapshot(targetChainId);
        const { indexCommitmentTimestamps, normalizeCommitment: normalize } =
          await import('@/services/note-timestamp-heal');
        // Indexes transacts AND deposits: a claim-link note from a deposit for
        // an unregistered recipient is a deposits[] row, and indexing only
        // transacts left it at the 0x0 stub, which the anchor path rejects.
        // Snapshot timestamps arrive as unix seconds, unix ms, OR ISO —
        // snapshotTimestampToMs handles all three (Date.parse alone dropped
        // unix-second rows and 'verified' false absences, GLM review C1).
        const { byCommitment, skippedRows, transactsIndexed, depositsIndexed } =
          indexCommitmentTimestamps(snapshot, snapshotTimestampToMs);
        console.log(
          '[ImportNote][heal] snapshot fallback:',
          transactsIndexed, 'transacts and', depositsIndexed, 'deposits indexed,', skippedRows, 'skipped',
        );
        // Absence is only PROVEN when every row was readable, in a copy newer
        // than the first try.
        verifiedAbsent = skippedRows === 0 && heldAt !== undefined && heldAt > firstTried;
        out = out.map((n) => {
          if (!needsFix(n)) return n;
          const hit = byCommitment.get(normalize(String(n.commitment)));
          console.log('[ImportNote][heal] snapshot lookup', n.commitment, '→', hit ?? 'NOT FOUND');
          if (!hit) return n;
          return { ...n, createdAtBlock: `0x${hit.ts.toString(16)}` as Hex, txHash: hit.txHash as Note['txHash'] };
        });
      } catch (e) {
        console.log('[ImportNote][heal] snapshot fallback failed', e instanceof Error ? e.message : String(e));
      }
    }
    return { notes: out, verifiedAbsent };
  }, []);

  // A claim recovered from the sender's on-chain backup names no owner and
  // carries no commitment (services/blind-deposit-backup.ts keeps only the
  // four fields the SDK announces). Materialise both from the claimant's own
  // identity BEFORE healing: the healer looks the note up by commitment in
  // the snapshot, so it needs the real one. Only the true recipient's address
  // reproduces the committed noteAddressHash; a wrong claimant gets a
  // commitment that is not in the tree, and the healer's absence proof then
  // says so rather than importing something unspendable. Shared by the device
  // and the on-chain path: the anchor path used to skip it and hand an
  // owner-less note to the merge (codex round 3).
  const materializeRecoveredClaims = useCallback(async (
    notes: Note[],
    owner: string | null | undefined,
  ): Promise<{ notes: Note[]; recovered: Set<string> }> => {
    const { isRecoveredClaimNote } = await import('@/services/note-receipt');
    const isRecovered = (n: Note) => isRecoveredClaimNote(n as unknown as Record<string, unknown>);
    const recovered = new Set<string>();
    if (!notes.some(isRecovered)) return { notes, recovered };
    if (!owner) {
      throw new Error('Sign in as the recipient first: this claim link names no address, so your signed-in account is the one it is claimed for.');
    }
    const { recomputeCommitment } = await import('@/services/audit-receipt');
    const ownerAddress = owner as Note['ownerAddress'];
    const materialized = await Promise.all(notes.map(async (n) => {
      if (!isRecovered(n)) return n;
      const commitment = await recomputeCommitment({
        ownerAddress,
        noteSecret: n.noteSecret,
        tokenId: n.tokenId,
        value: n.value,
        label: n.label,
      } as never);
      recovered.add(String(commitment).toLowerCase());
      // Built from the validated fields ONLY, no spread: nothing else the link
      // carried rides along (a supplied noteAddressHash would be kept by the
      // SDK's import migration instead of derived from the owner, a supplied
      // timestamp would skip the healer). createdAtBlock is forced to the stub
      // so the snapshot MUST date this commitment before anything is written,
      // and the note is a fresh, unspent, owned one by construction.
      return {
        commitment,
        value: n.value,
        tokenId: n.tokenId,
        label: n.label,
        noteSecret: n.noteSecret,
        txHash: n.txHash,
        ownerAddress,
        status: NoteStatus.ACTIVE,
        isOwned: true,
        createdAtBlock: '0x0' as Hex,
        spentAtBlock: null,
        parentCommitmentHash: null,
        // noteAddressHash deliberately absent: backfillNoteAddressHashes
        // derives it from (ownerAddress, noteSecret) on the way into the SDK.
      } as Note;
    }));
    log('info', 'ImportNote', 'Recovered claim materialised for the signed-in recipient', {
      count: recovered.size,
      commitments: [...recovered],
    });
    return { notes: materialized, recovered };
  }, [log]);

  // Device-only: merge the note into this browser's NoteManager. Fast,
  // no fees — but it lives only here until the user anchors or backs up.
  const importToDevice = useCallback(async (input: Note | Note[], opts?: { expectedChainId?: number }) => {
    // Share the anchor path's synchronous lock (codex round 1, P0): a same-
    // tick double press used to run two concurrent merges of the same
    // export blob — last write wins, potentially dropping the other's notes.
    if (runningRef.current) return;
    runningRef.current = true;
    // A two-lineage transfer emits one note per lineage; the receipt packs
    // them all, and dropping any loses the recipient's funds. Merge every note.
    const notes = Array.isArray(input) ? input : [input];
    setStatus('importing');
    setStatusMessage('');
    setErrMessage(null);
    // An earlier claim's refusal describes that claim, not this import.
    setApprovalBlock(null);
    try {
      // Chain recheck at the merge boundary (codex): the receipt's stamped
      // chain must match the session this merge writes into.
      if (opts?.expectedChainId !== undefined && opts.expectedChainId !== sessionChainId) {
        throw new Error(`This receipt is for chain ${opts.expectedChainId} but the session is on chain ${sessionChainId}. Switch networks and retry.`);
      }
      await ensureInitialized();
      if (notes.length === 0) throw new Error('There is nothing to claim in this link.');
      const { notes: materialized, recovered } = await materializeRecoveredClaims(notes, sessionAddress);
      const { notes: healedNotes, verifiedAbsent } = await resolveCreatedAtBlocks(materialized, opts?.expectedChainId ?? sessionChainId);
      // BEFORE the merge: nothing below runs for a recovered claim the snapshot
      // could not date.
      assertLinkNotesAnchored(healedNotes, recovered, verifiedAbsent);
      let account = await exportAccount();
      for (const note of healedNotes) {
        account = mergeImportedNote(account, asPendingImport(note));
      }
      // Non-null after at least one merge (guarded above); TS can't see it.
      await importAccount(account as NonNullable<typeof account>);
      setHasUnanchoredLocalNote(true);
      refreshNotes();
      // Durable for as long as the note is. My balances cannot otherwise know this
      // value is link-only: its claim callout asks whether the WALLET is
      // unregistered, which is already satisfied for most people who reach here.
      // healedNotes, not notes: a recovered claim only HAS a commitment after
      // materialisation above.
      recordUnanchoredNotes(sessionAddress, sessionChainId, healedNotes.map((n) => n.commitment));
      setStatus('imported');
      log('info', 'ImportNote', 'Note(s) imported (device only)', {
        count: healedNotes.length,
        commitments: healedNotes.map((n) => n.commitment),
      });
    } catch (e) {
      setStatus('error');
      setErrMessage(describeError(e));
      log('error', 'ImportNote', `Device import failed: ${describeError(e)}`, e);
    } finally {
      runningRef.current = false;
    }
  }, [ensureInitialized, exportAccount, importAccount, refreshNotes, sessionChainId, sessionAddress, resolveCreatedAtBlocks, materializeRecoveredClaims, log]);

  // "Can this wallet pay for its own claim, or must the relayer carry it?"
  //
  // The cold-start case this exists for: a freshly created wallet receives its
  // first private payment and holds NO native currency, so every transaction
  // today's path sends — the keystore registration, the viewing key — is
  // impossible. Instead the wallet signs an EIP-712 `SetAuthPolicy` off-chain
  // (free) and the relayer submits `PrivacyPoolRelay.registerAndRelay`, which
  // runs `Keystore.setAuthPolicyWithSig` and the claim in ONE transaction and
  // takes its fee out of the note being claimed. The relayer prices its own
  // work; this side does no gas arithmetic beyond deciding WHETHER to ask.
  //
  // Balance is the trigger, matching the withdraw modal's policy: a funded
  // wallet keeps paying its own registration gas rather than silently moving
  // that cost onto the payment it is claiming.
  const resolveClaimFunding = useCallback(async (
    owner: SdkAddress,
    session: Awaited<ReturnType<typeof ensureInitialized>>,
  ): Promise<ClaimFunding> => {
    // No client to read the balance with: assume the wallet pays, which is the
    // behaviour this flow has always had.
    if (!publicClient) return { kind: 'self-funded' };
    // `supported: true` asks the affordability question ONLY — whether the chain
    // can carry a registration leg is a separate gate below, because the
    // registration-free variant needs no allow-list. A failed balance read
    // resolves to self-funded inside the helper, never to "empty wallet".
    const decision = await readRegistrationPath({
      getBalanceWei: () => publicClient.getBalance({ address: owner as `0x${string}` }),
      getGasPriceWei: () => publicClient.getGasPrice(),
    }, {
      onReadError: (scope, err) => log('warn', 'ImportNote', `${scope} read failed for the claim-funding decision`, err),
    });
    if (decision.path !== 'relayed-claim') {
      log('info', 'ImportNote', 'Wallet funds its own claim', {
        reason: decision.reason,
        balanceWei: decision.balanceWei.toString(),
        estimatedGasCostWei: decision.estimatedGasCostWei.toString(),
      });
      return decision.reason === 'funded'
        ? { kind: 'self-funded', walletGasWei: decision.estimatedGasCostWei }
        : { kind: 'self-funded' };
    }
    // Already-registered accounts must NOT take the bundled route: the SDK
    // refuses it ("Account is already registered") and the on-chain
    // setAuthPolicyWithSig one-time guard would fire. They still get a gasless
    // claim, just without the registration leg.
    let authPolicyRegistered = false;
    try {
      authPolicyRegistered = await session.isKeystoreRegistered();
    } catch (err) {
      // Fail closed: an unreadable registration state must not send a bundled
      // registration at an account that may already have one.
      log('warn', 'ImportNote', 'Registration check failed; no relayed claim offered', err);
      return { kind: 'unfunded', reason: decision.reason };
    }
    if (authPolicyRegistered) {
      log('info', 'ImportNote', 'Relayed claim without a registration leg', { reason: decision.reason });
      return { kind: 'relayed', mode: 'withdraw', reason: decision.reason };
    }
    const supported = supportsColdStartClaim(
      chainId,
      withdrawalProcessorAddress,
      // Static member read — Metro only inlines static process.env.EXPO_PUBLIC_*
      // access in the production web export.
      process.env.EXPO_PUBLIC_COLD_START_CLAIM_RELAYS,
    );
    if (!supported) {
      // No verified registerAndRelay on this chain+relay. Offering the claim
      // would die inside the relayer's simulate, after the user had signed and
      // paid for ~15s of proving.
      log('warn', 'ImportNote', 'Cold-start claim unavailable on this chain', {
        chainId,
        relay: withdrawalProcessorAddress,
        reason: decision.reason,
      });
      return { kind: 'unfunded', reason: decision.reason };
    }
    log('info', 'ImportNote', 'Cold-start register-and-withdraw claim', {
      reason: decision.reason,
      balanceWei: decision.balanceWei.toString(),
      gasPriceWei: (decision.gasPriceWei ?? 0n).toString(),
    });
    return { kind: 'relayed', mode: 'register-and-withdraw', reason: decision.reason };
  }, [publicClient, chainId, withdrawalProcessorAddress, log]);

  // Advisory probe for the claim surface — run it once the account is unlocked
  // so the page can promise "no gas needed" (or not) BEFORE the user presses
  // claim. Never throws: an unavailable answer just leaves the default copy.
  const probeClaimFunding = useCallback(async () => {
    if (identityMode !== 'wallet' || !address) {
      probedFundingRef.current = null;
      setClaimFunding(null);
      return;
    }
    // Idempotent per (chain, account). Callers drive this from an effect, and
    // the probe SETS state — without this latch an unstable dependency (a fresh
    // publicClient or log identity) would spin: render → probe → setState →
    // render. It also keeps two RPC reads and a registration check off every
    // re-render. A real account or chain switch changes the key and re-probes.
    const key = `${chainId}:${address.toLowerCase()}`;
    if (probedFundingRef.current === key) return;
    probedFundingRef.current = key;
    try {
      const session = await ensureInitialized();
      setClaimFunding(await resolveClaimFunding(address as SdkAddress, session));
    } catch (err) {
      // Clear the latch so a transient failure does not silence the advisory —
      // including the "this wallet has no gas" warning — for the whole session.
      // Safe against a render loop: `setClaimFunding(null)` when it is already
      // null is a no-op React bails out of, so a caller-driven effect cannot
      // spin on the failure path the way it could on the success path.
      probedFundingRef.current = null;
      log('debug', 'ImportNote', 'Claim-funding probe skipped', err);
      setClaimFunding(null);
    }
  }, [identityMode, address, chainId, ensureInitialized, resolveClaimFunding, log]);

  type KeystoreRegistration = Awaited<ReturnType<Awaited<ReturnType<typeof ensureInitialized>>['prepareRegisterKeystore']>>;
  // The self-funded registration legs (auth policy, then viewing key), each
  // confirmed. Shared by the claim and the DEV-493 register-only offer.
  const sendRegistrationLegs = useCallback(async (registration: KeystoreRegistration) => {
    // A public client is REQUIRED here: without it a reverted registration
    // would go unnoticed and the note would be labelled anchored while its
    // inbox was never set up. Fail closed instead.
    if (!publicClient) {
      throw new Error('Cannot confirm the on-chain setup on this network. Try again in a moment.');
    }
    if (registration.keystoreCalldata) {
      const keystoreHash = await sendTransactionAsync({
        chainId,
        to: registration.keystoreCalldata.to,
        data: registration.keystoreCalldata.data,
        value: BigInt(registration.keystoreCalldata.value),
      });
      const keystoreReceipt = await publicClient.waitForTransactionReceipt({ hash: keystoreHash, timeout: 180_000 });
      // viem RESOLVES for a reverted tx — the status field is the only signal.
      if (keystoreReceipt.status !== 'success') {
        throw new Error('Inbox setup failed on-chain. Your funds are still saved on this device. Retry.');
      }
    }
    if (registration.viewingKeyCalldata) {
      const viewingKeyHash = await sendTransactionAsync({
        chainId,
        to: registration.viewingKeyCalldata.to,
        data: registration.viewingKeyCalldata.data,
        value: BigInt(registration.viewingKeyCalldata.value),
      });
      const viewingKeyReceipt = await publicClient.waitForTransactionReceipt({ hash: viewingKeyHash, timeout: 180_000 });
      if (viewingKeyReceipt.status !== 'success') {
        throw new Error('Account setup failed on-chain. Your funds are still saved on this device. Retry.');
      }
    }
    try {
      keystoreManager?.markRegistered(chainId);
    } catch {
      // SDK already has it; duplicate marker calls are harmless.
    }
    markRegistered(sessionAddress, chainId);
    setReceiveSetup(sessionAddress, chainId, 'complete', 'onchain');
  }, [publicClient, sendTransactionAsync, chainId, keystoreManager, markRegistered, sessionAddress]);

  // DEV-493: register the wallet without claiming (see registerOffer).
  const registerWalletOnly = useCallback(async () => {
    if (runningRef.current || identityMode !== 'wallet' || !address) return;
    runningRef.current = true;
    // Same run-generation guard as the claim: a reset() (modal closed, next
    // link opened) while this is pending must not paint "Registered" there.
    const runId = ++runIdRef.current;
    const live = () => runIdRef.current === runId;
    setRegisterState({ status: 'registering' });
    try {
      // The legs are sent on chainId, so the wallet has to be there first.
      if (isSupportedEvmChainId(chainId)) {
        await switchChainAsync({ chainId });
      }
      const session = await ensureInitialized();
      const registration = await session.prepareRegisterKeystore();
      if (!registration.alreadyRegistered) {
        if (!registration.keystoreCalldata && !registration.viewingKeyCalldata) {
          throw new Error('On-chain setup is unavailable for this session.');
        }
        await sendRegistrationLegs(registration);
      } else {
        setReceiveSetup(sessionAddress, chainId, 'complete', 'onchain');
      }
      if (live()) {
        setRegisterOffer(null);
        setRegisterState({ status: 'registered' });
      }
    } catch (e) {
      log('warn', 'ImportNote', 'Register-only setup failed', e);
      if (live()) setRegisterState({ status: 'error', error: describeError(e) });
    } finally {
      runningRef.current = false;
    }
  }, [identityMode, address, ensureInitialized, sendRegistrationLegs, sessionAddress, chainId, switchChainAsync, log]);
  const dismissRegisterOffer = useCallback(() => setRegisterOffer(null), []);

  // On-chain anchor: register the viewing key if needed and self-transfer
  // the imported commitment so it emits a discoverable Note event
  // recoverable from any device. Wallet-only: registration is an
  // owner-signed on-chain tx and the SDK keystore manager has no wallet
  // interactor, so the calldata must be submitted through wagmi — the
  // same path the keystore registration modal uses. Account-key sessions
  // have no wallet to sign it, hence the identityMode guard.
  //
  // A wallet that cannot pay for those transactions takes the relayed route
  // instead (see resolveClaimFunding): the relayer registers it and claims on
  // its behalf, taking its cut out of the note.
  // PENDING (or INACTIVE) to ACTIVE in the live session, then persisted. True
  // only when every note landed ACTIVE.
  const promoteApprovedNotes = useCallback(async (commitments: readonly Hash[]): Promise<boolean> => {
    const { noteManager } = getCommittedManagers();
    if (!noteManager) return false;
    try {
      for (const commitment of commitments) {
        if (noteManager.getNote(commitment).status === NoteStatus.INACTIVE) {
          noteManager.updateNoteStatus(commitment, NoteStatus.PENDING);
        }
        if (noteManager.getNote(commitment).status === NoteStatus.PENDING) {
          noteManager.updateNoteStatus(commitment, NoteStatus.ACTIVE);
        }
      }
      if (commitments.some((c) => noteManager.getNote(c).status !== NoteStatus.ACTIVE)) return false;
    } catch {
      return false;
    }
    await exportAccount();
    refreshNotes();
    return true;
  }, [getCommittedManagers, exportAccount, refreshNotes]);

  const importOnChain = useCallback(async (input: Note | Note[], opts?: { expectedChainId?: number }) => {
    const notes = Array.isArray(input) ? input : [input];
    if (runningRef.current) {
      // A previous anchor's wallet prompt may still be unresolved. Refusing
      // silently made the button a dead click after a reset() — say so.
      // (Never clear runningRef from reset(): two concurrent anchors would
      // race prepareTransfer on the same commitment.)
      //
      // But the refusal is a MESSAGE, never a state transition (QA
      // 2026-08-26). setStatus('error') here dropped `busy` -- derived from
      // `status` at the bottom of this hook -- which re-enabled the Claim
      // button and replaced the live 'Generating proof...' label with 'Claim
      // on-chain', mid-proof. The user read the flow as dead and kept
      // pressing; every press re-armed this same branch. The run that owns
      // the button keeps owning it until its own finally releases the lock.
      setErrMessage('A claim is already in progress. Finish or cancel it in your wallet.');
      return;
    }
    if (identityMode !== 'wallet' || !address) {
      setStatus('error');
      setErrMessage('Connect the wallet this payment was sent to.');
      return;
    }
    const owner = address as SdkAddress;
    runningRef.current = true;
    const runId = ++runIdRef.current;
    // A completion from a superseded run must not touch shared state.
    const live = () => runIdRef.current === runId;
    setStatus('anchoring');
    setErrMessage(null);
    setApprovalBlock(null);
    // This run's own confirmed quote is the only thing allowed to set this
    // again — a stale top-up from a previous run must not be shown as if it
    // applied to a claim that received none.
    setClaimGasTopUpWei(null);
    setClaimSplit(null);
    setRegisterOffer(null);
    try {
      // Before the network switch and everything after it: a link whose deposit
      // is not approved yet cannot be spent, so nothing should reach the wallet.
      // `unknown` falls through to the check after the merge below.
      const preApproval = await checkLinkApproval(notes, opts?.expectedChainId ?? sessionChainId);
      if (isBlockedApproval(preApproval)) throw new LinkNotApprovedError(preApproval);

      if (isSupportedEvmChainId(chainId)) {
        await switchChainAsync({ chainId });
      }

      if (live()) setStatusMessage('Claiming…');
      if (notes.length === 0) throw new Error('There is nothing to claim in this link.');
      // Chain recheck at the merge boundary (codex) — see importToDevice.
      if (opts?.expectedChainId !== undefined && opts.expectedChainId !== sessionChainId) {
        throw new Error(`This receipt is for chain ${opts.expectedChainId} but the session is on chain ${sessionChainId}. Switch networks and retry.`);
      }
      const session = await ensureInitialized();
      // A recovered claim gets its owner and commitment from the connected
      // wallet first (see materializeRecoveredClaims); the healer and the
      // merge below both key on the commitment.
      const { notes: materialized, recovered } = await materializeRecoveredClaims(notes, owner);
      // Heal stubbed createdAtBlock BEFORE the merge — the anchor's witness
      // reads the note from NoteManager, so the corrected timestamp must be
      // the one that lands there (see resolveCreatedAtBlocks).
      const { notes: healedNotes, verifiedAbsent } = await resolveCreatedAtBlocks(materialized, opts?.expectedChainId ?? sessionChainId);
      // A recovered claim the snapshot could not date is refused here, before
      // the merge below writes anything (the general unresolved check further
      // down runs after it, for full receipts).
      assertLinkNotesAnchored(healedNotes, recovered, verifiedAbsent);
      let account = await exportAccount();
      for (const note of healedNotes) {
        account = mergeImportedNote(account, asPendingImport(note));
      }
      await importAccount(account as NonNullable<typeof account>);
      setHasUnanchoredLocalNote(true);
      refreshNotes();
      // Record it HERE, before the anchor is attempted, not only on the
      // device-only path. The note is already device-resident at this line, and
      // an anchor that does not confirm leaves it exactly as link-only as
      // pressing "keep on this device" would have. This is the path Pat took on
      // 2026-09-01: the claim ran, the anchor never confirmed, and My balances
      // had nothing to show because only the other path recorded anything.
      // The clear below is guarded on a confirmed anchor, so the flag survives
      // precisely the cases where the funds really are link-only.
      recordUnanchoredNotes(sessionAddress, sessionChainId, healedNotes.map((n) => n.commitment));

      // importAccount ran discovery, so the session now holds the status the
      // transact will check. Refuse here, before any signature, quote or proof.
      const merged = await exportAccount();
      const mergedStatus = new Map((merged?.notes ?? []).map((n) => [String(n.commitment).toLowerCase(), n.status]));
      const statuses = healedNotes.map((n) => mergedStatus.get(String(n.commitment).toLowerCase()));
      if (statuses.some((s) => s !== NoteStatus.ACTIVE)) {
        if (statuses.some((s) => s === NoteStatus.SPENT || s === NoteStatus.EXITED || s === NoteStatus.EXIT_PENDING)) {
          throw new Error('This payment has already been claimed or moved. Nothing was sent.');
        }
        if (statuses.some((s) => s === NoteStatus.REJECTED)) throw new LinkNotApprovedError('rejected');
        // Discovery did not bring the note into the account, so its approval is not the question.
        if (statuses.some((s) => s === undefined)) {
          throw new Error("Couldn't load this payment. Nothing was sent. Retry in a moment.");
        }
        const postApproval = await checkLinkApproval(healedNotes, opts?.expectedChainId ?? sessionChainId);
        if (isBlockedApproval(postApproval)) throw new LinkNotApprovedError(postApproval);
        // Discovery leaves a note PENDING when its association-set read was
        // deferred, and the provider's promotion pass runs later. An approved
        // answer here is the same rule that pass applies, so promote now.
        const promoted = postApproval === 'approved' && await promoteApprovedNotes(healedNotes.map((n) => n.commitment));
        if (!promoted) {
          throw new Error("Couldn't confirm this payment's approval just now. Nothing was sent. Retry in a moment.");
        }
      }

      // The "is this note on-chain at all" check used to sit HERE, after the
      // merge, so a note the chain had never seen was already on the device by
      // the time the user was told. It now runs before the merge, for both
      // paths, which is also before the user is charged for registration and
      // proving (assertLinkNotesAnchored above).

      // Decided HERE, from the wallet's live balance, not from anything the page
      // cached: this is the last moment before money moves.
      const funding = await resolveClaimFunding(owner, session);
      setClaimFunding(funding);
      const relayed = funding.kind === 'relayed' ? funding : null;

      // True only when EVERY leg's receipt positively confirmed. Declared across
      // both branches: it gates disarming the data-loss guard below.
      let anchorConfirmed = true;

      if (relayed) {
        // === Relayed claim: the relayer registers the wallet and claims for it ===
        //
        // The claim is ONE relayed transaction over every note in the receipt.
        // `TransactOrchestrator.getTransactOutputNotes` groups the inputs by
        // label and emits a change note per label, so a two-lineage transfer is
        // covered in a single pass — which it has to be, because the bundled
        // registration is one-shot: once the auth policy is set, a second
        // `registerAndRelay` for the same account reverts.
        // Everything below is gated BEFORE the signature on purpose: each of
        // these would otherwise surface as an opaque SDK or relayer rejection
        // after the user had already signed and paid for ~30s of proving.
        //
        // The quote, the relay address and the balance read above are all keyed
        // on `chainId` (the app's selection) while the proof is built by a
        // session bound to `sessionChainId`. The two normally agree, but a
        // legacy receipt carries no chainId and so skips the merge-boundary
        // check that would have caught a split — and a mainnet fee commitment
        // bound into an Optimism proof dies with PoolVault_ProofContextMismatch.
        if (chainId !== sessionChainId) {
          throw new Error(`The app is on chain ${chainId} but this payment lives on chain ${sessionChainId}. Switch networks and retry — your funds stay saved on this device.`);
        }
        const tokenId = healedNotes[0].tokenId;
        if (healedNotes.some((n) => n.tokenId.toLowerCase() !== tokenId.toLowerCase())) {
          // The transact proves one asset; the SDK's own getNotesTokenId would
          // throw later, well after the user had signed.
          throw new Error('This link mixes tokens, which cannot be claimed in one relayed transaction. Keep it on this device and claim it once the wallet has gas.');
        }
        // The relayed claim spends the whole receipt in ONE transact, so it
        // inherits the circuit's input ceiling (MAX_INPUTS = 5, thrown by the
        // SDK's resolveAndValidateInputNotes). The self-funded path had no such
        // limit — it proved one transact per note — so say plainly what to do
        // instead rather than letting a 6-note link die mid-claim.
        if (healedNotes.length > RELAYED_CLAIM_MAX_INPUTS) {
          throw new Error(`This link carries ${healedNotes.length} notes, more than the ${RELAYED_CLAIM_MAX_INPUTS} a single relayed claim can spend. Keep it on this device, then claim from your shielded balance.`);
        }
        const noteValueWei = healedNotes.reduce((sum, n) => sum + BigInt(n.value), 0n);
        const inputCommitments = healedNotes.map((n) => n.commitment);

        // The signature comes FIRST because it is user-paced: a fee commitment
        // lives ~60s and the proof after it eats a good part of that, so a
        // signature prompt sitting in front of the quote would expire it.
        let signature: Hex | undefined;
        let deadline: Hex | undefined;
        if (relayed.mode === 'register-and-withdraw') {
          deadline = buildRegistrationDeadline(Date.now());
          const typedData = session.buildSetAuthPolicyTypedData(deadline);
          // Wording matters here: FlowProgress derives its stage from this
          // string, and "waiting for"/"sign"/"relay" all jump it forward (and it
          // is monotonic, so it can never come back). Keep the pre-proof
          // messages free of those tokens — including "approve", whose middle
          // matches the /prov/ proof pattern and pinned the whole flow at the
          // Prove stage from the signature prompt onward.
          if (live()) setStatusMessage('Accept the free authorization — no gas needed');
          // Signing costs nothing on-chain — this IS the "no gas" trick. The
          // relayer forwards it to Keystore.setAuthPolicyWithSig.
          signature = await signTypedDataAsync({
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message,
          } as Parameters<typeof signTypedDataAsync>[0]) as Hex;
        }

        // Let the RELAYER price its own work, then converge on a quote whose
        // gross equals that fee, so the fee is the only value that leaves the
        // pool and the remainder of the payment stays shielded as a change note.
        // The first quote asks for the whole note — the worst case to price
        // against — and each pass re-asks at the fee the last one returned
        // (flat-fee assets settle in two; a bps asset needs one more).
        if (live()) setStatusMessage('Checking the network fee…');
        // Gas for the wallet's own setViewingKey. Only register-and-withdraw
        // knows the viewing key is missing (registerAndRelay never sets it).
        let extraGas = relayed.mode === 'register-and-withdraw'
          && registrationTopUpEnabled(chainId, process.env.EXPO_PUBLIC_REGISTRATION_TOP_UP_CHAINS);
        const quoteFor = (amountWei: bigint) => getQuote(
          chainId,
          amountWei.toString(),
          tokenId as `0x${string}`,
          owner as `0x${string}`,
          extraGas,
        );
        // ONLY the first quote's rejection is an answer about this payment: the
        // relayer refuses what it cannot profitably relay with "Relay fee (…)
        // exceeds withdrawal amount (…)", and at the full note value that means
        // the fee really does outweigh the payment.
        const describeTooSmall = () => new Error(CLAIM_FEE_EXCEEDS_PAYMENT);
        // One quote is not the answer (DEV-494): the relayer prices off the gas
        // price of the moment, and a $5 claim on Ethereum sits close enough to
        // its fee that one busy block refused it and a retry minutes later
        // claimed. Refuse only when a second, fresh quote agrees.
        const freshQuote = () => quoteWithFreshRetry({
          quote: () => quoteFor(noteValueWei),
          isTooSmall: isAmountRejection,
          onFirstRefusal: (err) => log('info', 'ImportNote', 'Relayer fee above the payment; asking once more for a fresh quote', err),
        });
        let initialQuote;
        try {
          // With the top-up asked for, a refusal falls back to claiming without
          // it below, which is where the second quote is spent.
          initialQuote = extraGas ? await quoteFor(noteValueWei) : await freshQuote();
        } catch (quoteErr) {
          if (!isAmountRejection(quoteErr)) throw quoteErr;
          if (!extraGas) throw describeTooSmall();
          // The top-up pushed the fee over the payment: claim without it.
          log('info', 'ImportNote', 'Payment cannot carry the gas top-up; claiming without it', quoteErr);
          extraGas = false;
          try {
            initialQuote = await freshQuote();
          } catch (retryErr) {
            if (isAmountRejection(retryErr)) throw describeTooSmall();
            throw retryErr;
          }
        }
        // Re-quote for the smallest payout. The search itself lives in
        // services/cold-start-claim.ts because the in-app gasless registration
        // runs the identical loop and its stopping rules must not drift; the
        // messages below stay here, where they can speak about "this payment".
        // A re-quote the relayer rejects just ends the search, and the claim
        // proceeds on the last good quote with a small payout instead of
        // failing with a misleading "fee exceeds this payment".
        const converge = (from: typeof initialQuote) => convergeFeeOnlyQuote({
          initialQuote: from,
          quoteFor,
          onRefused: (err) => log('info', 'ImportNote', 'Fee-only re-quote refused; keeping the last good quote', err),
        });
        let converged = await converge(initialQuote);
        // DEV-482: the full-value quote can pass while fee + the top-up payout
        // floor does not fit the payment. Decide the top-up from the converged
        // numbers and claim without it rather than fail in planFeeOnlyClaim.
        if (extraGas && !feeOnlyQuoteFits(converged, noteValueWei)) {
          log('info', 'ImportNote', 'Fee plus the top-up payout floor does not fit this payment; claiming without the top-up', {
            grossWei: converged.quote.amountSent,
            noteValueWei: noteValueWei.toString(),
          });
          extraGas = false;
          try {
            converged = await converge(await freshQuote());
          } catch (retryErr) {
            if (isAmountRejection(retryErr)) throw describeTooSmall();
            throw retryErr;
          }
        }
        const { quote, tightened } = converged;
        // Falling back on the FULL-VALUE quote would withdraw the entire payment
        // to the wallet — the opposite of this flow's promise that the claim
        // lands in the shielded balance. An accepted re-quote always lands the
        // gross at the relayer's own fee, so "never tightened" is the only way
        // that can happen, and it must fail rather than cash the user out.
        if (!tightened && BigInt(quote.amountSent) !== BigInt(quote.feeAmount)) {
          throw new Error('The relayer could not price a fee-only claim just now, and claiming would have moved this whole payment out of the pool. Nothing was sent — it stays saved on this device. Retry in a moment.');
        }
        // Not converging is not a failure: an unconverged quote just pays a few
        // wei out to the claimer, which every downstream assertion accepts.
        const plan = planFeeOnlyClaim({
          noteValueWei,
          amountSentWei: BigInt(quote.amountSent),
          feeAmountWei: BigInt(quote.feeAmount),
        });
        log('info', 'ImportNote', 'Relayed claim plan', {
          mode: relayed.mode,
          reason: relayed.reason,
          noteValueWei: noteValueWei.toString(),
          feeWei: quote.feeAmount,
          grossWei: plan.grossWei.toString(),
          payoutWei: plan.payoutWei.toString(),
          changeWei: plan.changeWei.toString(),
          feeOnly: plan.feeOnly,
          processor: withdrawalProcessorAddress,
        });

        // The SDK refuses a zero top-up when extraGas is set; fail before proving.
        const claimTopUpWei = extraGas ? decodeGasTopUpWei(quote.feeCommitment?.data) : null;
        if (extraGas && (claimTopUpWei === null || claimTopUpWei <= 0n)) {
          throw new Error('The relayer quote did not include the gas it was asked for. Nothing was sent, and your funds stay saved on this device. Retry in a moment.');
        }
        const claimParams = {
          inputCommitments,
          amount: `0x${plan.payoutWei.toString(16)}` as Hex,
          tokenId,
          recipientAddress: owner,
          // Must match the flag the quote was requested with.
          extraGas,
          selectedQuote: {
            // The relayer advertises its signer EOA as the processor, but the
            // on-chain msg.sender for a relayed claim is the PrivacyPoolRelay
            // contract — bind the proof to that or PoolVault rejects the context
            // with PoolVault_ProofContextMismatch. Same rebinding the withdraw
            // modal's cold-start path does.
            relayerInfo: { ...quote.relayer, processorAddress: withdrawalProcessorAddress },
            quote: {
              txCost: quote.txCost,
              gasPrice: quote.gasPrice,
              feeAmount: quote.feeAmount,
              amountSent: quote.amountSent,
              amountReceived: quote.amountReceived,
              feeCommitment: quote.feeCommitment,
            },
          },
        };
        if (live()) setStatusMessage(CLAIM_PROVING);
        if (!live()) { log('warn', 'ImportNote', 'Stale run aborted before the relayed claim'); return; }
        // The SDK proves, posts to the relayer and waits for the block inside
        // ONE call, so the label used to read "Generating proof" through all
        // three (DEV-494). Hear the post and the relayer's hash and say which
        // wait it is. The step times go to the local debug log only, so a slow
        // claim shows whose wait it was.
        const claimT0 = Date.now();
        const claimSteps: Record<string, number> = {};
        const stopHearingStart = onRelayCalled((method) => {
          if (!isClaimRelayMethod(method)) return;
          claimSteps.relayPostedMs = Date.now() - claimT0;
          if (live()) setStatusMessage(RELAY_WAITING_RELAYER);
        });
        const stopHearingHash = onRelayedTxHash((_hash, method) => {
          if (!isClaimRelayMethod(method)) return;
          claimSteps.relayerAnsweredMs = Date.now() - claimT0;
          if (live()) setStatusMessage(RELAY_WAITING_BLOCK);
        });
        let receipt: TxReceiptLike;
        try {
          receipt = relayed.mode === 'register-and-withdraw'
            ? await session.registerAndWithdraw({ ...claimParams, signature, deadline })
            : await session.relayWithdraw(claimParams);
          claimSteps.minedSeenMs = Date.now() - claimT0;
        } catch (relayErr) {
          // Classified HERE, around the one relayed claim call, and nowhere
          // else: the self-funded anchor loop relays per note, so a refusal
          // there can follow a note that already moved (review of DEV-494).
          const text = claimRelayFailureText(relayErr);
          if (text) throw new Error(text, { cause: relayErr });
          throw relayErr;
        } finally {
          stopHearingStart();
          stopHearingHash();
          log('info', 'ImportNote', 'Relayed claim timing', { ...claimSteps, endedMs: Date.now() - claimT0 });
        }
        // A resolved promise is not success: the SDK returns failed receipts
        // without persisting note updates.
        const claimStatus = (receipt as { status?: unknown } | undefined)?.status;
        if (claimStatus === false || claimStatus === 'reverted') {
          throw new Error('The transaction failed on-chain. Your funds are still saved on this device. Retry.');
        }
        anchorConfirmed = claimStatus === true || claimStatus === 'success';
        // The relayed branch is the OPPOSITE shape to the self-funded loop: one
        // transaction carries every input, so one hash legitimately maps to all
        // of inputCommitments. Same rule though - only on positive confirmation.
        //
        // Receipt success is not enough to license an anchor stamp: the SDK's
        // relayed transfer path has already returned unrelated successful relay
        // receipts. For stamps, require the returned receipt logs or the shared
        // bulk Transacted index to show OUR expected nullifiers.
        let anchorStampTxHash: string | null = null;
        if (anchorConfirmed) {
          const claimTxHash = (receipt as { txHash?: unknown } | undefined)?.txHash;
          const returnedTxHash = typeof claimTxHash === 'string' ? claimTxHash : null;
          const confirmChain = getChainConfig(sessionChainId);
          const confirmPool = LEGACY_CONFIG?.pool ?? confirmChain?.contracts?.poolAddress;
          const confirmFromBlock = confirmChain?.contracts?.fromBlock;
          const confirmKey = keystoreManager?.getPrivateNullifyingKey();
          if (!returnedTxHash) {
            log('warn', 'ImportNote', 'Relayed claim returned no transaction hash; not stamping');
            anchorConfirmed = false;
          } else if (!confirmPool || confirmFromBlock === undefined || !confirmKey) {
            log('warn', 'ImportNote', 'Relayed claim could not be locally confirmed; missing pool configuration or nullifying key', {
              txHash: returnedTxHash,
              chainId: sessionChainId,
            });
            anchorConfirmed = false;
          } else {
            const receiptLogs = (receipt as { logs?: unknown } | undefined)?.logs;
            let receiptLogsConfirm = false;
            if (Array.isArray(receiptLogs) && receiptLogs.length > 0) {
              try {
                const {
                  createHashService,
                  createNoteComputationService,
                  createPoolVaultInteractor,
                  createRPCInteractor,
                } = await import('@/services/sdk-runtime');
                const noteComp = await createNoteComputationService();
                const expectedNullifiers = inputCommitments.map(
                  (commitment) => noteComp.computeNullifier(confirmKey, commitment as Hash).toLowerCase(),
                );
                const hashService = await createHashService();
                const rpc = createRPCInteractor(sessionChainId, Number(confirmFromBlock));
                const poolVault = createPoolVaultInteractor(
                  rpc,
                  String(confirmPool) as SdkAddress,
                  hashService,
                  confirmFromBlock,
                );
                const confirmedNullifiers = new Set(
                  poolVault.extractSpentNullifiers(
                    receiptLogs as Parameters<typeof poolVault.extractSpentNullifiers>[0],
                  ).map((n) => n.toLowerCase()),
                );
                receiptLogsConfirm = expectedNullifiers.every((n) => confirmedNullifiers.has(n));
                if (!receiptLogsConfirm) {
                  log('warn', 'ImportNote', 'Relayed claim receipt did not consume the expected nullifiers', {
                    txHash: returnedTxHash,
                    expectedCount: expectedNullifiers.length,
                    confirmedCount: confirmedNullifiers.size,
                  });
                }
              } catch (confirmErr) {
                log('warn', 'ImportNote', 'Relayed claim receipt-log confirmation failed', confirmErr);
              }
            }

            if (receiptLogsConfirm) {
              anchorStampTxHash = returnedTxHash;
            } else {
              try {
                const { confirmRelayedSpend } = await import('@/services/onchain-note-index');
                const { observed } = await confirmRelayedSpend({
                  chainId: sessionChainId,
                  poolAddress: String(confirmPool),
                  fromBlock: confirmFromBlock,
                  inputCommitments: inputCommitments as Hash[],
                  privateNullifyingKey: confirmKey,
                });
                const observedTxHash = observed?.txHash ?? null;
                if (!observed) {
                  log('warn', 'ImportNote', 'Relayed claim was not visible in bulk Transacted data yet; not stamping', {
                    returnedTxHash,
                  });
                  anchorConfirmed = false;
                } else if (!observedTxHash) {
                  log('warn', 'ImportNote', 'Relayed claim spent nullifiers were observed without a transaction hash; not stamping', {
                    returnedTxHash,
                  });
                  anchorConfirmed = false;
                } else if (observedTxHash.toLowerCase() !== returnedTxHash.toLowerCase()) {
                  log('warn', 'ImportNote', 'Relayed claim inputs were spent by a different transaction than the relayer returned', {
                    returnedTxHash,
                    observedTxHash,
                  });
                  anchorConfirmed = false;
                } else {
                  anchorStampTxHash = observedTxHash;
                }
              } catch (confirmErr) {
                log('warn', 'ImportNote', 'Relayed claim bulk confirmation failed', confirmErr);
                anchorConfirmed = false;
              }
            }
          }

          if (anchorConfirmed) {
            recordAnchorStamps(
              sessionAddress,
              sessionChainId,
              anchorStampTxHash,
              inputCommitments.map((c) => String(c)),
            );
            // The relayer fee this claim was quoted and paid, for its row's
            // details (DEV-517). Never re-quoted at view time.
            if (anchorStampTxHash) {
              // The notes this claim spent were received payments: the spend of
              // exactly them is this claim, a Transfer In (DEV-574). Local only,
              // and only once the receipt or the bulk index showed OUR
              // nullifiers spent: a failed or unrelated relay records nothing,
              // so a later send of those notes keeps its own label.
              recordClaimInputs(sessionChainId, inputCommitments.map((c) => String(c)), relayed.mode === 'register-and-withdraw');
              recordWithdrawFee({
                txHash: anchorStampTxHash,
                feeAmount: String(quote.feeAmount),
                tokenAddress: String(healedNotes[0]?.tokenId ?? ''),
                chainId: sessionChainId,
                timestamp: Date.now(),
                kind: 'claim',
              });
            }
          }
        }
        if (anchorConfirmed) {
          if (live()) {
            setClaimGasTopUpWei(claimTopUpWei);
            setClaimSplit({ feeWei: BigInt(quote.feeAmount), payoutWei: plan.payoutWei, changeWei: plan.changeWei });
          }
          // A confirmed relayed claim spent from a registered keystore leaf.
          markRegistered(sessionAddress, chainId);
          if (relayed.mode === 'register-and-withdraw') {
            // The keystore leaf landed in the same transaction, but
            // registerAndRelay sets no viewing key.
            setReceiveSetup(sessionAddress, chainId, 'partial', 'local');
          } else {
            // The viewing key may or may not be set: ask the chain.
            void keystoreStatusForChain(chainId)
              .then((identity) => setReceiveSetup(sessionAddress, chainId, receiveSetupFromIdentity(identity), 'onchain'))
              .catch(() => { /* the next status refresh answers */ });
          }
        }
      } else {
        const registration = await session.prepareRegisterKeystore();
        if (registration.alreadyRegistered) setReceiveSetup(sessionAddress, chainId, 'complete', 'onchain');
        if (!registration.alreadyRegistered && !registration.keystoreCalldata && !registration.viewingKeyCalldata) {
          throw new Error('On-chain setup is unavailable for this session. The funds stay saved on this device.');
        }
        // Each leg submits INDEPENDENTLY (codex round 2): the viewing-key leg
        // was nested under a non-null auth leg, so the SDK's viewing-only
        // repair state (keystoreCalldata null, viewingKeyCalldata non-null)
        // could never run and the anchor emitted an undecryptable Note event.
        if (!registration.alreadyRegistered && (registration.keystoreCalldata || registration.viewingKeyCalldata)) {
          // Affordability BEFORE the wallet pays for registration (DEV-456). The
          // anchor loop below only learns the fee exceeds a note after both
          // setup transactions were mined, so a payment too small to claim
          // still cost the user two transactions of gas. Price each note on the
          // SAME route the loop pays (a relayed transfer), non-committing and
          // with no recipient, like the send form's estimate. An unavailable
          // estimate refuses nothing: the loop's binding quote still decides.
          if (live()) setStatusMessage('Checking the network fee…');
          for (const n of healedNotes) {
            const value = BigInt(n.value);
            const fee = await probeTransferFee(chainId, String(n.tokenId), value);
            if (fee === 'rejected' || (fee !== null && fee >= value)) {
              // DEV-493: the wallet holds gas, so it can still register now and
              // receive future payments directly. Offered, never assumed.
              if (live() && funding.kind === 'self-funded' && funding.walletGasWei !== undefined) {
                const legs = (registration.keystoreCalldata ? 1n : 0n) + (registration.viewingKeyCalldata ? 1n : 0n);
                setRegisterOffer({ gasCostWei: funding.walletGasWei * (legs > 0n ? legs : 1n), chainId });
              }
              throw new Error('The network fee currently exceeds this amount, so it cannot be added right now. Nothing was sent. It stays saved on this device. Retry later.');
            }
          }
          if (live()) setStatusMessage('Setting up your inbox…');
          await sendRegistrationLegs(registration);
        }

        const transferQuotes = relayerTransferQuotes(chainId);
        const recipientDeps = await loadTransferRecipientDeps(chainId);
        // Anchor each note as its own self-transfer so it emits a discoverable
        // event. Registration above happened once; only the transfers loop.
        // healedNotes, not notes: a recovered claim only carries its owner and
        // commitment after materialisation, and the anchor selects by both.
        for (let i = 0; i < healedNotes.length; i++) {
          const note = healedNotes[i];
          if (live()) {
            setStatusMessage(healedNotes.length > 1 ? `Generating proof… (${i + 1}/${healedNotes.length})` : 'Generating proof…');
          }
          // The relayer's fee comes OUT of the note (QA 2026-08-16): relayTransfer
          // proves with the quote's feeCommitment.feeAmount ON TOP of the amount,
          // so the note anchors its value less the quoted fee. The quote is
          // requested right before relayTransfer, so its one proof gets the
          // commitment's whole lifetime.
          const noteValue = BigInt(note.value);
          const recipient = await buildTransferRecipient({ kind: 'address', evmAddress: owner }, 1, recipientDeps);
          const selectedQuote = await requestTransferQuote(transferQuotes, note.tokenId as SdkAddress);
          if (!selectedQuote) {
            throw new Error('No fee quote available right now. Try again in a moment.');
          }
          const anchorFee = transferRelayFee({ selectedQuote });
          const anchoredNet = noteValue - anchorFee;
          if (anchoredNet <= 0n) {
            throw new Error('The network fee currently exceeds this amount, so it cannot be added right now. It stays saved on this device. Retry later.');
          }
          const outputPlan = planTransferOutputs({
            inputNotes: [note],
            amount: anchoredNet,
            fee: anchorFee,
            tokenId: note.tokenId as SdkAddress,
            recipient: recipient.recipient,
            commitment: recipientDeps.commitment,
          });
          const relayerOption = relayTransferParams({
            inputCommitments: [note.commitment as Hash],
            amount: anchoredNet,
            tokenId: note.tokenId as SdkAddress,
            built: recipient,
            selectedQuote,
          });
          if (live()) {
            setStatusMessage(healedNotes.length > 1 ? `Submitting… (${i + 1}/${healedNotes.length})` : 'Submitting…');
          }
          const relayCheck = expectTransferRelay(transferRelayExpectation(selectedQuote, 1, outputPlan));
          const relayResult = await session.relayTransfer(relayerOption).catch((relayErr: unknown) => {
            throw plainTransferRelayError(relayErr);
          }).finally(() => relayCheck.release());
          // The relay resolves even when its on-chain tx reverted; the SDK
          // returns without persisting the note update in that case. Trust the
          // receipt status, not the promise resolving. (Shape is `any` in our
          // thin SDK types — read defensively, reject only on an EXPLICIT false
          // so an SDK that returns no receipt still anchors as before.)
          const relayStatus = (relayResult as { txReceipt?: { status?: unknown } } | undefined)?.txReceipt?.status;
          if (relayStatus === false || relayStatus === 'reverted') {
            throw new Error('The transaction failed on-chain. Your funds are still saved on this device. Retry.');
          }
          // A SUCCESSFUL RECEIPT IS NOT PROOF THIS TRANSACT HAPPENED.
          //
          // relayTransfer waits on whatever tx hash the relayer hands back. The
          // SDK's own verifier notices when the expected PoolVault nullifier is
          // absent from that receipt, but it only warns and returns, and
          // finalizeTransfer returns the successful receipt regardless. Reading
          // txReceipt.status alone therefore accepts ANY successful relayer
          // transaction as a completed anchor. Pat's claim on 2026-09-01 surfaced
          // 0xba030ff2, an unrelated 5 USDC Entrypoint.deposit by another address
          // (pool topic 0xed45e0df Deposited, no 0x10763cc4 Transacted, no
          // nullifier consumed), and he was told his funds were anchored.
          //
          // A returned recipient note is POSITIVE evidence this receipt is ours.
          // Its ABSENCE is not negative evidence, and treating it as such is a
          // worse bug than the one above: finalizeTransfer enriches recipient
          // notes AFTER persisting, and prepareRecipientNotes drops any output
          // whose commitment timestamp will not resolve, which the resolver
          // treats as transient and gives up on after three retries. So a
          // perfectly good anchor can return an empty array, and an earlier
          // version of this check threw on it, telling the user their payment
          // had not landed when it had, irrecoverably, after the spend.
          //
          // So: evidence, not a verdict. Missing evidence leaves anchorConfirmed
          // false, which keeps the tab-close guard armed and logs "confirmation
          // unknown" instead of claiming either outcome. No sum comparison: with
          // one input commitment there is exactly one recipient output and its
          // value is already the prepared amount, so equality adds nothing and
          // only invents ways to be wrong.
          //
          // The real fix is SDK PR #392, which returns the nullifier verdict as
          // TransferResult.spentNullifiersConfirmed. That is computed from the
          // receipt's Transacted logs and does not depend on a timestamp read,
          // so it can say "not ours" with authority. Consume it once vendored.
          const relayedNotes = (relayResult as { recipientNotes?: unknown[] } | undefined)?.recipientNotes ?? [];
          const sdkVerdict = (relayResult as { spentNullifiersConfirmed?: boolean } | undefined)?.spentNullifiersConfirmed;
          const receiptIsOurs = sdkVerdict === true || (sdkVerdict === undefined && relayedNotes.length > 0);
          if (!receiptIsOurs) {
            log('warn', 'ImportNote', 'Relay receipt did not positively confirm this transact; leaving the claim unconfirmed', {
              txHash: (relayResult as { txReceipt?: { txHash?: unknown } } | undefined)?.txReceipt?.txHash ?? null,
              recipientNoteCount: relayedNotes.length,
              sdkVerdict: sdkVerdict ?? 'absent (SDK predates PR #392)',
            });
          }
          // Positive confirmation required to DISARM the data-loss guard
          // (codex round 1): a missing/unknown status still reports anchored,
          // but the tab-close warning stays armed — false-positive warnings
          // are the safe failure direction; a silently-unanchored note is not.
          const legConfirmed = receiptIsOurs && (relayStatus === true || relayStatus === 'success');
          // This leg spent a received note (DEV-574); only once it succeeded.
          if (legConfirmed && sdkVerdict === true) recordClaimInputs(sessionChainId, [String(note.commitment)], false);
          anchorConfirmed = anchorConfirmed && legConfirmed;
          // THIS leg's verdict, and THIS leg's single commitment - not the
          // batch accumulator and not notes.map(...). The self-funded path
          // submits one transact per note, so a stamp naming the whole receipt
          // would assert that this transaction spent notes it never touched.
          // Written only on positive confirmation: the stamp's only job is to
          // license a confident label, so a speculative one licenses a false
          // one, and absence correctly degrades to the neutral fee row.
          if (legConfirmed) {
            const legTxHash = (relayResult as { txReceipt?: { txHash?: unknown } } | undefined)?.txReceipt?.txHash;
            recordAnchorStamps(
              sessionAddress,
              sessionChainId,
              typeof legTxHash === 'string' ? legTxHash : null,
              [String(note.commitment)],
            );
            if (typeof legTxHash === 'string' && anchorFee > 0n) {
              recordWithdrawFee({
                txHash: legTxHash,
                feeAmount: anchorFee.toString(),
                tokenAddress: String(note.tokenId),
                chainId: sessionChainId,
                timestamp: Date.now(),
                kind: 'claim',
              });
            }
          }
        }
      }

      refreshNotes();
      // No discovery pass timed to the claim: the SDK applied the confirmed
      // spend to the note manager, and the grid's discovery confirms the rest
      // (services/public-feeds.ts). Passes a few seconds after a relayed claim
      // would tie this client to it.
      // Guarded: a stale run's success must not disarm the tab-close guard
      // for a NEWER unanchored note (false-positive warnings are the safe
      // failure direction for a data-loss guard).
      // BRACED, and it must stay braced. This `if` used to have no braces, so
      // only the first statement was guarded and clearUnanchoredNotes ran
      // unconditionally - on every completion of the claim run, including one
      // where the anchor was submitted but never confirmed. That silently
      // disarmed both the tab-close guard and the My balances callout for a
      // note that really was still link-only, which is the precise data-loss
      // this whole mechanism exists to prevent. The indentation always claimed
      // the guard; the braces did not back it up.
      if (live() && anchorConfirmed) {
        setHasUnanchoredLocalNote(false);
        clearUnanchoredNotes(sessionAddress, sessionChainId, healedNotes.map((n) => n.commitment));
      }
      if (live()) {
        if (anchorConfirmed) {
          setStatus('anchored');
          setStatusMessage('');
          // A re-entrancy notice from a double-press must not survive the
          // success it was complaining about.
          setErrMessage(null);
        } else {
          // Submitted but NOT positively confirmed (codex round 2: saying
          // "Saved on-chain" while the tab-close guard stays armed was a
          // contradiction). Honest state: note is safe on this device, the
          // anchor needs verification.
          setStatus('error');
          setErrMessage('The transaction was submitted but could not be confirmed. Your funds are still saved on this device. Check it later and retry only if it did not land.');
        }
      }
      log('info', 'ImportNote', anchorConfirmed ? 'Note(s) anchored on-chain' : 'Anchor submitted, confirmation unknown', {
        count: healedNotes.length,
        commitments: healedNotes.map((n) => n.commitment),
      });
    } catch (e) {
      if (live()) {
        setStatus('error');
        setStatusMessage('');
        setErrMessage(describeError(e));
        const blocked = e instanceof LinkNotApprovedError
          ? e.approval
          : claimErrorApproval(e instanceof Error ? e.message : String(e));
        if (blocked) setApprovalBlock(blocked);
      }
      if (e instanceof LinkNotApprovedError) {
        log('info', 'ImportNote', 'Claim refused: link not approved yet', { approval: e.approval });
      } else {
        log('error', 'ImportNote', `On-chain import failed: ${describeError(e)}`, e);
      }
    } finally {
      runningRef.current = false;
    }
  }, [
    identityMode,
    address,
    chainId,
    sessionChainId,
    sessionAddress,
    switchChainAsync,
    markRegistered,
    ensureInitialized,
    exportAccount,
    importAccount,
    refreshNotes,
    sendTransactionAsync,
    signTypedDataAsync,
    getQuote,
    withdrawalProcessorAddress,
    resolveClaimFunding,
    materializeRecoveredClaims,
    publicClient,
    keystoreManager,
    keystoreStatusForChain,
    resolveCreatedAtBlocks,
    sendRegistrationLegs,
    promoteApprovedNotes,
    log,
  ]);

  const busy = status === 'importing' || status === 'anchoring';
  const done = status === 'imported' || status === 'anchored';

  return {
    status,
    statusMessage,
    errMessage,
    busy,
    done,
    hasUnanchoredLocalNote,
    approvalBlock,
    claimFunding,
    claimGasTopUpWei,
    claimSplit,
    probeClaimFunding,
    registerOffer,
    registerState,
    registerWalletOnly,
    dismissRegisterOffer,
    importToDevice,
    importOnChain,
    reset,
  };
}
