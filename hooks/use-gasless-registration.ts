import { approxUnderlyingText } from '@/services/share-display';
import { useCallback } from 'react';
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain } from 'wagmi';

import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useRelayerQuote } from '@/hooks/use-relayer';
import { useDebug } from '@/components/debug-provider';
import { getChainConfig, isSupportedEvmChainId } from '@/config/chains';
import { registrationTopUpEnabled, supportsColdStartClaim } from '@/config/cold-start';
import { LEGACY_CONFIG } from '@/config/env';
import { getWithdrawalProcessorAddress } from '@/config/relayer';
import { getTokenMetadata } from '@/config/tokens';
import { formatUnits, formatEther } from 'viem';
import {
  buildRegistrationDeadline,
  convergeFeeOnlyQuote,
  feeOnlyQuoteFits,
  isAmountRejection,
  planFeeOnlyClaim,
  readRegistrationPath,
} from '@/services/cold-start-claim';
import {
  describeQuoteFailure,
  filterFeeNotesByAssociationSet,
  narrowFeeNotes,
  selectFeeNoteCandidates,
  type FeeNoteCandidate,
  type GaslessRegistrationEligibility,
  type GaslessRegistrationMode,
  type QuotedRegistrationPlan,
} from '@/services/gasless-registration';
import { decodeGasTopUpWei } from '@/services/gas-top-up';
import { decideViewingKeyPath, receiveSetupFromIdentity, setReceiveSetup, topUpCovers, viewingKeyShortfallWei } from '@/services/receive-setup';
import { NoteStatus } from '@/services/sdk-types';
import type { Address as SdkAddress, Hash, Hex, Note, TxReceiptLike } from '@/services/sdk-types';
import { recordOwnAction } from '@/services/own-actions-store';
import { recordWithdrawFee } from '@/services/withdraw-fees-store';

/**
 * In-app gasless keystore registration, for a wallet that has funds in the pool
 * but no gas in the wallet.
 *
 * The counterpart of hooks/use-note-import.ts's relayed claim, moved off the
 * /import-note link page and into the app. Same mechanism — sign SetAuthPolicy
 * off-chain, let the relayer post `registerAndRelay` and take its fee out of a
 * note — but reached from the ordinary registration surface, so the payee of a
 * V3 payment request (who never opens a claim link, because their note is
 * auto-discovered) can get out of the cold start too.
 *
 * Three stages, and the boundaries are load-bearing:
 *   - `probeEligibility()` is ADVISORY and DISCLOSES NOTHING. Local state and
 *     this app's own RPC only — no relayer contact — so merely opening a modal
 *     never tells a third party what this wallet holds. It answers "is this
 *     worth offering?", never "will it work".
 *   - `quoteRegistration()` runs on the user's press. This is the first relayer
 *     contact, matching every other surface in the app, and it is where the
 *     money question is settled: it re-validates live state, rejects notes
 *     already spent on-chain, prices the work, and returns a plan whose fee is
 *     shown to the user before anything is signed.
 *   - `submitRelayedRegistration()` takes that CONFIRMED plan and holds the
 *     relayer to it: the final fee may come in lower, never higher than the
 *     number the user agreed to.
 *
 * Where the top-up is enabled, the relay also forwards gas for `setViewingKey`;
 * it is priced into the fee, so every fee here includes it.
 *
 * EVM-only by construction: `registerAndRelay` is an EVM relay contract and
 * config/cold-start.ts is keyed by EVM chain id.
 */
export function useGaslessRegistration(options?: {
  /**
   * The chain being registered on. The registration modal passes its own
   * target here: it can be opened for ANOTHER chain (`targetChainId`), and
   * this hook used to act on the app's active chain regardless, so a modal
   * titled "Register on BNB Chain" could price, spend and register on
   * Ethereum instead. Defaults to the app's active chain.
   */
  chainId?: number;
}) {
  const { address } = useAccount();
  // The chain this flow ACTS ON: the caller's target, else the app's
  // selection (not the wallet's, the same source hooks/use-note-import.ts and
  // the withdraw modal read). Every wagmi hook defaults its chainId to the
  // WALLET's chain, which can diverge from what the app is displaying.
  const activeChainId = useActiveEvmChain().id;
  const chainId = options?.chainId ?? activeChainId;
  // The chain of the SDK session the transact is proved against. The quote, the
  // relay address and the balance read are all keyed on `chainId`; a split
  // between the two binds a fee commitment from one chain into a proof for
  // another, which dies with PoolVault_ProofContextMismatch.
  const sessionChainId = useSessionChainId();
  const publicClient = usePublicClient({ chainId });
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const { getQuote } = useRelayerQuote();
  const {
    poolSession,
    sessionTarget,
    noteManager,
    keystoreManager,
    keysReady,
    identityMode,
    ensureInitialized,
    refreshNotes,
    exportAccount,
    getCommittedManagers,
    keystoreStatusForChain,
    sessionAddress,
  } = usePoolSession();
  const { log } = useDebug();

  // Whether the chain being registered on is the one the live session, and so
  // every note this hook reads and spends, belongs to. The relayed path proves
  // with `poolSession` and takes its fee out of `noteManager`'s notes: both are
  // the SESSION chain's. Aimed at any other chain it would spend a note and
  // register on the session's chain while the modal named another. Checked
  // against the derived session chain AND the committed live session, since
  // the two can briefly disagree mid-switch.
  const onSessionChain = chainId === sessionChainId
    && (sessionTarget === null || sessionTarget.chainId === chainId);

  // The PrivacyPoolRelay the registration is bundled into. It is BOTH the
  // on-chain msg.sender the proof must bind as its processor and half the
  // cold-start allow-list key — pool-era switching can point the app at an
  // OLDER relay on the same chain, and an older relay has no registerAndRelay.
  const withdrawalProcessorAddress = getWithdrawalProcessorAddress(chainId);

  // Static member read: Metro only inlines static process.env.EXPO_PUBLIC_* access.
  const topUpEnabled = registrationTopUpEnabled(chainId, process.env.EXPO_PUBLIC_REGISTRATION_TOP_UP_CHAINS);

  /**
   * The notes this session can spend right now.
   *
   * Read straight off the NoteManager rather than through `useNotes`, on
   * purpose: this hook is consumed by a context PROVIDER, and subscribing the
   * provider to every note revision would re-render it on each sync for a value
   * only read inside an async probe.
   */
  const readActiveNotes = useCallback((): Note[] => {
    if (!noteManager) return [];
    try {
      return noteManager.getNotes({ status: NoteStatus.ACTIVE }) ?? [];
    } catch (err) {
      log('warn', 'GaslessRegistration', 'Could not read notes for the fee selection', err);
      return [];
    }
  }, [noteManager, log]);

  /**
   * Resolve ASP membership from the one public, root-gated bulk set. This never
   * makes a per-label request (which would disclose exactly what the wallet is
   * about to spend), and the shared SDK cache avoids redownloading unchanged
   * leaves across the probe/quote/submit checks.
   */
  const filterAssociationSpendableNotes = useCallback(async (
    candidates: readonly Note[],
    options: { freshDecisions?: boolean } = {},
  ): Promise<Note[]> => {
    const {
      createHashService,
      getPoolAssociationSetLeaves,
      getPoolBlockedLabelHashes,
    } = await import('@/services/sdk-runtime');
    const [hashService, leaves] = await Promise.all([
      createHashService(),
      getPoolAssociationSetLeaves(chainId),
    ]);
    // A pure read of the scheduled snapshot — there is no fresh/stale choice to
    // make here any more, and `options.freshDecisions` cannot buy one, because
    // buying one would mean a request timed to this call.
    const blocked = getPoolBlockedLabelHashes(chainId);
    return filterFeeNotesByAssociationSet(
      candidates,
      leaves,
      [...blocked],
      (label) => hashService.hash([label]),
    );
  }, [chainId]);

  /**
   * Rejects (and self-heals) notes whose nullifier is ALREADY SPENT on-chain.
   *
   * The state tree is append-only, so a note that was spent from another device
   * — or during a sync window that missed the event — still looks ACTIVE
   * locally and still has its commitment leaf. Proving against it produces a
   * transaction that reverts with `PoolVault_NullifierAlreadySpent`, and
   * without the self-heal the very next attempt selects the same dead note. The
   * withdraw path added this check in 88445db6; a relayed registration is a
   * withdrawal and needs exactly the same guard, run BEFORE the signature so
   * nothing is asked of the user on a doomed selection.
   *
   * Fails OPEN on a read error, matching the withdraw path: the contract still
   * enforces the truth, and failing closed here would block registration on one
   * flaky `eth_call`.
   */
  const findSpentNotes = useCallback(async (notes: Note[]): Promise<Set<string>> => {
    const spent = new Set<string>();
    const poolAddress = LEGACY_CONFIG?.pool ?? getChainConfig(chainId)?.contracts?.poolAddress;
    if (!poolAddress || !keystoreManager || notes.length === 0) return spent;
    try {
      const { createNoteComputationService, createHashService, createPoolVaultInteractor, createRPCInteractor } =
        await import('@/services/sdk-runtime');
      const { createOnChainNoteIndex } = await import('@/services/onchain-note-index');
      const noteComputationService = await createNoteComputationService();
      const hashService = await createHashService();
      const fromBlock = getChainConfig(chainId)?.contracts?.fromBlock;
      const poolVaultInteractor = createPoolVaultInteractor(
        createRPCInteractor(chainId),
        poolAddress as Hex,
        hashService,
        fromBlock,
      );
      // PRIVACY: one bulk index, not one spentNullifiers() eth_call per note.
      // A per-note read hands the RPC provider the exact nullifiers of this
      // account moments before one of them is published, which is the leak
      // closed in a5f5f26 (this check was copied from the withdraw path as it
      // stood BEFORE that commit). Same answer, from data every client fetches
      // identically. See docs/privacy-request-discipline.md; the guard test
      // services/__tests__/no-targeted-reads.test.ts fails if it comes back.
      const noteIndex = createOnChainNoteIndex({
        chainId,
        poolVaultInteractor: poolVaultInteractor as never,
        hashService: hashService as never,
        poolAddress: poolAddress as string,
      });
      await noteIndex.refresh();
      const privateNullifyingKey = keystoreManager.getPrivateNullifyingKey();
      for (const note of notes) {
        try {
          const nullifier = noteComputationService.computeNullifier(privateNullifyingKey, note.commitment);
          if (noteIndex.isNullifierSpent(nullifier as Hex)) spent.add(note.commitment);
        } catch (err) {
          log('warn', 'GaslessRegistration', `Nullifier spent-check failed for ${note.commitment}`, err);
        }
      }
    } catch (err) {
      log('warn', 'GaslessRegistration', 'Nullifier preflight unavailable; proceeding', err);
      return spent;
    }
    // Self-heal so balances stop counting them and the next attempt picks a
    // live note instead of tripping over the same one.
    for (const commitment of spent) {
      try {
        noteManager?.updateNoteStatus(commitment as Hex, NoteStatus.SPENT);
      } catch (err) {
        log('warn', 'GaslessRegistration', `Could not mark stale note SPENT: ${commitment}`, err);
      }
    }
    if (spent.size > 0) {
      log('warn', 'GaslessRegistration', 'Dropped notes whose nullifier is already spent on-chain', {
        commitments: [...spent],
      });
      refreshNotes();
    }
    return spent;
  }, [chainId, keystoreManager, noteManager, refreshNotes, log]);

  /**
   * Prices one candidate with the relayer and, if its fee leaves something
   * behind, narrows it to the fewest notes that clear that fee.
   *
   * The quote is taken at the candidate's FULL value — the worst case, since
   * the fee is `relayCost + bps × amount`. A candidate that clears the fee at
   * its full value clears it at every smaller amount too, so this single round
   * trip settles the question conservatively.
   *
   * The two failure modes are reported apart on purpose. `too-small` is a
   * statement about the user's balance and sends them to add funds;
   * `unavailable` is a statement about the relayer and must not.
   */
  const priceCandidate = useCallback(async (
    candidate: FeeNoteCandidate,
    owner: SdkAddress,
    extraGas: boolean,
  ): Promise<
    | { ok: true; notes: FeeNoteCandidate; feeWei: bigint; payoutWei: bigint; gasTopUpWei: bigint | null }
    | { ok: false; reason: 'too-small' | 'unavailable'; feeWei?: bigint }
  > => {
    let quote;
    try {
      quote = await getQuote(
        chainId,
        candidate.totalWei.toString(),
        candidate.tokenId as Hex,
        owner as Hex,
        extraGas,
      );
    } catch (err) {
      // The relayer refuses what it cannot profitably relay with a specific
      // family of messages; at the candidate's FULL value that genuinely means
      // the fee outweighs the balance. Anything else — a 5xx, a timeout, a
      // transport error — is an outage and says nothing about the balance.
      const amountRejected = isAmountRejection(err);
      log(amountRejected ? 'info' : 'warn', 'GaslessRegistration',
        amountRejected
          ? 'Relayer says its fee outweighs this asset'
          : 'Relayer could not be reached to price the registration fee',
        { tokenId: candidate.tokenId, totalWei: candidate.totalWei.toString(), error: err });
      return { ok: false, reason: amountRejected ? 'too-small' : 'unavailable' };
    }
    const feeWei = (() => {
      try {
        return BigInt(quote.feeAmount);
      } catch {
        return 0n;
      }
    })();
    // A zero (or unparseable) fee is not a bargain, it is a bad quote: the
    // relayer rejects an `amountOut` of 0, so there would be nothing to bundle
    // the registration into.
    if (feeWei <= 0n) return { ok: false, reason: 'unavailable' };
    const gasTopUpWei = extraGas ? decodeGasTopUpWei(quote.feeCommitment?.data) : null;
    // The SDK would refuse this at submit, after the user signed.
    if (extraGas && (gasTopUpWei === null || gasTopUpWei <= 0n)) {
      log('warn', 'GaslessRegistration', 'Relayer quote carries no gas top-up although one was requested', {
        tokenId: candidate.tokenId,
      });
      return { ok: false, reason: 'unavailable' };
    }
    // Price what the submit will actually send (DEV-482): with `extraGas` the
    // relayer demands a public payout floor on top of its fee, so the fee alone
    // understates what leaves the pool. Decided here, before anything is shown.
    const converged = await convergeFeeOnlyQuote({
      initialQuote: quote,
      quoteFor: (amountWei) => getQuote(chainId, amountWei.toString(), candidate.tokenId as Hex, owner as Hex, extraGas),
      onRefused: (err) => log('info', 'GaslessRegistration', 'Fee-only re-quote refused while pricing', err),
    });
    if (!feeOnlyQuoteFits(converged, candidate.totalWei)) {
      // Too small: the converged gross (fee plus any payout floor) is the real minimum.
      return { ok: false, reason: converged.tightened ? 'too-small' : 'unavailable', feeWei: converged.tightened ? BigInt(converged.quote.amountSent) : feeWei };
    }
    const grossWei = BigInt(converged.quote.amountSent);
    const convergedFeeWei = BigInt(converged.quote.feeAmount);
    const narrowed = narrowFeeNotes(candidate, feeWei + grossWei - convergedFeeWei);
    if (!narrowed) return { ok: false, reason: 'too-small', feeWei: grossWei };
    // `feeWei` stays the full-value price: the ceiling the submit compares against.
    return { ok: true, notes: narrowed, feeWei, payoutWei: grossWei - convergedFeeWei, gasTopUpWei };
  }, [chainId, getQuote, log]);

  /**
   * Whether the wallet can pay `setViewingKey` itself, computed the same way as
   * the publish step so the two never disagree. RPC only, no relayer contact.
   */
  const readViewingKeyPath = useCallback(async (scope: string): Promise<
    ReturnType<typeof decideViewingKeyPath> & { balanceWei: bigint }
    | { path: 'self-register'; reason: 'balance-unreadable'; estimatedGasCostWei: bigint; balanceWei: bigint }
  > => {
    if (!publicClient || !address || !poolSession) {
      return { path: 'self-register', reason: 'balance-unreadable', estimatedGasCostWei: 0n, balanceWei: 0n };
    }
    const owner = address as Hex;
    const [balance, gasPrice] = await Promise.allSettled([
      publicClient.getBalance({ address: owner }),
      publicClient.getGasPrice(),
    ]);
    if (balance.status === 'rejected') {
      log('warn', 'GaslessRegistration', `balance read failed for ${scope}`, balance.reason);
      return { path: 'self-register', reason: 'balance-unreadable', estimatedGasCostWei: 0n, balanceWei: 0n };
    }
    if (gasPrice.status === 'rejected') {
      log('warn', 'GaslessRegistration', `gas-price read failed for ${scope}`, gasPrice.reason);
    }
    const gasPriceWei = gasPrice.status === 'fulfilled' ? gasPrice.value : undefined;
    let gasEstimate: bigint | null = null;
    if (balance.value > 0n && gasPriceWei && gasPriceWei > 0n) {
      try {
        const registration = await poolSession.prepareRegisterKeystore();
        const calldata = registration.viewingKeyCalldata;
        if (calldata) {
          gasEstimate = await publicClient.estimateGas({
            account: owner,
            to: calldata.to as Hex,
            data: calldata.data as Hex,
          });
        }
      } catch (err) {
        // Estimation can fail for an account short of gas; fall back to the static budget.
        log('info', 'GaslessRegistration', `setViewingKey estimate unavailable for ${scope}; using the static budget`, err);
      }
    }
    return { ...decideViewingKeyPath({ balanceWei: balance.value, gasPriceWei, gasEstimate, chainId }), balanceWei: balance.value };
  }, [publicClient, address, poolSession, log, chainId]);

  /**
   * "Is a relayer-paid registration worth OFFERING this wallet?"
   *
   * Advisory, and silent: local state and this app's own RPC only. It must
   * never contact the relayer — opening a modal is not consent to tell a third
   * party what a wallet holds, and every quote carries the wallet address, the
   * asset and an exact note-group total.
   *
   * Never throws: an unavailable answer is returned as `probe-failed`, which
   * fails closed to the self-funded path.
   *
   * ORDERED so affordability is settled before any dead-end check. Everything
   * after the balance read reports `walletCanPay: false`, which is what lets
   * the surface say "this wallet is stuck, and here is why" instead of showing
   * a button that fails inside the wallet. Checking chain support or note
   * availability first would have produced answers that could not be described.
   */
  const probeEligibility = useCallback(async (): Promise<GaslessRegistrationEligibility> => {
    if (!keysReady || !poolSession) {
      return { kind: 'ineligible', blocker: 'session-locked', walletCanPay: null };
    }
    // An account key has no wallet to sign SetAuthPolicy with, and registering
    // with key-derived material while some other wallet signs would write the
    // wrong keystore.
    if (identityMode !== 'wallet' || !address) {
      return { kind: 'ineligible', blocker: 'not-wallet-session', walletCanPay: null };
    }
    if (!publicClient) {
      return {
        kind: 'ineligible',
        blocker: 'probe-failed',
        detail: 'No public client for this chain.',
        walletCanPay: null,
      };
    }
    const owner = address as SdkAddress;

    // Already registered? Nothing to bundle, and `registerAndRelay` would
    // revert on the keystore's one-time guard. Asked of the TARGET chain: the
    // live session answers only for its own, and reading it for another chain
    // reported "already registered" for an account registered only here.
    // Auth set without a viewing key is not "already registered": it needs a top-up.
    let mode: GaslessRegistrationMode;
    try {
      const status = await keystoreStatusForChain(chainId);
      if (status === 'unknown') throw new Error(`Registration on chain ${chainId} could not be read.`);
      setReceiveSetup(sessionAddress ?? owner, chainId, receiveSetupFromIdentity(status), 'onchain');
      // 'incompatible' is registered under another unlock: nothing to register or finish.
      if (status === 'compatible' || status === 'incompatible') {
        return { kind: 'ineligible', blocker: 'already-registered', walletCanPay: null };
      }
      mode = status === 'partial' ? 'top-up' : 'register';
    } catch (err) {
      // Fail closed: an unreadable registration state must not send a bundled
      // registration at an account that may already have one.
      return {
        kind: 'ineligible',
        blocker: 'probe-failed',
        detail: err instanceof Error ? err.message : String(err),
        walletCanPay: null,
      };
    }

    // Affordability only — whether the chain can carry a registration leg is a
    // separate gate below.
    const decision = mode === 'top-up'
      ? await readViewingKeyPath('the registration decision')
      : await readRegistrationPath({
        getBalanceWei: () => publicClient.getBalance({ address: owner as Hex }),
        getGasPriceWei: () => publicClient.getGasPrice(),
      }, {
        onReadError: (scope, err) => log('warn', 'GaslessRegistration', `${scope} read failed for the registration decision`, err),
      });
    if (decision.path !== 'relayed-claim') {
      // `balance-unreadable` and `unknown-gas-price` are NOT "this wallet is
      // funded" — they are "we could not tell". Reporting them as funded
      // asserted a fact we never established, and for a genuinely empty wallet
      // behind a flaky RPC it suppressed both the offer and the warning.
      if (decision.reason === 'balance-unreadable' || decision.reason === 'unknown-gas-price') {
        return {
          kind: 'ineligible',
          blocker: 'probe-failed',
          detail: decision.reason,
          walletCanPay: null,
        };
      }
      log('info', 'GaslessRegistration', 'Wallet funds its own registration', {
        reason: decision.reason,
        balanceWei: decision.balanceWei.toString(),
        estimatedGasCostWei: decision.estimatedGasCostWei.toString(),
      });
      return { kind: 'ineligible', blocker: 'wallet-funded', detail: decision.reason, walletCanPay: true };
    }

    // === From here the wallet is genuinely stuck: walletCanPay is false ======

    // A proof built by a session on one chain cannot carry a fee commitment
    // quoted on another, and the notes that would pay the fee are the session
    // chain's. (The wallet sitting on an UNSUPPORTED chain does not land here —
    // useSessionChainId falls back to the app selection then — and is repaired
    // by the switchChainAsync in the submit.)
    if (!onSessionChain) {
      return {
        kind: 'ineligible',
        blocker: 'other-chain',
        detail: `Registering on chain ${chainId}; the live session is on chain ${sessionTarget?.chainId ?? sessionChainId}.`,
        walletCanPay: false,
      };
    }

    const supported = mode === 'top-up'
      ? topUpEnabled
      : supportsColdStartClaim(
        chainId,
        withdrawalProcessorAddress,
        // Static member read — Metro only inlines static process.env.EXPO_PUBLIC_*
        // access in the production web export.
        process.env.EXPO_PUBLIC_COLD_START_CLAIM_RELAYS,
      );
    if (!supported) {
      log('warn', 'GaslessRegistration', 'No verified registerAndRelay on this chain', {
        chainId,
        relay: withdrawalProcessorAddress,
      });
      return { kind: 'ineligible', blocker: 'chain-unsupported', walletCanPay: false };
    }

    let approvedNotes: Note[];
    try {
      approvedNotes = await filterAssociationSpendableNotes(readActiveNotes());
    } catch (err) {
      return {
        kind: 'ineligible',
        blocker: 'probe-failed',
        detail: `Association-set check failed: ${err instanceof Error ? err.message : String(err)}`,
        walletCanPay: false,
      };
    }
    const candidates = selectFeeNoteCandidates(approvedNotes);
    if (candidates.length === 0) {
      return { kind: 'ineligible', blocker: 'no-notes', walletCanPay: false };
    }
    // Whether the fee actually FITS is not answerable here — only the relayer
    // can price its own work, and asking costs the user their privacy. The
    // offer stops at "there is something to pay with"; quoteRegistration
    // settles the rest, before anything is signed.
    log('info', 'GaslessRegistration', 'Relayed registration worth offering', {
      mode,
      reason: decision.reason,
      candidates: candidates.length,
    });
    return { kind: 'eligible', mode, candidates };
  }, [
    keysReady,
    poolSession,
    identityMode,
    address,
    publicClient,
    chainId,
    onSessionChain,
    sessionTarget,
    sessionChainId,
    keystoreStatusForChain,
    sessionAddress,
    topUpEnabled,
    readViewingKeyPath,
    withdrawalProcessorAddress,
    readActiveNotes,
    filterAssociationSpendableNotes,
    log,
  ]);

  /** Re-checks onchain that the plan's mode still matches the account's state. */
  const assertModeStillApplies = useCallback(async (mode: GaslessRegistrationMode) => {
    const status = await keystoreStatusForChain(chainId);
    if (status === 'unknown') {
      throw new Error('Could not read this wallet\'s registration just now. Nothing was sent. Retry in a moment.');
    }
    setReceiveSetup(sessionAddress ?? address, chainId, receiveSetupFromIdentity(status), 'onchain');
    if (mode === 'register' && status !== 'unregistered') {
      throw new Error('This wallet is already registered on-chain.');
    }
    if (mode === 'top-up' && status !== 'partial') {
      throw new Error(status === 'unregistered'
        ? 'This wallet is not registered on this chain yet. Nothing was sent. Press Register.'
        : 'Setup is already complete on this chain. Nothing was sent.');
    }
  }, [keystoreStatusForChain, chainId, sessionAddress, address]);

  const formatMinimum = useCallback((tokenId: string, wei: bigint): string => {
    const token = getTokenMetadata(tokenId, chainId);
    const exact = formatUnits(wei, token.decimals);
    const [whole, frac = ''] = exact.split('.');
    // Round up: a minimum rounded down is not a minimum.
    const shown = frac.length > 6
      ? formatUnits(((wei + 10n ** BigInt(token.decimals - 6) - 1n) / 10n ** BigInt(token.decimals - 6)) * 10n ** BigInt(token.decimals - 6), token.decimals)
      : `${whole}${frac ? `.${frac}` : ''}`;
    return approxUnderlyingText(`${shown} ${token.symbol}`, token.symbol);
  }, [chainId]);

  /**
   * The user pressed Register. Settle the money question and produce a plan to
   * show them.
   *
   * This is the FIRST relayer contact in the flow, and it is deliberately here:
   * a quote carries the wallet address, the asset and an exact note-group
   * total, so it happens only once the user has asked for the registration —
   * the same bar every other surface in this app applies.
   *
   * Re-validates everything the probe established (state moves between opening
   * a modal and pressing a button), drops notes already spent on-chain, then
   * prices candidates in order until one fits. Throws user-facing copy; nothing
   * has been signed or sent when it does.
   */
  const quoteRegistration = useCallback(async (
    candidates: FeeNoteCandidate[],
    mode: GaslessRegistrationMode = 'register',
  ): Promise<QuotedRegistrationPlan> => {
    const nativeSymbol = getChainConfig(chainId)?.nativeCurrency.symbol ?? 'ETH';
    if (identityMode !== 'wallet' || !address || !publicClient || !poolSession) {
      throw new Error('Gasless registration is no longer available for this wallet. Nothing was sent.');
    }
    if (!onSessionChain) {
      throw new Error('Registering without gas only works on the chain your wallet is connected to. Nothing was sent.');
    }
    const owner = address as SdkAddress;
    await assertModeStillApplies(mode);
    const decision = mode === 'top-up'
      ? await readViewingKeyPath('the re-read at submit')
      : await readRegistrationPath({
        getBalanceWei: () => publicClient.getBalance({ address: owner as Hex }),
        getGasPriceWei: () => publicClient.getGasPrice(),
      }, {
        onReadError: (scope, err) => log('warn', 'GaslessRegistration', `${scope} re-read failed at submit`, err),
      });
    if (decision.path !== 'relayed-claim') {
      // Funded between the offer and the press: the user should pay their own
      // registration gas rather than have it silently taken out of a note.
      throw new Error(mode === 'top-up'
        ? 'This wallet now has enough gas to finish setup itself, so the relayer was not used. Nothing was sent. Press Finish setup again.'
        : 'This wallet can now pay for its own registration, so the relayer was not used. Nothing was sent — press Register again.');
    }
    const extraGas = mode === 'top-up' || topUpEnabled;
    // What the top-up must cover: the viewing-key gas the wallet still lacks,
    // at the current gas price (the static budget, since an estimate from a
    // wallet with no gas is not available). Read once, before any quote.
    let topUpShortfallWei = 0n;
    if (extraGas) {
      try {
        const [bal, gasPriceWei] = await Promise.all([
          publicClient.getBalance({ address: owner as Hex }),
          publicClient.getGasPrice(),
        ]);
        topUpShortfallWei = viewingKeyShortfallWei({ gasPriceWei, balanceWei: bal, chainId });
      } catch (err) {
        log('warn', 'GaslessRegistration', 'Could not read gas price for the top-up check; not bounding the top-up', err);
      }
    }

    // Rebuild from CURRENT notes and CURRENT association-set membership. A
    // rejected high-value label must not displace smaller approved notes from
    // the five-input budget, and a root change between modal open and this press
    // must be observed before any balance is disclosed to the relayer.
    const offeredTokenIds = new Set(candidates.map((candidate) => candidate.tokenId));
    let approvedCurrentNotes: Note[];
    try {
      approvedCurrentNotes = await filterAssociationSpendableNotes(
        readActiveNotes().filter((note) => offeredTokenIds.has(note.tokenId)),
        { freshDecisions: true },
      );
    } catch (err) {
      throw new Error(`Could not verify which shielded notes are approved right now. Nothing was sent — retry in a moment. (${err instanceof Error ? err.message : String(err)})`);
    }
    const refreshedCandidates = selectFeeNoteCandidates(approvedCurrentNotes);
    if (refreshedCandidates.length === 0) {
      throw new Error('No ASP-approved shielded notes are available to pay the registration fee yet. Nothing was sent — sync and retry.');
    }

    // Before pricing, not after: a note spent from another device still reads
    // ACTIVE here, and quoting against it would disclose a balance the wallet
    // does not have and then fail on-chain.
    const spent = await findSpentNotes(refreshedCandidates.flatMap((c) => c.notes));
    const live = refreshedCandidates
      .map((c) => {
        const notes = c.notes.filter((n) => !spent.has(n.commitment));
        return {
          ...c,
          notes,
          totalWei: notes.reduce((sum, n) => {
            try { return sum + BigInt(n.value); } catch { return sum; }
          }, 0n),
        };
      })
      .filter((c) => c.notes.length > 0 && c.totalWei > 0n);
    if (live.length === 0) {
      throw new Error('Every note this wallet holds has already been spent elsewhere. The balance has been corrected on this device — nothing was sent.');
    }

    // An outage anywhere in the loop must not be reported as "your balance is
    // too small" — that sends the user to fund a wallet that needs no funding.
    let sawOutage = false;
    let minimum: { tokenId: string; feeWei: bigint } | null = null;
    for (const candidate of live) {
      let priced = await priceCandidate(candidate, owner, extraGas);
      let planExtraGas = extraGas;
      // A top-up that is missing or too small to finish setup is not worth
      // paying for. For a plain registration, fall back to one without it (the
      // account then finishes setup later); a top-up-only run has nothing
      // else to offer, so it says why instead (review of #130).
      const shortTopUp = priced.ok && extraGas && !topUpCovers(priced.gasTopUpWei, topUpShortfallWei);
      // Requesting the top-up can push the full-note quote over the "fee
      // outweighs the balance" line even though the same note affords plain
      // registration without the optional gas — retry without it, same as the
      // claim flow's fallback (hooks/use-note-import.ts).
      const topUpMadeItTooSmall = !priced.ok && extraGas && priced.reason === 'too-small';
      if (extraGas && ((!priced.ok && priced.reason === 'unavailable') || shortTopUp || (mode !== 'top-up' && topUpMadeItTooSmall))) {
        if (mode === 'top-up') {
          if (shortTopUp && priced.ok) {
            throw new Error(`The relayer's gas top-up (${formatEther(priced.gasTopUpWei ?? 0n)}) would not cover finishing setup (${formatEther(topUpShortfallWei)} needed at current gas prices). Nothing was sent. Try again later.`);
          }
        } else {
          log('info', 'GaslessRegistration', 'Top-up unavailable, short, or made this note too small; pricing the registration without it', {
            tokenId: candidate.tokenId,
            quotedTopUpWei: priced.ok ? priced.gasTopUpWei?.toString() ?? null : null,
            shortfallWei: topUpShortfallWei.toString(),
          });
          priced = await priceCandidate(candidate, owner, false);
          planExtraGas = false;
        }
      }
      if (!priced.ok) {
        if (priced.reason === 'unavailable') sawOutage = true;
        if (priced.reason === 'too-small' && priced.feeWei !== undefined && (!minimum || priced.feeWei < minimum.feeWei)) {
          minimum = { tokenId: candidate.tokenId, feeWei: priced.feeWei };
        }
        continue;
      }
      const plan: QuotedRegistrationPlan = {
        mode,
        extraGas: planExtraGas,
        gasTopUpWei: planExtraGas ? priced.gasTopUpWei : null,
        tokenId: priced.notes.tokenId,
        notes: priced.notes.notes,
        noteValueWei: priced.notes.totalWei,
        quotedFeeWei: priced.feeWei,
        quotedPayoutWei: priced.payoutWei,
        changeWei: priced.notes.totalWei - priced.feeWei - priced.payoutWei,
      };
      log('info', 'GaslessRegistration', 'Quoted a relayed registration for confirmation', {
        mode,
        extraGas: plan.extraGas,
        gasTopUpWei: plan.gasTopUpWei?.toString() ?? null,
        tokenId: plan.tokenId,
        labels: [...new Set(plan.notes.map((note) => note.label))],
        inputs: plan.notes.length,
        noteValueWei: plan.noteValueWei.toString(),
        quotedFeeWei: plan.quotedFeeWei.toString(),
        changeWei: plan.changeWei.toString(),
      });
      return plan;
    }
    log('warn', 'GaslessRegistration', 'No candidate could fund the registration fee', {
      sawOutage,
      candidates: live.map((c) => ({ tokenId: c.tokenId, totalWei: c.totalWei.toString() })),
    });
    throw new Error(describeQuoteFailure(
      sawOutage ? 'relayer-unavailable' : 'fee-exceeds-balance',
      nativeSymbol,
      {
        // Strictly more: a balance equal to the fee leaves no change note.
        minimum: minimum ? formatMinimum(minimum.tokenId, minimum.feeWei + 1n) : null,
        withTopUp: extraGas,
        // Registration is already done in this mode — only the gas top-up
        // for setViewingKey failed to price. Say that, not "failed registration".
        topUpOnly: mode === 'top-up',
      },
    ));
  }, [
    chainId, onSessionChain, identityMode, address, publicClient, poolSession, topUpEnabled, readViewingKeyPath,
    readActiveNotes, filterAssociationSpendableNotes, findSpentNotes, priceCandidate, log,
    assertModeStillApplies, formatMinimum,
  ]);

  /** Whether the spend is visible onchain, via the bulk index (no per-nullifier reads). */
  const confirmSpendOnchain = useCallback(async (inputCommitments: Hash[]): Promise<boolean> => {
    const poolAddress = LEGACY_CONFIG?.pool ?? getChainConfig(chainId)?.contracts?.poolAddress;
    const fromBlock = getChainConfig(chainId)?.contracts?.fromBlock;
    const privateNullifyingKey = keystoreManager?.getPrivateNullifyingKey();
    if (!poolAddress || fromBlock === undefined || !privateNullifyingKey) return false;
    try {
      const { confirmRelayedSpend } = await import('@/services/onchain-note-index');
      const { confirmed } = await confirmRelayedSpend({
        chainId,
        poolAddress: String(poolAddress),
        fromBlock,
        inputCommitments,
        privateNullifyingKey: privateNullifyingKey as Hex,
      });
      return confirmed;
    } catch (err) {
      log('warn', 'GaslessRegistration', 'Onchain confirmation of the relayed spend failed', err);
      return false;
    }
  }, [chainId, keystoreManager, log]);

  /**
   * Registers the keystore (or, for `top-up`, sends the wallet gas) through the
   * relayer, paying for it out of a note.
   *
   * Takes the plan the user was SHOWN and CONFIRMED (see `quoteRegistration`).
   * The confirmed `quotedFeeWei` is binding from here on: the relayer's final
   * fee may come in lower, never higher. Without that ceiling the flow would
   * quote after the signature and pay whatever came back — a misconfigured or
   * hostile relayer could take almost the whole balance under a button that
   * promised no gas.
   *
   * Resolves with the gas forwarded, from the submitted commitment.
   *
   * Throws with user-facing copy on every refusal — the caller renders the
   * message as-is. Nothing has moved when it throws before the relay; after
   * it, only a confirmed receipt (or the spend seen onchain) is trusted.
   */
  const submitRelayedRegistration = useCallback(async (options: {
    plan: QuotedRegistrationPlan;
    onStatus?: (message: string) => void;
  }): Promise<{ gasTopUpWei: bigint | null }> => {
    const setStatus = options.onStatus ?? (() => {});
    const plan = options.plan;
    const topUpOnly = plan.mode === 'top-up';
    const again = topUpOnly ? 'Press Finish setup again.' : 'Press Register again.';
    if (!address || !poolSession) {
      throw new Error('Gasless registration is no longer available for this wallet. Nothing was sent.');
    }
    // The last gate before a signature. The quote stage checks this too, but a
    // wallet or chain switch while the confirmation sat on screen can move the
    // live session away from the chain the plan was priced for, and past this
    // point a note on the session's chain would pay to register there.
    if (!onSessionChain) {
      throw new Error(`Your wallet moved to another chain since this was priced. Nothing was sent. ${again}`);
    }
    // Cheap last look before the commitment point: another tab may have
    // registered (or published the viewing key) while the confirmation was on
    // screen, and registerAndRelay reverts on the keystore's one-time guard.
    await assertModeStillApplies(plan.mode);
    const owner = address as SdkAddress;

    // NOT dead code, despite the probe requiring chainId === sessionChainId:
    // useSessionChainId only follows the connector while the connector is on a
    // SUPPORTED chain, so a wallet parked on a foreign network still satisfies
    // that equality (the session falls back to the app selection). Without this
    // switch the wallet would then refuse to sign typed data whose EIP-712
    // domain names a chain it is not on.
    if (isSupportedEvmChainId(chainId)) {
      await switchChainAsync({ chainId });
    }
    const session = await ensureInitialized();

    const assertPlanStillApproved = async (
      phase: 'sign' | 'prove',
      options: { freshDecisions?: boolean } = {},
    ) => {
      let approvedNotes: Note[];
      try {
        approvedNotes = await filterAssociationSpendableNotes(plan.notes, options);
      } catch (err) {
        throw new Error(`Could not refresh note approvals before ${phase === 'sign' ? 'signing' : 'proving'}. Nothing was sent — retry in a moment. (${err instanceof Error ? err.message : String(err)})`);
      }
      const approvedCommitments = new Set(approvedNotes.map((note) => note.commitment));
      if (plan.notes.some((note) => !approvedCommitments.has(note.commitment))) {
        throw new Error(`A shielded note is no longer ASP-approved, so this was stopped before ${phase === 'sign' ? 'you signed' : 'a proof was generated'}. Nothing was sent — sync and retry.`);
      }
    };

    // The signature comes FIRST because it is user-paced: a fee commitment
    // lives ~60s and the proof after it eats a good part of that, so a
    // signature prompt sitting in front of the quote would expire it. A top-up
    // registers nothing, so it has no signature at all.
    let signature: Hex | null = null;
    let deadline: Hex | null = null;
    if (!topUpOnly) {
      await assertPlanStillApproved('sign', { freshDecisions: true });
      deadline = buildRegistrationDeadline(Date.now());
      const typedData = session.buildSetAuthPolicyTypedData(deadline);
      // Wording matters: FlowProgress derives its stage from this string and the
      // stage is monotonic, so a word that jumps it forward can never be undone.
      // "Accept", not "Approve" — /prov/ matches the middle of "approve" and
      // pinned the whole ~30s flow at the Prove stage from the signature onward.
      setStatus('Accept the free authorization — no gas needed');
      // Signing costs nothing on-chain — this IS the "no gas" trick. The relayer
      // forwards it to Keystore.setAuthPolicyWithSig.
      signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      } as Parameters<typeof signTypedDataAsync>[0]) as Hex;
    }

    // The wallet prompt is user-paced. Bypass the rejection TTL after it
    // closes so a revocation during the prompt cannot poison the proof.
    await assertPlanStillApproved('prove', { freshDecisions: true });

    // Let the RELAYER price its own work, then re-quote for the smallest payout
    // it accepts: 0 without a top-up, or with `extraGas` the floor the relayer
    // names in its refusal plus 25% headroom, which goes to the wallet. Fee and
    // that payout leave the pool; the remainder stays shielded as change.
    setStatus('Checking the network fee…');
    const quoteFor = (amountWei: bigint) => getQuote(
      chainId,
      amountWei.toString(),
      plan.tokenId as Hex,
      owner as Hex,
      plan.extraGas,
    );
    // ONLY the first quote's rejection is an answer about this balance: the
    // relayer refuses what it cannot profitably relay, and at the full value
    // that means the fee really does outweigh what the wallet holds.
    let initialQuote;
    try {
      initialQuote = await quoteFor(plan.noteValueWei);
    } catch (quoteErr) {
      if (isAmountRejection(quoteErr)) {
        throw new Error(topUpOnly
          ? 'The relayer fee now exceeds your shielded balance, so it cannot send gas for you. Nothing was sent. Retry when fees are lower, or add a little gas to this wallet.'
          : 'The relayer fee now exceeds your shielded balance, so it cannot register this wallet for you. Nothing was sent — retry when fees are lower, or add a little gas to this wallet.');
      }
      throw quoteErr;
    }
    // THE CEILING. Priced on the same full selection the confirmation showed,
    // so it is directly comparable: anything above the number the user agreed
    // to is refused rather than quietly charged. Same fund-safety rule the
    // withdraw modal applies between its review and its confirm. A retry
    // re-quotes from scratch and shows a fresh number, so this cannot wedge.
    if (BigInt(initialQuote.feeAmount) > plan.quotedFeeWei) {
      log('warn', 'GaslessRegistration', 'Relayer fee rose above the confirmed ceiling — aborting', {
        confirmedFeeWei: plan.quotedFeeWei.toString(),
        quotedFeeWei: initialQuote.feeAmount,
      });
      throw new Error(`The relayer’s fee went up since you confirmed it, so nothing was sent. ${again}`);
    }
    const { quote, tightened } = await convergeFeeOnlyQuote({
      initialQuote,
      quoteFor,
      onRefused: (err) => log('info', 'GaslessRegistration', 'Fee-only re-quote refused; keeping the last good quote', err),
    });
    // Falling back on the FULL-VALUE quote would withdraw the entire shielded
    // balance to the wallet — the opposite of what this flow promises. An
    // accepted re-quote always lands the gross at the relayer's own fee, so
    // "never tightened" is the only way that can happen, and it must fail
    // rather than cash the user out.
    if (!tightened && BigInt(quote.amountSent) !== BigInt(quote.feeAmount)) {
      throw new Error('The relayer could not price a fee-only transaction just now, and going ahead would have moved your whole shielded balance out of the pool. Nothing was sent. Retry in a moment.');
    }
    // Not converging is not a failure: an unconverged quote just pays a few wei
    // out to the wallet, which every downstream assertion accepts.
    //
    // The convergence only ever replaces a quote with a strictly tighter one, so
    // this should be unreachable — but it is the last point before value moves,
    // and the ceiling is the whole protection here.
    // DEV-482: the ceiling covers everything that leaves the pool, the fee AND
    // the top-up payout floor the confirmation showed, not the fee alone.
    if (BigInt(quote.feeAmount) > plan.quotedFeeWei
      || BigInt(quote.amountSent) > plan.quotedFeeWei + plan.quotedPayoutWei) {
      throw new Error(`The relayer’s fee went up while preparing this, so nothing was sent. ${again}`);
    }
    // The SDK refuses a zero top-up with `extraGas`; fail before proving.
    const gasTopUpWei = plan.extraGas ? decodeGasTopUpWei(quote.feeCommitment?.data) : null;
    if (plan.extraGas && (gasTopUpWei === null || gasTopUpWei <= 0n)) {
      throw new Error(`The relayer's quote did not include the gas for your wallet, so nothing was sent. ${again}`);
    }
    // planFeeOnlyClaim's own throws are worded for the /import-note claim page
    // ("this payment … stays saved on this device"), which is nonsense in a
    // registration modal — there is no payment and nothing was saved. Translate
    // them, keeping the real cause in the debug log.
    let feePlan;
    try {
      feePlan = planFeeOnlyClaim({
        noteValueWei: plan.noteValueWei,
        amountSentWei: BigInt(quote.amountSent),
        feeAmountWei: BigInt(quote.feeAmount),
      });
    } catch (planErr) {
      log('warn', 'GaslessRegistration', 'Fee-only split refused the converged quote', planErr);
      throw new Error('The relayer fee moved and no longer leaves anything of your shielded balance behind, so nothing was sent. Retry in a moment, or add a little gas to this wallet.');
    }
    log('info', 'GaslessRegistration', 'Relayed registration plan', {
      mode: plan.mode,
      tokenId: plan.tokenId,
      labels: [...new Set(plan.notes.map((note) => note.label))],
      inputs: plan.notes.length,
      noteValueWei: plan.noteValueWei.toString(),
      feeWei: quote.feeAmount,
      grossWei: feePlan.grossWei.toString(),
      payoutWei: feePlan.payoutWei.toString(),
      changeWei: feePlan.changeWei.toString(),
      feeOnly: feePlan.feeOnly,
      extraGas: plan.extraGas,
      gasTopUpWei: gasTopUpWei?.toString() ?? null,
      processor: withdrawalProcessorAddress,
      deadline,
    });

    // Fee quoting/convergence can take several network round trips after the
    // post-signature check. Refresh at the actual proof boundary too: a label
    // revoked during those awaits must never enter the relayed spend.
    await assertPlanStillApproved('prove', { freshDecisions: true });
    setStatus('Generating proof…');
    const relayParams = {
      inputCommitments: plan.notes.map((note) => note.commitment),
      amount: `0x${feePlan.payoutWei.toString(16)}` as Hex,
      tokenId: plan.tokenId as Hex,
      recipientAddress: owner,
      // Must match the quote's flag for the SDK's nativeGas guard.
      extraGas: plan.extraGas,
      selectedQuote: {
        // The relayer advertises its signer EOA as the processor, but the
        // on-chain msg.sender for a relayed spend is the PrivacyPoolRelay
        // contract — bind the proof to that or PoolVault rejects the context
        // with PoolVault_ProofContextMismatch. Same rebinding the claim page and
        // the withdraw modal's cold-start path do.
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
    const receipt: TxReceiptLike = topUpOnly
      ? await session.relayWithdraw(relayParams)
      : await session.registerAndWithdraw({ ...relayParams, signature, deadline });
    // A resolved promise is not success: the SDK returns failed receipts
    // without persisting note updates.
    const status = (receipt as { status?: unknown } | undefined)?.status;
    if (status === false || status === 'reverted') {
      throw new Error(topUpOnly
        ? 'The gas transfer failed on-chain. Your funds are untouched. Retry.'
        : 'The registration transaction failed on-chain. Your funds are untouched. Retry.');
    }
    const sdkConfirmed = status === true || status === 'success';
    let confirmed = sdkConfirmed;
    if (!confirmed) {
      // Unconfirmed receipt: check onchain rather than re-relay (would pay twice).
      confirmed = await confirmSpendOnchain(plan.notes.map((note) => note.commitment as Hash));
    }
    if (!confirmed) {
      throw new Error(topUpOnly
        ? 'The gas transfer was submitted but could not be confirmed. Check back in a moment before retrying, because it may already have landed.'
        : 'The registration was submitted but could not be confirmed. Check back in a moment before retrying — it may already have landed.');
    }

    setReceiveSetup(sessionAddress ?? owner, chainId, 'partial', 'local');

    // Name this spend for what it was in the activity list (DEV-574) and keep
    // the relayer fee it paid for its details (DEV-517). Local records of a
    // hash the relayer already returned; nothing is requested.
    const setupTxHash = (receipt as { txHash?: unknown } | undefined)?.txHash;
    if (typeof setupTxHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(setupTxHash)) {
      const txHash = setupTxHash.toLowerCase();
      try {
        recordOwnAction({ kind: topUpOnly ? 'setup-gas' : 'setup-register', chainId, txHash, timestamp: Date.now() });
        recordWithdrawFee({ txHash, feeAmount: String(quote.feeAmount), tokenAddress: String(plan.tokenId).toLowerCase(), chainId, timestamp: Date.now(), kind: 'withdrawal' });
      } catch { /* bookkeeping only */ }
    }

    // An SDK-confirmed receipt already marked the inputs SPENT and added the
    // change. One confirmed from bulk chain data instead left them untouched,
    // so mark the inputs here and nothing reselects them. The change note
    // arrives with the grid's discovery: passes timed to this relayed spend
    // would tie this client to it.
    if (!sdkConfirmed) {
      const manager = getCommittedManagers().noteManager ?? noteManager;
      for (const note of plan.notes) {
        try {
          if (manager && String(manager.getNote(note.commitment as Hash).status) === NoteStatus.ACTIVE) {
            manager.updateNoteStatus(note.commitment as Hash, NoteStatus.SPENT);
          }
        } catch { /* not held here, or already settled */ }
      }
      try { await exportAccount(); } catch { /* the next discovery pass persists it */ }
    }
    refreshNotes();

    log('info', 'GaslessRegistration', topUpOnly ? 'Gas top-up relayed' : 'Keystore registered by the relayer', {
      chainId,
      inputs: plan.notes.length,
      feeWei: quote.feeAmount,
      gasTopUpWei: gasTopUpWei?.toString() ?? null,
    });
    return { gasTopUpWei };
  }, [
    poolSession,
    address,
    chainId,
    onSessionChain,
    switchChainAsync,
    ensureInitialized,
    signTypedDataAsync,
    getQuote,
    filterAssociationSpendableNotes,
    withdrawalProcessorAddress,
    assertModeStillApplies,
    confirmSpendOnchain,
    sessionAddress,
    refreshNotes,
    noteManager,
    getCommittedManagers,
    exportAccount,
    log,
  ]);

  return { probeEligibility, quoteRegistration, submitRelayedRegistration };
}
