/**
 * One Stellar privacy account per connected address, shared by every
 * component: the derived protocol keys (one wallet signature per page load),
 * the SDK PoolSession, and the account's notes.
 *
 * Every flow here follows the call sequence of the Stellar SDK's live-testnet
 * e2e (packages/stellar-sdk/scripts/e2e-stellar/stellar-e2e.test.ts at
 * v2.0@69f76259), which ran green against this deployment:
 *   deposit   prepareDeposit → executeDeposit → discoverNotes
 *   register  isKeystoreRegistered → registerKeystore (two txs), before the
 *             first deposit (or the first spend, for accounts without one)
 *   withdraw  withdraw({ processorAddress: owner, inputCommitments })
 *   transfer  transfer({ recipientDiscoveryData: { evmAddress: G… } })
 *   exit      rageQuit({ commitment })
 *
 * One addition: after a deposit, the ASP ciphertext the SDK already computed
 * (and the Stellar adapter drops) is registered on the ASP registry via
 * `register_label`, which is how the testnet ASP learns the label to approve.
 *
 * Request timing (docs/privacy-request-discipline.md): nothing here syncs in
 * response to a flow. Chain reads run on the fixed clock in
 * hooks/use-stellar-session.ts; a finished flow only refreshes the local view
 * from the session's own state.
 *
 * Storage: the account export holds every note secret, so it lives in
 * sessionStorage (gone with the tab), exactly like the EVM export in
 * components/sdk-provider.tsx. Plaintext copies older builds left in
 * localStorage are deleted at load. Payment requests are the exception, as
 * on EVM: their records also persist in localStorage
 * (stellar-request-storage.ts), since nothing else can rebuild a blind
 * request's note secrets, and making one downloads a request backup.
 */
import type {
  Hex,
  IRelayerInteractor,
  Note,
  PoolSession,
  ProtocolKeys,
  StellarAddress,
  StellarLog,
  StellarProof,
  StellarWalletProvider,
  TransferResult,
} from '@privacy-pools-v2/stellar-sdk';

import {
  STELLAR_KEY_APP_IDENTIFIER,
  estimateStellarRelayFee,
  STELLAR_RELAYER_CHAIN_ID,
  STELLAR_TESTNET_CONTRACTS,
  STELLAR_TESTNET_DEPLOYMENT_LEDGER,
  STELLAR_TESTNET_NETWORK,
  STELLAR_TESTNET_RPC_URL,
  STELLAR_TRANSFER_RELAY_FEE_ESTIMATE,
  requireStellarRelayerUrl,
} from '@/config/stellar-deployment';
import { STELLAR_TESTNET_ID } from '@/config/chains';
import { ASP_URL, PAY_URL_BASE } from '@/config/env';
import { LEGACY_APP_ORIGINS } from '@/config/site-urls';
import {
  purgeLegacyStellarAccountCopies,
  readSessionAccount,
  writeSessionAccount,
} from '@/services/stellar/stellar-account-storage';
import {
  FetchCircuitArtifacts,
  StellarTestnetAspProvider,
  createNoRelayerInteractor,
  createIndexedRpcInteractor,
  loadStellarSdk,
  type StellarSdk,
  type IndexedStellarRpcInteractor,
  type StellarRpcInteractor,
} from '@/services/stellar/stellar-runtime';
import { createStellarRelayer, relayAwareRpc } from '@/services/stellar/stellar-relayer';
import {
  decodeStellarBackup,
  decodeStellarRequestBackup,
  encodeStellarBackup,
  encodeStellarRequestBackup,
  mergeStellarExports,
  mergeStellarRequestRecords,
  type SealedEnvelopeLike,
} from '@/services/stellar/stellar-backup';
import {
  markStellarRequestsBackedUp,
  markStellarRequestsHeldByBackup,
  purgeBackedUpStellarRequests,
  readStoredStellarRequests,
  writeStoredStellarRequests,
} from '@/services/stellar/stellar-request-storage';
import {
  addSessionPaymentRequest,
  listSessionPaymentRequests,
  type SessionPaymentRequest,
} from '@/services/session-payment-requests';
import { bumpPaymentRequestRevision } from '@/services/payment-request-revision';
import { registerDebugSnapshot } from '@/services/debug-snapshots';
import { toImportableNote, type StellarClaimNote } from '@/services/stellar/stellar-claim';
import { findSentClaim, readSentClaims, saveSentClaim, SENT_CLAIMS_BASE_KEY, setSentClaimTx } from '@/services/stellar/stellar-sent-claims';
import { isStellarAccountAddress, requestStates, type StellarRequestState } from '@/services/stellar/stellar-request';
import type { StellarSdkPaymentRequest } from '@/services/payment-request-codec';
import { envScopedStorageKey } from '@/config/app-environment';
import { buildStellarNoteOrigins, reconstructStellarSpends, type StellarNoteOrigins } from '@/services/stellar-activity';
import { withSigningWindow } from '@/services/stellar/stellar-signing-window';

export type { StellarRequestState };

purgeLegacyStellarAccountCopies();

export type StellarPoolSession = PoolSession<string, StellarAddress, StellarProof, StellarLog>;
export type StellarNote = Note<StellarAddress>;

export type StellarAccountStatus = 'idle' | 'unlocking' | 'syncing' | 'ready' | 'error';

export interface StellarAccountSnapshot {
  address: string | null;
  status: StellarAccountStatus;
  /** Keys derived and session built: flows can run without another signature. */
  unlocked: boolean;
  notes: StellarNote[];
  registered: boolean | null;
  /**
   * Where each of these notes came from on chain (deposit + depositor, or a
   * transact output) and when, read from the pool's event history in bulk on
   * the sync clock. Null until the first sync reads it. Local derivation input
   * for the activity rows (services/stellar-activity.ts).
   */
  noteOrigins: StellarNoteOrigins | null;
  /**
   * The blind payment requests this account holds (made here or restored
   * from a backup), and whether the SDK has seen one paid. From the
   * session's own state, no request.
   */
  paymentRequests: StellarRequestState[];
  lastSyncedAt: number | null;
  error: string | null;
}

export type StellarFlowStage =
  | 'unlocking'
  | 'registering'
  | 'proving'
  | 'signing'
  | 'confirming'
  | 'registering-label'
  | 'relaying'
  | 'syncing';

type StageListener = (stage: StellarFlowStage) => void;

/** Slots per blind request: a transfer spends up to five notes and pays one recipient note per input. */
const STELLAR_REQUEST_SLOTS = 5;

const EMPTY: StellarAccountSnapshot = {
  address: null,
  status: 'idle',
  unlocked: false,
  notes: [],
  registered: null,
  noteOrigins: null,
  paymentRequests: [],
  lastSyncedAt: null,
  error: null,
};

class StellarAccount {
  private snapshot: StellarAccountSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private signer: StellarWalletProvider | null = null;
  private sessionPromise: Promise<StellarPoolSession> | null = null;
  // The relayer, set only while a relayed withdrawal or transfer runs (see buildSession).
  private activeRelayer: IRelayerInteractor<StellarAddress> | null = null;
  private rpc: IndexedStellarRpcInteractor | null = null;
  private syncPromise: Promise<void> | null = null;
  // Serialises flows: two spends built from one note view would double-select.
  private queue: Promise<unknown> = Promise.resolve();
  // Bumped whenever the bound address changes: a flow started for one account
  // refuses to submit anything after another account binds.
  private generation = 0;
  // Memory only, like the session's own keys: matches this account's spends
  // in the pool's Transacted events (services/stellar-activity.ts).
  private nullifyingKey: string | null = null;
  private poseidon: ReturnType<StellarSdk['PoseidonHashService']['create']> | null = null;

  getSnapshot = (): StellarAccountSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<StellarAccountSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Follows the wallet. A different address drops the previous account entirely. */
  bind(address: string | null, signer: StellarWalletProvider | null) {
    if (address === this.snapshot.address) {
      this.signer = signer;
      return;
    }
    // Signing out or switching away: the requests the user is proven to hold
    // a backup of leave this browser with the account. Any other stays.
    const previous = this.snapshot.address;
    if (previous) purgeBackedUpStellarRequests(STELLAR_TESTNET_ID, previous);
    this.signer = signer;
    this.generation++;
    this.sessionPromise = null;
    this.nullifyingKey = null;
    this.syncPromise = null;
    // Show the last synced notes straight away (read-only): keys are memory
    // only, so without this every reload reads a zero balance until the user
    // signs again. Spending still unlocks first.
    if (address && restoreStoredRows(address)) bumpPaymentRequestRevision();
    this.snapshot = { ...EMPTY, address, notes: address ? readCachedNotes(address) : [], paymentRequests: address ? readCachedRequests(address) : [] };
    for (const listener of this.listeners) listener();
  }

  private requireSigner(): { address: string; signer: StellarWalletProvider; generation: number } {
    const address = this.snapshot.address;
    if (!address || !this.signer) throw new Error('Connect a Stellar wallet first.');
    return { address, signer: this.signer, generation: this.generation };
  }

  /** Throws when the account a flow started for is no longer the bound one. */
  private assertStillBound(generation: number) {
    if (generation !== this.generation) {
      throw new Error('The connected Stellar account changed. Start again.');
    }
  }

  /**
   * Derives keys (one signature) and builds the session, once per address.
   * The signature never leaves this function; only the derived keys are kept,
   * in memory.
   */
  ensureSession(onStage?: StageListener): Promise<StellarPoolSession> {
    if (!this.sessionPromise) {
      const { address, signer } = this.requireSigner();
      onStage?.('unlocking');
      this.set({ status: 'unlocking', error: null });
      this.sessionPromise = this.buildSession(address, signer).then(
        (session) => {
          if (this.snapshot.address === address) this.set({ unlocked: true, status: 'ready' });
          return session;
        },
        (error) => {
          if (this.snapshot.address === address) {
            this.sessionPromise = null;
            this.set({ status: 'error', error: messageOf(error) });
          }
          throw error;
        },
      );
    }
    return this.sessionPromise;
  }

  /** The session's RPC; while a relayer is active it never builds a `transact` from this account (see relayAwareRpc). */
  private confirmingRpc(rpc: IndexedStellarRpcInteractor): IndexedStellarRpcInteractor {
    return relayAwareRpc(rpc, STELLAR_TESTNET_CONTRACTS.poolContractId, () => this.activeRelayer !== null);
  }

  /** Reads the relayer's details and builds its client; refuses one serving another deployment. */
  private async connectRelayer(sdk: StellarSdk): Promise<IRelayerInteractor<StellarAddress>> {
    const url = requireStellarRelayerUrl();
    let details: { relayerAddress: string; contracts?: { relay?: string } };
    try {
      const res = await fetch(`${url}/v1/details/stellar/${STELLAR_RELAYER_CHAIN_ID}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`relayer details ${res.status}`);
      details = await res.json();
    } catch {
      throw new Error('The Stellar testnet relayer is not reachable. Try again later.');
    }
    if (details.contracts?.relay !== STELLAR_TESTNET_CONTRACTS.relayContractId) {
      throw new Error('The Stellar testnet relayer serves another deployment.');
    }
    return createStellarRelayer(sdk, { url, relayerAddress: details.relayerAddress });
  }

  /** Runs `fn` with the relayer handed to the session; it is reachable only for this call, as for a withdrawal. */
  private async withTransferRelayer<T>(relayer: IRelayerInteractor<StellarAddress>, fn: () => Promise<T>): Promise<T> {
    this.activeRelayer = relayer;
    try {
      return await fn();
    } finally {
      this.activeRelayer = null;
    }
  }

  /**
   * Stamps claimed notes imported with the '0x0' creation stub. The pool's state-tree leaf is
   * hash(tag, commitment, createdAt), so a stubbed note can never be anchored ("Leaf … not found in
   * tree"). The time comes from the pool's own events (the whole-history index: no read names the
   * note). Returns false when a note is not indexed yet; `required` makes that an error instead.
   */
  private async stampClaimedNotes(session: StellarPoolSession, commitments: readonly Hex[], required: boolean): Promise<boolean> {
    const wanted = new Set(commitments.map((c) => BigInt(c)));
    const account = await session.exportAccount();
    const stubs = account.notes.filter((n) => wanted.has(BigInt(n.commitment)) && BigInt(n.createdAtBlock ?? 0) === 0n);
    if (stubs.length === 0 || !this.rpc) return stubs.length === 0;
    const sdk = await loadStellarSdk();
    const pool = new sdk.StellarPoolVaultChainAdapter({
      rpcInteractor: this.rpc,
      contractId: STELLAR_TESTNET_CONTRACTS.poolContractId,
      readSourcePublicKey: sdk.STELLAR_NEUTRAL_READ_SOURCE,
      deploymentLedger: Number(STELLAR_TESTNET_DEPLOYMENT_LEDGER),
    });
    for (const note of stubs) {
      const createdAt = await pool.getCommitmentValue(note.commitment as Hex);
      if (createdAt === 0n) {
        if (required) throw new Error('This payment is not on the pool index yet. Try again in a minute.');
        return false;
      }
      note.createdAtBlock = `0x${createdAt.toString(16)}` as Hex;
    }
    await session.importAccount(account);
    return true;
  }

  /** Relays the first quoted option; refuses a receipt that did not spend this transfer's notes. */
  private async relayPreparedTransfer(
    session: StellarPoolSession,
    prepared: Awaited<ReturnType<StellarPoolSession['prepareTransfer']>>,
  ): Promise<TransferResult<StellarAddress, StellarLog>> {
    const option = prepared.relayOptions[0];
    if (!option) throw new Error('The relayer did not return a quote.');
    // Note selection and the UI reserve the estimate; a higher signed fee would come out of the slack.
    if (BigInt(option.selectedQuote.quote.feeCommitment.feeAmount) > STELLAR_TRANSFER_RELAY_FEE_ESTIMATE) {
      throw new Error('The relayer asks for more than the fee shown. Try again later.');
    }
    // The recipient's noteSecretsMap must stay: relayTransfer builds the note data itself, and without
    // the map it encodes blind (secretless) notes the recipient can neither discover nor spend.
    const result = await session.relayTransfer(option);
    if (result.spentNullifiersConfirmed === false) throw new Error('The relayer reported a transaction that is not this transfer.');
    return result;
  }

  private async buildSession(address: string, signer: StellarWalletProvider): Promise<StellarPoolSession> {
    const sdk = await loadStellarSdk();
    this.rpc = createIndexedRpcInteractor(sdk, ASP_URL);
    const protocolKeys = await deriveProtocolKeys(sdk, address, signer);
    if (this.snapshot.address === address) this.nullifyingKey = String(protocolKeys.privateNullifyingKey);
    const session = await sdk.StellarPoolSessionBuilder.create({
      chainId: STELLAR_TESTNET_ID,
      ownerAddress: address,
      rpcUrl: STELLAR_TESTNET_RPC_URL,
      // Event history from the testnet indexer (every event since the
      // deployment); everything else is plain Soroban RPC. A relayed
      // transfer's receipt is confirmed from pool events, never by its hash.
      rpcInteractor: this.confirmingRpc(this.rpc),
      networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase,
      poolContractId: STELLAR_TESTNET_CONTRACTS.poolContractId,
      deploymentLedger: STELLAR_TESTNET_DEPLOYMENT_LEDGER,
      keystoreContractId: STELLAR_TESTNET_CONTRACTS.keystoreContractId,
      aspRegistryContractId: STELLAR_TESTNET_CONTRACTS.aspRegistryContractId,
      // Required by the config schema even with an ASP override; never fetched.
      ipfsGatewayUrl: 'http://unused.invalid',
      protocolKeys,
      // Each transaction's validity window starts when Freighter is asked to sign it
      // (stellar-signing-window.ts). The key derivation above signs through the bare signer.
      walletInteractor: { type: 'freighter', provider: withSigningWindow(signer) },
      // In-memory: the account is persisted below via export/import after every
      // sync (one JSON blob per account), which also restores notes saved by
      // builds from before the SDK's storage schema fix.
      persistentStorage: { type: 'memory' },
      // The SDK's store is in memory, but every payment request record (with its note secrets) is
      // kept in localStorage by stellar-request-storage.ts and imported back on each session build.
      ephemeralPaymentRequests: true,
      aspDataProvider: new StellarTestnetAspProvider(sdk, ASP_URL),
      circuitArtifacts: new FetchCircuitArtifacts(),
      // No relayer outside a relayed flow: the SDK asks every relayer for a quote even on a
      // self-submitted transfer, and a relayer without the transfer routes refuses it.
      relayerInteractor: new Proxy(createNoRelayerInteractor(sdk), {
        get: (none, prop) => Reflect.get(this.activeRelayer ?? none, prop),
      }),
    }) as StellarPoolSession;
    const saved = readSessionAccount<SavedAccount>(STELLAR_TESTNET_ID, address);
    if (saved) {
      try {
        await session.importAccount({ ...saved, owner: address, chainId: STELLAR_TESTNET_ID } as Parameters<StellarPoolSession["importAccount"]>[0]);
      } catch (error) {
        console.warn('[stellar] saved account could not be restored; rediscovering from chain', error);
      }
    }
    // The requests this browser kept (another tab, or before a reload): the
    // tab's copy above does not have them when the tab is new.
    const stored = readStoredStellarRequests(STELLAR_TESTNET_ID, address).records;
    if (stored.length > 0) {
      try {
        const live = await session.exportAccount();
        const { merged, added } = mergeStellarRequestRecords(live, stored);
        if (added > 0) await session.importAccount(merged);
      } catch (error) {
        // Kept in localStorage either way (writes only add), so a later
        // build or a backup import can still restore them.
        console.warn('[stellar] saved payment requests could not be restored', error);
      }
    }
    return session;
  }

  private async persist(session: StellarPoolSession, address: string) {
    // An account signed out of mid-flow is not written back: its sign-out
    // purge (bind) must stay done.
    if (this.snapshot.address !== address) return;
    try {
      const exported = await session.exportAccount();
      if (this.snapshot.address !== address) return;
      saveAccount(address, exported);
    } catch (error) {
      console.warn('[stellar] could not save the account for this tab', error);
    }
  }

  /**
   * After a flow: publish the session's own note state (the SDK already
   * recorded the new / spent notes) without a network request, so the finish
   * of a transaction never triggers a chain read. The next clock tick syncs.
   */
  private async refreshLocal(session: StellarPoolSession, address: string) {
    if (this.snapshot.address !== address) return;
    try {
      const exported = await session.exportAccount();
      if (this.snapshot.address !== address) return;
      saveAccount(address, exported);
      this.set({ notes: exported.notes, paymentRequests: requestStates(exported), status: 'ready' });
    } catch (error) {
      console.warn('[stellar] could not refresh the local note view', error);
    }
  }

  /** Runs `fn` after every earlier flow has settled. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The background tick: a no-op until the account is unlocked, and while an
   * unlock is still waiting on the wallet (a tick must not flip "unlocking" to
   * "syncing" and offer the unlock again).
   */
  syncIfUnlocked(): Promise<void> {
    if (!this.snapshot.unlocked || this.snapshot.status === 'unlocking') return Promise.resolve();
    return this.sync();
  }

  /**
   * The on-chain origin of each held note, from the pool's whole event history:
   * ONE bulk read by contract id (no start ledger, so from the deployment), the
   * exact request note discovery makes. Nothing in it is derived from a note;
   * the notes only pick which events are kept.
   */
  private async readNoteOrigins(notes: readonly StellarNote[]): Promise<StellarNoteOrigins> {
    const rpc = this.rpc;
    if (!rpc) throw new Error('Stellar RPC not ready');
    const sdk = await loadStellarSdk();
    const contractId = STELLAR_TESTNET_CONTRACTS.poolContractId;
    const page = await rpc.getEvents({ contractId });
    // Decode through the SDK's own adapter, fed the page already in hand so it
    // makes no request of its own.
    const adapter = new sdk.StellarPoolVaultChainAdapter({
      rpcInteractor: { getEvents: async () => page } as unknown as StellarRpcInteractor,
      contractId,
      readSourcePublicKey: this.snapshot.address ?? '',
    });
    const [deposits, transacts, ragequits] = await Promise.all([
      adapter.fetchDepositedEvents(),
      adapter.fetchTransactedEvents(),
      adapter.fetchRagequitEvents(),
    ]);
    // A one-time claim whose send was never seen to confirm (the tab died
    // mid-send) gets its tx hash from the outputs, so its row can rebuild the link.
    healSentClaims(this.snapshot.address, transacts);
    // Sends and withdrawals, matched by nullifier against the notes in hand.
    // Local only: the key never leaves memory and nothing new is requested.
    const nullifyingKey = this.nullifyingKey;
    const spends = nullifyingKey
      ? reconstructStellarSpends({
        notes: notes.map((n) => ({
          commitment: String(n.commitment),
          value: String(n.value),
          tokenId: String(n.tokenId),
          label: n.label ? String(n.label) : undefined,
          txHash: n.txHash ? String(n.txHash) : undefined,
        })),
        transacts: transacts.map((t) => ({
          txHash: String(t.txHash),
          outputCommitments: t.outputCommitments.map(String),
          nullifierHashes: t.nullifierHashes.map(String),
          withdrawnValue: String(t.withdrawnValue),
          asset: String(t.asset),
        })),
        nullifyingKey,
        hashService: await (this.poseidon ??= sdk.PoseidonHashService.create()),
      })
      : undefined;
    return buildStellarNoteOrigins({
      notes,
      deposits: deposits.map((d) => ({ txHash: String(d.txHash), outputCommitment: String(d.outputCommitment), depositor: String(d.caller) })),
      transacts: transacts.map((t) => ({ txHash: String(t.txHash), outputCommitments: t.outputCommitments.map(String) })),
      logs: page.events.map((e) => ({ transactionHash: String(e.transactionHash), ledger: String(e.ledger), ledgerClosedAt: e.ledgerClosedAt })),
      spends,
      ragequits: ragequits.map((r) => ({ txHash: String(r.txHash), commitment: String(r.commitment) })),
    });
  }

  /** Rescans the chain for this account's notes. Concurrent callers share one pass. */
  sync(): Promise<void> {
    if (!this.sessionPromise) return Promise.resolve();
    if (!this.syncPromise) {
      const address = this.snapshot.address;
      this.set({ status: 'syncing' });
      this.syncPromise = (async () => {
        try {
          const session = await this.ensureSession();
          // One pass, one whole-history page (stellar-runtime.ts): the SDK's
          // per-note timestamp lookups and the activity index below all read
          // it, so how many notes discovery finds changes no request.
          const rpc = this.rpc;
          const pass = <T,>(fn: () => Promise<T>) => (rpc ? rpc.withEventPage(fn) : fn());
          const { exported, registered, noteOrigins } = await pass(async () => {
            await session.discoverNotes();
            if (address) await this.persist(session, address);
            const [exportedNow, registeredNow] = await Promise.all([
              session.exportAccount(),
              session.isKeystoreRegistered().catch(() => null),
            ]);
            // Same clock tick, same bulk read the discovery above makes (pool
            // contract id from the deployment ledger). A failure keeps the last
            // index rather than failing the sync.
            const origins = await this.readNoteOrigins(exportedNow.notes).catch((error) => {
              console.warn('[stellar] could not read the pool event history for activity', error);
              return null;
            });
            return { exported: exportedNow, registered: registeredNow, noteOrigins: origins };
          });
          if (this.snapshot.address !== address) return;
          this.set({
            notes: exported.notes,
            paymentRequests: requestStates(exported),
            registered,
            // Only a changed index is published: an identical one would re-run
            // every activity derivation on each tick for nothing.
            // A failed read keeps the last index but marks it incomplete: the
            // discovery above may have added notes it does not cover.
            ...(noteOrigins
              ? JSON.stringify(noteOrigins) !== JSON.stringify(this.snapshot.noteOrigins) ? { noteOrigins } : {}
              : this.snapshot.noteOrigins?.complete
                ? { noteOrigins: { ...this.snapshot.noteOrigins, complete: false } }
                : {}),
            lastSyncedAt: Date.now(),
            status: 'ready',
            error: null,
          });
        } catch (error) {
          if (this.snapshot.address === address) this.set({ status: 'error', error: messageOf(error) });
          throw error;
        } finally {
          this.syncPromise = null;
        }
      })();
    }
    return this.syncPromise;
  }

  private async ensureRegistered(session: StellarPoolSession, generation: number, onStage?: StageListener) {
    // prepareRegisterKeystore checks both legs and builds only the missing one. isKeystoreRegistered()
    // checks just the auth policy, so an account whose set_viewing_key never landed read as
    // registered forever and could not be sent to (RecipientViewingKeyUnregistered).
    const registration = await session.prepareRegisterKeystore();
    if (registration.alreadyRegistered) return;
    this.assertStillBound(generation);
    onStage?.('registering');
    await session.executeRegisterKeystore(registration);
    // The spend right after re-checks registration, and the RPC can lag the
    // registration by a few seconds (seen on testnet as a failed check on a
    // registered account). Wait until the read agrees before continuing.
    let confirmed = false;
    for (let attempt = 0; attempt < 10 && !confirmed; attempt++) {
      try {
        confirmed = (await session.prepareRegisterKeystore()).alreadyRegistered;
      } catch {
        // transient read failure right after registering: retry
      }
      if (!confirmed) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!confirmed) {
      throw new Error('Your account registration has not shown up on chain yet. Try again in a minute.');
    }
    this.set({ registered: true });
  }

  /**
   * `recipient` (a registered Stellar account) makes this a deposit FOR that
   * account: the SDK reads its viewing key from the keystore, encrypts the
   * note to it, and the recipient discovers it on their own sync. An
   * unregistered recipient is refused before anything is signed.
   */
  deposit(params: { amount: bigint; recipient?: string; onStage?: StageListener; shouldContinue?: () => boolean }) {
    return this.enqueue(async () => {
      const { onStage } = params;
      // Pinned at the start: an account switch mid-flow must not move the
      // pending-label marker (or anything else) to the new account.
      const { address, generation } = this.requireSigner();
      const session = await this.ensureSession(onStage);
      // Registered before the deposit, like EVM and Sui: the deposit already names this
      // address, so registering now reveals nothing new. Deferred to the first spend, it
      // would land seconds before the relayed withdrawal and link the two. A deposit FOR
      // someone else leaves no note here, so it needs no registration of the payer, and
      // asking for one would put signatures ahead of the recipient check.
      if (!params.recipient) await this.ensureRegistered(session, generation, onStage);
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
      onStage?.('proving');
      const base = { tokenId: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId, value: toHex(params.amount) };
      const prepared = params.recipient
        // The field name is EVM-flavoured; the Stellar SDK resolves the
        // recipient's viewing key from the Stellar keystore by this G-address.
        ? await session.prepareDepositFor({ ...base, discoveryData: { evmAddress: params.recipient as StellarAddress } })
        : await session.prepareDeposit(base);
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
      this.assertStillBound(generation);
      onStage?.('signing');
      // One transaction (`deposit_with_label`): the ASP label cannot fail on its own.
      const receipt = await session.executeDeposit(prepared);
      if (!receipt.status) throw new Error('The deposit transaction failed on-chain.');
      const txHash = receipt.txHash as string;
      onStage?.('syncing');
      await this.refreshLocal(session, address);
      return {
        txHash,
        commitment: prepared.pendingNote.commitment,
        label: prepared.pendingNote.label,
        labelRegistered: true,
        pendingLabel: null,
      };
    });
  }

  withdraw(params: {
    amount: bigint;
    recipient: string;
    inputCommitments: Hex[];
    onStage?: StageListener;
    shouldContinue?: () => boolean;
  }) {
    return this.enqueue(async () => {
      const { onStage } = params;
      const { address, generation } = this.requireSigner();
      const session = await this.ensureSession(onStage);
      // Relayed: the relayer submits through the relay contract, so the user's
      // account never appears on the withdrawal. Its details are read BEFORE
      // registration, so an unreachable relayer fails before the wallet is asked to sign.
      const relayer = await this.connectRelayer(await loadStellarSdk());
      await this.ensureRegistered(session, generation, onStage);
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
      // The fee comes on top of `amount`, so the inputs must cover amount + fee.
      onStage?.('proving');
      this.activeRelayer = relayer;
      let receipt;
      try {
        // One committed quote and one proof. prepareWithdraw would quote, then
        // prove self-submit calldata that relayWithdraw discards and proves
        // again, so the relay option is built from the same quote request
        // here. relayWithdraw checks the quote against the asset, recipient
        // and amount before it proves.
        const tokenId = STELLAR_TESTNET_CONTRACTS.nativeAssetContractId;
        const [relayerInfo] = await relayer.getRelayers();
        if (!relayerInfo) throw new Error('The relayer did not return a quote.');
        const quote = await relayer.getWithdrawalQuote(relayerInfo, {
          asset: tokenId,
          commit: true,
          recipient: params.recipient,
          extraGas: false,
          amount: params.amount.toString(),
          // Priced by proof shape, as the SDK asks for it (n = m = inputs).
          shape: { n: Math.min(params.inputCommitments.length, 5), m: Math.min(params.inputCommitments.length, 5) },
        });
        // The inputs were selected for amount + this estimate; a higher fee would not be covered.
        if (BigInt(quote.feeAmount) > estimateStellarRelayFee(params.amount)) {
          throw new Error('The relayer asks for more than the fee shown. Try again later.');
        }
        const option = {
          inputCommitments: params.inputCommitments,
          amount: toHex(params.amount),
          tokenId,
          recipientAddress: params.recipient,
          extraGas: false,
          selectedQuote: { relayerInfo, quote },
        };
        if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
        this.assertStillBound(generation);
        onStage?.('relaying');
        receipt = await session.relayWithdraw(option);
      } finally {
        this.activeRelayer = null;
      }
      if (!receipt.status) throw new Error('The relayed withdrawal failed on-chain.');
      onStage?.('syncing');
      await this.refreshLocal(session, address);
      return { txHash: receipt.txHash as string };
    });
  }

  transfer(params: {
    amount: bigint;
    recipient: string;
    inputCommitments: Hex[];
    onStage?: StageListener;
    shouldContinue?: () => boolean;
  }) {
    return this.enqueue(async () => {
      const { onStage } = params;
      const { address, generation } = this.requireSigner();
      const session = await this.ensureSession(onStage);
      // The relayer is read before registration, so an unreachable one fails before the wallet signs.
      const relayer = await this.connectRelayer(await loadStellarSdk());
      await this.ensureRegistered(session, generation, onStage);
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
      this.assertStillBound(generation);
      onStage?.('proving');
      // The recipient's viewing key is resolved by the SDK here (it throws
      // RecipientViewingKeyUnregistered when there is none), so no separate
      // lookup naming the recipient is made beforehand.
      const result = await this.withTransferRelayer(relayer, async () => {
        // Relayed: the relayer submits, its fee comes on top of `amount`.
        const prepared = await session.prepareTransfer({
          tokenId: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId,
          amount: toHex(params.amount),
          inputCommitments: params.inputCommitments,
          // The field name is EVM-flavoured; the Stellar SDK resolves the
          // recipient's viewing key from the Stellar keystore by this G-address.
          recipientDiscoveryData: { evmAddress: params.recipient },
        });
        if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
        this.assertStillBound(generation);
        onStage?.('relaying');
        return this.relayPreparedTransfer(session, prepared);
      });
      if (!result.txReceipt.status) throw new Error('The transfer transaction failed on-chain.');
      onStage?.('syncing');
      await this.refreshLocal(session, address);
      return { txHash: result.txReceipt.txHash as string };
    });
  }

  /**
   * A private transfer to an account with no viewing key yet: nothing on chain
   * announces the note, so its secret goes to the recipient in a one-time link
   * (services/stellar/stellar-claim.ts). The notes are saved for the sender
   * (stellar-sent-claims.ts) BEFORE the transfer is submitted; if that save
   * fails nothing is sent.
   */
  sendOneTime(params: {
    amount: bigint;
    recipient: string;
    inputCommitments: Hex[];
    onStage?: StageListener;
    shouldContinue?: () => boolean;
    /** Called with the link's notes once they are saved, before submitting. */
    onClaimReady?: (notes: StellarClaimNote[]) => void;
  }) {
    return this.enqueue(async () => {
      const { onStage } = params;
      const { address, generation } = this.requireSigner();
      if (!isStellarAccountAddress(params.recipient)) throw new Error('Not a Stellar account address.');
      if (params.recipient === address) throw new Error('That is your own address. Pick someone else to send to.');
      const session = await this.ensureSession(onStage);
      await this.ensureRegistered(session, generation, onStage);
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
      this.assertStillBound(generation);
      onStage?.('proving');
      const prepared = await session.prepareColdStartTransfer({
        tokenId: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId,
        amount: toHex(params.amount),
        inputCommitments: params.inputCommitments,
        recipientEvmAddress: params.recipient as StellarAddress,
      });
      const opts = prepared.executeOptions;
      const secrets = opts.recipient.noteSecretsMap;
      if (!secrets) throw new Error('The transfer could not be prepared for a one-time link.');
      const notes: StellarClaimNote[] = opts.recipientPendingNotes.map((n) => ({
        commitment: String(n.commitment),
        noteAddressHash: `0x${BigInt(n.noteAddressHash).toString(16).padStart(64, '0')}`,
        noteSecret: String(secrets.get(n.noteAddressHash) ?? ''),
        value: String(n.value),
        tokenId: String(n.tokenId),
        label: String(n.label),
        ownerAddress: params.recipient,
        txHash: '0x0',
      }));
      if (notes.length === 0 || notes.some((n) => !n.noteSecret)) {
        throw new Error('The transfer could not be prepared for a one-time link.');
      }
      const id = `${Date.now().toString(36)}-${notes[0].commitment.slice(-8)}`;
      saveSentClaim(sentClaimsStorage(), SENT_CLAIMS_KEY, {
        id,
        sender: address,
        recipient: params.recipient,
        amount: params.amount.toString(),
        notes,
        txHash: null,
        createdAt: Date.now(),
      });
      params.onClaimReady?.(notes);
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
      this.assertStillBound(generation);
      onStage?.('signing');
      // The claim notes are already built above, so the SDK's own rebuild of
      // them (one commitment-keyed timestamp read per note, after the
      // transfer) is skipped: without the secrets map it returns the receipt
      // only. The change notes are persisted exactly as on any transfer.
      const result = await session.executeTransfer({ ...opts, recipient: { ...opts.recipient, noteSecretsMap: undefined } });
      if (!result.txReceipt.status) throw new Error('The transfer transaction failed on-chain.');
      const txHash = String(result.txReceipt.txHash);
      setSentClaimTx(sentClaimsStorage(), SENT_CLAIMS_KEY, id, txHash);
      onStage?.('syncing');
      await this.refreshLocal(session, address);
      return { txHash, notes: notes.map((n) => ({ ...n, txHash })) };
    });
  }

  /**
   * Imports the notes of a one-time link into this account (the session
   * re-derives every field and refuses notes for another owner). Local only:
   * the next clock sync marks them spendable once the chain shows them.
   */
  claim(notes: readonly StellarClaimNote[]): Promise<{ imported: number; already: number }> {
    return this.enqueue(async () => {
      const { address, generation } = this.requireSigner();
      if (notes.some((n) => n.ownerAddress !== address)) {
        throw new Error('This link is for another Stellar account. Switch accounts in Freighter.');
      }
      const session = await this.ensureSession();
      this.assertStillBound(generation);
      const held = new Set((await session.exportAccount()).notes.map((n) => BigInt(n.commitment)));
      let imported = 0;
      for (const n of notes) {
        if (held.has(BigInt(n.commitment))) continue;
        await session.importReceivedNote(toImportableNote(n) as Parameters<StellarPoolSession['importReceivedNote']>[0]);
        imported++;
      }
      // Best effort here (a just-sent note may not be indexed yet); saving requires it.
      await this.stampClaimedNotes(session, notes.map((n) => n.commitment as Hex), false);
      await this.refreshLocal(session, address);
      return { imported, already: notes.length - imported };
    });
  }

  /**
   * Saves claimed notes to this account for good: a private transfer to
   * itself, announced to its own viewing key, so any device finds it by sync
   * and the link is no longer needed. Registers the account first if needed
   * (Freighter pays; relayed registration is not available on Stellar).
   */
  keepClaim(commitments: readonly Hex[], params?: { onStage?: StageListener }) {
    return this.enqueue(async () => {
      const { address, generation } = this.requireSigner();
      const session = await this.ensureSession(params?.onStage);
      const relayer = await this.connectRelayer(await loadStellarSdk());
      await this.ensureRegistered(session, generation, params?.onStage);
      await this.stampClaimedNotes(session, commitments, true);
      const { notes } = await session.exportAccount();
      const wanted = new Set(commitments.map((c) => BigInt(c)));
      const claimed = notes.filter((n) => wanted.has(BigInt(n.commitment)));
      if (claimed.length !== wanted.size || claimed.some((n) => n.status !== 'ACTIVE')) {
        throw new Error('Not spendable yet. Try again after the next sync.');
      }
      this.assertStillBound(generation);
      params?.onStage?.('proving');
      const total = claimed.reduce((sum, n) => sum + BigInt(n.value), 0n);
      const result = await this.withTransferRelayer(relayer, async () => {
        // Relayed: the fee comes out of the claimed notes, and whatever the
        // estimate over-reserves returns to this account as change.
        if (total <= STELLAR_TRANSFER_RELAY_FEE_ESTIMATE) throw new Error('This link holds less than the relayer fee.');
        const prepared = await session.prepareTransfer({
          tokenId: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId,
          amount: toHex(total - STELLAR_TRANSFER_RELAY_FEE_ESTIMATE),
          inputCommitments: claimed.map((n) => n.commitment as Hex),
          recipientDiscoveryData: { evmAddress: address },
        });
        this.assertStillBound(generation);
        params?.onStage?.('relaying');
        return this.relayPreparedTransfer(session, prepared);
      });
      if (!result.txReceipt.status) throw new Error('The transaction failed on-chain.');
      params?.onStage?.('syncing');
      await this.refreshLocal(session, address);
      return { txHash: String(result.txReceipt.txHash) };
    });
  }

  ragequit(params: { commitment: Hex; onStage?: StageListener; shouldContinue?: () => boolean }) {
    return this.enqueue(async () => {
      const { onStage } = params;
      const { address, generation } = this.requireSigner();
      const session = await this.ensureSession(onStage);
      await this.ensureRegistered(session, generation, onStage);
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
      this.assertStillBound(generation);
      onStage?.('proving');
      const receipt = await session.rageQuit({ commitment: params.commitment });
      if (!receipt.status) throw new Error('The exit transaction failed on-chain.');
      onStage?.('syncing');
      await this.refreshLocal(session, address);
      return { txHash: receipt.txHash as string };
    });
  }

  /**
   * Deposits carry their ASP label in the same transaction (`deposit_with_label`), so nothing is
   * left to re-send. Markers stored by older builds belong to the replaced 2026-09-30 pool: sending
   * them to the current registry would only register junk labels, so they are dropped.
   */
  retryPendingLabels(_extra: readonly PendingLabel[] = []): Promise<{ sent: number; failed: number; firstError: string | null }> {
    return this.enqueue(async () => {
      const { address } = this.requireSigner();
      for (const item of readLabelPending(address)) clearLabelPending(address, item.depositTxHash);
      for (const commitment of readLegacyLabelPending(address)) clearLegacyLabelPending(address, commitment);
      return { sent: 0, failed: 0, firstError: null };
    });
  }

  /**
   * The account backup (services/stellar/stellar-backup.ts): the SDK's sealed
   * export under `password`, plus this account's payment-request records.
   * Unlocks first if needed (explicit user action).
   */
  exportBackup(password: string): Promise<{ payload: string; noteCount: number }> {
    return this.enqueue(async () => {
      const { address } = this.requireSigner();
      const session = await this.ensureSession();
      const [sealed, { notes }] = await Promise.all([session.exportAccountSealed(password), session.exportAccount()]);
      const payload = encodeStellarBackup({
        chainId: STELLAR_TESTNET_ID,
        owner: address,
        sealed: sealed as unknown as SealedEnvelopeLike,
        requests: listSessionPaymentRequests(address),
      });
      return { payload, noteCount: notes.length };
    });
  }

  /**
   * Restores a backup into this account, merged with what the session holds
   * (stellar-backup.ts says why not a replace). A wrong password fails before
   * anything changes. The next sync reconciles statuses against the chain.
   */
  importBackup(raw: string, password: string): Promise<{ added: number; requests: number }> {
    return this.enqueue(async () => {
      const { address, generation } = this.requireSigner();
      const linkOrigins = [PAY_URL_BASE, typeof window !== 'undefined' ? window.location?.origin : undefined, ...LEGACY_APP_ORIGINS].filter((o): o is string => !!o);
      const file = decodeStellarBackup(raw, { owner: address, chainId: STELLAR_TESTNET_ID, linkOrigins });
      const session = await this.ensureSession();
      this.assertStillBound(generation);
      const live = await session.exportAccount();
      try {
        await session.importAccountSealed(file.sealed as unknown as Parameters<StellarPoolSession['importAccountSealed']>[0], password);
      } catch (error) {
        const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
        if (/Decryption|decrypt|InvalidEncryptedRecord|Passphrase|tamper/i.test(text)) throw new Error('Wrong password, or the backup is damaged.');
        throw error;
      }
      const restored = await session.exportAccount();
      const merged = mergeStellarExports(live, restored);
      try {
        await session.importAccount(merged);
      } catch (error) {
        await session.importAccount(live).catch(() => undefined);
        throw error;
      }
      const known = new Set(listSessionPaymentRequests(address).map((r) => r.requestId));
      const newRequests = file.requests.filter((r) => !known.has(r.requestId));
      // Oldest first, so the newest ends up on top of the list.
      for (const r of [...newRequests].sort((a, b) => a.createdAtMs - b.createdAtMs)) addSessionPaymentRequest(r);
      if (newRequests.length > 0) bumpPaymentRequestRevision();
      await this.refreshLocal(session, address);
      // The user holds this file: its exact copies count as backups.
      if (this.snapshot.address === address) markStellarRequestsHeldByBackup(STELLAR_TESTNET_ID, address, restored.paymentRequests ?? []);
      return { added: merged.notes.length - live.notes.length, requests: newRequests.length };
    });
  }

  /**
   * A blind payment request (services/stellar/stellar-request.ts). The SDK
   * keeps the request (its note secrets; the payment key is re-derived from
   * the viewing key) in this account, which is saved for the tab and rides
   * the account backup. Nothing goes on chain and no viewing key has to be
   * published: the payer's note is found through the request itself.
   */
  createPaymentRequest(params: { amount: bigint; onStage?: StageListener }): Promise<StellarSdkPaymentRequest> {
    return this.enqueue(async () => {
      const { address, generation } = this.requireSigner();
      if (params.amount <= 0n) throw new Error('Enter an amount first.');
      const session = await this.ensureSession(params.onStage);
      this.assertStillBound(generation);
      const request = await session.generatePaymentRequest({
        amount: toHex(params.amount),
        tokenId: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId,
        // One recipient note per input note: the five-input transfer cap.
        slots: STELLAR_REQUEST_SLOTS,
      });
      // Saved before the link is shown: without the record the payment cannot
      // be found, and the session itself keeps nothing across a reload.
      const exported = await session.exportAccount();
      this.assertStillBound(generation);
      if (!saveAccount(address, exported)) {
        throw new Error('This browser would not save the request, so a payment to it could not be found. Nothing was shared.');
      }
      if (this.snapshot.address === address) this.set({ notes: exported.notes, paymentRequests: requestStates(exported), status: 'ready' });
      return request as StellarSdkPaymentRequest;
    });
  }

  /** Lists a request this account made, in this tab and in what the browser keeps. */
  recordRequestRow(row: SessionPaymentRequest) {
    addSessionPaymentRequest(row);
    const address = this.snapshot.address;
    if (address && row.owner === address.toLowerCase()) {
      writeStoredStellarRequests(STELLAR_TESTNET_ID, address, { records: [], rows: [row] });
    }
  }

  /**
   * The request backup file for the bound account (stellar-backup.ts): every
   * request record this browser holds for it, plus its list rows. Built
   * without waiting on a running flow, so it is ready the moment a request
   * exists. Null when there is no request to back up. Once the file is
   * saved, `markRequestBackupSaved` with its paymentIds.
   */
  exportRequestBackup(): { payload: string; paymentIds: string[] } | null {
    const address = this.snapshot.address;
    if (!address) return null;
    const tab = readSessionAccount<SavedAccount>(STELLAR_TESTNET_ID, address)?.paymentRequests ?? [];
    const kept = readStoredStellarRequests(STELLAR_TESTNET_ID, address);
    const { merged } = mergeStellarRequestRecords({ notes: [], syncCursor: '0x0', paymentRequests: tab }, kept.records);
    const records = merged.paymentRequests ?? [];
    if (records.length === 0) return null;
    const known = new Set<string>();
    const requests = [...listSessionPaymentRequests(address), ...kept.rows].filter((r) => !known.has(r.requestId) && !!known.add(r.requestId));
    const paymentIds = records.flatMap((r) => {
      const id = (r as { paymentId?: unknown }).paymentId;
      return typeof id === 'string' ? [id] : [];
    });
    return { payload: encodeStellarRequestBackup({ chainId: STELLAR_TESTNET_ID, owner: address, records, requests }), paymentIds };
  }

  /**
   * Proof that a request backup file for `owner` was saved (the save-file
   * picker wrote and closed it, or a native share completed): its requests may
   * leave this browser at sign-out. Never for a plain download.
   */
  markRequestBackupSaved(owner: string, paymentIds: readonly string[]) {
    markStellarRequestsBackedUp(STELLAR_TESTNET_ID, owner, paymentIds);
  }

  /**
   * Restores a request backup: adds the requests only the file has (the
   * live copy of a request wins) and their list rows. No password, like the
   * EVM request backup. Unlocks first if needed (explicit user action).
   */
  importRequestBackup(raw: string): Promise<{ requests: number }> {
    return this.enqueue(async () => {
      const { address, generation } = this.requireSigner();
      const linkOrigins = [PAY_URL_BASE, typeof window !== 'undefined' ? window.location?.origin : undefined, ...LEGACY_APP_ORIGINS].filter((o): o is string => !!o);
      const file = decodeStellarRequestBackup(raw, { owner: address, chainId: STELLAR_TESTNET_ID, linkOrigins });
      const session = await this.ensureSession();
      this.assertStillBound(generation);
      const live = await session.exportAccount();
      const { merged, added } = mergeStellarRequestRecords(live, file.records);
      if (added > 0) {
        try {
          await session.importAccount(merged);
        } catch (error) {
          await session.importAccount(live).catch(() => undefined);
          throw error;
        }
      }
      const known = new Set(listSessionPaymentRequests(address).map((r) => r.requestId));
      const newRows = file.requests.filter((r) => !known.has(r.requestId));
      for (const r of [...newRows].sort((a, b) => a.createdAtMs - b.createdAtMs)) addSessionPaymentRequest(r);
      if (newRows.length > 0 || added > 0) bumpPaymentRequestRevision();
      await this.refreshLocal(session, address);
      // The user holds this file: its exact copies count as backups.
      if (this.snapshot.address === address) markStellarRequestsHeldByBackup(STELLAR_TESTNET_ID, address, file.records);
      return { requests: added };
    });
  }

  /**
   * Pays a blind request: `prepareFulfillPaymentRequest` builds the transfer
   * to the request's slots (encrypted to its payment key, tagged with its
   * tag), then it is submitted like any Stellar transfer. Nothing about the
   * recipient is looked up.
   */
  payPaymentRequest(params: {
    request: StellarSdkPaymentRequest;
    inputCommitments: Hex[];
    onStage?: StageListener;
    shouldContinue?: () => boolean;
  }) {
    return this.enqueue(async () => {
      const { onStage } = params;
      const { address, generation } = this.requireSigner();
      if (params.request.tokenId !== STELLAR_TESTNET_CONTRACTS.nativeAssetContractId) throw new Error('This request is not for XLM.');
      const session = await this.ensureSession(onStage);
      const relayer = await this.connectRelayer(await loadStellarSdk());
      await this.ensureRegistered(session, generation, onStage);
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
      this.assertStillBound(generation);
      onStage?.('proving');
      const result = await this.withTransferRelayer(relayer, async () => {
        const prepared = await session.prepareFulfillPaymentRequest({
          paymentRequest: params.request as Parameters<StellarPoolSession['prepareFulfillPaymentRequest']>[0]['paymentRequest'],
          inputCommitments: params.inputCommitments,
        });
        if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded');
        this.assertStillBound(generation);
        onStage?.('relaying');
        return this.relayPreparedTransfer(session, prepared);
      });
      if (!result.txReceipt.status) throw new Error('The transfer transaction failed on-chain.');
      onStage?.('syncing');
      await this.refreshLocal(session, address);
      return { txHash: String(result.txReceipt.txHash) };
    });
  }

  /**
   * Makes this account able to RECEIVE private transfers: unlocks and
   * publishes the keystore entry (viewing key) if it is not there yet. A
   * payment request needs it, since the payer's transfer is encrypted to it.
   */
  ensureCanReceive(params?: { onStage?: StageListener }) {
    return this.enqueue(async () => {
      const { generation } = this.requireSigner();
      const session = await this.ensureSession(params?.onStage);
      await this.ensureRegistered(session, generation, params?.onStage);
    });
  }
}

async function deriveProtocolKeys(
  sdk: StellarSdk,
  address: string,
  signer: StellarWalletProvider,
): Promise<ProtocolKeys> {
  const walletInteractor = new sdk.FreighterWalletInteractor({
    provider: signer,
    networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase,
    rpcInteractor: new sdk.SorobanRPCInteractor({
      rpcUrl: STELLAR_TESTNET_RPC_URL,
      networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase,
    }),
  });
  const signature = await walletInteractor.signKeyDerivationMessage(address);
  const derived = new sdk.StellarCryptoService().deriveKeysFromSignature({
    signature,
    appIdentifier: STELLAR_KEY_APP_IDENTIFIER,
    revocableKeyIndex: '0x0',
  });
  return { ...derived, revocableKeyIndex: '0x0' } as ProtocolKeys;
}

type SavedAccount = { notes: StellarNote[]; syncCursor: Hex; paymentRequests?: unknown[] };

/** Last synced notes (this tab only), read-only, for display before unlock. */
function readCachedNotes(address: string): StellarNote[] {
  return readSessionAccount<SavedAccount>(STELLAR_TESTNET_ID, address)?.notes ?? [];
}

function readCachedRequests(address: string): StellarRequestState[] {
  const tab = readSessionAccount<SavedAccount>(STELLAR_TESTNET_ID, address)?.paymentRequests ?? [];
  const kept = readStoredStellarRequests(STELLAR_TESTNET_ID, address).records;
  const { merged } = mergeStellarRequestRecords({ notes: [], syncCursor: '0x0', paymentRequests: tab }, kept);
  return requestStates(merged);
}

/**
 * The tab's account copy, and the account's requests in localStorage. True
 * when the requests are kept there (the tab copy is a cache; a new tab
 * rediscovers notes from chain).
 */
function saveAccount(address: string, exported: SavedAccount): boolean {
  writeSessionAccount(STELLAR_TESTNET_ID, address, exported);
  return writeStoredStellarRequests(STELLAR_TESTNET_ID, address, {
    records: exported.paymentRequests ?? [],
    rows: listSessionPaymentRequests(address),
  });
}

/** Lists, in this tab, the requests the browser kept for `address`. True when any was added. */
function restoreStoredRows(address: string): boolean {
  const known = new Set(listSessionPaymentRequests(address).map((r) => r.requestId));
  const missing = readStoredStellarRequests(STELLAR_TESTNET_ID, address).rows.filter((r) => !known.has(r.requestId));
  for (const r of [...missing].sort((a, b) => a.createdAtMs - b.createdAtMs)) addSessionPaymentRequest(r);
  return missing.length > 0;
}

const LABEL_PENDING_KEY = (address: string) => `ppv2_stellar_label_pending_v2_${STELLAR_TESTNET_ID}_${address}`;

/** A confirmed deposit whose `register_label` still has to be sent. */
export type PendingLabel = { depositTxHash: string; aspCiphertext: Hex };

function readLabelPending(address: string): PendingLabel[] {
  try {
    const raw = globalThis.localStorage?.getItem(LABEL_PENDING_KEY(address));
    return raw ? (JSON.parse(raw) as PendingLabel[]) : [];
  } catch {
    return [];
  }
}

function writeLabelPending(address: string, list: PendingLabel[]) {
  try {
    if (list.length) globalThis.localStorage?.setItem(LABEL_PENDING_KEY(address), JSON.stringify(list));
    else globalThis.localStorage?.removeItem(LABEL_PENDING_KEY(address));
  } catch {
    // storage unavailable: the retry list is best-effort
  }
}

function clearLabelPending(address: string, depositTxHash: string) {
  writeLabelPending(address, readLabelPending(address).filter((p) => p.depositTxHash !== depositTxHash));
}

/** Pre-ciphertext markers (commitments only), from builds before the v2 key. */
const LEGACY_LABEL_PENDING_KEY = (address: string) => `ppv2_stellar_label_pending_${STELLAR_TESTNET_ID}_${address}`;

function readLegacyLabelPending(address: string): Hex[] {
  try {
    const raw = globalThis.localStorage?.getItem(LEGACY_LABEL_PENDING_KEY(address));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((c): c is Hex => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

function clearLegacyLabelPending(address: string, commitment: Hex) {
  try {
    const rest = readLegacyLabelPending(address).filter((c) => c !== commitment);
    if (rest.length) globalThis.localStorage?.setItem(LEGACY_LABEL_PENDING_KEY(address), JSON.stringify(rest));
    else globalThis.localStorage?.removeItem(LEGACY_LABEL_PENDING_KEY(address));
  } catch {
    // storage unavailable: the marker is retried next time
  }
}

function toHex(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const stellarAccount = new StellarAccount();

// Dev-only handle for inspecting the account from the console.
if (typeof __DEV__ !== 'undefined' && __DEV__) {
  (globalThis as { __ppv2Stellar?: StellarAccount }).__ppv2Stellar = stellarAccount;
}

// The sender's saved one-time claims (services/stellar/stellar-sent-claims.ts).
const SENT_CLAIMS_KEY = envScopedStorageKey(SENT_CLAIMS_BASE_KEY);

function sentClaimsStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** This account's saved claim for one of its sends, if it made one (for the activity row). */
export function findStellarSentClaim(sender: string, txHash: string) {
  return findSentClaim(readSentClaims(sentClaimsStorage(), SENT_CLAIMS_KEY), sender, { txHash });
}

function healSentClaims(sender: string | null, transacts: readonly { txHash: unknown; outputCommitments: readonly unknown[] }[]) {
  if (!sender) return;
  const storage = sentClaimsStorage();
  const open = readSentClaims(storage, SENT_CLAIMS_KEY).filter((c) => c.sender === sender && !c.txHash);
  if (open.length === 0) return;
  for (const t of transacts) {
    const hit = findSentClaim(open, sender, { txHash: String(t.txHash), outputCommitments: t.outputCommitments.map(String) });
    if (hit && !hit.txHash) setSentClaimTx(storage, SENT_CLAIMS_KEY, hit.id, String(t.txHash));
  }
}

// Debug recording snapshot (services/debug-snapshots.ts): the Stellar account's
// state around a recording. Counts and flags only, no key and no note secret.
registerDebugSnapshot('stellar', () => {
  const s = stellarAccount.getSnapshot();
  const byStatus: Record<string, number> = {};
  for (const n of s.notes) byStatus[String(n.status)] = (byStatus[String(n.status)] ?? 0) + 1;
  const address = s.address;
  return {
    address,
    status: s.status,
    unlocked: s.unlocked,
    registered: s.registered,
    error: s.error,
    lastSyncedAt: s.lastSyncedAt,
    notes: byStatus,
    eventIndex: s.noteOrigins
      ? {
        complete: s.noteOrigins.complete,
        origins: Object.keys(s.noteOrigins.byCommitment).length,
        spends: s.noteOrigins.spends?.length ?? null,
        exits: s.noteOrigins.exits?.length ?? null,
      }
      : null,
    pendingAspRegistrations: address ? readLabelPending(address).length + readLegacyLabelPending(address).length : 0,
    savedClaims: address ? readSentClaims(sentClaimsStorage(), SENT_CLAIMS_KEY).filter((c) => c.sender === address).length : 0,
  };
});
