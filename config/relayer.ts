import type { Address, Hex } from '@/services/sdk-types';
import { ActivePoolSelection } from '@/config/pool-profile';
import {
  CURRENT_RELAY,
  RELAY_PROCESSOR_BY_VAULT,
  resolveSepoliaRelayerBaseUrl,
} from '@/config/relayer-eras';
import { ACTIVE_DEPLOYMENTS_BY_CHAIN } from '@/config/environments';

// `PoolVault.transact` enforces `_transactParams.processor == msg.sender`
// (PoolVault.sol:143), and the proof's context binds those params, so the
// frontend must bind the proof to whichever address actually posts the tx —
// bind the wrong one and it reverts in verification with
// PoolVault_ProofContextMismatch().
//
// ⚠️ The transfer processor is RELAYER-VERSION-DEPENDENT and has flipped twice.
// The 0xbow relayer backend routes the two relayed flows through DIFFERENT
// on-chain callers (see relayer `evm.chain.service.ts`):
//
//   transfers + payment fulfillment  (sdkTransfer → simulateAndWriteRelayTransfer):
//     relayer signer EOA → PoolVault.transact DIRECTLY
//     on-chain msg.sender = the signer EOA  ⇒  processor = signer EOA.
//
//   withdrawals  (sdkWithdraw → simulateAndWriteRelay):
//     relayer signer EOA → PrivacyPoolRelay.relay(...) → PoolVault.transact
//     on-chain msg.sender = the PrivacyPoolRelay contract  ⇒  processor = relay contract.
//
// History: an earlier deployed relayer build routed transfers through the relay
// contract too (so this was briefly set to the relay contract). The relayer's
// "Transfer contract integration" (#181) moved transfers back to a direct
// PoolVault.transact (processor = signer EOA) and that build was deployed
// 2026-06-09. If transfers start reverting with PoolVault_ProofContextMismatch
// again, first check whether the relayer flipped the transfer route again.

// EOA the relayer backend signs from on Sepolia. It is the on-chain caller for
// the TRANSFER route (direct PoolVault.transact), so it is the transfer
// processor. Also the default fee-recipient surfaced in the withdrawal review UI.
export const SEPOLIA_RELAYER_SIGNER_ADDRESS =
  '0x4Ba5fF376865b370790A56276C63e7984DCFf1f7' as Address;

// Sepolia PrivacyPoolRelay contract for the current 0xbow deployment. It is the
// on-chain msg.sender for the WITHDRAWAL route (relayer → relay(...) → transact),
// so it is the processor the withdrawal proof's context MUST bind to. PoolVault
// checks both `_transactParams.processor == msg.sender` (PoolVault.sol:143) and
// `_proof.context() == keccak256(abi.encode(_transactParams, _noteData))`
// (PoolVault.sol:146); binding the wrong address reverts the latter with
// PoolVault_ProofContextMismatch(). Bumped alongside the 2026-05-31 pool
// redeploy — the previous deploy's relay was
// 0xb52f2465C165791ebf2A1e3eD6c6Ef8055f996C6.
// V9 PrivacyPoolRelay (sepolia-deployment-v9.md). The relayer posts the
// WITHDRAWAL route through relay() on this contract, so withdrawal proofs bind
// to it. The TRANSFER route is NOT this contract on the current relayer build —
// it posts directly from the signer EOA (see SEPOLIA_TRANSFER_PROCESSOR_ADDRESS
// below and issue #217). An earlier draft of this comment claimed both routes
// went through relay(); the live transfer revert disproved that.
//
// Older pools (in-app pool switcher): each era's relay still points at its
// own pool on-chain, so proofs bind to it — but the hosted relayer service
// only posts for the current pool, so relayed routes on an older pool may be
// declined; ragequit is the supported exit there. Era routing is mapped per
// vault (the ASP feed doesn't carry relayer data); unmapped pools fall back
// to the current relay.
// Era data + the pure URL resolver live in config/relayer-eras.ts (no
// react-native imports → bun-testable). This module applies the active pool
// selection to them.
const selectedRelayEra = ActivePoolSelection
  ? RELAY_PROCESSOR_BY_VAULT[ActivePoolSelection.poolVault.toLowerCase()]
  : undefined;

export const SEPOLIA_RELAY_PROCESSOR_ADDRESS = (selectedRelayEra?.relay ?? CURRENT_RELAY) as Address;

// Static member read — Metro only inlines static process.env.EXPO_PUBLIC_*
// access in the production web export (see config/sui-deployment.ts).
export const SEPOLIA_RELAYER_BASE_URL = resolveSepoliaRelayerBaseUrl(
  ActivePoolSelection?.poolVault,
  process.env.EXPO_PUBLIC_SEPOLIA_RELAYER_URL,
);

// The current 0xbow relayer posts the TRANSFER route directly from the signer
// EOA (relayer "Transfer contract integration" #181, deployed 2026-06-09; and
// re-confirmed live 2026-06-30 in issue #217 — binding the relay contract
// reverts every relayed transfer with PoolVault_ProofContextMismatch). So
// transfers default to the signer EOA; an era can opt back into the relay
// contract only by explicitly setting transfersViaSignerEoa: false in the map.
export const SEPOLIA_TRANSFER_PROCESSOR_ADDRESS: Address =
  selectedRelayEra && selectedRelayEra.transfersViaSignerEoa === false
    ? SEPOLIA_RELAY_PROCESSOR_ADDRESS
    : SEPOLIA_RELAYER_SIGNER_ADDRESS;
export const SEPOLIA_WITHDRAWAL_PROCESSOR_ADDRESS: Address = SEPOLIA_RELAY_PROCESSOR_ADDRESS;

// ---------------------------------------------------------------------------
// Per-chain resolvers.
//
// The SEPOLIA_* constants above describe the ONE relayer Sepolia talks to. The
// environment deployments (prod pools in Prod, the whitelisted staging pools in
// Staging) each carry their OWN PrivacyPoolRelay and relayer, so anything that
// binds a proof processor must resolve it from the chain it is transacting on,
// through the ACTIVE environment's pins — never from a build-wide constant and
// never from the other environment's map (same chain ids, different pools).
// Sepolia (staging only) falls through to the constants.

/** WITHDRAWAL proof processor: the chain's PrivacyPoolRelay contract. */
export function getWithdrawalProcessorAddress(chainId: number): Address {
  const deployment = ACTIVE_DEPLOYMENTS_BY_CHAIN[chainId];
  // relay.POOL() == the vault was verified on-chain for every pinned
  // deployment (staging 2026-07-30, prod 2026-09-02), so a proof bound here
  // matches msg.sender.
  if (deployment) return deployment.relay as Address;
  return SEPOLIA_WITHDRAWAL_PROCESSOR_ADDRESS;
}

/**
 * TRANSFER proof processor: the relayer's signer EOA on the current relayer
 * routing. Pinned per deployment (recovered from the relayer's own fee
 * commitments; env-overridable per chain); if a build blanks the pin the relay
 * contract stands in, which is correct ONLY for a relayer build that routes
 * transfers through relay() (the pre-#181 behaviour).
 */
export function getTransferProcessorAddress(chainId: number): Address {
  const deployment = ACTIVE_DEPLOYMENTS_BY_CHAIN[chainId];
  if (deployment) return (deployment.relayerSigner ?? deployment.relay) as Address;
  return SEPOLIA_TRANSFER_PROCESSOR_ADDRESS;
}

/**
 * Was a Transacted log with this caller submitted on the relayer's TRANSFER
 * route (services/transact-shape.ts says why that matters)? False when the
 * chain's transfer and withdrawal processors are the same address, since the
 * caller then cannot tell the routes apart.
 */
export function isTransferRouteCaller(caller: unknown, chainId: number | undefined): boolean {
  // Snapshot data is not validated per field, and this runs during render.
  if (typeof caller !== 'string' || chainId === undefined) return false;
  const transfer = getTransferProcessorAddress(chainId).toLowerCase();
  if (transfer === getWithdrawalProcessorAddress(chainId).toLowerCase()) return false;
  return caller.toLowerCase() === transfer;
}

/** The relayer's signer EOA — also the default fee receiver shown in review UIs. */
export function getRelayerSignerAddress(chainId: number): Address {
  const deployment = ACTIVE_DEPLOYMENTS_BY_CHAIN[chainId];
  if (deployment) return (deployment.relayerSigner ?? deployment.relay) as Address;
  return SEPOLIA_RELAYER_SIGNER_ADDRESS;
}

// Intent swaps (withdraw-and-swap) execute through a DEDICATED RelaySwaps
// contract — the relayer posts the swap route with `{ processor: RelaySwaps }`
// (relayer evm.chain.service.ts), and the SDK also uses this address as
// LiFi's `fromAddress` when quoting (the swap runs from the processor).
// Binding the transfer signer EOA or the PrivacyPoolRelay withdrawal
// contract here would produce proofs whose context can never match the
// on-chain caller (PoolVault_ProofContextMismatch after full proving) and
// quotes routed from the wrong initiator. No RelaySwaps is deployed on
// Sepolia yet, so this is env-driven and FAIL-CLOSED: unset ⇒ undefined ⇒
// the intent-swap feature stays dark even with EXPO_PUBLIC_INTENT_SWAPS=true
// (config/intent-swaps.ts gates on it). Do NOT default this to the
// withdrawal relay address — RelaySwaps is a different contract.
const swapProcessorEnv = process.env.EXPO_PUBLIC_SEPOLIA_SWAP_PROCESSOR_ADDRESS;
export const SEPOLIA_SWAP_PROCESSOR_ADDRESS: Address | undefined =
  swapProcessorEnv && /^0x[0-9a-fA-F]{40}$/.test(swapProcessorEnv.trim())
    ? (swapProcessorEnv.trim() as Address)
    : undefined;

// Ethereum MAINNET and OP RelaySwaps: the ACTIVE environment's deployment pins
// (`relaySwaps` in config/staging-deployments.ts or config/prod-deployments.ts).
// Staging mainnet is Daffy's 0x5f3927f2… (verified on-chain 2026-08-18), prod
// mainnet is 0xd0395c08… since the 2026-09-18 relayer redeploy (0x5936aEfB…
// before, verified 2026-09-02; the relayer publishes the live one), OP is
// staging-only (0x3b20f2df…, verified 2026-08-17). The env overrides live ON the
// records now (EXPO_PUBLIC_MAINNET_/OPTIMISM_SWAP_PROCESSOR_ADDRESS for staging,
// EXPO_PUBLIC_PROD_RELAY_SWAPS_ADDRESS for prod), so a build carrying the
// staging override can never re-point a prod proof at the staging processor
// (codex, 2026-09-02). Undefined when the active environment has no RelaySwaps
// on the chain: the feature then stays dark there.
export const MAINNET_SWAP_PROCESSOR_ADDRESS: Address | undefined =
  ACTIVE_DEPLOYMENTS_BY_CHAIN[1]?.relaySwaps as Address | undefined;
export const OPTIMISM_SWAP_PROCESSOR_ADDRESS: Address | undefined =
  ACTIVE_DEPLOYMENTS_BY_CHAIN[10]?.relaySwaps as Address | undefined;

// Shape we override on the SDK's `prepareWithdraw` result before handing
// it to `relayWithdrawal`. The SDK reads `selectedQuote.relayerInfo.processorAddress`
// when re-proving against the relayed route, so we have to rewrite the
// nested field, not just the top-level one. Structural (no index
// signatures) so the SDK's option interfaces, which carry extra fields,
// satisfy it.
type RelayerOptionWithProcessor = {
  processorAddress?: Address | Hex;
  selectedQuote: {
    relayerInfo: {
      processorAddress: Address | Hex;
    };
  };
};

/**
 * Rebind the SDK's chosen relayer-quote option to a specific on-chain
 * processor. The SDK accepts whatever the relayer backend reports in its
 * `/relayer/details` response; for withdrawals the relayer reports the
 * signer EOA (since that's the address it'll sign from), but the actual
 * on-chain `msg.sender` for `PoolVault.transact` will be the
 * `PrivacyPoolRelay` contract that wraps the call. Override before
 * `relayWithdrawal` so the proof binds to the correct processor.
 */
export function rebindProcessor<T extends RelayerOptionWithProcessor>(
  option: T,
  processor: Address,
): T {
  return {
    ...option,
    processorAddress: processor,
    selectedQuote: {
      ...option.selectedQuote,
      relayerInfo: {
        ...option.selectedQuote.relayerInfo,
        processorAddress: processor,
      },
    },
  };
}
