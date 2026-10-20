// Intent conversions use the configured chain and final-leg capabilities.
//
// THE SURFACE SHIPS DARK. EXPO_PUBLIC_INTENT_LOCKDOWN defaults to locked since
// 2026-09-21 (Pat); a deployment opts in with an explicit `false`. Everything
// below describes what is offered ONCE unlocked.
//
// Conversion destinations, verified against the prod registry on 2026-09-21 by
// running services/entrypoint-only-route.ts, not by reading it:
//   • mainnet: the three vault shares (ppUSDC, ppUSDT, ppETH), from this chain
//     or from another one. Every plain mainnet asset is refused — ETH because
//     native deposits route through ppETH, USDC and USDT because their plain
//     pools were replaced on 2026-09-04 and are withdraw-only now.
//   • BNB Chain: ppUSDT same-chain, plus BNB and FDUSD.
//   • The one vault refusal left is the bridged RESHIELD's far leg, which
//     builds a plain Entrypoint deposit and says so.
//
// Yield shares used to be refused here for want of a router-aware final leg.
// That stopped being true when the SDK was re-vendored (2c673149): it exports
// `prepareYieldSwapDeposit`, and services/swap-flows.ts `buildRedeposit` uses
// it for a share target. The same comment then outlived the same code a second
// time, for the cross-chain shield: `PoolSessionSwapDeposit` routes a share
// target through that helper whether or not `fromChainId` is the pool chain,
// and takes a `sourceChain` for exactly that. Lifted 2026-09-22. If a share
// target starts being refused again, check the SDK export before the gates.
//
// RelaySwaps configuration is necessary for note-funded flows; live liquidity,
// fee-commitment lifetime and SDK quote validation still decide execution.

import { MAINNET_SWAP_PROCESSOR_ADDRESS, OPTIMISM_SWAP_PROCESSOR_ADDRESS, SEPOLIA_SWAP_PROCESSOR_ADDRESS } from '@/config/relayer';
import { ACTIVE_DEPLOYMENTS_BY_CHAIN, ACTIVE_ENVIRONMENT, type SwapTokenInfo } from '@/config/environments';
import { resolveSwapAvailability } from '@/services/intent-swaps';
import { conversionTargetsFor, intentTargetRefusal } from '@/config/intent-targets';
import { crossFlowsEnabled, swapSurfaceEnabled } from '@/config/intent-lockdown';
import { getConfiguredYieldDeployments } from '@/config/yield';
import { isLegacyPlainToken } from '@/config/pool-paths';
import { destinationCallsSupported } from '@/config/destination-calls';
import { mergeDeliveryTokens } from '@/services/swap-delivery-rule';

export { resolveSwapAvailability };
export type { SwapTokenInfo };

// IMPORTANT: read the flag via a STATIC `process.env.EXPO_PUBLIC_*` member
// expression. Expo/Metro only inlines static member access at build time; a
// dynamic `process.env[name]` lookup is NOT inlined and resolves to
// `undefined` in the production web export (it silently "works" only in
// local dev). See config/yield.ts and config/sui-deployment.ts for the same
// warning.
/**
 * Default-ON flag: only an explicit "false" turns it off. Unset and empty both
 * mean on, so a deployment that never sets the var still gets swaps.
 */
/**
 * Chains this deployment has switched off (EXPO_PUBLIC_DISABLED_CHAIN_IDS).
 * Parsed here rather than imported from config/chains on purpose: importing that
 * module from this one adds a load-order edge that initialises part of the config
 * graph early and froze an env-derived constant elsewhere (it broke two golden
 * accounting tests). The env var is the same source of truth either way.
 */
const disabledChainIds: ReadonlySet<number> = new Set(
  (process.env.EXPO_PUBLIC_DISABLED_CHAIN_IDS ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id > 0),
);

/** True when this build serves the chain at all: deployed in the ACTIVE environment AND not switched off. */
function buildServesChain(chainId: number): boolean {
  return !!ACTIVE_DEPLOYMENTS_BY_CHAIN[chainId] && !disabledChainIds.has(chainId);
}

function toBoolDefaultOn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  return normalized !== 'false' && normalized !== '0';
}

/**
 * Master switch for the whole intent-swap UI + SDK wiring. Default ON — set
 * EXPO_PUBLIC_INTENT_SWAPS=false to turn the feature off.
 *
 * On alone does NOT make the shielded-note flows executable: withdraw-and-swap
 * (flow 2) and reshield (flow 3) additionally need a deployed RelaySwaps
 * processor for the chain, and stay fail-closed without one — see
 * intentSwapsEnabledForChain. Swap-into-deposit (flow 1) does not use a
 * processor, so this flag is the master gate. Flow 1 also needs LiFi coverage and an open,
 * configured plain destination. Unsupported chains fail before quoting.
 */
export const INTENT_SWAPS_ENABLED = toBoolDefaultOn(process.env.EXPO_PUBLIC_INTENT_SWAPS);

/**
 * LiFi API key. Optional — unauthenticated requests work but are
 * rate-limited, which shows up as intermittent quote failures under any real
 * load, so set it in every deployment that has swaps on.
 */
export const LIFI_API_KEY: string | undefined =
  process.env.EXPO_PUBLIC_LIFI_API_KEY?.trim() || undefined;

/**
 * Swap-into-a-deposit (guide flow 1): wallet token X → swap → shielded
 * token Y.
 *
 * Deliberately NOT gated on the RelaySwaps processor. Flow 1 is a direct
 * wallet → LiFi transaction: the SDK quotes with the session owner as LiFi's
 * `fromAddress`, embeds the deposit calldata, and the user's own wallet
 * submits it. No relayer and no RelaySwaps contract are involved — those
 * belong to the flows that spend a shielded note (2 and 3), where the proof
 * must bind to an on-chain caller. Requiring the processor here would keep
 * flow 1 dark on chains where it would work fine.
 *
 * It needs LiFi coverage and at least one open plain destination. The input
 * can be any supported wallet token, so two pool assets are not required.
 */
/**
 * LiFi exchanges to keep out of a swap route.
 *
 * The SDK takes a `denyExchanges` list (v2-monorepo#364) for one reason: some
 * exchanges quote with a lifetime shorter than the time this app needs to build
 * the ZK proof, so the route is dead before it can be submitted. Empty by
 * default, so behaviour is unchanged until a specific exchange earns its place
 * here; set EXPO_PUBLIC_SWAP_DENY_EXCHANGES to a comma-separated list.
 */
export const SWAP_DENY_EXCHANGES: readonly string[] = (process.env.EXPO_PUBLIC_SWAP_DENY_EXCHANGES ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

/**
 * The deny list for a quote that ends in a bridged destination call. `fly` is
 * always on it: its calldata carries a deadline shorter than the bridge takes,
 * so the destination swap reverts on arrival and the bridged funds go to the
 * fallback wallet (one of the 2026-09-23 BNB losses, v2-monorepo#437).
 */
export const CROSS_CHAIN_DENY_EXCHANGES: readonly string[] = [...new Set([...SWAP_DENY_EXCHANGES, 'fly'])];

export function swapDepositEnabledForChain(chainId: number): boolean {
  // Cross-ASSET deposit (pay with X, shield Y). No url escape hatch: see
  // config/intent-lockdown.ts.
  if (!crossFlowsEnabled()) return false;
  if (!INTENT_SWAPS_ENABLED) return false;
  // Asked about the POOLS this chain can land a conversion in, not about the
  // Swap tab's delivery list: those answer different questions and mainnet
  // makes the difference visible, because its pools are shares (reachable
  // through their router) while its swap outputs are not.
  return buildServesChain(chainId) && lifiServesChain(chainId)
    && conversionTargetsFor(chainId).length > 0;
}

/**
 * Reshield (guide flow 3): shielded token A → shielded token B, same chain,
 * funds never leave the pool. Needs BOTH quote providers on the session (the
 * swap quote for the estimate, the swap-and-deposit quote for the redeposit),
 * which pool-session-service attaches together.
 */
export function reshieldEnabledForChain(chainId: number): boolean {
  return crossFlowsEnabled() && intentSwapsEnabledForChain(chainId)
    && (getSwapOutputTokens(chainId).length > 0
      || LIFI_SERVED_CHAIN_IDS.some((id) => crossChainReshieldSupported(chainId, id)));
}

/**
 * Cross-chain reshield (guide flow 4), gated on a supported destination.
 *
 * This used to be a hard `false` because the three methods it needs
 * (estimateReshieldCrosschainAmount, prepareReshieldCrosschainQuote,
 * relayReshieldCrosschain) were not in the vendored SDK. That is no longer
 * true: since the eecb069b vendor bump they are present in both the runtime
 * bundle and the types, `PoolSession` carries an optional `reshieldCrosschain`
 * delegate, and `PoolSessionConfig` (the direct factory this app uses) accepts
 * the `destinationChainId` + `destinationEntrypointInteractor` pair that builds
 * it. So the gate is now a real one rather than a lie about the bundle.
 *
 * Default ON: this whole app is private staging, so a capability the SDK can
 * actually perform belongs where it can be tested rather than hidden. The gate
 * below still refuses every pair that cannot work — non-LiFi chains, chains this
 * build does not serve, a source with no RelaySwaps, a destination with no
 * configured assets — so "on" only ever means the configured open destinations.
 *
 * The Swap tab drives it, and scripts/e2e/crosschain-swap*.ts exercises it on
 * staging. Its dust-rescue auto-submit is not wired: leftover on the
 * destination lands at the RELAYER's address by design, since no user wallet
 * exists there. EXPO_PUBLIC_RESHIELD_CROSSCHAIN=false forces it off.
 */
/**
 * Read at CALL time, not module load, unlike the other flags here. Metro still
 * inlines the static `process.env.EXPO_PUBLIC_*` member read in the production
 * web export, so the bundle gets a literal either way — but a function keeps the
 * flag observable in tests, which a module-load constant is not once bun has
 * cached the module for the process.
 */
export function reshieldCrosschainEnabled(): boolean {
  return toBoolDefaultOn(process.env.EXPO_PUBLIC_RESHIELD_CROSSCHAIN);
}

/**
 * Can a shielded note on `sourceChainId` be reshielded into the pool on
 * `destinationChainId`?
 *
 * Every clause is a deployment fact, in the order that makes a failure
 * cheapest to understand:
 *  1. the intent-swaps master switch, then flow 4's own flag, which stays off
 *     until a trial proves the flow;
 *  2. it must actually cross chains (same-chain reshield is flow 3);
 *  3. both ends must be chains this BUILD serves (staging-only today);
 *  4. BOTH ends must be LiFi networks — the bridge leg is a LiFi route, so
 *     Citrea and Sepolia can never take part no matter what we deploy there;
 *  5. the SOURCE needs a RelaySwaps deployment, because the relayer binds the
 *     swap proof to it and quotes LiFi with it as `fromAddress`;
 *  6. the DESTINATION needs configured swap outputs, i.e. assets its
 *     entrypoint will accept as a deposit.
 *
 * Note what this cannot check: whether the relayer actually serves swap quotes
 * for the source chain. That is per-deployment runtime state (chain 1 answers,
 * availability can change at runtime), so the call still has to fail gracefully.
 */
export function crossChainReshieldSupported(
  sourceChainId: number,
  destinationChainId: number,
): boolean {
  if (!crossFlowsEnabled()) return false;
  // The master switch first, like every sibling gate: flow 4 IS intent-swap
  // wiring (it needs the LiFi providers and the relayer's swap route), and
  // pool-session-service only attaches those when INTENT_SWAPS_ENABLED. Without
  // this clause the kill switch would not kill — the gate would approve a pair
  // whose quote calls then throw "swapQuoteProvider must be configured".
  if (!INTENT_SWAPS_ENABLED) return false;
  if (!reshieldCrosschainEnabled()) return false;
  if (sourceChainId === destinationChainId) return false;
  // Both ends must be chains THIS BUILD serves. The clauses below are static
  // tables that say nothing about the build: chains 1 and 10 only exist when
  // EXPO_PUBLIC_STAGING is on, so without this a non-staging build would approve
  // 10→1 and then throw "Unsupported chain: 1" out of createRPCInteractor at
  // session-creation time. Checked against STAGING_BY_CHAIN, not getChainConfig,
  // deliberately: config/staging-deployments is ALREADY in this module's
  // transitive graph (via config/relayer), whereas importing config/chains adds
  // a new edge that pulls part of the config graph in ahead of its usual load
  // order — which froze an env-derived constant in another module and broke two
  // unrelated golden tests. Every LiFi-served chain we have is a staging chain,
  // so this is the same check without the new coupling.
  if (!buildServesChain(sourceChainId) || !buildServesChain(destinationChainId)) return false;
  if (!lifiServesChain(sourceChainId) || !lifiServesChain(destinationChainId)) return false;
  if (!getSwapProcessorAddress(sourceChainId)) return false;
  // The deposit on the far side is a bridge destination call (config/destination-calls).
  if (!destinationCallsSupported(destinationChainId)) return false;
  // `> 0`, not the `>= 2` of flow 1: a reshield re-deposits into ONE asset, so
  // a single configured destination output is enough.
  //
  // Deliberately NOT also requiring a RelaySwaps on the DESTINATION, though the
  // asymmetry with crossChainSwapDepositSupported (which checks both ends) looks
  // like an oversight and was raised as one in review. The SDK constructs
  // PoolSessionReshieldCrosschain with no relaySwapsAddress whatsoever — only
  // chainId, destinationChainId, the two entrypoint interactors, the relayer
  // interactor and the quote providers (dist/index.js:7048). The source clause
  // above stands because the relayer binds the swap proof to that chain's
  // RelaySwaps; the destination has no such binding, so requiring one there
  // would refuse a legitimate future destination that has a pool and an
  // entrypoint but no RelaySwaps of its own.
  // Asked FROM the source, so a destination whose only open pool is its
  // native coin does not look open to a bridged reshield.
  return getSwapOutputTokens(destinationChainId, sourceChainId).length > 0;
}

/**
 * The processor contract swap quotes and proofs bind to — the chain's
 * deployed RelaySwaps contract (the on-chain msg.sender for the swap route,
 * and LiFi's `fromAddress` at quote time). Distinct from both the transfer
 * signer EOA and the PrivacyPoolRelay withdrawal contract; binding either
 * of those produces PoolVault_ProofContextMismatch after full proving.
 * Undefined ⇒ no RelaySwaps deployed for this chain ⇒ swaps stay dark.
 */
export function getSwapProcessorAddress(chainId: number): `0x${string}` | undefined {
  if (chainId === 11155111) return SEPOLIA_SWAP_PROCESSOR_ADDRESS;
  // Ethereum mainnet — LiFi-served, RelaySwaps deployed (pinned in
  // config/relayer.ts, verified on-chain to approve LiFi's router), and the
  // relayer prices its swap quotes. Fully live, not a placeholder.
  if (chainId === 1) return MAINNET_SWAP_PROCESSOR_ADDRESS;
  // OP mainnet — the intents testing deployment. LiFi-served AND its
  // RelaySwaps is deployed (2026-08-17, pinned default in config/relayer.ts),
  // so OP is the first chain where flows 2/3 can bind to a real processor.
  if (chainId === 10) return OPTIMISM_SWAP_PROCESSOR_ADDRESS;
  // Any other chain: the active environment's pinned RelaySwaps, if the
  // deployment has one (both BSC environments do; Citrea does not).
  return ACTIVE_DEPLOYMENTS_BY_CHAIN[chainId]?.relaySwaps as `0x${string}` | undefined;
}

/**
 * Every RelaySwaps contract that has served a swap route, per chain: current
 * and past, prod and staging. A Transacted log whose caller is one of these
 * went through a swap route, whatever the environment of this build, because
 * only RelaySwaps calls the pool as that address. Activity reads it to name a
 * withdrawal "via swap" on a device with no record of the swap.
 *
 * Prod: 0xd0395c08 on chains 1 and 56 since 2026-09-18, 0x5936aEfB before.
 * Staging: 0x1aB4008b (1), 0x581Bc5D5 (10), 0xbe169487 (56),
 * 0x1069f1B3 (8453) current;
 * 0x5f3927f2 (1) and 0x3b20f2df (10) past.
 */
const KNOWN_RELAY_SWAPS: Readonly<Record<number, readonly string[]>> = {
  1: [
    '0xd0395c08dd8ea7671a7a65bdca8e473e8e8260a8',
    '0x5936aefb2134550f3f526d65e984620582d270e7',
    '0x1ab4008b96b1791ec693304ab8855b86fe093724',
    '0x5f3927f24ec20f49b3850a5b78eb2015945e57f7',
  ],
  10: [
    '0x581bc5d58597c0602f05c4f58e88418d27920980',
    '0x3b20f2dfc225b54567561343a1c63eebb8db63f5',
  ],
  56: [
    '0xd0395c08dd8ea7671a7a65bdca8e473e8e8260a8',
    '0x5936aefb2134550f3f526d65e984620582d270e7',
    '0xbe16948700c538d71599db99df604a2ea9a7e61a',
  ],
  8453: ['0x1069f1b3a5bad78a38af64a9018a4724bd8a738c'],
};

/** Was a Transacted log with this caller submitted by a RelaySwaps contract? */
export function isSwapRouteCaller(caller: unknown, chainId: number | undefined): boolean {
  // Snapshot data is not validated per field, and this runs during render.
  if (typeof caller !== 'string' || chainId === undefined) return false;
  const c = caller.toLowerCase();
  if (KNOWN_RELAY_SWAPS[chainId]?.includes(c)) return true;
  const current = getSwapProcessorAddress(chainId);
  return !!current && current.toLowerCase() === c;
}

/**
 * THE gate every swap entry point (buttons, tabs, the modal itself, quote
 * fetching) must consult. Flag ON alone is not enough — without a deployed
 * RelaySwaps processor the proofs cannot bind to anything real.
 */
export function intentSwapsEnabledForChain(chainId: number): boolean {
  if (!swapSurfaceEnabled() || !buildServesChain(chainId) || !lifiServesChain(chainId)) return false;
  // At least one configured plain input and a different reachable output are
  // required. A legacy input may exit even when its own pool is no target.
  const crossChainPair = crossFlowsEnabled() && lifiServesChain(chainId)
    && LIFI_SERVED_CHAIN_IDS.some((id) => id !== chainId && buildServesChain(id)
      && receivableAddresses(id, chainId).size > 0);
  const sameChainOutputs = receivableAddresses(chainId, chainId);
  const sameChainPair = getSwapInputTokens(chainId).some((input) =>
    [...sameChainOutputs].some((output) => input.address.toLowerCase() !== output));
  if (getSwapInputTokens(chainId).length === 0 || (!sameChainPair && !crossChainPair)) return false;
  return resolveSwapAvailability(INTENT_SWAPS_ENABLED, getSwapProcessorAddress(chainId));
}

/**
 * Destination chains a swap can deliver to from the given pool chain — the
 * chains the RELAYER and LIFI both support, not ppv2's active-chain list
 * (`supportedChainIds`), which is a different concept (the chain the pool
 * lives on vs the chain you receive on).
 *
 * The source chain first (a plain same-chain withdraw-and-swap), then every
 * chain a cross-chain delivery can actually reach from it. The swap modal offers
 * the destination-network pane as soon as this returns more than one.
 *
 * This used to hard-return same-chain only, on two grounds that no longer hold:
 * the deployed relayer DOES serve /swap (chain 1 prices quotes; verified
 * 2026-08-18), and LiFi serves two of our chains. What each clause below still
 * enforces:
 *  - swaps must be enabled on the SOURCE chain, since that is where the note
 *    exits and where the relayer binds the proof to a RelaySwaps;
 *  - both ends must be LiFi networks, because the delivery leg is a LiFi route;
 *  - the build must actually serve the destination (chains 1 and 10 are staging
 *    only), or the app would advertise a chain it cannot resolve;
 *  - the destination needs something to receive, which is either list: a
 *    conversion target from THIS source (a vault share only on its own chain)
 *    or a plain wallet delivery.
 * The destination needs NO RelaySwaps of its own: the swap executes on the
 * source chain and LiFi delivers the output to an address over there.
 */
export function getSwapDestinationChains(poolChainId: number): number[] {
  // Locked down: the pool chain is the only destination.
  if (!crossFlowsEnabled()) return [poolChainId];
  if (!intentSwapsEnabledForChain(poolChainId) || !lifiServesChain(poolChainId)) {
    return [poolChainId];
  }
  const reachable = LIFI_SERVED_CHAIN_IDS.filter(
    (id) => id !== poolChainId
      // Staged AND not disabled: a chain switched off with
      // EXPO_PUBLIC_DISABLED_CHAIN_IDS is absent from the chain config, so
      // advertising it would offer a destination the app cannot resolve (kimi).
      && buildServesChain(id)
      && receivableAddresses(id, poolChainId).size > 0,
  );
  return [poolChainId, ...reachable].filter((id) => receivableAddresses(id, poolChainId).size > 0);
}

/**
 * Chains LiFi actually serves among the ACTIVE environment's chains (staging:
 * 1, 10, 8453 and 56; prod: 1 and 56, per li.quest/v1/chains). A cross-chain
 * swap-and-deposit is ONE LiFi contract-calls transaction that bridges from the
 * source chain and executes the pool deposit on the destination, so LiFi has to
 * serve BOTH ends. Our testnets (Sepolia) and Citrea are not LiFi networks, so
 * they can never be either end of that route.
 */
const LIFI_SERVED_CHAIN_IDS: readonly number[] = ACTIVE_ENVIRONMENT.lifiServedChainIds;

export function lifiServesChain(chainId: number): boolean {
  return LIFI_SERVED_CHAIN_IDS.includes(chainId);
}

/**
 * Can the SDK route a cross-chain swap-and-deposit from `sourceChainId` into a
 * pool on `poolChainId`? (SDK ≥ eecb069b, v2-monorepo#372 — the session takes a
 * `swapDepositSourceChain` and `SwapAndDepositParams.fromChainId` may differ
 * from the pool chain.)
 *
 * Every condition is a real deployment fact, checked rather than assumed:
 *  - the two chains differ (same-chain is the ordinary flow-1 path);
 *  - LiFi serves BOTH (it bridges from the source and calls the deposit on the
 *    destination — see lifiServesChain);
 *  - the SOURCE chain has a RelaySwaps deployment, because its
 *    `approvedRouters` is the allowlist the SDK validates LiFi's
 *    transactionTo/approvalAddress against — "that is where the transaction
 *    executes, so the pool chain's allowlist would be the wrong trust anchor"
 *    (SDK's own words);
 *  - the DESTINATION chain has one too, since the session validates its own
 *    quote addresses against the pool chain's RelaySwaps;
 *  - swap-and-deposit is enabled for the destination (assets configured),
 *    share pools included: they are reachable here for the same reason they are
 *    same-chain, since the deposit is prepared on the destination's session.
 */
export function crossChainSwapDepositSupported(sourceChainId: number, poolChainId: number): boolean {
  if (!crossFlowsEnabled()) return false;
  if (!INTENT_SWAPS_ENABLED) return false;
  if (sourceChainId === poolChainId) return false;
  if (!buildServesChain(sourceChainId) || !buildServesChain(poolChainId)) return false;
  if (!lifiServesChain(sourceChainId) || !lifiServesChain(poolChainId)) return false;
  if (!getSwapProcessorAddress(sourceChainId) || !getSwapProcessorAddress(poolChainId)) return false;
  if (!destinationCallsSupported(poolChainId)) return false;
  // The same gate as same-chain, with nothing subtracted for the bridge. The
  // session this flow prepares against IS the destination's — built for
  // poolChainId with its yield deployments, with the wallet's chain attached as
  // swapDepositSourceChain — so the SDK sizes a share target through that
  // chain's router (prepareYieldSwapDeposit) whether or not fromChainId is the
  // pool chain, and vets the LiFi addresses against the SOURCE chain's
  // RelaySwaps, which is why both ends are required above. The one thing the
  // bridge does subtract is a plain native coin: the executor cannot send the
  // exact `msg.value` its Entrypoint deposit needs.
  return swapDepositEnabledForChain(poolChainId) && conversionTargetsFor(poolChainId, true).length > 0;
}

// Same sentinel the deposit flow and the SDK use for the native asset.
export const NATIVE_ASSET_ADDRESS =
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`;

// Candidate OUTPUT tokens per destination chain, from the ACTIVE environment
// (config/environments.ts): staging carries Sepolia, mainnet, OP, Base and
// BSC; prod carries mainnet, BSC, OP, Base and Arbitrum. Each list mirrors that
// chain's configured pool assets; on a LiFi-served chain it could grow beyond
// them - any ERC-20 LiFi can route to is a valid output.
const SWAP_OUTPUT_TOKENS: Record<number, SwapTokenInfo[]> = ACTIVE_ENVIRONMENT.swapOutputTokens;

/**
 * Outputs for the SHIELDED swap surface: the sell side is always a shielded
 * balance, so naming another `sourceChainId` makes this the cross-chain
 * reshield, whose deposit the bridge executes on arrival. That reaches a yield
 * share through its router but never a plain native coin (see
 * services/entrypoint-only-route.ts). Omit it for the "does this chain receive
 * anything at all" questions, which are same-chain by meaning.
 */
export function getSwapOutputTokens(destinationChainId: number, sourceChainId?: number): SwapTokenInfo[] {
  if (!buildServesChain(destinationChainId) || !lifiServesChain(destinationChainId)) return [];
  const bridgedEntrypointDeposit = sourceChainId !== undefined && sourceChainId !== destinationChainId;
  return (SWAP_OUTPUT_TOKENS[destinationChainId] ?? []).filter(
    (token) => intentTargetRefusal(token.address, destinationChainId, false, bridgedEntrypointDeposit) === null,
  );
}

/**
 * Assets a swap can hand to a WALLET on `chainId`: the "Receive as" pickers in
 * withdraw and send, and the Swap tab in its wallet mode. LiFi has to buy and
 * pay out this exact token, so a yield share can never be one (that IS the
 * 2026-09-04 liquidity constraint, and this is the list it governs).
 *
 * Deliberately NOT filtered by intentTargetRefusal: that rule answers where a
 * DEPOSIT may land. A closed or superseded pool says nothing about paying the
 * plain coin to an address, and applying it here left mainnet with nothing to
 * receive once ppETH replaced the plain ETH pool.
 */
export function getSwapDeliveryTokens(chainId: number): SwapTokenInfo[] {
  if (!buildServesChain(chainId) || !lifiServesChain(chainId)) return [];
  // The rule, and why the registry is merged in, is in
  // services/swap-delivery-rule.ts, where bun tests can reach it.
  return mergeDeliveryTokens(
    SWAP_OUTPUT_TOKENS[chainId] ?? [],
    ACTIVE_ENVIRONMENT.tokensByChain[chainId] ?? {},
    NATIVE_ASSET_ADDRESS,
  ) as SwapTokenInfo[];
}

/**
 * Everything `sourceChainId` can actually hand to `destinationChainId`, as
 * lowercase addresses: a conversion that lands in a pool there, or a plain
 * delivery to a wallet. The chain-level gates ask this rather than one list,
 * because mainnet is open on one and not the other (its pools are shares, its
 * deliverable assets are not).
 */
function receivableAddresses(destinationChainId: number, sourceChainId: number): Set<string> {
  const addresses = new Set<string>();
  for (const token of getSwapOutputTokens(destinationChainId, sourceChainId)) {
    addresses.add(token.address.toLowerCase());
  }
  for (const token of getSwapDeliveryTokens(destinationChainId)) {
    addresses.add(token.address.toLowerCase());
  }
  return addresses;
}

/**
 * What a note can be spent FROM. Spendable plain notes remain inputs even when
 * their old pool is superseded, and a share is an input wherever this build
 * configures its deployment. Never derive inputs from safe targets.
 *
 * Shares were excluded outright until 2026-09-22, on the same reading that kept
 * them out of the output list: that LiFi cannot fill them. That is true of the
 * DELIVERY list above, where LiFi must hand the token to a wallet, and it is
 * why that list still drops them. It was never true here. The swap never sells
 * a share: RelaySwaps redeems it to the wrapper's underlying first, and LiFi is
 * quoted from that token. The SDK encodes exactly that substitution, in both
 * the same-chain and cross-chain reshield paths, and reports it back as
 * `ReshieldEstimate.swapInputToken` (`tokenId` for a plain note, the wrapper's
 * `underlying` for a share).
 *
 * The cost of the old reading was total: once ppETH replaced the plain ETH pool
 * on mainnet, every note a new user held was a share, so the input list came
 * down to the legacy ETH pool alone and nobody who had shielded since could
 * start a swap at all.
 *
 * CONFIGURED, not merely inventoried, mirroring `shareRouteConfigured` on the
 * target side: a build with yield switched off has no wrapper for the SDK to
 * resolve, so it must not offer the share as a source either. The redemption
 * also has to be allowlisted on that chain's RelaySwaps (`approvedZaps`), which
 * is on-chain state this table cannot read; the quote fails closed if it ever
 * disagrees, the same as every other capability behind this list.
 */
export function getSwapInputTokens(chainId: number): SwapTokenInfo[] {
  if (!buildServesChain(chainId) || !lifiServesChain(chainId)) return [];
  return (SWAP_OUTPUT_TOKENS[chainId] ?? []).filter((token) => {
    const meta = ACTIVE_ENVIRONMENT.tokensByChain[chainId]?.[token.address.toLowerCase()];
    if (!meta) return false;
    // A plain pool a share has replaced is not a swap source at all (Pat,
    // 2026-09-22). It stays spendable through Withdraw and Send, which is how
    // a legacy holder gets their money out, but the conversion surface does
    // not offer it. Replaces the older "spendable plain notes remain inputs
    // even when superseded": on mainnet that rule left legacy ETH as the only
    // input, which is what the pre-#94 list was, and it is not what we want now
    // that the shares are the live pools.
    if (isLegacyPlainToken(meta, chainId)) return false;
    if (!meta.yieldShare) return true;
    return getConfiguredYieldDeployments(chainId).some(
      (d) => d.ppUSDC.toLowerCase() === token.address.toLowerCase(),
    );
  });
}

export function intentSwapInputSupported(chainId: number, address: string): boolean {
  return intentSwapsEnabledForChain(chainId)
    && getSwapInputTokens(chainId).some((token) => token.address.toLowerCase() === address.toLowerCase());
}

/**
 * The units the SWAP leg is denominated in for a note spent from `address`.
 *
 * A note's own identity is not always the identity of the number quoted
 * against it. For a plain note the swap consumes the note's token and the two
 * are the same. For a share the swap never sees the share at all: RelaySwaps
 * redeems it first, so the amount handed to LiFi is in the wrapper's
 * underlying, which is a different symbol and often a different scale (ppUSDC
 * is 18 decimals, the USDC it redeems to is 6). The SDK reports the same thing
 * back as `ReshieldEstimate.swapInputToken`.
 *
 * Read the review screen's net amount through this, never through the note's
 * own units: an 18-decimals formatter over a 6-decimals number renders about a
 * trillionth of the real figure, and it renders it as a confident-looking
 * "0.00". The gross and the relayer fee stay in the NOTE's units, because the
 * SDK takes the fee off the amount withdrawn, before the redemption.
 */
export function swapInputUnits(
  chainId: number,
  address: string,
  noteUnits: { symbol: string; decimals: number },
): { symbol: string; decimals: number } {
  const key = address.toLowerCase();
  const meta = ACTIVE_ENVIRONMENT.tokensByChain[chainId]?.[key];
  if (!meta?.yieldShare) return noteUnits;
  const deployment = getConfiguredYieldDeployments(chainId).find((d) => d.ppUSDC.toLowerCase() === key);
  if (!deployment) return noteUnits;
  return { symbol: deployment.underlyingSymbol, decimals: deployment.underlyingDecimals };
}

/**
 * Why a chain this build serves cannot take part in a swap, or undefined when
 * it can. The widget lists every served chain and greys out these ones with
 * the reason, rather than leaving a new chain out of the list (Mike, #276).
 *  - source: the note exits here, so it needs a RelaySwaps and a LiFi route;
 *  - destination: a reshield from `sourceChainId` lands a deposit here, which
 *    is a bridge destination call (config/destination-calls).
 */
export function swapChainUnavailableReason(
  chainId: number,
  role: 'source' | 'destination',
  sourceChainId?: number,
): string | undefined {
  if (!buildServesChain(chainId)) return undefined;
  if (!lifiServesChain(chainId)) return 'No swap route yet';
  if (role === 'source') {
    return getSwapProcessorAddress(chainId) && intentSwapsEnabledForChain(chainId) ? undefined : 'No swaps yet';
  }
  if (!destinationCallsSupported(chainId)) return 'Swaps cannot land here yet';
  if (sourceChainId !== undefined && sourceChainId !== chainId && !crossChainReshieldSupported(sourceChainId, chainId)) {
    return 'No route from this chain yet';
  }
  return undefined;
}
