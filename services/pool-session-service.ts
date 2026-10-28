import { getPoolBlockedLabelHashes, normalizeHashString } from '@/services/public-asp-cache';
import {
  LiFiSwapQuoteProvider,
  NoteComputationService,
  PaymentRequestService,
  PaymentRequestStorageAdapter,
  createEvmPoolSession,
  EvmSwapChainAdapter,
} from '@privacy-pools-v2/sdk';
import * as PrivacyPoolsSdk from '@privacy-pools-v2/sdk';
import { withAcrossDirect, type AcrossSdkExports } from '@/services/across-provider';
import { ACTIVE_DEPLOYMENTS_BY_CHAIN } from '@/config/environments';
import type {
  Address,
  IKeystoreManager,
  INoteManager,
  ICircuitArtifacts,
  IPaymentRequestService,
  IWalletInteractor,
  EvmPoolSessionConfig,
} from '@privacy-pools-v2/sdk';
import {
  createCryptoService,
  createHashService,
  createMerkleService,
  createProofService,
  createWitnessService,
  createASPClient,
  createASPDataProvider,
  createRelayerInteractor,
  createRelayerlessInteractor,
  createRPCInteractor,
  createEntrypointInteractor,
  createPoolVaultInteractor,
  createKeystoreInteractor,
} from '@/services/sdk-setup';
import { getChainConfig } from '@/config/chains';
import { recordingNoteEventReads } from '@/services/note-ciphertexts';
import { createSdkConsoleLogger } from '@/services/sdk-logger';
import { buildReshieldDestinationKeys } from '@/services/reshield-destination';
import { createPublicClient, fallback } from 'viem';
import { policedHttp } from '@/services/egress-transport';
import { getConfiguredYieldDeployments, getYieldDeploymentsForChain } from '@/config/yield';
import { probeYieldVault } from '@/services/yield-vault-probe';
import { getSwapProcessorAddress, INTENT_SWAPS_ENABLED, LIFI_API_KEY } from '@/config/intent-swaps';
import { getSdkStorageService, migratePaymentRequestStateToOwner, migratePaymentRequestStateToV2Shape } from '@/services/sdk-storage';
import { swapDepositSlippage } from '@/services/swap-flows';
import { installNativeDeliveryBridgeDeny } from '@/services/lifi-native-delivery';

/**
 * Test-only bridge allowlist for cross-chain LiFi quotes, from
 * EXPO_PUBLIC_LIFI_ALLOW_BRIDGES (comma-separated LiFi bridge keys). Unset in
 * every real build, so LiFi picks the bridge as before; only the cross-chain
 * e2e workflow sets it.
 */
export const LIFI_CROSS_CHAIN_BRIDGES: string[] | undefined = (process.env.EXPO_PUBLIC_LIFI_ALLOW_BRIDGES ?? '')
  .split(',').map((b) => b.trim()).filter(Boolean);

export interface CreatePoolSessionParams {
  ownerAddress: Address;
  chainId: number;
  entrypointAddress: Address;
  poolAddress: Address;
  keystoreAddress: Address;
  keystoreManager: IKeystoreManager;
  noteManager: INoteManager;
  circuitArtifacts: ICircuitArtifacts;
  deploymentBlock?: number;
  /**
   * Override the relayer record's processor address. The batch-withdrawal
   * session passes the PrivacyPoolRelay contract here so batch proofs bind to
   * the on-chain relayBatch msg.sender (the single-withdraw path rebinds
   * per-call instead; batch can't). Omitted → the transfer-route default.
   */
  relayerProcessorAddress?: Address;
  /**
   * Build this session with NO relayers, so the SDK's unconditional
   * pre-proof quote fetch inside `prepareTransfer` is skipped entirely.
   * Only for flows that provably never relay (the disclosed self-submit
   * transfer). See `createRelayerlessInteractor`.
   */
  withoutRelayers?: boolean;
  /**
   * Cross-chain swap-and-deposit (SDK ≥ eecb069b): the chain the PAY token and
   * the wallet live on, while this session's pool (and therefore the deposit)
   * is on `chainId`. The SDK validates LiFi's transactionTo/approvalAddress
   * against the SOURCE chain's RelaySwaps allowlist, since that is where the
   * transaction executes — so the address travels with the chain id.
   *
   * Only pass this for a pair config/intent-swaps says is routable
   * (crossChainSwapDepositSupported); omitted ⇒ swapAndDeposit stays
   * same-chain, exactly as before.
   */
  swapSourceChain?: {
    chainId: number;
    relaySwapsAddress: Address;
    /** Wallet for the SOURCE chain (services/wallet-interactor builds one over wagmi). */
    walletInteractor: IWalletInteractor;
    /** Source chain's deployment block, for its RPC interactor's log scans. */
    deploymentBlock?: number;
  };
  /**
   * Destination attachment for CROSS-CHAIN RESHIELD (flow 4): the note is spent
   * from this session's chain and re-deposited into the pool on
   * `chainId`+entrypoint given here. The SDK builds its `reshieldCrosschain`
   * delegate only when BOTH the chain id and a destination entrypoint
   * interactor are present, so they travel together.
   *
   * Only pass this for a pair config/intent-swaps says is supported
   * (crossChainReshieldSupported); omitted ⇒ no delegate, and the session's
   * reshield methods stay same-chain, exactly as before.
   */
  reshieldDestination?: {
    chainId: number;
    entrypointAddress: Address;
    /** Destination chain's deployment block, for its RPC interactor's log scans. */
    deploymentBlock?: number;
    /**
     * The destination chain's share targets, i.e. the `yields` array off a
     * session built FOR that chain. With them the SDK can fund a share on the
     * far side through its router; without them the only destination call it
     * can build is `Entrypoint.deposit`, which no share pool accepts, so a
     * share target is refused before it is ever offered.
     */
    yieldDepositTargets?: readonly unknown[];
  };
}

export async function createPoolSession(params: CreatePoolSessionParams) {
  const {
    ownerAddress,
    chainId,
    swapSourceChain,
    reshieldDestination,
    entrypointAddress,
    poolAddress,
    keystoreAddress,
    keystoreManager,
    noteManager,
    circuitArtifacts,
    deploymentBlock,
    relayerProcessorAddress,
    withoutRelayers,
  } = params;

  const cryptoService = createCryptoService();
  const hashService = await createHashService();
  const merkleService = createMerkleService(hashService);
  // Single shared NoteComputationService — every PoolSession delegate
  // (Deposit, Keystore, Transfer, Withdraw, NoteDiscovery, Ragequit)
  // expects this in its config now. Constructing it once and threading
  // it through PoolSessionConfig satisfies all the sub-configs.
  const noteComputationService = new NoteComputationService({ hashService, cryptoService });
  const proofService = createProofService(circuitArtifacts);
  const witnessService = createWitnessService(hashService, merkleService, cryptoService);
  const aspDataProvider = await createASPDataProvider(chainId);
  // Decisions can veto a published leaf before the tree changes. Check every
  // transaction here, before witness construction, without altering proof leaves.
  const buildTransactWitness = witnessService.buildTransactWitness.bind(witnessService);
  witnessService.buildTransactWitness = async (inputs) => {
    // Reads the scheduled snapshot; cannot fetch. If the grid has not delivered
    // one, or the one it has is past its age bound, this throws and the spend
    // stops here — an unknown decision set must not read as permission.
    let blocked: ReadonlySet<string>;
    try {
      blocked = getPoolBlockedLabelHashes(chainId);
    } catch {
      throw new Error('Cannot confirm this note is still spendable right now. Try again in a moment.');
    }
    if (inputs.inputNotes.some((note) => blocked.has(normalizeHashString(hashService.hash([note.label]))))) {
      throw new Error('An input note is rejected or requires proof of innocence. Refresh your notes before spending.');
    }
    return buildTransactWitness(inputs);
  };
  const aspClient = await createASPClient(chainId, merkleService, aspDataProvider);
  const relayerInteractor = withoutRelayers
    ? createRelayerlessInteractor()
    : createRelayerInteractor(chainId, relayerProcessorAddress);
  const chainContracts = getChainConfig(chainId)?.contracts;
  const syncFromBlock = chainContracts?.fromBlock;
  // Keystore predates the V6 pool deploy on Sepolia, so it has its own
  // scan floor — falling back to the pool's fromBlock would miss any
  // leaves registered before the V5→V6 pool migration.
  const keystoreSyncFromBlock = chainContracts?.keystoreFromBlock ?? syncFromBlock;

  const rpc = createRPCInteractor(chainId, deploymentBlock);
  const entrypointInteractor = createEntrypointInteractor(rpc, entrypointAddress);
  const poolVaultInteractor = createPoolVaultInteractor(rpc, poolAddress, hashService, syncFromBlock);
  // Discovery appends the Note events above the ASP's index from here. Their
  // ciphertexts answer whose a deposit is like the ASP's own
  // (services/deposit-ownership.ts, signal 3), so they are kept too.
  poolVaultInteractor.getNoteEvents = recordingNoteEventReads(
    chainId,
    poolVaultInteractor.getNoteEvents.bind(poolVaultInteractor),
  );
  const keystoreInteractor = createKeystoreInteractor(rpc, keystoreAddress, keystoreSyncFromBlock);

  // Persistent payment-request store. Default PoolSessionFactory wiring
  // uses InMemoryStorageService → records vanish on refresh, taking the
  // per-request paymentPrivKey with them and breaking discovery for the
  // recipient. We pre-build the service so we can also call
  // loadFromStorage() before handing the session out — the SDK doesn't
  // do that itself (see PoolSessionFactory.create).
  // SDK 3a3f5f9 namespaced the payment-request storage key by owner.
  // Re-key any records the old SDK wrote under the un-namespaced key so
  // they're not orphaned after the upgrade. One-time, best-effort.
  await migratePaymentRequestStateToOwner(chainId, ownerAddress);
  // v2.0 migration: backfill noteAddressHashes / drop paymentPrivKey on
  // records the pre-v2.0 SDK wrote, or loadFromStorage() below rejects the
  // whole blob and the recovery path resets the store.
  await migratePaymentRequestStateToV2Shape(chainId, ownerAddress);
  const paymentRequestStorageAdapter = new PaymentRequestStorageAdapter(chainId, getSdkStorageService(), ownerAddress);
  const paymentRequestService: IPaymentRequestService = new PaymentRequestService({
    ownerAddress,
    cryptoService,
    hashService,
    noteComputationService,
    // v2.0 migration: PaymentRequestService no longer persists paymentPrivKey;
    // it re-derives it from the keystore viewing key on load.
    keystoreManager,
    storageAdapter: paymentRequestStorageAdapter,
  });
  try {
    await paymentRequestService.loadFromStorage();
  } catch (err) {
    // `loadFromStorage` throws `InvalidStorageStateError` when the
    // persisted blob fails the SDK's Zod schema (older serializer
    // format, manual corruption, partial write). Without recovery the
    // user is locked out of the entire chain's PoolSession until they
    // clear site data manually. Reset the request store for this chain
    // and continue — open requests are lost (the receiver can't
    // discover stale payments anyway without paymentPrivKey), but
    // session creation succeeds and future requests work normally.
    console.warn(
      `[PoolSession] Resetting corrupt payment-request state for chain ${chainId}:`,
      err,
    );
    try {
      await paymentRequestService.clear();
    } catch (clearErr) {
      console.warn('[PoolSession] Failed to clear payment-request state:', clearErr);
    }
  }

  // Aave yield module: optional. Present only when EXPO_PUBLIC_YIELD_ENABLED
  // is set AND a deployment for this chain is configured (config/yield.ts)
  // AND that deployment's vault contracts actually have bytecode on chain.
  //
  // The third condition is why this reads the CONFIGURED deployment first: it
  // is the one place allowed to see an unverified deployment, because it has
  // to know what to probe. On the Sepolia preview (2026-09-02) the env named a
  // placeholder vault, 0x2222...2222, with no code; the SDK's prepareYieldDeposit
  // does no such check and every USDC shield died in previewDeposit. Probing
  // here, before the session exists, means getYieldDeploymentForChain below
  // and every UI gate that shares it answer undefined for a fake vault, and
  // the deposit falls back to a plain shield. An RPC failure records
  // 'unreachable', which is also treated as unusable: a vault we cannot verify
  // is a vault we do not route money into, and session creation carries on.
  const configuredYields = getConfiguredYieldDeployments(chainId);
  for (const configuredYield of configuredYields) {
    const chainCfg = getChainConfig(chainId);
    const rpcUrls = (chainCfg?.rpcUrls ?? (chainCfg?.rpcUrl ? [chainCfg.rpcUrl] : [])).filter(Boolean);
    // Bounded on purpose (kimi review of 7483ea3): with viem's defaults a hung
    // endpoint costs 10s, a TimeoutError carries no numeric code so the WHOLE
    // fallback walk is retried 3 more times, and Sepolia lists 4 URLs, which is
    // ~160s added to session init in the worst case. 5s per URL, no retries:
    // ~20s worst case, and 'unreachable' is the (closed) answer either way.
    const probeClient = rpcUrls.length > 0
      ? createPublicClient({
        transport: fallback(rpcUrls.map((url) => policedHttp(url, { timeout: 5_000 })), { retryCount: 0 }),
      })
      : null;
    const expectedPool = ACTIVE_DEPLOYMENTS_BY_CHAIN[chainId];
    const verdict = await probeYieldVault(
      chainId,
      configuredYield,
      async (address) => (probeClient ? probeClient.getCode({ address: address as `0x${string}` }) : undefined),
      // Structural check: the router must wrap this share and deposit into
      // this chain's Entrypoint + PoolVault. Without a client or a known pool
      // there is nothing to compare against, and the probe reads unreachable.
      probeClient && expectedPool
        ? {
            expected: { entrypoint: expectedPool.entrypoint, poolVault: expectedPool.pool },
            readRouter: async (router) => {
              const [vault, entrypoint, poolVault] = await Promise.all((['VAULT', 'ENTRYPOINT', 'POOL_VAULT'] as const).map((fn) =>
                probeClient.readContract({
                  address: router as `0x${string}`,
                  abi: [{ type: 'function', name: fn, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const,
                  functionName: fn,
                }) as Promise<string>));
              // NATIVE_MODE is read on its own and tolerated when it reverts: a
              // router deployed before that getter existed is an ERC-20 router,
              // and routerMatches reads an absent value as exactly that. A
              // native-mode deployment needs `true` here, so an unreadable
              // answer fails that config closed while leaving ppUSDC alone.
              const nativeMode = await probeClient.readContract({
                address: router as `0x${string}`,
                abi: [{ type: 'function', name: 'NATIVE_MODE', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }] as const,
                functionName: 'NATIVE_MODE',
              }).then((v) => v as boolean).catch(() => undefined);
              return { vault, entrypoint, poolVault, nativeMode };
            },
          }
        : undefined,
    );
    if (verdict !== 'ok') {
      console.warn(
        `[PoolSession] Yield disabled for chain ${chainId}: vault probe returned '${verdict}'`
        + ` (ppUSDC ${configuredYield.ppUSDC}, ppRouter ${configuredYield.ppRouter}).`
        + ' Deposits will shield plainly. Check EXPO_PUBLIC_YIELD_DEPLOYMENT_JSON.',
      );
    }
  }
  // Every VERIFIED deployment on the chain. The first rides the SDK's original
  // `yieldDeployment`; the rest go in `yieldDeployments` (v2-monorepo #397), so
  // one session serves mainnet's ppUSDC and ppUSDT. An SDK without #397 ignores
  // the second key, and the deposit modal refuses a second-share deposit rather
  // than routing it through the first (see resolveYieldNamespace there).
  const yieldDeployments = getYieldDeploymentsForChain(chainId);
  const yieldDeployment = yieldDeployments[0];

  // Intent swaps (flag-gated, EXPO_PUBLIC_INTENT_SWAPS): a LiFi-backed quote
  // provider enables session.prepareSwapQuote(). Flag OFF → no provider →
  // the session is identical to before (prepareSwapQuote throws, and the UI
  // entry points are hidden anyway).
  // ONE LiFi instance serves both interfaces (it implements ISwapQuoteProvider
  // AND ISwapAndDepositQuoteProvider), so both config slots get the same
  // object. Attaching only the first is the documented cause of
  // "prepareReshieldQuote throws for no visible reason": the swap-and-deposit
  // provider is what the redeposit leg of flows 1 and 3 needs, and a missing
  // provider throws rather than degrading.
  //
  // The API key is optional but unauthenticated LiFi is rate-limited, which
  // surfaces as intermittent quote failures rather than a clear error.
  const lifiProvider = INTENT_SWAPS_ENABLED
    ? new LiFiSwapQuoteProvider({
      ...(LIFI_API_KEY ? { apiKey: LIFI_API_KEY } : {}),
      // e2e only: pins cross-chain quotes to the listed bridges. Empty in real
      // builds, so users get LiFi's own bridge choice.
      ...(LIFI_CROSS_CHAIN_BRIDGES?.length ? { allowBridges: LIFI_CROSS_CHAIN_BRIDGES } : {}),
    })
    : undefined;
  if (lifiProvider) {
    // Flow 1's contract-call quotes default to 0.5% slippage same-chain, and
    // the deposit calldata demands its EXACT amount — at 0.5% the route
    // under-delivers often enough that the whole tx reverts with
    // 'ERC20: transfer amount exceeds balance' (QA 2026-08-18, OP tx
    // 0x39d78563…; relayer team: "with 1% it passes 99% of the time").
    // prepareSwapAndDeposit doesn't thread slippage, so raise the default at
    // the provider boundary. Callers that DO set slippage still win.
    //
    // Chain-aware since 2026-09-21: a flat 0.01 also overwrote the SDK's 0.03
    // CROSS-chain default, so every bridge route quoted with a third of the
    // headroom a bridge leg needs, while services/lifi-quote.ts and the shield
    // preview both priced it at 0.03. swapDepositSlippage is the one place the
    // two now read it from.
    const realGetSwapAndDepositQuote = lifiProvider.getSwapAndDepositQuote.bind(lifiProvider);
    (lifiProvider as unknown as { getSwapAndDepositQuote: typeof realGetSwapAndDepositQuote }).getSwapAndDepositQuote =
      (params: Parameters<typeof realGetSwapAndDepositQuote>[0]) =>
        realGetSwapAndDepositQuote({
          slippage: swapDepositSlippage(params.fromChainId, params.toChainId ?? params.fromChainId),
          ...params,
        });
    // A cross-chain call delivering the native coin (a shield into ppETH from
    // another network) denies Across, which refuses that shape and fails the
    // whole quote. The shield preview sends the same list.
    installNativeDeliveryBridgeDeny(lifiProvider);
    // The LiFi native-token echo (0x000… vs our 0xeee…) is normalised inside
    // the SDK since v2.0 4102d308 (#379 isSameToken in the session asserts,
    // plus canonicalTokenAddress in LiFiSwapQuoteProvider). The provider-
    // boundary shim that bridged the gap (services/lifi-native-echo.ts) was
    // removed with the re-vendor; see 0xbow-remote#18.
  }

  // Direct Across (EXPO_PUBLIC_ACROSS_DIRECT, default off): cross-chain ERC-20
  // legs from the chains in EXPO_PUBLIC_ACROSS_DIRECT_CHAINS deposit into the
  // Across SpokePool directly; every other route, and any Across quote that
  // fails, stays on the LiFi provider above with its shims. Inert until the
  // vendored SDK exports the Across classes AND a privacy-safe quote transport
  // is reviewed. withAcrossDirect currently preserves LI.FI even with the flag on.
  const swapProvider = lifiProvider
    ? (withAcrossDirect(lifiProvider, PrivacyPoolsSdk as unknown as AcrossSdkExports) as typeof lifiProvider)
    : undefined;

  // The session chain's RelaySwaps: with it the SDK validates LiFi quote
  // addresses against approvedRouters before use, on both the swap-deposit and
  // reshield paths. Undefined for chains with no deployment (fail-closed).
  const sessionRelaySwaps = getSwapProcessorAddress(chainId);

  // Destination attachment (flow 4). Its own RPC connection, per the SDK's
  // contract: the destination entrypoint is read on the destination chain,
  // never through this session's.
  const destinationEntrypointInteractor = reshieldDestination
    ? createEntrypointInteractor(
      createRPCInteractor(reshieldDestination.chainId, reshieldDestination.deploymentBlock),
      reshieldDestination.entrypointAddress,
    )
    : undefined;

  // Source-chain attachment. Its RPC interactor is this chain's twin: allowance
  // reads and receipt waits for the approval + swap, which execute over there.
  // The split SDK also wants the source chain's own swap adapter: RelaySwaps
  // router-allowlist and approval reads happen on the source chain, so it wraps
  // the same source-chain RPC, never this session's.
  const swapSourceRpc = swapSourceChain
    ? createRPCInteractor(swapSourceChain.chainId, swapSourceChain.deploymentBlock)
    : undefined;
  const swapDepositSourceChain = swapSourceChain && swapSourceRpc
    ? {
      chainId: swapSourceChain.chainId,
      walletInteractor: swapSourceChain.walletInteractor,
      rpcInteractor: swapSourceRpc,
      relaySwapsAddress: swapSourceChain.relaySwapsAddress,
      swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: swapSourceRpc }),
    }
    : undefined;

  const config: EvmPoolSessionConfig = {
    ownerAddress,
    chainId,
    ...(sessionRelaySwaps ? { relaySwapsAddress: sessionRelaySwaps } : {}),
    ...(swapDepositSourceChain ? { swapDepositSourceChain } : {}),
    // Both or neither, decided in one tested place: the SDK ignores a lone chain
    // id, so half-configuring silently produces a session whose
    // reshieldCrosschain methods throw at call time, inside a money flow.
    ...buildReshieldDestinationKeys(
      reshieldDestination,
      destinationEntrypointInteractor,
      reshieldDestination?.yieldDepositTargets as EvmPoolSessionConfig['destinationYieldDepositTargets'],
    ),
    ...(yieldDeployment ? { yieldDeployment } : {}),
    ...(yieldDeployments.length > 1 ? { yieldDeployments: yieldDeployments.slice(1) } : {}),
    ...(swapProvider
      ? { swapQuoteProvider: swapProvider, swapAndDepositQuoteProvider: swapProvider }
      : {}),
    cryptoService,
    merkleService,
    witnessPreparationService: witnessService,
    proofService,
    entrypointInteractor,
    noteManager,
    keystoreManager,
    keystoreInteractor,
    hashService,
    noteComputationService,
    poolVaultInteractor,
    aspClient,
    aspDataProvider,
    rpcInteractor: rpc,
    relayerInteractor,
    paymentRequestService,
  };

  // Forward the SDK's own warnings/errors to the console (see services/sdk-logger.ts).
  return createEvmPoolSession(config, { logger: createSdkConsoleLogger() });
}
