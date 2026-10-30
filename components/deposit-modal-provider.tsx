import { SWAP_DEPOSIT_REFUND_NOTE } from '@/services/swap-deposit-copy';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { HubErrorBoundary } from '@/components/home/hub-error-boundary';
import { shieldHeadroomRoomText } from '@/services/shield-headroom-copy';
import { relaunchReady } from '@/services/deposit-relaunch';
import { simulateWithAllowanceOverride } from '@/services/allowance-override-sim';
import { KEY_SESSION_DEPOSIT_FOR_COPY } from '@/services/recipient-registration-hint';
import { submitWalletTransaction } from '@/services/wallet-submit';
import { buildDepositApprovalCalls, submitApprovedDeposit } from '@/services/deposit-batch';
import { walletCapabilities } from '@/services/wallet-signature-timeout';
import { getAccount } from '@wagmi/core';
import { BatchNotSubmittedError, submitAtomicBatch, supportsAtomicBatch, type BatchCall } from '@/services/wallet-batch';
import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { usePathname } from 'expo-router';
import { plainNativeDepositRefused, resolveDepositPayAsset } from '@/services/shield-pools';
import { ACTIVE_ENVIRONMENT } from '@/config/environments';
import { cappedQuickAmounts, checkDepositCap } from '@/services/deposit-cap';
import { reportErrorReport } from '@/services/error-reports';
import { classifyFailure } from '@/services/error-reports-cause';
import { stellarErrorReportStage, type ErrorReportStage } from '@/services/error-reports-failure';
import { TEST_MODE } from '@/config/env';
import { DEPOSIT_FAQ_URL, SUPPORT_FORM_URL, SUPPORT_TELEGRAM_URL } from '@/config/support';
import { ENTRYPOINT_ASSETS_ABI, getMinimumDepositAmount, getVettingFeeBPS, type EntrypointAssetConfig } from '@/services/entrypoint-assets';
import { sameSymbol } from '@/services/symbol-match';
import { formatDepositMinimum, friendlyDepositError, PREVIEW_MINT_ABI, requiredUnderlyingForMinShares, scaleUnits } from '@/services/deposit-limits';
import { sdkErrorText } from '@/services/sdk-error-amounts';
import { decodeRevertPayload } from '@/services/revert-decode';
import { truncateAddress } from '@/services/hex-format';
import { CaretDownIcon, CaretUpIcon, CheckCircleIcon, CloseIcon } from '@/components/ui/modal-icons';
import { WEB_FIXED_POSITION, WEB_BLUR_BACKDROP, WEB_NO_OUTLINE } from '@/components/ui/web-style-shims';
import { useBackHandler } from '@/hooks/use-back-handler';
import { FeeWarning } from '@/components/fee-warning';
import { SHIELD_GAS_UNITS } from '@/config/fee-warnings';
import { useFeePricing } from '@/hooks/use-fee-pricing';
import { buildFeeBreakdown, gasCostUsd, tokenUsd, type FeeGasReading } from '@/services/fee-warning';
import { lifiScanUrl } from '@/services/lifi-scan';
import { View, Text, Pressable, Platform, useWindowDimensions, TextInput, Animated, Easing, Linking, ScrollView } from 'react-native';
import type { ViewStyle, TextStyle } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { resolveConfiguredEntrypoint } from '@/services/pool-entrypoint';
import { useAccount, useBalance, useSendTransaction, useSignTypedData, usePublicClient, useReadContract, useSwitchChain, useEstimateFeesPerGas, useConfig } from 'wagmi';
import { getPublicClient, getCallsStatus, getCapabilities, sendCalls } from 'wagmi/actions';
import { encodeFunctionData, erc20Abi, parseUnits, formatUnits } from 'viem';
import type { Address as ViemAddress, Hex } from 'viem';
import { Colors } from '@/constants/theme';
import { depositCardMaxHeight, shouldUseRoomyDepositLayout } from '@/services/deposit-layout';
import { useTheme } from '@/components/theme-provider';
import { useToast } from '@/components/toast-provider';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { useRequireConnection } from '@/hooks/use-require-connection';
import { sanitizeAmountInput } from '@/services/token-amount';
import { formatUsdPrecise } from '@/services/format-fiat';
import { useDebug } from '@/components/debug-provider';
import { useTxActivity } from '@/components/tx-activity-provider';
import { useLatchedWhile } from '@/hooks/use-latched-while';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { useAccountRecoveryModal } from '@/components/account-recovery-modal-provider';
import { getExplorerName, getExplorerTxUrl, getChainConfig, isChainSelectable, supportedChainIds, STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { STELLAR_TESTNET_CONTRACTS, STELLAR_XLM } from '@/config/stellar-deployment';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { useStellarBalance } from '@/hooks/use-stellar-balance';
import { describeStellarStage, stellarErrorMessage } from '@/services/stellar/stellar-copy';
import { StellarLabelRetryNotice } from '@/components/stellar-label-retry';
import { isStellarAccountAddress } from '@/services/stellar/stellar-request';
import type { PendingLabel } from '@/services/stellar/stellar-account';
import { recordOutgoingDeposit } from '@/services/outgoing-deposits-store';
import { recordSentAuditsVerified, dropSentAudits } from '@/services/audit-store';
import { UNSAVED_CLAIM_WARNING } from '@/services/unsaved-claim-warning-copy';
import { buildBlindDepositBackup, webRandomFill, type BlindDepositBackupResult } from '@/services/blind-deposit-backup';
import { commitmentKey, swapDepositRecipient, type BlindSwapRecipientInput, type BuiltClaimNote } from '@/services/swap-deposit-recipient';
import { buildSentReceiptUrl, previewNoteReceiptUrl } from '@/services/note-receipt';
import { recordOwnAction } from '@/services/own-actions-store';
import { recordShieldSwap } from '@/services/swap-bookkeeping';
import { recordSwap } from '@/services/swap-records-store';
import { pendingDepositRow, swapDepositPendingAsset } from '@/services/feed-reconciliation';
import { addPendingOwnRow, removePendingOwnRow } from '@/services/pending-own-rows-store';

/** Refusal when the recipient has no viewing key on this chain (depositFor). */
const RECIPIENT_UNREGISTERED_MESSAGE =
  'That address is not registered with Privacy Pools on this network yet, so it could not find this deposit. Ask them to register first. Nothing was sent.';

/** Lowercase the optional recipient; empty, malformed, zero or self = ordinary deposit. */
function normalizeDepositRecipient(raw: string | undefined, owner: string | null | undefined, stellar = false): string | null {
  // A Stellar account is case-sensitive base32: kept exactly as typed.
  if (stellar) {
    const g = raw?.trim();
    if (!g || !isStellarAccountAddress(g) || g === owner) return null;
    return g;
  }
  const v = raw?.trim().toLowerCase();
  if (!v || !/^0x[0-9a-f]{40}$/.test(v) || v === '0x0000000000000000000000000000000000000000') return null;
  if (owner && v === owner.toLowerCase()) return null;
  return v;
}

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

/** A route's informational USD figure; anything not a positive number is unknown. */
function usdFigure(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Tri-state recipient precheck for "Deposit to another address". 'unregistered'
 * only when the answer is definitive (ASP registry cache, or the chain returned
 * the zero key); a failed lookup is 'unknown' so a network blip never reads as
 * "the recipient is not set up". The SDK repeats the authoritative on-chain
 * check inside prepareDepositFor right before proving.
 */
export async function checkRecipientRegistration(
  chainId: number,
  recipient: ViemAddress,
): Promise<'registered' | 'unregistered' | 'unknown'> {
  const cfg = getChainConfig(chainId);
  if (!cfg?.contracts) return 'unknown';
  try {
    const sdkSetup = await import('@/services/sdk-runtime');
    const { lookupViewingKey } = await import('@/services/viewing-key-cache');
    const rpc = sdkSetup.createRPCInteractor(chainId, Number(cfg.contracts.fromBlock));
    const ks = sdkSetup.createKeystoreInteractor(
      rpc,
      cfg.contracts.keystoreAddress as ViemAddress,
      cfg.contracts.keystoreFromBlock,
    );
    const result = await lookupViewingKey(
      chainId,
      recipient,
      { getViewingKey: (a) => ks.getViewingKey(a) },
      { keystoreAddress: cfg.contracts.keystoreAddress },
    );
    if (result.viewingKey) return 'registered';
    // The ASP registry answered (after a full re-pull on a miss, inside
    // lookupViewingKey): that is the verdict. Confirming a miss on the pool
    // RPC would name this recipient to the provider as the user types.
    if (result.source === 'cache' && result.aspAvailable) return 'unregistered';
    // Only reached with no ASP registry: the RPC answered, or it failed.
    return result.lookupFailed ? 'unknown' : 'unregistered';
  } catch {
    return 'unknown';
  }
}
import { useChainRouter } from '@/hooks/use-chain-router';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { useOpLock } from '@/hooks/use-op-lock';
import { getDepositableTokens, getDepositComingSoonTokens, getKnownTokenMetadata, getTokenMetadataBySymbol, type TokenMetadata } from '@/config/tokens';
import { comingSoonDepositMessage, displayTokenSymbol } from '@/services/share-display';
import { useSuiSession } from '@/hooks/use-sui-session';
import { SUI_SUPPORTED_TOKENS } from '@/config/sui-tokens';
import { useSuiClientQuery } from '@mysten/dapp-kit';
import { ChainLogo, chainLogoChainFor } from '@/components/ui/chain-logo';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { TokenSelectSheet } from '@/components/ui/token-select-sheet';
import { FlowProgress } from '@/components/ui/flow-progress';
import { useAllChainsPriceMap, usePriceFeedsSettled } from '@/hooks/use-all-chains-price-map';
import apiClient from '@/services/api-client';
import { invalidateTransactionCaches } from '@/services/cache';
import { NoteStatus, type Note, type PoolSession, type YieldDeployment } from '@/services/sdk-types';
import { getConfiguredNativeYieldDeployment, getConfiguredYieldDepositDeploymentForUnderlying, getConfiguredYieldDeploymentForAsset, getNativeYieldDepositDeployment, getYieldDepositDeploymentForUnderlying, getYieldDeploymentsForChain, VAULT_DEPOSITS_PAUSED_MESSAGE, YIELD_APY_PERCENT, YIELD_OPT_OUT_FEE, yieldDepositsPaused, yieldOptOutFeeActive } from '@/config/yield';
import { PP_ROUTER_QUOTE_ABI, toYieldDepositFor } from '@/services/yield-deposit-for';
import { toNativeYieldDeposit } from '@/services/yield-native-deposit';
import { useYieldVaultProbeVersion } from '@/hooks/use-yield-vault-probe';
import { useRelayerAssetSupport } from '@/hooks/use-relayer-asset-support';
import { fetchRelayerAssetAddresses, RelayerUnavailableError, relayerAssetSupport, relayerShareExitMessage } from '@/services/relayer-assets';
import { computeDepositTotal } from '@/services/yield-math';
import { YieldBlock, YieldCostRow } from '@/components/yield/yield-block';
import { useTabCloseGuard } from '@/hooks/use-tab-close-guard';
import { LinkLeaveConfirm } from '@/components/ui/link-leave-confirm';
import { CLAIM_LINK_INSTRUCTION, CLAIM_LINK_LEAVE, needsLeaveConfirm } from '@/services/link-leave-guard';
import { crossChainSwapDepositSupported, swapDepositEnabledForChain } from '@/config/intent-swaps';
import { createWagmiWalletInteractor } from '@/services/wallet-interactor';
import {
  DEPOSIT_GAS_BUDGET,
  maxShieldAmountWei,
  nativeDepositGasReserveWei,
  priceWalletTx,
  walletTxFields,
  type FeeReadClient,
} from '@/services/wallet-tx-fees';
import {
  BRIDGE_POLL_INTERVAL_MS,
  BRIDGE_POLL_MAX_MS,
  bridgePollIntervalFor,
  bridgeResyncDue,
  describeSwapStatus,
  bridgeDeliveryOutcome,
  formatAmountText,
  isTerminalSwapStatus,
  runSwapAndDeposit,
  SwapDepositPreflightError,
  UnexpectedSwapTxError,
  type SwapDepositDisplay,
  type SwapDepositRecipient,
  type SwapDepositSessionLike,
  type SwapStatusLike,
  type SentApprovalRecord,
} from '@/services/swap-flows';
import { CopyIconButton } from '@/components/ui/copy-address';
import { withoutStrandedPendingNote } from '@/services/pending-note-cleanup';
import { loadStoredAccountExport, saveStoredAccountExport } from '@/components/sdk-provider';
import { isNoRouteError } from '@/services/intent-swaps';
import {
  approvalErrorAllowsZeroReset,
  validatePreparedYieldDeposit,
  yieldApprovalValues,
  yieldExitDisclosure,
  isCapBelowQuoteError,
  isExpiredYieldQuoteError,
  sizeWrapDeposit,
  YIELD_QUOTE_EXPIRED_MESSAGE,
} from '@/services/yield-deposit-safety';
import { conversionDepositTarget, intentTargetRefusal, targetAcceptsConversion } from '@/config/intent-targets';
import { useNativeMockBlock } from '@/hooks/use-native-mock-block';

// react-native-web supports CSS properties (position:'fixed', backdropFilter, outlineStyle)
// that are absent from React Native's ViewStyle/TextStyle type definitions.
// These typed constants apply web-only styles without `as any`.

/** `Error(string)` — the ABI-encoded revert-reason selector. */

/**
 * Split an `eth_call` failure into "the node ran it and the EVM reverted" and
 * "the call could not be performed at all" (code review 2026-08-27).
 *
 * The distinction is the whole point. A revert is the node's verdict on this
 * exact transaction, so refusing to broadcast is right. A transport failure
 * says nothing about the transaction, and treating it as a revert would block
 * a perfectly good deposit — the public OP endpoint answers 429 to ordinary
 * session traffic (QA 2026-08-20, see config/staging-deployments.ts). This is
 * the same "unreachable is not refused" split services/transfer-outcome.ts
 * draws for transfers, where collapsing the two was a money bug twice.
 *
 * viem wraps a reverting eth_call as CallExecutionError → ExecutionRevertedError
 * → RpcRequestError{ code: 3, data }, so a `code === 3` (or ExecutionRevertedError)
 * node anywhere in the cause chain, or raw revert bytes, is the execution
 * signal; a 429, timeout or dropped socket arrives as HttpRequestError /
 * TimeoutError / a non-3 RPC code and carries neither.
 */
function classifySimulationFailure(err: unknown): { executionReverted: boolean; detail: string } {
  const e = err as { data?: unknown; walk?: (fn: (node: unknown) => boolean) => unknown };
  const withData = e.walk?.((node) => typeof (node as { data?: unknown })?.data === 'string');
  const raw = (withData as { data?: string } | null | undefined)?.data
    ?? (typeof e.data === 'string' ? e.data : undefined);
  const revertNode = e.walk?.((node) => {
    const n = node as { code?: unknown; name?: unknown };
    return n?.code === 3 || n?.name === 'ExecutionRevertedError';
  });
  // Raw bytes alone count only when there is something in them: a bare '0x'
  // from a transport-shaped error must not read as a revert.
  const executionReverted = Boolean(revertNode)
    || (typeof raw === 'string' && raw.startsWith('0x') && raw.length > 2);
  return {
    executionReverted,
    detail: executionReverted
      ? decodeRevertPayload(raw)
      : (err instanceof Error ? err.message.split('\n')[0] : String(err)),
  };
}

/**
 * Did this eth_call fail because the node would not apply the state override,
 * rather than because the transaction reverted?
 *
 * Only a real execution revert is a verdict on the route. A refused override
 * argument, a timeout, a rate limit and a dropped socket all arrive without
 * the revert signal, and every one of them has to send the flow back to the
 * approve-first fallback instead of condemning a route that may be fine. So
 * the question is answered the safe way round: anything that is not provably a
 * revert counts as unsupported.
 */
function isUnsupportedOverrideError(err: unknown): boolean {
  return !classifySimulationFailure(err).executionReverted;
}

// --- Token Configuration ---

/** DEV-566: re-reads of a stale "not registered" before the deposit asks to register. */
const DEPOSIT_AUTH_LAG_RETRIES = 2;
const DEPOSIT_AUTH_LAG_RETRY_MS = 1_500;
const NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  isNative: boolean;
}

const SUPPORTED_TOKENS: TokenInfo[] = [
  { symbol: 'ETH', address: NATIVE_ASSET_ADDRESS, decimals: 18, isNative: true },
  { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6, isNative: false },
  { symbol: 'USDT', address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0', decimals: 6, isNative: false },
];

// Quick-amount presets shown as tappable chips under the amount input.
// Native (ETH) vs stablecoins (USDC/USDT). Display is K-abbreviated.
export const QUICK_AMOUNTS_NATIVE = ['0.1', '1', '5', '10', '100'];
export const QUICK_AMOUNTS_STABLE = ['100', '1000', '5000', '10000', '100000'];
const formatQuickAmount = (v: string) => {
  const n = Number(v);
  return n >= 1000 ? `${n / 1000}K` : v;
};

export const TOKEN_NAMES: Record<string, string> = {
  ETH: 'Ether',
  BNB: 'BNB',
  USDC: 'USD Coin',
  USDT: 'Tether USD',
  SUI: 'Sui',
};

// Configured Sui assets in the shared TokenInfo shape (the EVM `address` slot
// holds the Move coin type, e.g. "0x2::sui::SUI"). The Sui deposit modal selects
// from these instead of the EVM list, so a user can only pick a coin type the
// pool actually supports. Currently just native SUI.
const SUI_TOKEN_INFOS: TokenInfo[] = SUI_SUPPORTED_TOKENS.map((t) => ({
  symbol: t.symbol,
  address: t.typeArg,
  decimals: t.decimals,
  isNative: t.isNative,
}));

// Stellar: native XLM only, addressed by its Stellar Asset Contract id.
const STELLAR_TOKEN_INFOS: TokenInfo[] = [{
  symbol: STELLAR_XLM.symbol,
  address: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId,
  decimals: STELLAR_XLM.decimals,
  isNative: true,
}];





/**
 * The SDK yield namespace that serves `deployment`. With v2-monorepo #397 the
 * session answers `yieldFor(share)`; before it, `session.yield` is the chain's
 * FIRST deployment and nothing says which. Using it for a second share (USDC
 * typed, ppUSDT namespace) would wrap the wrong asset, so on an older SDK the
 * yield path is only taken when the chain has exactly one verified deployment,
 * or the namespace names the share itself.
 */
function resolveYieldNamespace(
  session: PoolSession,
  deployment: YieldDeployment,
  chainId: number,
): NonNullable<PoolSession['yield']> {
  const share = deployment.ppUSDC.toLowerCase();
  const byToken = session.yieldFor?.(deployment.ppUSDC);
  if (byToken) return byToken;
  const first = session.yield;
  if (!first) throw new Error('Yield deployment is configured but the session has no yield module.');
  const firstShare = first.deployment?.ppUSDC?.toLowerCase();
  if (firstShare === share) return first;
  if (firstShare === undefined && getYieldDeploymentsForChain(chainId).length === 1) return first;
  throw new Error(`This build cannot deposit ${displayTokenSymbol(deployment.underlyingSymbol)} into its yield pool yet: the SDK serves one yield asset per chain. Nothing was sent.`);
}

/**
 * Why a requested asset cannot be shielded here, in the asset's own name. A
 * withdraw-only legacy asset (prod plain USDC) gets the honest reason and the
 * way out; anything else the catalog lacks gets the plain refusal.
 */
function cannotShieldMessage(options: { tokenSymbol?: string; tokenAddress?: string }, chainId: number): string {
  const meta = (options.tokenAddress ? getKnownTokenMetadata(options.tokenAddress, chainId) : undefined)
    ?? (options.tokenSymbol ? getTokenMetadataBySymbol(options.tokenSymbol, chainId) : undefined);
  const symbol = meta?.symbol ?? options.tokenSymbol ?? 'That token';
  // Vault deposits are paused (EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED): the share,
  // its underlying and a native coin with a vault route all say so, before the
  // "not verified yet" and "coming soon" readings below.
  if (meta?.depositPaused) return VAULT_DEPOSITS_PAUSED_MESSAGE;
  // A yield share whose vault is not verified yet: the deposit is paid in the
  // underlying through the PPRouter, and that route only opens once the vault
  // has been checked on chain. Say so, and that it is a wait, not a refusal.
  if (meta?.yieldShare) {
    // displayTokenSymbol, never the share's own name: no prose names the share
    // (Pat, 2026-09-12).
    return `Deposits into ${displayTokenSymbol(symbol)} are unavailable until the vault is verified. Try again shortly.`;
  }
  // Not open YET (mainnet ETH) — the pool exists and will take deposits, so
  // this is a date, not a refusal. Named with its chain because the same asset
  // is open on other chains in this build.
  if (meta?.depositComingSoon) {
    return comingSoonDepositMessage(symbol, getChainConfig(chainId)?.displayName);
  }
  return meta?.withdrawOnly
    ? `Deposits of ${symbol} are closed on this network. Withdraw or send your shielded ${symbol} instead.`
    : `${symbol} can't be shielded on this network.`;
}

/**
 * The deposit asset for an open. Returns null when the caller NAMED an asset
 * the depositable catalog does not have: the old fallback to catalog[0] (ETH)
 * let a card showing "10 USDC" run the provider on 10 ETH, so the launch cap
 * refused it as "$100 (about 0.0407 ETH)" (Pat, 2026-09-04). A provider must
 * never price, cap or deposit a different asset than the card shows.
 */
function resolveSupportedToken(options: { tokenSymbol?: string; tokenAddress?: string } | undefined, chainId: number): TokenInfo | null {
  // Resolve against the ACTIVE chain's catalog (codex round 2): the static
  // Sepolia SUPPORTED_TOKENS meant an inline mainnet/OP USDC intent stored a
  // Sepolia address that the chain-validity effect then never matched — the
  // primed deposit either stalled forever or targeted the wrong contract.
  const catalog: TokenInfo[] = getDepositableTokens(chainId).map((t) => ({
    symbol: t.symbol,
    name: t.symbol,
    address: t.address,
    decimals: t.decimals,
    isNative: t.isNative,
  }));
  const fallback = catalog[0] ?? SUPPORTED_TOKENS[0];
  if (!options) return fallback;

  const requestedSymbol = options.tokenSymbol?.toUpperCase();
  const requestedAddress = options.tokenAddress?.toLowerCase();
  if (!requestedSymbol && !requestedAddress) return fallback;

  const match = catalog.find((token) => (
    (requestedSymbol && sameSymbol(token.symbol, requestedSymbol))
    || (requestedAddress && token.address.toLowerCase() === requestedAddress)
  ));
  if (!match) return null;
  // A yield SHARE named as the deposit asset (the pool page opens the modal
  // with its pool symbol, ppUSDC) is deposited as its UNDERLYING: the router
  // wraps USDC on the way in and no wallet holds ppUSDC, so resolving the
  // share literally read a 0 ppUSDC wallet balance and refused every mainnet
  // USDC deposit (Matthew, prod, 2026-09-05). services/shield-pools.ts holds
  // the rule; the result is re-found in the catalog so the modal keeps working
  // on catalog entries only.
  // The FULL registry entry, not the TokenInfo projection: the projection drops
  // `yieldShare`, and that flag is how a share with no configured route at all
  // is recognised — that one still resolves to null and the open is refused,
  // rather than stored as the payment token where nothing re-resolves it
  // (codex P2 on 7421944).
  //
  // CONFIGURED, not vault-verified (Pat, 2026-09-12): a configured share
  // resolves to its UNDERLYING, which is what the wallet actually holds, so
  // the bug that comment guards against cannot come back through this door.
  // Refusing the open until the probe answered just moved the dead end
  // earlier. The deposit itself still re-reads the verified gate at send time.
  const paid = resolveDepositPayAsset(
    getKnownTokenMetadata(match.address, chainId)
      ?? { symbol: match.symbol, address: match.address, decimals: match.decimals, isNative: match.isNative },
    chainId,
    getConfiguredYieldDeploymentForAsset,
    getKnownTokenMetadata,
  );
  if (!paid) return null;
  return catalog.find((token) => token.address.toLowerCase() === paid.address.toLowerCase()) ?? null;
}


// --- Icons ---





// --- Context ---

/** Read-only view of the deposit flow for INLINE hosts (the home action
 *  hub). All state and orchestration stay in this provider; an inline host
 *  is presentation only — the same handlers the modal drives, without the
 *  modal chrome. */
export type DepositFlowView = {
  step: 'deposit' | 'loading' | 'success';
  loadingMessage: string;
  depositError: string | null;
  depositAmountFormatted: string;
  txHash: string | null;
  explorerUrl: string;
  /** True while an inline (no-modal) deposit owns its host widget. */
  inlineActive: boolean;
  /** The one-time claim link when this deposit went to an UNREGISTERED
   *  recipient. Nothing on chain announces that note, so a host that shows a
   *  success state without offering this leaves the money unreachable - and
   *  must not tell the user the recipient will discover it. Null otherwise. */
  claimReceiptUrl: string | null;
  /** Stellar only: the deposit landed but its ASP registration did not, so it
   *  cannot be approved until that is re-sent. Null when nothing is owed. */
  stellarLabelRetry: { retry: () => Promise<boolean> } | null;
  /** The claim link was copied this session: leaving no longer asks (DEV-491). */
  claimLinkCopied: boolean;
  /** Copies the claim link; resolves whether the copy landed. */
  copyClaimLink: () => Promise<boolean>;
  /** Runs `leave` now, or after "Did you copy the claim link?" while it is uncopied. */
  guardClaimLeave: (leave: () => void) => void;
  /** Lowercase recipient when this deposit is FOR another address (depositFor), else null. */
  recipientAddress: string | null;
  /** Flow-1 ("Deposit from") route-cost line, once the quote exists. */
  swapRouteEstimate: string | null;
  /** Destination chain's name when this deposit shields into a pool on ANOTHER
   *  chain. The note lands there, not in the balance the user is looking at, so
   *  the settled state has to say where it went. Null for same-chain. */
  crossChainDestination: string | null;
  /** Live bridge-delivery state for a settled cross-chain shield. */
  bridgeProgress: {
    tone: 'pending' | 'done' | 'failed';
    text: string;
    explorerUrl?: string;
    /** LI.FI Scan for the source tx (services/lifi-scan.ts), there from the first second of the wait. */
    lifiScanUrl?: string;
  } | null;
  /** Flow-1 consent gate: quoted figures + the parked promise's resolvers.
   *  The modal renders its own card; inline hosts (the hub) render this —
   *  without it a desktop inline swap-deposit would hang on the promise
   *  with no visible way to answer it. */
  swapConsent: {
    inputAmountText: string;
    inputAmountUSD: string | null;
    depositAmountText: string;
    durationText: string | null;
    needsApproval: boolean;
    paySymbol: string;
    accept: () => void;
    decline: () => void;
  } | null;
  /** Unsaved-claim warning gate for a blind deposit whose claim link this
   *  browser could not store. Inline hosts must render it for the same reason
   *  as swapConsent. Copy: services/unsaved-claim-warning-copy.ts. */
  storageConsent: {
    accept: () => void;
    decline: () => void;
  } | null;
};

type DepositModalContextType = {
  openDepositModal: (options?: { tokenSymbol?: string; tokenAddress?: string; initialAmount?: string; recipientAddress?: string }) => void;
  closeDepositModal: () => void;
  /** Whether the modal is currently shown — consumed by the URL bridge. */
  isOpen: boolean;
  /** Run the whole deposit INLINE (desktop action hub): primes token/amount
   *  through the same gates as openDepositModal, then goes straight to
   *  confirm — no modal, no review step. */
  startInlineDeposit: (options: {
    tokenSymbol?: string;
    tokenAddress?: string;
    initialAmount?: string;
    payTokenAddress?: string;
    /**
     * A pay token OUTSIDE this chain's known catalog: a wallet holding the
     * catalog does not list, or an address the user pasted.
     *
     * Everything about the pay token was scoped to getActionableTokens, so
     * "swap + deposit with a non-pool pay token" only ever worked for catalog
     * assets that happened not to be the destination. Anything else (LINK, a
     * pasted address) was refused, then silently cleared (QA B-c).
     *
     * The caller resolves symbol/decimals on chain and vouches for it here; the
     * swap leg downstream only needs those fields and never pool membership.
     */
    payTokenExternal?: { symbol: string; address: string; decimals: number; isNative?: boolean; sourceChainId: number };
    /**
     * Shield into a pool on ANOTHER chain, paying from the wallet's current
     * chain (cross-chain flow 1). Honoured only for pairs
     * crossChainSwapDepositSupported approves; anything else falls back to an
     * ordinary same-chain deposit rather than silently changing chains.
     */
    poolChainId?: number;
    /**
     * The destination pool's vetting fee, as the caller read it from that
     * chain's Entrypoint. For the fee estimate only: this chain's Entrypoint
     * does not price a deposit landing elsewhere.
     */
    poolVettingFeeBps?: number;
    /** Shield FOR another, registered EVM address (SDK depositFor, path B).
     *  The note belongs to them; this wallet only pays. Self/empty = ordinary. */
    recipientAddress?: string;
  }) => void;
  /** Leave inline mode (dismiss the progress/success panel in the host). */
  resetInlineDeposit: () => void;
  flow: DepositFlowView;
};

function missingProvider(): never {
  throw new Error('useDepositModal must be used within a DepositModalProvider');
}

const DEFAULT_FLOW: DepositFlowView = {
  step: 'deposit',
  loadingMessage: '',
  depositError: null,
  depositAmountFormatted: '',
  claimReceiptUrl: null,
  stellarLabelRetry: null,
  claimLinkCopied: false,
  copyClaimLink: async () => false,
  guardClaimLeave: (leave) => leave(),
  txHash: null,
  explorerUrl: '',
  inlineActive: false,
  recipientAddress: null,
  swapRouteEstimate: null,
  crossChainDestination: null,
  bridgeProgress: null,
  swapConsent: null,
  storageConsent: null,
};

const DepositModalContext = createContext<DepositModalContextType>({
  openDepositModal: missingProvider,
  closeDepositModal: missingProvider,
  isOpen: false,
  startInlineDeposit: missingProvider,
  resetInlineDeposit: missingProvider,
  flow: DEFAULT_FLOW,
});

export function useDepositModal() {
  return useContext(DepositModalContext);
}

// --- Provider ---

export function DepositModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const isDark = colorScheme === 'dark';
  const { width, height } = useWindowDimensions();
  const isMobile = width <= 540;
  // On a phone the modal presents as a bottom sheet.
  const isSheet = isMobile;
  // Roomy (minHeight 560) input card only when BOTH dimensions clear their
  // thresholds — a width-only check clipped short/landscape viewports
  // (844×390, 580×500) with overflow hidden and no scroll (codex P2).
  const isRoomy = shouldUseRoomyDepositLayout(width, height);
  const { log, isDebugEnabled } = useDebug();
  const { beginTx, endTx, txPending } = useTxActivity();
  const { openKeystoreRegistrationModal } = useKeystoreRegistrationModal();
  const queryClient = useQueryClient();
  const { openExportNotesModal } = useAccountRecoveryModal();

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
  const withOpLock = useOpLock();
  // Chain FROZEN at submission — explorer links must not follow a later
  // app-chain switch (codex round 3, P2).
  const [txChainId, setTxChainId] = useState<number | null>(null);
  // Sui routing: when the active app chain is Sui, deposits run the Sui session
  // (witness -> proof -> entrypoint::deposit + note persistence) instead of the
  // wagmi/EVM path below. `useChainRouter` reflects the header chain selection,
  // independent of wagmi's chain id.
  const { isSui: isSuiChain, isStellar, activeChain, selectChain, getExplorerUrl: getSuiExplorerUrl } = useChainRouter();
  // "Not an EVM chain": every EVM-only path below (wagmi balances, fee reads,
  // cross-chain, swaps, yield, depositFor) is off on Sui and Stellar alike.
  // Where the two differ (asset list, balance, submit) they branch explicitly.
  const isSui = isSuiChain || isStellar;
  // The prod $ launch cap guards real-value pools. Stellar is testnet XLM with
  // no USD price, so the cap would only ever read "can't check": uncapped,
  // exactly like the staging world.
  const depositCapUsd = isStellar ? undefined : ACTIVE_ENVIRONMENT.maxDepositUsd;
  const suiSession = useSuiSession();
  const stellarSession = useStellarSession();
  const stellarOwner = isStellar && stellarSession.wallet.isConnected ? stellarSession.wallet.address : null;
  const { data: stellarBalanceData } = useStellarBalance(stellarOwner);
  const chainConfig = getChainConfig(chainId);
  const chainDisplayName = isSui
    ? (activeChain?.displayName ?? (isStellar ? 'Stellar' : 'Sui'))
    : (chainConfig?.displayName ?? `Chain ${chainId}`);
  const { address: connectedAddress, chainId: walletChainId, connector } = useAccount();
  const ensureConnected = useRequireConnection();
  // Key gate: actions that need the derived keys prompt for the one-time
  // signature on demand (the modal no longer auto-opens on connect). Read
  // through a ref so the onSigned continuation re-enters with fresh state.
  const { keysReady, identityMode, sessionAddress } = usePoolSession();
  // Key-precedence deposits: the session (account key) OWNS the deposit;
  // the connected wallet only pays for it. Surface that explicitly.
  const keyOwnedDeposit = identityMode === 'key';
  const depositOwnerAddress = (sessionAddress ?? connectedAddress) as `0x${string}` | undefined;
  const keysReadyRef = useRef(keysReady);
  keysReadyRef.current = keysReady;
  const { openSeedDerivationModal } = useSeedDerivationModal();
  const { sendTransactionAsync } = useSendTransaction();
  const wagmiConfig = useConfig();
  // Keep unresolved wallet broadcasts when the modal closes or a run throws.
  // A different account, chain or input token must never inherit these rows.
  const swapApprovalRecoveryRef = useRef(new Map<string, SentApprovalRecord[]>());
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId });
  // Every wallet send in this flow goes out with the shared fee policy
  // (services/wallet-tx-fees.ts, DEV-542), read from this app's RPC for the
  // tx's own chain: estimated gas + 20%; EIP-1559 tip = max(node tip, chain
  // floor) and maxFee = 2 x base fee + tip; legacy chains (BNB) gasPrice.
  // Left unpriced, wallets on a quiet Ethereum asked ~18x the real fee.
  // `stillLive` runs after the pricing await, so a run closed meanwhile
  // never opens a wallet prompt.
  const sendWalletTx = useCallback(
    async (
      tx: { chainId: number; to: ViemAddress; data: Hex; value: bigint },
      fallbackGas?: bigint,
      stillLive?: () => void,
    ) => {
      const client = connectedAddress
        ? (getPublicClient(wagmiConfig, { chainId: tx.chainId }) as unknown as FeeReadClient | undefined)
        : undefined;
      const plan = connectedAddress
        ? await priceWalletTx(client, { account: connectedAddress as ViemAddress, to: tx.to, data: tx.data, value: tx.value }, fallbackGas, tx.chainId)
        : null;
      stillLive?.();
      return sendTransactionAsync({ ...tx, ...walletTxFields(plan) });
    },
    [connectedAddress, wagmiConfig, sendTransactionAsync],
  );
  const {
    poolSession,
    noteManager,
    isInitialized: sdkReady,
    error: sdkError,
    ensureInitialized,
    exportAccount,
    getCommittedManagers,
    refreshNotes,
    assertCanDeposit,
    createCrossChainShieldSession,
  } = usePoolSession();

  // The review step is gone: the form shows the full cost picture inline and
  // its CTA goes straight to confirm (feat/ui-overhaul UX).
  const [step, setStep] = useState<'deposit' | 'loading' | 'success'>('deposit');
  // Route the provider currently sits on — the inline receipt is retired when
  // the user leaves the route it was launched from (see below).
  const pathname = usePathname();
  // Operation epoch (codex P1-5): bumped on open/close so a run that outlived
  // its modal session aborts before broadcasting and never writes the new
  // session's UI.
  const opEpochRef = useRef(0);
  // Inline (no-modal) presentation: the desktop action hub runs the same flow
  // in its own card. While true, the root modal never renders; the hub reads
  // `flow` and shows the progress/success panels itself.
  const [inlineActive, setInlineActive] = useState(false);
  // A primed inline confirm waiting for its token/amount state to commit —
  // handleConfirm reads provider state, so we can't call it in the same tick
  // that sets the state. The effect below fires once the render carrying the
  // primed values has committed.
  const pendingInlineConfirmRef = useRef<{ tokenAddress: string; amount: string; recipient: string | null } | null>(null);
  // The options of the latest inline launch, and a relaunch waiting for the
  // wallet to be on `chainId`. Registering on a cross-chain shield's
  // destination sends the wallet over there and back; the deposit then
  // relaunches from its original inputs, through the same gates as any
  // launch, instead of replaying the closure captured at the handoff.
  //
  // STATE, not a ref: setting it must itself cause the render that fires the
  // relaunch. A ref waited for whatever render came next (a poll, a balance
  // refresh) and popped a wallet prompt nothing on screen had asked for.
  // `inlineLaunchGenRef` is bumped by every new launch, reset, modal open and
  // navigation, so a relaunch parked before one of those is dropped instead of
  // landing on top of whatever the user started since.
  const lastInlineOptionsRef = useRef<Parameters<DepositModalContextType['startInlineDeposit']>[0] | null>(null);
  const inlineLaunchGenRef = useRef(0);
  const [pendingRelaunch, setPendingRelaunch] = useState<{
    chainId: number;
    gen: number;
    options: Parameters<DepositModalContextType['startInlineDeposit']>[0];
  } | null>(null);
  const cancelPendingRelaunch = useCallback(() => {
    inlineLaunchGenRef.current += 1;
    setPendingRelaunch(null);
  }, []);
  // Read through a ref inside async flows (the registration handoff) so a
  // continuation restores the surface that was actually active at handoff.
  const inlineActiveRef = useRef(false);
  inlineActiveRef.current = inlineActive;
  // "Deposit to another address" (SDK depositFor, path B): the recipient's
  // lowercase EVM address for THIS launch, or null for an ordinary deposit.
  // Mirrored in a ref because handleConfirm runs across async state commits.
  const [depositRecipient, setDepositRecipient] = useState<string | null>(null);
  const depositRecipientRef = useRef<string | null>(null);
  depositRecipientRef.current = depositRecipient;

  // Warn before the tab closes mid-deposit — approval/deposit txs are in
  // flight and the fresh note is not yet confirmed at that point.
  useTabCloseGuard(
    step === 'loading',
    'A deposit is in progress. Closing this tab may interrupt it before your balance is confirmed.',
  );

  const [amount, setAmount] = useState('');
  const [dollarValue, setDollarValue] = useState('$0.00');
  const [selectedToken, setSelectedToken] = useState<TokenInfo>(SUPPORTED_TOKENS[0]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // Swap-into-deposit (guide flow 1): pay with a wallet token that is NOT the
  // asset being shielded — the SDK swaps it through LiFi and deposits the
  // output in one transaction. null = the ordinary same-asset deposit, which is
  // every existing code path below. EVM-only. NOT gated on the RelaySwaps
  // processor: this flow is a direct wallet→LiFi transaction with no relayer,
  // so it only needs the master flag and two configured assets.
  const [payToken, setPayToken] = useState<TokenInfo | null>(null);
  // A caller-vouched pay token outside the catalog (see payTokenExternal).
  // Held separately so payTokenOptions can include it and the invalidation
  // effect below does not treat it as stale and null it out.
  const [externalPayToken, setExternalPayToken] = useState<TokenInfo | null>(null);
  // Destination pool chain when THIS launch is a cross-chain shield (pay token
  // on the wallet's chain, pool on another). Null = ordinary same-chain.
  const [crossChainPoolId, setCrossChainPoolId] = useState<number | null>(null);
  // Read only while it still names this launch's destination pool and asset.
  const [crossChainVetting, setCrossChainVetting] = useState<{ poolChainId: number; token: string; bps: number } | null>(null);
  // The confirm path reads the destination through this ref, not the state.
  // startInlineDeposit primes the confirm one tick after setCrossChainPoolId,
  // and the confirm callback is memoized — a launch that changes ONLY the
  // destination (same amount, same token objects as the previous one) would not
  // rebuild that callback, so the state it closed over would still name the
  // PREVIOUS destination and file the note against the wrong chain. A ref set
  // in the same synchronous call as the launch cannot be stale.
  const crossChainPoolIdRef = useRef<number | null>(null);
  const [payDropdownOpen, setPayDropdownOpen] = useState(false);
  // What the route says it will spend, filled in once the quote exists and
  // shown alongside the loading message — the wallet is about to ask for an
  // amount of the pay token the user never typed.
  const [swapRouteEstimate, setSwapRouteEstimate] = useState<string | null>(null);
  // The consent gate for a Pay-with route: holds the quoted figures plus the
  // resolver the flow is awaiting, so Continue/Cancel decide it. Nothing has
  // been signed while this is set.
  const [swapConfirm, setSwapConfirm] = useState<{
    display: SwapDepositDisplay;
    resolve: (approved: boolean) => void;
    /** The quoted route's own USD figures and the native fee it rides on top, for its fee breakdown. */
    route: { inputUsd: number | null; deliveredUsd: number | null; nativeFeeWei: bigint };
  } | null>(null);
  // The warning gate for a claim link THIS browser could not save: holds the
  // resolver the blind-deposit flow is awaiting, so Continue anyway / Cancel
  // decide it. Nothing has been signed while this is set. Same shape as the
  // Pay-with consent above, same closing rules (services/unsaved-claim-warning-copy.ts).
  const [storageConfirm, setStorageConfirm] = useState<{
    resolve: (approved: boolean) => void;
  } | null>(null);
  // The deposit modal is shared EVM/Sui. Offer only assets configured for the
  // active chain so a user can't select a coin type the Sui pool doesn't
  // support — and on multi-EVM builds, only THIS chain's canonical contracts
  // (depositing the Sepolia USDC address on mainnet targets a junk contract).
  const activeEvmChainId = chainId;
  // yieldProbeVersion: the catalog itself no longer waits on the probe, but a
  // verdict landing still changes what the FORM may do with a yield underlying
  // (the yield toggle, the send-time route), so the memo keeps the signal.
  const yieldProbeVersion = useYieldVaultProbeVersion();
  // Minus the yield SHARES. A share is never what a wallet pays with: the
  // PPRouter mints it from the underlying inside the deposit, and
  // resolveDepositPayAsset already turns a share-named open (the pool page
  // opens with ppUSDC) back into USDC. Listing both put TWO rows named "USDC"
  // in the picker - the share row bypassed that rule and selected a token no
  // wallet spends (Pat, 2026-09-12). One row per asset, and it is the one that
  // deposits. Generic: every share the yield table configures, on any chain.
  const availableTokens = useMemo<TokenInfo[]>(
    () => (isStellar ? STELLAR_TOKEN_INFOS : isSui ? SUI_TOKEN_INFOS : getDepositableTokens(activeEvmChainId).filter((t) => !t.yieldShare)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yieldProbeVersion is a change signal
    [isSui, isStellar, activeEvmChainId, yieldProbeVersion],
  );
  // Assets whose pool has not opened yet (mainnet ETH). Kept OUT of
  // availableTokens — nothing may select, price or deposit one — but listed in
  // the picker as a disabled "Available soon" row, because a user who came to
  // deposit ETH deserves the answer rather than a list that omits it.
  const comingSoonTokens = useMemo<TokenMetadata[]>(
    () => (isSui ? [] : getDepositComingSoonTokens(activeEvmChainId)),
    [isSui, activeEvmChainId],
  );
  // The selected asset belongs to the destination. Reconciling it against the
  // wallet chain can replace mainnet USDC with BNB or change USDT's decimals
  // while inline confirmation is waiting for prices. availableTokens remains
  // the wallet catalog because pay-token lookup must still use the source.
  useEffect(() => {
    const depositTokens = !isSui && crossChainPoolId !== null
      ? getDepositableTokens(crossChainPoolId).filter((t) => !t.yieldShare)
      : availableTokens;
    if (depositTokens.length === 0) return;
    // Resolve to the actual configured token for the deposit chain: match by
    // coin id (address / Move typeArg) first, then symbol — so we never keep a
    // stale token object whose shape (address/decimals) belongs to the other
    // chain. Matters once a Sui asset shares a symbol with an EVM one (e.g. USDC).
    const byAddress = depositTokens.find((t) => t.address === selectedToken.address);
    const bySymbol = depositTokens.find((t) => t.symbol === selectedToken.symbol);
    const configured = byAddress ?? bySymbol ?? depositTokens[0];
    // Which branch resolved the asset, and to what. The silent
    // `depositTokens[0]` fallback can substitute a DIFFERENT asset than the
    // user picked - and on the Sui list entry 0 is SUI, whose `address` slot
    // holds a Move coin type ("0x2::sui::SUI") that coerces to the EVM address
    // 0x0000…0002. That is exactly the id a failed USDC deposit reported
    // (AssetNotEnabled: 0x…02), so name the branch rather than guess again.
    try {
      console.log(
        `[perf] · deposit-token resolve isSui=${isSui} chain=${crossChainPoolId ?? activeEvmChainId}`
        + ` want=${selectedToken.symbol}/${selectedToken.address}`
        + ` via=${byAddress ? 'address' : bySymbol ? 'symbol' : 'FALLBACK[0]'}`
        + ` got=${configured.symbol}/${configured.address}`
        + ` available=[${depositTokens.map((t) => t.symbol).join(',')}]`,
      );
    } catch { /* diagnostics must never break the form */ }
    if (
      configured.address !== selectedToken.address
      || configured.symbol !== selectedToken.symbol
      || configured.decimals !== selectedToken.decimals
      || configured.isNative !== selectedToken.isNative
    ) {
      setSelectedToken(configured);
    }
  }, [availableTokens, selectedToken, isSui, crossChainPoolId]);
  // --- Swap-into-deposit (flow 1) availability ---

  // Not offered for key-owned deposits. There, the connected wallet is only the
  // PAYER while the session owner is the note owner — but prepareSwapAndDeposit
  // quotes LiFi with the session owner as `fromAddress` and checks that
  // address's allowance, while the tokens would come from the payer. The two
  // addresses disagree, so the route would be built against the wrong balance.
  // A cross-chain shield is enabled by the DESTINATION pool's swap outputs, not
  // the wallet chain's: what the wallet's chain declares for its OWN swaps says
  // nothing about whether it can pay into another chain's pool, so gating this
  // on swapDepositEnabledForChain(chainId) alone would refuse launches that
  // route perfectly well.
  // Can this destination take a converting or bridged deposit at all? Both end
  // in ONE deposit call on the pool's chain, and prod plain USDC accepts none:
  // it enters only through its direct PPRouter route. Asked HERE, where
  // the options are offered, rather than at confirm — the refusal used to come
  // after the amount, the route and the pay token were already chosen, and read
  // as nonsense to someone whose input was USDC already (Pat, 2026-09-12).
  // Asked about the pool the conversion would REACH, not the asset named on the
  // card: where that chain wraps the asset, that pool is the share and the
  // final leg is its router deposit. Asking about the underlying would keep
  // saying "closed" for a conversion that now lands. Paying from another chain
  // means the bridge executes the deposit, which a share's router takes and a
  // plain native coin cannot (services/entrypoint-only-route.ts).
  const targetTakesConversion = isSui
    || targetAcceptsConversion(
      getKnownTokenMetadata(
        conversionDepositTarget(selectedToken.address, crossChainPoolId ?? chainId, selectedToken.isNative),
        crossChainPoolId ?? chainId,
      ),
      crossChainPoolId ?? chainId,
      false,
      crossChainPoolId !== null && crossChainPoolId !== chainId,
    );
  const crossChainShieldActive = !isSui && !keyOwnedDeposit && targetTakesConversion
    && crossChainPoolId !== null
    && crossChainSwapDepositSupported(chainId, crossChainPoolId);
  const swapDepositAvailable = !isSui && !keyOwnedDeposit && targetTakesConversion
    && (swapDepositEnabledForChain(chainId) || crossChainShieldActive);
  /** Tokens that can PAY for a deposit of the selected asset. */
  const payTokenOptions = useMemo(
    () => {
      if (!swapDepositAvailable) return [];
      // Across chains the same asset is a legitimate pay token (bridging ETH
      // into the OP ETH pool); only WITHIN one chain is it a no-op that would
      // route an ordinary deposit through a pointless swap.
      const catalog = availableTokens.filter((t) => crossChainShieldActive
        || t.address.toLowerCase() !== selectedToken.address.toLowerCase());
      if (!externalPayToken) return catalog;
      // Same no-op rule applies to the vouched token.
      if (!crossChainShieldActive
        && externalPayToken.address.toLowerCase() === selectedToken.address.toLowerCase()) return catalog;
      return catalog.some((t) => t.address.toLowerCase() === externalPayToken.address.toLowerCase())
        ? catalog
        : [externalPayToken, ...catalog];
    },
    [swapDepositAvailable, crossChainShieldActive, availableTokens, selectedToken.address, externalPayToken],
  );
  const swapDepositActive = !!payToken
    && swapDepositAvailable
    && (crossChainShieldActive
      || payToken.address.toLowerCase() !== selectedToken.address.toLowerCase());
  // A pay token that stops being valid (chain switch, or it became the deposit
  // asset) must not linger — it would silently route an ordinary deposit
  // through a swap, or through a token this chain doesn't have.
  useEffect(() => {
    if (!payToken) return;
    if (!swapDepositAvailable
      || !payTokenOptions.some((t) => t.address.toLowerCase() === payToken.address.toLowerCase())) {
      setPayToken(null);
    }
  }, [payToken, swapDepositAvailable, payTokenOptions]);
  // A vouched token belongs to the chain it was resolved on. Keeping it across a
  // source-chain change would re-admit the previous chain's address/decimals.
  const vouchedChainRef = useRef<number | null>(null);
  useEffect(() => {
    if (externalPayToken && vouchedChainRef.current !== null && vouchedChainRef.current !== chainId) {
      setExternalPayToken(null);
      setPayToken(null);
    }
    vouchedChainRef.current = chainId;
  }, [chainId, externalPayToken]);

  // DEV-222: network selector — only the chains the ASP/app supports (Sepolia
  // for now). Data-driven off supportedChainIds so it grows automatically.
  const supportedNetworks = useMemo(
    () =>
      supportedChainIds
        // Sui testnet is debug-gated on production builds: keep it out of the
        // picker unless debug mode is on or the Sui session is already active.
        .filter((id) => isChainSelectable(id, isDebugEnabled) || id === chainId)
        .map((id) => ({ id, name: getChainConfig(id)?.displayName ?? `Chain ${id}` })),
    [isDebugEnabled, chainId],
  );
  const [txHash, setTxHash] = useState<string | null>(null);
  // Latched from the prepared route so a mid-flight probe change cannot make
  // the success screen forget that the note and its payout are share tokens.
  const [preparedYieldExitDisclosure, setPreparedYieldExitDisclosure] = useState<string | null>(null);
  // The one-time link a blind deposit's recipient needs. Success-screen only;
  // the durable copy is the audit disclosure, which the row menu rebuilds from.
  const [claimReceiptUrl, setClaimReceiptUrl] = useState<string | null>(null);
  // The deposit whose ASP registration is still owed, and the account that made it.
  const [stellarLabelPending, setStellarLabelPending] = useState<{ owner: string; item: PendingLabel } | null>(null);
  // DEV-491: the claim link is the recipient's only way to this deposit, so
  // leaving the success card before it was copied asks first. A new link
  // starts uncopied.
  const [claimLinkCopied, setClaimLinkCopied] = useState(false);
  useEffect(() => { setClaimLinkCopied(false); }, [claimReceiptUrl]);
  const [claimLeavePending, setClaimLeavePending] = useState<{ leave: () => void } | null>(null);
  const copyClaimLink = useCallback(async (): Promise<boolean> => {
    if (!claimReceiptUrl) return false;
    const { copyText } = await import('@/services/copy-text');
    const ok = await copyText(claimReceiptUrl);
    if (ok) setClaimLinkCopied(true);
    return ok;
  }, [claimReceiptUrl]);
  // Only on the success card: the link outlives it until the next confirm.
  const claimLinkAtRisk = step === 'success' && needsLeaveConfirm({ link: claimReceiptUrl, copied: claimLinkCopied });
  const guardClaimLeave = useCallback((leave: () => void) => {
    if (claimLinkAtRisk) setClaimLeavePending({ leave });
    else leave();
  }, [claimLinkAtRisk]);
  useTabCloseGuard(claimLinkAtRisk, `${CLAIM_LINK_LEAVE.title} ${CLAIM_LINK_LEAVE.body}`);
  const [depositError, setDepositError] = useState<string | null>(null);
  const { toast: errorToast } = useToast();
  // Every flow error ALSO surfaces as a destructive toast — visible even
  // when the inline error line is below the fold or the modal is closing.
  // The stage the running deposit last entered, and whether it took the yield
  // route. Written by handleConfirm as it goes, read by the reporter below.
  const depositErrorReportRef = useRef<{ phase: ErrorReportStage; isYield?: boolean }>({ phase: 'unknown' });
  const reportDepositError = useCallback((msg: string | null, cause?: unknown, stage?: string) => {
    setDepositError(msg);
    if (msg) errorToast({ title: msg, variant: 'destructive' });
    // The fact plus the failure CLASS, never the message itself: these strings
    // quote amounts, tokens, addresses and relayer responses, and the class is
    // a boolean that cannot. The values below ride in a separate bag that only
    // a staging build sends - services/error-reports.ts decides, not this line.
    if (msg) {
      reportErrorReport('deposit-failed', { testMode: TEST_MODE === true, ...classifyFailure(msg, cause) }, {
        ...(stage ? { stage } : {}),
        detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : msg,
        ...(depositOwnerAddress ? { address: depositOwnerAddress } : {}),
        ...(amount ? { amount } : {}),
        asset: selectedToken.symbol,
        chainId,
      }, undefined, {
        stage,
        phase: depositErrorReportRef.current.phase,
        error: cause,
        chainId,
        asset: selectedToken.symbol,
        isYield: depositErrorReportRef.current.isYield,
      });
    }
  }, [errorToast, depositOwnerAddress, amount, selectedToken, chainId]);
  const [loadingMessage, setLoadingMessage] = useState('Preparing deposit...');
  const [feeExpanded, setFeeExpanded] = useState(false);
  // Aave yield (flag-gated): deposits default INTO the yield pool; the user
  // opts out per deposit at review time (fixed once deposited). EVM-only.
  const [yieldOptIn, setYieldOptIn] = useState(true);
  // getYieldDeploymentForChain answers undefined until the vault is verified on
  // chain (services/yield-vault-probe.ts), and this provider mounts long before
  // that probe runs. Without the version in the deps this memo would freeze the
  // pre-probe answer for the life of the chain and could keep offering yield
  // for a vault the session had already refused. It re-evaluates the moment a
  // verdict is recorded.
  // Per ASSET, not per chain: mainnet carries ppUSDC and ppUSDT, and the
  // deployment that takes the user's USDC is the one whose underlying it is.
  // The native coin has its own route (ppETH): a NATIVE_MODE PPRouter takes
  // msg.value, wraps it to WETH itself and mints the share, so there is no
  // underlying ERC-20 to look the deployment up by and no approval to grant.
  // Until such a route is configured AND probed this is undefined, which is
  // exactly the behaviour native deposits had before ppETH existed.
  const yieldDeployment = useMemo(
    () => {
      if (isSui) return undefined;
      return selectedToken.isNative
        ? getNativeYieldDepositDeployment(chainId)
        : getYieldDepositDeploymentForUnderlying(chainId, selectedToken.address);
    },
    // yieldProbeVersion is read for its change signal, not its value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isSui, chainId, selectedToken.isNative, selectedToken.address, yieldProbeVersion],
  );
  /** This deposit funds the router with value instead of an ERC-20 approval. */
  const yieldIsNative = !!yieldDeployment && yieldDeployment.nativeMode === true && selectedToken.isNative;
  const yieldAvailable = !!yieldDeployment
    // Pay-with routes through prepareSwapAndDeposit, which returns BEFORE the
    // yield branch and produces an ordinary note. Leaving the toggle on-screen
    // and enabled would take a yield opt-in and silently ignore it.
    && !swapDepositActive;
  // Yield is NOT optional for an asset whose plain deposit is closed at the
  // Entrypoint (prod plain USDC is withdraw-only): opting out would send a
  // deposit that reverts. The toggle is not offered and the yield path is taken.
  // Same for the native coin on a chain whose build configures a native-mode
  // route (mainnet ETH → ppETH): the plain ETH pool is superseded, so opting
  // out would land the deposit in the legacy pool (Pat, 2026-09-18).
  const yieldForced = yieldAvailable
    && ((!selectedToken.isNative && !!getKnownTokenMetadata(selectedToken.address, chainId)?.withdrawOnly)
      || (selectedToken.isNative && getConfiguredNativeYieldDeployment(chainId) !== undefined));
  const yieldOn = yieldForced || yieldOptIn;
  // A share note's only exits (Withdraw, Send) go through the relayer. Until the
  // relayer lists the share, a yield deposit would be locked in, so it is
  // refused in words (services/relayer-assets.ts; prod relayer 2026-09-04:
  // "Asset … not found for chain 1"). Opens by itself once they add it.
  const shareExitSupport = useRelayerAssetSupport(yieldDeployment ? chainId : undefined, yieldDeployment?.ppUSDC);
  // Quiet while the first read is in flight: a "checking…" line on every yield
  // deposit read as a problem when there was none (Pat, 2026-09-04). The
  // confirm-time re-check below still refuses if the relayer does not list it.
  const yieldExitBlocked = yieldAvailable && yieldOn && !!yieldDeployment && shareExitSupport !== 'supported' && shareExitSupport !== 'checking'
    ? relayerShareExitMessage(shareExitSupport, displayTokenSymbol(yieldDeployment.underlyingSymbol.toUpperCase()))
    : null;
  const currentYieldExitDisclosure = yieldDeployment
    ? yieldExitDisclosure(displayTokenSymbol(yieldDeployment.underlyingSymbol.toUpperCase()))
    : null;
  // One visibility truth for the sheet: the classic modal open, OR the mobile
  // inline flow presenting its progress/success in the drawer.
  const sheetVisible = isOpen || (inlineActive && isMobile && (step === 'loading' || step === 'success'));
  // Entrance animation: on mobile the modal is a bottom drawer that slides up
  // from below; on desktop it fades/settles in place. Driven by the sheet's
  // visibility (not raw isOpen — the mobile-progress drawer kept opacity 0
  // and showed only the blurred backdrop).
  const sheetAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (sheetVisible) {
      sheetAnim.setValue(0);
      Animated.timing(sheetAnim, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    }
  }, [sheetVisible, sheetAnim]);

  // --- Balance Queries ---

  // Pause refetches while a tx is in flight — wagmi otherwise watches
  // new blocks aggressively and floods the RPC during the wait.
  // Balance is validated on the chain the funds are actually spent on — see
  // the `chainId` note above for why passing it explicitly matters here.
  // One constant for every wallet read in this modal, so the cadence an
  // observer sees never depends on what the user is doing.
  const DEPOSIT_BALANCE_POLL_MS = 30_000;

  // Whose reads these are: a wallet or chain switch mid-send must not leave the
  // latch showing the previous account's balance.
  const depositReadIdentity = `${connectedAddress ?? ''}:${chainId}:${selectedToken.address}`;

  // FIXED cadence, latched display. Note this site's gate was
  // `txPending ? false : undefined`, i.e. no timer either way, so it had no
  // silence window of its own — the interval is an addition, matching the
  // ERC-20 read below which genuinely needed one. The real pauses were the gas
  // poll and the `!txPending` enabled gates (one here, one in pools-provider),
  // and those did leak:
  // disabled for the transaction, then refetched the instant it settled, which
  // is a burst timed to the on-chain event (services/latched-value.ts).
  const { data: liveNativeBalance } = useBalance({
    address: connectedAddress,
    chainId,
    query: { refetchInterval: DEPOSIT_BALANCE_POLL_MS },
  });
  const nativeBalance = useLatchedWhile(liveNativeBalance, txPending, depositReadIdentity);

  const { data: liveErc20BalanceRaw } = useReadContract({
    address: selectedToken.address as ViemAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress] : undefined,
    chainId,
    // Data readiness only; the transaction gate moved to the latch below. The
    // interval is NOT optional: the `!txPending` flip this replaces was also the
    // only thing that refreshed this balance, so without a cadence a user who
    // spends their whole token balance keeps seeing the pre-spend figure and the
    // next deposit is built against it and rejected by the wallet.
    query: {
      enabled: !isSui && !selectedToken.isNative && !!connectedAddress,
      refetchInterval: DEPOSIT_BALANCE_POLL_MS,
    },
  });
  const erc20BalanceRaw = useLatchedWhile(liveErc20BalanceRaw, txPending, depositReadIdentity);

  // Sui native SUI balance (dapp-kit), used when the active chain is Sui.
  // NOTE: this queries/formats the *native* SUI balance only. It's correct while
  // SUI is the sole configured Sui asset (its decimals/symbol match the chain
  // native currency). When a non-SUI Sui coin is added, pass the selected token's
  // typeArg as `coinType` to getBalance and derive symbol/decimals from it.
  const suiOwner = suiSession.account?.address;
  const { data: suiBalanceData } = useSuiClientQuery(
    'getBalance',
    { owner: suiOwner ?? '' },
    { enabled: isSuiChain && !!suiOwner },
  );

  const suiDecimals = activeChain?.nativeCurrency.decimals ?? 9;
  const suiSymbol = activeChain?.nativeCurrency.symbol ?? 'SUI';

  const walletBalance = useMemo(() => {
    if (isStellar) {
      // Spendable = total minus the account reserve and a fee margin.
      if (!stellarBalanceData) return 0;
      return Number(formatUnits(stellarBalanceData.spendable, STELLAR_XLM.decimals));
    }
    if (isSui) {
      if (!suiBalanceData) return 0;
      return Number(formatUnits(BigInt(suiBalanceData.totalBalance), suiDecimals));
    }
    if (selectedToken.isNative) {
      if (!nativeBalance) return 0;
      return Number(formatUnits(nativeBalance.value, nativeBalance.decimals));
    }
    if (erc20BalanceRaw == null) return 0;
    return Number(formatUnits(erc20BalanceRaw as bigint, selectedToken.decimals));
  }, [isSui, isStellar, stellarBalanceData, suiBalanceData, suiDecimals, selectedToken, nativeBalance, erc20BalanceRaw]);

  const displaySymbol = isSui ? suiSymbol : selectedToken.symbol;
  // Balance source still loading → dash, not a false "0.0000".
  const walletBalanceLoading = isStellar
    ? stellarBalanceData == null
    : isSui
    ? suiBalanceData == null
    : selectedToken.isNative
      ? nativeBalance == null
      : erc20BalanceRaw == null;
  const walletBalanceFormatted = walletBalanceLoading ? '—' : `${walletBalance.toFixed(4)} ${displaySymbol}`;

  // --- Gas reserve (native deposits) ---

  // A native (ETH) deposit spends the amount as the transaction's msg.value, so
  // the gas fee must be paid out of the SAME balance. Depositing the full
  // balance leaves nothing for gas and the wallet rejects the submit with
  // "Insufficient funds for gas * price + value" — even though the client-side
  // "amount <= balance" check passed. Reserve a conservative gas buffer (the
  // deposit verifies a ZK proof on-chain, so it's gas-heavy) priced ABOVE the
  // wallet's likely upfront cost, and cap the spendable amount below balance.
  // Kept in wei (bigint) end-to-end so a sub-wei rounding gap can't slip an
  // amount past the guard that the wallet then rejects. ERC-20 deposits are
  // unaffected: their gas is paid in ETH, separate from the token amount.
  const { data: liveFeeData } = useEstimateFeesPerGas({
    chainId,
    // eth_gasPrice, the base the send's max fee is derived from.
    type: 'legacy',
    query: { refetchInterval: DEPOSIT_BALANCE_POLL_MS },
  });
  const feeData = useLatchedWhile(liveFeeData, txPending, depositReadIdentity);

  const walletBalanceWei = useMemo<bigint>(() => {
    if (selectedToken.isNative) return nativeBalance?.value ?? 0n;
    return (erc20BalanceRaw as bigint | undefined) ?? 0n;
  }, [selectedToken.isNative, nativeBalance, erc20BalanceRaw]);

  const gasReserveWei = useMemo<bigint>(() => {
    if (!selectedToken.isNative && !swapDepositActive) return 0n;
    // The same reserve the Shield tab's Max uses (DEV-542): 1.25x the bound
    // the deposit is SENT with, the cross-pay route's heavier gas included.
    return nativeDepositGasReserveWei({ gasPriceWei: feeData?.gasPrice, chainId, crossPay: swapDepositActive });
  }, [selectedToken.isNative, swapDepositActive, feeData, chainId]);

  // Vetting fee for the selected asset — the deposit charges it ON TOP of
  // the amount (ERC-20 allowance = amount + fee; native msgValue likewise),
  // so the spendable cap below must leave room for it. Fail-soft: while
  // unknown the cap is fee-less, and the on-top charge is re-derived from
  // the on-chain config at confirm regardless.
  // On prod this is 0 by design: the ppUSDC / ppUSDT shares' 20% yield cut is
  // the revenue line instead (Pat, 2026-09-04; see services/share-yield.ts).
  // Staging charges 100 bps on ETH. Both come from the Entrypoint's assets()
  // config, never from this app.
  const { data: depositAssetConfig, isLoading: depositAssetConfigLoading } = useQuery({
    // The yield route deposits SHARES: read the share's Entrypoint config (its
    // minimum is in shares; prod ppUSDC: 10), not the closed underlying's.
    queryKey: ['deposit-asset-config', chainId, yieldOn && yieldDeployment ? yieldDeployment.ppUSDC : selectedToken.address],
    enabled: !isSui && !!publicClient,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const entrypoint = await resolveConfiguredEntrypoint(chainId);
      if (!entrypoint || !publicClient) return null;
      const cfg = await publicClient.readContract({
        address: entrypoint as ViemAddress,
        abi: ENTRYPOINT_ASSETS_ABI,
        functionName: 'assets',
        args: [(yieldOn && yieldDeployment ? yieldDeployment.ppUSDC : selectedToken.address) as ViemAddress],
      }) as EntrypointAssetConfig;
      return {
        vettingFeeBps: Number(getVettingFeeBPS(cfg)),
        minAmountWei: getMinimumDepositAmount(cfg),
      };
    },
  });
  const depositVettingFeeBps = depositAssetConfig?.vettingFeeBps;
  const depositMinAmountWei = depositAssetConfig?.minAmountWei;

  // Max depositable, in wei: the balance minus the gas reserve (native only —
  // ERC-20 gas is paid in the chain's native asset), scaled down by the
  // vetting fee so amount + floor(amount·f/10000) still fits the balance.
  // Same helper as the Shield tab's Max, so Max always passes this check.
  const spendableBalanceWei = useMemo<bigint>(() => maxShieldAmountWei({
    balanceWei: walletBalanceWei,
    payIsNative: selectedToken.isNative,
    gasPriceWei: feeData?.gasPrice,
    chainId,
    crossPay: swapDepositActive,
    vettingFeeBps: depositVettingFeeBps,
  }), [selectedToken.isNative, walletBalanceWei, feeData, chainId, swapDepositActive, depositVettingFeeBps]);

  // Display-only float of the spendable cap (the validation itself stays in wei).
  const spendableBalanceFormatted = useMemo(
    () => Number(formatUnits(spendableBalanceWei, selectedToken.decimals)).toFixed(4),
    [spendableBalanceWei, selectedToken.decimals],
  );

  // --- Price, off the public-feed grid ---
  //
  // Never a query here. Keyed on the selected token, a query fetched when the
  // modal opened and again on every token change, putting a /token-prices
  // request on the wire at the exact moment a deposit began. The grid has no
  // `enabled` and no `refetch`, so this component cannot cause a request.
  //
  // `priceLoading` gates the inline auto-confirm, so it must mean "the grid has
  // not answered", NOT "the map is empty". Those are different: the dev ASP
  // prices Sepolia tokens at 0.00 and the feed publishes a valid `{}`. Reading
  // emptiness as loading is what hung a real payment on 2026-09-18
  // (services/price-feed-settled.ts).
  const depositPriceMap = useAllChainsPriceMap(chainId);
  const tokenPrice = depositPriceMap[displayTokenSymbol(selectedToken.symbol)] ?? 0;
  const priceError = null;
  const priceLoading = !usePriceFeedsSettled();

  // --- Validation ---

  const enteredAmount = parseFloat(amount) || 0;

  // The share minimum in the PAY asset (services/deposit-limits.ts). For a
  // yield deposit the Entrypoint minimum is in SHARES and the wallet pays the
  // underlying, so it is converted at the vault's live rate with previewMint
  // (assets for exactly minShares) and rounded UP to display precision. The
  // old approximation assumed rate 1.0 and printed the raw figure with a share
  // parenthetical ("10.050251256281407036 USDT (10 ppUSDT)", prod 2026-09-05).
  const minSharesForYield = yieldOn && yieldDeployment && depositMinAmountWei != null && depositMinAmountWei > 0n
    ? depositMinAmountWei
    : null;
  const { data: minAssetsForShares, isError: minAssetsError, isLoading: minAssetsLoading, refetch: refetchMinAssets } = useQuery({
    queryKey: ['deposit-min-preview-mint', chainId, yieldDeployment?.ppUSDC, minSharesForYield?.toString()],
    enabled: !isSui && !!publicClient && !!yieldDeployment && minSharesForYield != null,
    staleTime: 60_000,
    queryFn: async () => {
      const assets = await publicClient!.readContract({
        address: yieldDeployment!.ppUSDC as ViemAddress,
        abi: PREVIEW_MINT_ABI,
        functionName: 'previewMint',
        args: [minSharesForYield!],
      });
      return (assets as bigint).toString();
    },
  });
  const { depositMinPayWei, depositMinIsEstimate } = useMemo<{ depositMinPayWei: bigint | null; depositMinIsEstimate: boolean }>(() => {
    if (depositMinAmountWei == null) return { depositMinPayWei: null, depositMinIsEstimate: false };
    if (!(yieldOn && yieldDeployment) || depositMinAmountWei === 0n) return { depositMinPayWei: depositMinAmountWei, depositMinIsEstimate: false };
    // previewMint unavailable (RPC error): fall back to rate ≈ 1 rather than
    // blocking the form - but REMEMBER it is an estimate. At a live rate above
    // ~1.002 the estimate is a figure the SDK still rejects, so the catch must
    // not repeat it as authoritative (codex P2 on 1a65ddb).
    const live = minAssetsForShares != null;
    const assets = live
      ? BigInt(minAssetsForShares)
      : minAssetsError
        ? scaleUnits(depositMinAmountWei, yieldDeployment.ppUSDCDecimals, yieldDeployment.underlyingDecimals)
        : null;
    if (assets == null) return { depositMinPayWei: null, depositMinIsEstimate: false };
    return {
      depositMinPayWei: requiredUnderlyingForMinShares({
        assetsForMinShares: assets,
        underlyingDecimals: yieldDeployment.underlyingDecimals,
        underlyingSymbol: yieldDeployment.underlyingSymbol,
      }),
      depositMinIsEstimate: !live,
    };
  }, [depositMinAmountWei, yieldOn, yieldDeployment, minAssetsForShares, minAssetsError]);
  // True only while a lookup is ACTIVELY in flight (isLoading = pending AND
  // fetching): a quiet line, and confirm waits. A failed or disabled lookup is
  // not "loading" - it must never park the form on "Checking…" for good
  // (codex P2 on 1a65ddb); with no figure the SDK's own check remains the
  // last line of defence and the catch below formats it. The old fail-soft
  // skip let that SDK text reach the toast verbatim (prod, 2026-09-05).
  const minPending = !isSui && !swapDepositActive && enteredAmount > 0
    && (depositAssetConfigLoading || minAssetsLoading);

  const validationError = useMemo(() => {
    if (!amount || enteredAmount === 0) return null;
    if (enteredAmount < 0) return 'Amount must be positive';
    // The yield route needs an exit: no deposit into a share the relayer cannot
    // pay out yet (see shareExitSupport above).
    if (yieldExitBlocked) return yieldExitBlocked;
    // Launch cap (prod $100, config/environments.ts): checked on the DEPOSIT
    // asset before the wallet-side rules, so it also covers swap-into-deposit,
    // where the amount typed is the deposit target rather than what the wallet
    // spends. The ASP refuses the same deposits server-side.
    const cap = checkDepositCap({
      amount: enteredAmount,
      symbol: selectedToken.symbol,
      priceUsd: tokenPrice,
      capUsd: depositCapUsd,
      pricePending: priceLoading,
    });
    if (!cap.ok) return cap.message;
    // Swap-into-deposit: the amount entered is the DEPOSIT target in the
    // shielded asset, while the wallet spends the pay token — so the
    // wallet-balance and gas-reserve rules below (which compare against the
    // deposit asset's balance) do not apply. The route's own quote decides
    // whether the wallet can cover it, and the swap fails before any deposit
    // if it can't.
    if (swapDepositActive) return null;
    // Sui: the dapp-kit balance is the whole budget (the PTB pays its own gas
    // out of a separate coin selection); the EVM wei/gas-reserve math below is
    // wagmi-specific.
    if (isSui) {
      if (enteredAmount > walletBalance) {
        return `Insufficient balance (${walletBalance.toFixed(4)} ${displaySymbol} available)`;
      }
      return null;
    }
    let enteredWei: bigint;
    try {
      enteredWei = parseUnits(amount, selectedToken.decimals);
    } catch {
      return null; // partially-typed amount (e.g. "0."); let the input settle
    }
    if (enteredWei > walletBalanceWei) {
      return `Insufficient balance (${walletBalance.toFixed(4)} ${displayTokenSymbol(selectedToken.symbol)} available)`;
    }
    // Enough balance, but not enough left over for the vetting fee (and gas,
    // when the deposit asset is the native token).
    if (enteredWei > spendableBalanceWei) {
      // Name only what is actually charged: the vetting fee is zero on some
      // assets (Sepolia ETH today), and telling someone to leave room for a fee
      // that does not exist is the kind of fee copy that gets reported as wrong.
      const roomText = shieldHeadroomRoomText({
        vettingFeeBps: depositVettingFeeBps,
        crossPayShield: false,
        payIsNative: selectedToken.isNative,
      });
      return `Leave room for ${roomText}. You can deposit up to ${spendableBalanceFormatted} ${displayTokenSymbol(selectedToken.symbol)}`;
    }
    // Entrypoint minimum, in the PAY asset (depositMinPayWei above). While it
    // is still loading the line is quiet and confirm waits, so the contract's
    // revert is never the first the user hears of it.
    if (minPending) return 'Checking the pool minimum…';
    if (depositMinPayWei != null && depositMinPayWei > 0n && enteredWei < depositMinPayWei) {
      return formatDepositMinimum(depositMinPayWei, selectedToken.decimals, selectedToken.symbol);
    }
    return null;
  }, [amount, enteredAmount, walletBalanceWei, spendableBalanceWei, spendableBalanceFormatted, walletBalance, selectedToken.decimals, selectedToken.symbol, isSui, displaySymbol, swapDepositActive, depositMinPayWei, minPending, tokenPrice, priceLoading, yieldExitBlocked, depositCapUsd]);

  // True while the cap cannot be judged yet because the price is still
  // loading: shown quietly (not as a red error) and the inline auto-confirm
  // waits for it instead of spending its one attempt on a transient state.
  const capPending = useMemo(() => {
    if (depositCapUsd === undefined || !(enteredAmount > 0)) return false;
    const v = checkDepositCap({
      amount: enteredAmount,
      symbol: selectedToken.symbol,
      priceUsd: tokenPrice,
      capUsd: depositCapUsd,
      pricePending: priceLoading,
    });
    return !v.ok && v.reason === 'pending';
  }, [enteredAmount, selectedToken.symbol, tokenPrice, priceLoading, depositCapUsd]);
  // Either transient state: the form stays quiet and the inline auto-confirm
  // waits, instead of spending its one attempt on "still loading".
  const softPending = capPending || minPending;

  // Connection gate: Sui uses the dapp-kit account, EVM uses the wagmi address.
  const isWalletConnected = isStellar ? !!stellarOwner : isSui ? !!suiOwner : !!connectedAddress;
  const canReview = enteredAmount > 0 && !validationError && isWalletConnected;

  // --- Deposit Flow ---

  // Follow-up balance syncs after a deposit settles.
  //
  // One refresh at success is too early for a cross-chain shield: the source
  // transaction has confirmed, but the note is minted by the DESTINATION pool
  // once the bridge delivers, which is seconds to a couple of minutes later. The
  // user was left staring at an unchanged balance and reloading the page (Pat,
  // real 1→10 deposit of USDC→USDT). So re-sync twice on a short timer, which
  // covers the common fast-bridge case without polling forever.
  // What a settled cross-chain deposit is waiting on. Held as its own state
  // rather than read off crossChainPoolId, which a later launch clears — the
  // bridge outlives the flow that started it.
  const [bridgeWatch, setBridgeWatch] = useState<{
    txHash: string;
    fromChainId: number;
    toChainId: number;
    /** The destination note the SDK persisted PENDING; removed if the deposit never executes. */
    pendingCommitment?: string;
  } | null>(null);
  const [bridgeProgress, setBridgeProgress] = useState<{
    tone: 'pending' | 'done' | 'failed';
    text: string;
    explorerUrl?: string;
    lifiScanUrl?: string;
  } | null>(null);
  const handleConfirmUnlocked = useCallback(async () => {
    // Operation binding (codex P1-5): a run whose modal was closed/reopened
    // aborts before broadcasting; its terminal writes are epoch-guarded.
    const runEpoch = opEpochRef.current;
    const live = () => opEpochRef.current === runEpoch;
    // True once this run has mined an ERC-20 approval. Past that point
    // "Nothing was sent." is false: a transaction went out and cost gas, and a
    // user who reads otherwise and then finds it in their wallet history
    // concludes the app took their money and denied it (QA, 2026-09-21).
    let approvalSent = false;
    const nothingSent = () => (approvalSent
      ? 'No tokens were deposited, but the approval before it already mined and cost gas.'
      : 'Nothing was sent.');
    /**
     * Our own confirmed deposit, written to the note manager from what this
     * client already knows: the prepared note and the block our own wallet's
     * transaction mined in. The state tree leaf is
     * Poseidon(commitment, timestamp), so the block's timestamp goes on the
     * note now; discovery on the feed grid confirms the rest on its own
     * schedule, and nothing here asks the ASP.
     */
    const recordOwnDepositNote = async (
      pendingNote: { commitment?: unknown; noteSecret?: unknown } | null | undefined,
      txHash: Hex,
      blockNumber: bigint,
    ): Promise<void> => {
      const client = publicClient;
      if (!client) {
        log('error', 'Deposit', 'No RPC client to read the deposit block; the next discovery pass writes the note');
        return;
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const block = await client.getBlock({ blockNumber });
          const commitment = pendingNote?.commitment as Hex;
          const activeNoteManager = noteManager ?? getCommittedManagers().noteManager;
          if (!activeNoteManager) {
            throw new Error('Note manager unavailable after deposit receipt.');
          }
          let note = null;
          try {
            note = activeNoteManager.getNote(commitment);
          } catch {
            note = null;
          }
          const blockTimestamp = `0x${block.timestamp.toString(16)}` as Hex;
          if (note) {
            note.createdAtBlock = blockTimestamp;
            note.txHash = txHash;
            log('info', 'Deposit', 'Updated note with block timestamp', {
              commitment,
              blockNumber: blockNumber.toString(),
              timestamp: block.timestamp.toString(),
            });
          } else if (pendingNote?.noteSecret) {
            activeNoteManager.addNote({
              ...(pendingNote as Note),
              noteSecret: pendingNote.noteSecret as Hex,
              status: NoteStatus.PENDING,
              createdAtBlock: blockTimestamp,
              spentAtBlock: null,
              txHash,
            });
            log('info', 'Deposit', 'Persisted pending deposit note after confirmation', {
              commitment,
              blockNumber: blockNumber.toString(),
              timestamp: block.timestamp.toString(),
            });
          } else {
            throw new Error('Prepared deposit note is missing the note secret.');
          }
          return;
        } catch (err) {
          if (attempt === 3) {
            log('error', 'Deposit', 'Note timestamp patch failed after 3 attempts - spending this note may fail until the next reload heals it', err);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        }
      }
    };
    // With no review step, confirm can be reached straight from the form (or
    // the inline hub, which has no form validation of its own) — re-assert
    // the live field validation here so neither path can bypass it (e.g. the
    // leave-ETH-for-gas balance rule).
    depositErrorReportRef.current = { phase: 'validate' };
    if (validationError) {
      setStep('deposit');
      reportDepositError(validationError);
      return;
    }
    setPreparedYieldExitDisclosure(null);
    setClaimReceiptUrl(null);
    setStellarLabelPending(null);
    // Money-path backstop for a pool that has not opened yet (mainnet ETH).
    // The catalogs already keep it out of every picker, so reaching here needs
    // a selection that outlived its chain (a mid-flow switch, the static
    // fallback list) — refuse before anything is signed rather than let the
    // Entrypoint revert on an asset it has no config for.
    if (!isSui && getKnownTokenMetadata(selectedToken.address, chainId)?.depositComingSoon) {
      setStep('deposit');
      reportDepositError(cannotShieldMessage({ tokenAddress: selectedToken.address }, chainId));
      return;
    }
    // === Stellar path ===
    // The shared Stellar account (services/stellar/stellar-account.ts) derives
    // keys on first use, proves, submits pool.deposit via Freighter, then
    // registers the label ciphertext with the ASP registry.
    if (isStellar) {
      if (!stellarOwner) {
        depositErrorReportRef.current.phase = 'wallet-connect';
        reportDepositError('Stellar wallet not connected.');
        return;
      }
      if (selectedToken.address !== STELLAR_TESTNET_CONTRACTS.nativeAssetContractId) {
        reportDepositError(`${displayTokenSymbol(selectedToken.symbol)} isn't available on Stellar. Supported: XLM.`);
        setStep('deposit');
        return;
      }
      let amountBase: bigint;
      try {
        amountBase = parseUnits(amount, STELLAR_XLM.decimals);
      } catch {
        reportDepositError('Enter a valid amount.');
        return;
      }
      if (amountBase < STELLAR_XLM.minDeposit) {
        reportDepositError('The minimum deposit on this pool is 1 XLM.');
        return;
      }
      setStep('loading');
      reportDepositError(null);
      depositErrorReportRef.current.phase = 'wallet-connect';
      setLoadingMessage(describeStellarStage('unlocking'));
      try {
        const res = await stellarSession.deposit({
          amount: amountBase,
          recipient: depositRecipientRef.current ?? undefined,
          shouldContinue: live,
          onStage: (stage) => { if (!live()) return; depositErrorReportRef.current.phase = stellarErrorReportStage(stage); setLoadingMessage(describeStellarStage(stage)); },
        });
        // A run the user closed must not paint its hash into a newer flow.
        if (!live()) return;
        setTxHash(res.txHash);
        setTxChainId(STELLAR_TESTNET_ID);
        setStellarLabelPending(res.pendingLabel ? { owner: stellarOwner, item: res.pendingLabel } : null);
        setStep('success');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'Deposit', `Stellar deposit failed: ${message}`, err);
        if (!live()) return;
        if (/Superseded/.test(message)) { setStep('deposit'); return; }
        if (/reject|denied|cancel|declined/i.test(message)) {
          setStep('deposit');
          reportDepositError('Transaction was rejected.', err);
          return;
        }
        reportDepositError(`Deposit failed: ${stellarErrorMessage(message)}`, err, 'stellar-broadcast');
        setStep('deposit');
      }
      return;
    }

    // === Sui path ===
    // Route the deposit to the Sui session (proof + entrypoint::deposit + note
    // persistence; keystore auto-registration happens inside session.deposit).
    // Keeps the EVM/wagmi path below untouched for EVM chains.
    if (isSui) {
      if (!suiSession.account?.address) {
        depositErrorReportRef.current.phase = 'wallet-connect';
        reportDepositError('Sui wallet not connected.');
        return;
      }
      // Validate the selected asset against the configured Sui coin types, and
      // source decimals + the Move coin type from that config (rather than
      // assuming native SUI) so a future non-SUI asset deposits correctly.
      const suiToken =
        SUI_SUPPORTED_TOKENS.find((t) => t.typeArg === selectedToken.address)
        ?? SUI_SUPPORTED_TOKENS.find((t) => t.symbol === selectedToken.symbol);
      if (!suiToken) {
        reportDepositError(
          `${displayTokenSymbol(selectedToken.symbol)} isn't available on Sui. Supported: ${SUI_SUPPORTED_TOKENS.map((t) => t.symbol).join(', ')}.`,
        );
        setStep('deposit');
        return;
      }
      setStep('loading');
      reportDepositError(null);
      depositErrorReportRef.current.phase = 'proof';
      setLoadingMessage('Building deposit proof...');
      try {
        const amountBase = parseUnits(amount, suiToken.decimals);
        depositErrorReportRef.current.phase = 'submit';
        setLoadingMessage('Submitting deposit (sign in wallet)...');
        const res = await suiSession.deposit({ amount: amountBase, coinType: suiToken.typeArg, shouldContinue: live });
        setTxHash(res.txDigest);
        setTxChainId(SUI_TESTNET_ID);
        if (live()) setStep('success');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'Deposit', `Sui deposit failed: ${message}`, err);
        // Stale runs must not repaint a reopened modal (codex); 'Superseded'
        // from the Sui method's pre-prompt gate lands here silently.
        if (!live()) return;
        if (/Superseded/.test(message)) { setStep('deposit'); return; }
        if (/reject|denied|cancel/i.test(message)) {
          setStep('deposit');
          reportDepositError('Transaction was rejected.', err);
          return;
        }
        reportDepositError(`Deposit failed: ${message}`, err, 'sui-broadcast');
        setStep('deposit');
      }
      return;
    }

    depositErrorReportRef.current.phase = 'wallet-connect';
    if (!connectedAddress) {
      reportDepositError('Wallet not connected.', undefined, 'wallet-connect');
      return;
    }
    if (!publicClient) {
      reportDepositError('Public client unavailable.');
      return;
    }

    setStep('loading');
    reportDepositError(null);
    setLoadingMessage('Initializing account...');
    // Pause background polling (balances, ASP queries) while the tx
    // is in flight so we don't blast the RPC during the wait.
    beginTx();
    // Idempotent release (codex round 1, P2): the registration/switch
    // handoffs release early AND return through the outer finally — the
    // double endTx() could clear another flow's global txPending flag.
    let txReleased = false;
    const releaseTx = () => { if (!txReleased) { txReleased = true; endTx(); } };
    log('info', 'Deposit', `Starting deposit: ${amount} ${selectedToken.symbol}`, {
      tokenAddress: selectedToken.address,
      chainId,
      connectedAddress,
    });

    // Which leg of a yield deposit this attempt reached: the expiry copy is only
    // right for a failure of the DEPOSIT transaction of the yield route (codex on
    // 0759cc6: a plain deposit's allowance error must keep its own message).
    let yieldPhase: 'none' | 'prepared' | 'deposit' = 'none';
    try {
      // Ensure the wallet is on the deposit chain BEFORE building anything —
      // and if a switch was actually needed, STOP and require a fresh press.
      // Continuing here would reuse state (session, token catalog, fee quote)
      // captured under the previous chain: with the session bound to the
      // wallet's old chain, the send would submit that chain's entrypoint
      // calldata on the NEW chain — on a chain where the entrypoint has no
      // code, a native deposit silently becomes a plain transfer (codex P1).
      // Same stop-after-switch pattern as the payment-request pay flows.
      if (walletChainId !== chainId) {
        await switchChainAsync({ chainId });
        releaseTx();
        setStep('deposit');
        reportDepositError('Network switched. Press Deposit again to continue.');
        return;
      }

      const session = sdkReady && poolSession
        ? poolSession
        : await ensureInitialized();

      if (!session) {
        throw new Error(sdkError || 'SDK initialization did not complete.');
      }

      // GUARD: block depositing under an unlock that isn't the one registered
      // on-chain — such a deposit would be stranded under an un-spendable
      // identity. Async: re-reads the on-chain registration against the
      // committed manager. Passing the WRITE chain pins the committed session
      // to the chain the tx below will execute on (codex P1).
      await assertCanDeposit(chainId);

      // === Cross-chain shield: a SECOND session, on the destination chain ===
      //
      // The committed session belongs to the wallet's chain (that is what
      // assertCanDeposit just validated, and the LiFi transaction really does
      // execute there). The NOTE, though, is minted by the destination pool, so
      // the deposit has to be prepared against a session configured for that
      // chain, with the source chain attached as swapDepositSourceChain.
      let depositSession = session;
      let depositChainId = chainId;
      const requestedPoolChainId = crossChainPoolIdRef.current;
      const crossChainThisRun = !isSui && !keyOwnedDeposit
        && requestedPoolChainId !== null
        && requestedPoolChainId !== chainId
        && crossChainSwapDepositSupported(chainId, requestedPoolChainId)
        && !!payToken;
      if (crossChainThisRun && requestedPoolChainId) {
        if (!connectedAddress) throw new Error('Connect a wallet to shield from another network.');
        setLoadingMessage('Preparing the destination pool…');
        const crossSession = await createCrossChainShieldSession({
          poolChainId: requestedPoolChainId,
          sourceChainId: chainId,
          walletInteractor: createWagmiWalletInteractor({
            chainId,
            address: connectedAddress as ViemAddress,
            sendTransaction: (tx) => sendWalletTx(tx),
            signTypedData: (payload) => signTypedDataAsync(payload as never),
          }),
        });
        if (!crossSession) {
          throw new Error('Shielding from another network is unavailable right now. Nothing was sent.');
        }
        depositSession = crossSession;
        depositChainId = requestedPoolChainId;
      }

      // Gate keystore registration via the shared explanation modal
      // before the deposit tx. We used to auto-register silently in
      // the loading screen — users had no idea why their wallet was
      // prompting them to sign two unfamiliar transactions back to
      // back. Now we close the deposit modal, show the registration
      // modal with plain-English copy, and reopen+resume the deposit
      // after registration confirms. State on this provider survives
      // the close because the provider is mounted at the app root.
      // === Deposit to another address (SDK depositFor) ===
      // A registered recipient gets a note announced to their viewing key; an
      // unregistered one gets a blind deposit and a claim link (below). Plain,
      // yield (DEV-451) and, since DEV-489, pay-with and cross-chain deposits:
      // the SDK's swap-and-deposit embeds the recipient's depositFor proof.
      const depositRecipientAddr = depositRecipientRef.current;
      const recipientMode = depositRecipientAddr !== null;
      // Set only on the blind path (unregistered recipient). Locals rather
      // than state: the secret is spendable, and it should live no longer than
      // this one run - the durable copy is the audit disclosure written after
      // the receipt, which the row menu rebuilds the link from.
      let blindNoteSecret: Hex | null = null;
      // The note a blind claim link names when it is NOT the typed token and
      // amount: a yield deposit's note is shares of the share token (DEV-451).
      let claimNote: { tokenId: ViemAddress; value: Hex } | null = null;
      let blindNoteAddressHash: Hex | null = null;
      // The on-chain backup of the claim material, encrypted to THIS sender's
      // viewing key (services/blind-deposit-backup.ts). Carries the path-A
      // noteData + depositSecret the prepare call must be given, and the
      // label/commitment the SDK must then agree with. Built AFTER tokenId and
      // amountHex are resolved below (they do not exist yet at the recipient
      // check); the check only decides "blind" and mints what the build needs.
      let blindBackup: BlindDepositBackupResult | null = null;
      let blindDepositSecret: Hex | null = null;
      let blindSenderViewingPubKey: string | null = null;
      // Kept for the swap path, which rebuilds the backup for the value the
      // SDK actually commits (see swapRecipient below).
      let blindNoteComputation: Parameters<typeof buildBlindDepositBackup>[0]['noteComputation'] | null = null;
      let blindCrypto: Parameters<typeof buildBlindDepositBackup>[0]['crypto'] | null = null;
      if (recipientMode) {
        // A yield deposit CAN go to someone else (DEV-451): the router forwards
        // a depositFor proof unchanged (services/yield-deposit-for.ts). So can a
        // pay-with or cross-chain one (DEV-489, SDK swap-and-deposit recipient).
        // An account-key session cannot: its deposits belong to the key.
        if (keyOwnedDeposit) throw new Error(`${KEY_SESSION_DEPOSIT_FOR_COPY} Nothing was sent.`);
        depositErrorReportRef.current.phase = 'recipient-check';
        setLoadingMessage('Checking the recipient...');
        const registration = await checkRecipientRegistration(depositChainId, depositRecipientAddr as ViemAddress);
        if (!live()) { releaseTx(); log('warn', 'Deposit', 'Stale run aborted after the recipient check'); return; }
        // An unregistered recipient is NOT a refusal. It used to be, and that
        // was wrong: the SDK's prepareDepositFor takes three forms and the
        // first, a pre-computed noteAddressHash with no discoveryData, exists
        // for exactly this case - its own doc calls it "blind cold-start, no
        // note announcement". Refusing meant you could not pay anyone who had
        // not signed up first, while the transfer flow had been handing the
        // same people an out-of-band claim link all along.
        //
        // So: mint the note secret here, hash it with the recipient's address
        // into the noteAddressHash the deposit commits to, and hand the secret
        // over afterwards as a link. Nothing on chain announces the note, so
        // the link is the recipient's ONLY route to the money - which is why
        // the disclosure is recorded below the moment the tx confirms, before
        // anything can be lost to a closed modal.
        if (registration === 'unregistered') {
          // The backup is encrypted to THIS sender's viewing key so any browser
          // they sign into can recover the claim material. No viewing key means
          // no backup, and a blind deposit with no backup is exactly the
          // one-browser-and-gone failure this exists to remove: refuse before
          // anything is signed rather than ship it.
          const senderViewingPubKey = getCommittedManagers().keystoreManager?.getViewingKeyPair().publicKey;
          if (!senderViewingPubKey) {
            throw new Error('Could not read this account\'s viewing key, so the claim could not be backed up. Reconnect and try again. Nothing was sent.');
          }
          const { createCryptoService } = await import('@/services/sdk-runtime');
          if (!live()) { releaseTx(); log('warn', 'Deposit', 'Stale run aborted while preparing the blind claim'); return; }
          const cryptoService = createCryptoService();
          // Mint here; build below once tokenId/amountHex exist. Both secrets
          // are ours on purpose: the deposit secret fixes the label, and the
          // backup must name the label the proof will commit to.
          blindSenderViewingPubKey = String(senderViewingPubKey);
          blindNoteSecret = cryptoService.generateSecret() as Hex;
          blindDepositSecret = cryptoService.generateSecret() as Hex;
          log('info', 'Deposit', 'Recipient is unregistered: depositing blind with a sender-recoverable backup; claim link will be issued', { chainId: depositChainId });
        } else if (registration === 'unknown') {
          throw new Error('Could not check whether that address is registered. Try again in a moment. Nothing was sent.');
        } else {
          log('info', 'Deposit', 'Deposit for another address: recipient is registered', { chainId: depositChainId });
        }
      }
      // The payer's OWN keystore registration is irrelevant for a depositFor:
      // the note belongs to the recipient, and this wallet cannot register
      // them. Never prompt the payer to register just to fund someone else.
      let isRegistered = recipientMode ? true : await depositSession.isKeystoreRegistered();
      // DEV-566: one stale "not registered" read sent an already-registered
      // wallet into "Register before you deposit", whose setAuthPolicy then
      // reverted (Keystore_AuthPolicyAlreadySet). Re-read before prompting,
      // the same lag allowance the Finish-setup path uses.
      for (let attempt = 0; !isRegistered && attempt < DEPOSIT_AUTH_LAG_RETRIES; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, DEPOSIT_AUTH_LAG_RETRY_MS));
        if (!live()) { releaseTx(); return; }
        isRegistered = await depositSession.isKeystoreRegistered();
      }
      console.log('[Deposit][debug] keystore registered:', isRegistered);
      if (!isRegistered && keyOwnedDeposit) {
        // The connected wallet is only the payer — it cannot register the
        // key account's keystore (registration must come from the owner).
        throw new Error(
          'This account key\'s keystore is not registered on-chain. Connect the owner wallet once to register, then key-funded deposits will work.',
        );
      }
      if (!isRegistered) {
        // Stale check after the RPC (codex): a deposit closed during this await
        // must not pop the registration modal, whose onSuccess would replay
        // the canceled amount under a fresh epoch.
        if (!live()) { releaseTx(); log('warn', 'Deposit', 'Stale run aborted before registration handoff'); return; }
        log('info', 'Deposit', 'Keystore not registered, prompting via modal');
        releaseTx();
        // Park the deposit at the form BEFORE handing off: nothing is in
        // flight while the registration modal owns the screen, so the hidden
        // provider must not sit in 'loading' — that kept the tab-close guard
        // armed indefinitely (and resumed into stale state) after "Not now".
        // Surface-aware: an inline (hub) deposit stays inline through the
        // handoff; a modal deposit hides and reopens the modal.
        const resumeInline = inlineActiveRef.current;
        // Pinned at the handoff: the launch being parked is THIS one, and any
        // launch/reset after it (bumping the generation) supersedes it.
        const handoffGen = inlineLaunchGenRef.current;
        const handoffOptions = lastInlineOptionsRef.current;
        // A cross-chain shield mints the note on the FAR chain, so that is the
        // keystore that must exist. The modal registers there by sending only
        // the wallet over for that one transaction (a wallet-chain excursion
        // pins the app and session here), and it resolves onSuccess only once
        // the wallet is back home; otherwise it calls onCancel.
        const crossChainRegistration = depositChainId !== chainId;
        const destName = getChainConfig(depositChainId)?.displayName ?? `chain ${depositChainId}`;
        const sourceName = getChainConfig(chainId)?.displayName ?? `chain ${chainId}`;
        setStep('deposit');
        setIsOpen(false);
        openKeystoreRegistrationModal({
          ...(crossChainRegistration
            ? {
              targetChainId: depositChainId,
              title: `Register on ${destName} first`,
              body: `This deposit lands in the ${destName} pool, and your account is not registered there yet. Register once on ${destName} and we'll come straight back to this deposit. Your wallet switches networks for that one transaction; nothing here is lost.`,
              primaryLabel: `Register on ${destName}`,
            }
            : {
              title: 'Register before you deposit',
              body:
                'Before using Privacy Pools, you need to register your wallet. This is a one-time onchain transaction only costing gas.',
              primaryLabel: 'Register and continue',
            }),
          // No relayer-paid registration here: a deposit is a wallet-signed
          // transaction no relayer carries, so a wallet with no gas would spend
          // a slice of its shielded balance on the registration fee and then
          // still fail the deposit it was trying to make. The honest "this
          // wallet can't pay" warning is the right answer for this caller.
          allowGasless: false,
          onSuccess: () => {
            if (!resumeInline) setIsOpen(true);
            if (!crossChainRegistration) {
              void handleConfirm();
              return;
            }
            // The bridge transaction is sent from HERE. The modal has already
            // brought the wallet home, so this switch is normally a no-op; it
            // stays as a guard because the send below must not start from the
            // far chain. Then relaunch from the launch's own inputs rather
            // than replay a closure captured before minutes of wallet prompts
            // (see pendingRelaunch).
            if (inlineLaunchGenRef.current !== handoffGen) return;
            void (async () => {
              try {
                await switchChainAsync({ chainId });
              } catch {
                if (inlineLaunchGenRef.current === handoffGen) {
                  reportDepositError(`Registered on ${destName}. Switch your wallet back to ${sourceName}, then shield again.`);
                }
                return;
              }
              // Something new started while the wallet switched back: that
              // launch owns the card now, not this one.
              if (handoffOptions && inlineLaunchGenRef.current === handoffGen) {
                setPendingRelaunch({ chainId, gen: handoffGen, options: handoffOptions });
              }
            })();
          },
          // "Not now" → bring the deposit back where it left off (the form)
          // instead of silently dropping the flow with hidden state.
          // A cross-chain registration that LANDED but did not come home (the
          // switch back was declined or timed out) arrives here too, with
          // `registered: true`. Say so: the page promised this deposit would
          // resume, and closing silently read as "nothing happened".
          onCancel: ({ registered }) => {
            if (!resumeInline) setIsOpen(true);
            if (registered && crossChainRegistration && inlineLaunchGenRef.current === handoffGen) {
              reportDepositError(`Registered on ${destName}. Switch your wallet back to ${sourceName}, then shield again.`);
            }
          },
        });
        return;
      }

      const amountWei = parseUnits(amount, selectedToken.decimals);
      const amountHex = `0x${amountWei.toString(16)}` as Hex;
      // LOWERCASE, always: the SDK stores prepareDeposit's tokenId VERBATIM
      // while discovered/restored notes arrive lowercase, and its
      // same-tokenId check for multi-note spends is character-strict — a
      // checksummed fresh note + a lowercase discovered note of the SAME
      // token would refuse to be spent together ("All input notes must have
      // the same tokenId").
      const tokenId = selectedToken.address.toLowerCase() as ViemAddress;
      // Blind deposit: now that the amount and token are fixed, build the
      // sender-recoverable backup. This is the announcement the proof context
      // will be bound to, and it names the label the SDK must derive from
      // blindDepositSecret - asserted equal just before broadcast.
      if (blindNoteSecret && blindDepositSecret && blindSenderViewingPubKey) {
        const { createCryptoService, createNoteComputationService } = await import('@/services/sdk-runtime');
        const noteComputation = await createNoteComputationService();
        if (!live()) { releaseTx(); log('warn', 'Deposit', 'Stale run aborted while building the blind backup'); return; }
        blindNoteComputation = noteComputation;
        blindCrypto = createCryptoService();
        blindBackup = buildBlindDepositBackup({
          recipient: depositRecipientAddr as ViemAddress,
          tokenId,
          value: amountHex,
          noteSecret: blindNoteSecret,
          depositSecret: blindDepositSecret,
          senderViewingPubKey: blindSenderViewingPubKey,
          noteComputation,
          crypto: blindCrypto,
          randomFill: webRandomFill,
        });
        blindNoteAddressHash = blindBackup.noteAddressHash;
      }
      // Unconditional, and at the point of use: the resolution effect above can
      // early-return (empty availableTokens), so logging only there missed the
      // case entirely. A USDC deposit failed with
      // `AssetNotEnabled: 0x0000…0002`, which is the Move coin type
      // "0x2::sui::SUI" coerced into an EVM address - so what matters is what
      // `selectedToken` actually holds when the deposit is built.
      try {
        console.log(
          `[perf] · deposit tokenId=${tokenId} from selectedToken=${selectedToken.symbol}`
          + `/${selectedToken.address} native=${selectedToken.isNative} decimals=${selectedToken.decimals}`,
        );
      } catch { /* diagnostics must never break a deposit */ }

      // === Swap-into-deposit (guide flow 1) ===
      //
      // A different code path, not a variation on the one below: the SDK owns
      // both the calldata and the submission (executeSwapAndDeposit), so this
      // returns early rather than joining the manual approve→simulate→send
      // pipeline. The optimistic activity row is skipped on purpose — the
      // deposited amount is only known once the route settles, and inventing
      // one would show a number the chain never emitted.
      if (swapDepositActive && payToken) {
        // Where the conversion actually lands. On a chain that wraps this asset
        // the pool is the SHARE, and the swap-into-deposit ends in that share's
        // router call rather than an Entrypoint deposit the pool would reject.
        // The amount above is already in this asset's units, which is exactly
        // the budget the router sizes its shares from. Crossing chains changes
        // nothing here: depositSession is the DESTINATION's, built with that
        // chain's yield deployments, so the router leg is the same one.
        const conversionTarget = conversionDepositTarget(
          tokenId,
          depositChainId,
          selectedToken.isNative,
        ) as ViemAddress;
        // Belt to the hub's braces: a withdraw-only or replaced pool reverts.
        const conversionRefusal = intentTargetRefusal(conversionTarget, depositChainId, false, depositChainId !== chainId);
        if (conversionRefusal) {
          reportDepositError(conversionRefusal);
          setStep('deposit');
          return;
        }
        depositErrorReportRef.current.phase = 'quote';
        setLoadingMessage('Finding a route…');
        // Set when the swap is broadcast (DEV-433), so a revert can take its
        // pending row back down.
        let broadcastSwapHash: string | null = null;
        try {
          const recoveryKey = `${chainId}:${connectedAddress.toLowerCase()}:${payToken.address.toLowerCase()}`;
          let approvalRecovery = swapApprovalRecoveryRef.current.get(recoveryKey);
          if (!approvalRecovery) {
            approvalRecovery = [];
            swapApprovalRecoveryRef.current.set(recoveryKey, approvalRecovery);
          }
          // DEV-433: the pending row goes up when the wallet returns the swap's
          // hash, like a plain deposit's, not after the receipt. Same row both
          // times (an upsert on chain + hash), so confirmation only refreshes it.
          const addSwapPendingRow = (
            hash: string,
            pendingNote: Parameters<typeof swapDepositPendingAsset>[0],
            amountWei: bigint,
          ) => {
            if (recipientMode) return;
            addPendingOwnRow(pendingDepositRow({
              chainId: depositChainId,
              chainName: getChainConfig(depositChainId)?.displayName || '',
              address: connectedAddress || '',
              txHash: hash,
              ...swapDepositPendingAsset(
                pendingNote,
                { address: selectedToken.address, symbol: selectedToken.symbol, decimals: selectedToken.decimals, amountRaw: amountWei.toString() },
                (addr) => getKnownTokenMetadata(addr, depositChainId),
              ),
              now: Date.now(),
            }));
          };
          // DEV-489: FOR SOMEONE ELSE the SDK embeds the recipient's depositFor
          // proof in the swap's deposit call, so the note is theirs. Registered:
          // announced to their viewing key. Blind: the same claim link as a plain
          // deposit, with our sender-recoverable backup as the announcement. The
          // SDK hands the backup builder the value it actually commits (shares on
          // a yield pool; a bridge refit or a smaller retry target moves it), so
          // each prepared route carries a backup that names its own note.
          const blindByCommitment = new Map<string, BuiltClaimNote>();
          let blindSwapClaim: { provisionalKey: string; disclosure: Record<string, unknown> } | null = null;
          let swapRecipient: SwapDepositRecipient | undefined;
          if (recipientMode) {
            let blind: BlindSwapRecipientInput | null = null;
            if (blindNoteSecret) {
              if (!blindDepositSecret || !blindSenderViewingPubKey || !blindNoteAddressHash || !blindNoteComputation || !blindCrypto) {
                throw new Error(`Could not prepare the claim details for this recipient. ${nothingSent()} Try again.`);
              }
              blind = {
                noteSecret: blindNoteSecret,
                depositSecret: blindDepositSecret,
                senderViewingPubKey: blindSenderViewingPubKey,
                noteAddressHash: blindNoteAddressHash,
                noteComputation: blindNoteComputation,
                crypto: blindCrypto,
                randomFill: webRandomFill,
              };
            }
            swapRecipient = swapDepositRecipient({
              recipient: depositRecipientAddr as ViemAddress,
              blind,
              onNote: (key, note) => { blindByCommitment.set(key, note); },
            });
          }
          const { prepared, txHash: swapHash, depositAmountWei: depositedWei } = await runSwapAndDeposit(
            depositSession as unknown as SwapDepositSessionLike,
            {
              ...(swapRecipient ? { recipient: swapRecipient } : {}),
              // A blind recipient's claim record, made durable before the swap's
              // wallet prompt, exactly as the plain deposit does before its own.
              beforeSwapSubmit: async (routed) => {
                if (!recipientMode) return;
                if (routed.pendingNote?.isOwned !== false) {
                  throw new Error('The prepared deposit is not the recipient\u2019s, so the swap was not sent.');
                }
                if (!blindNoteSecret) return;
                const commitment = routed.pendingNote?.commitment;
                const label = routed.pendingNote?.label;
                const note = commitment ? blindByCommitment.get(commitmentKey(String(commitment))) : undefined;
                if (!commitment || !label || !note) {
                  throw new Error('Could not prepare the claim details for this recipient, so the swap was not sent. Try again.');
                }
                const provisionalKey = `pending:${String(commitment).toLowerCase()}`;
                const disclosure = {
                  chainId: depositChainId,
                  commitment,
                  ownerAddress: depositRecipientAddr as ViemAddress,
                  noteSecret: blindNoteSecret,
                  tokenId: note.tokenId,
                  value: note.value,
                  label,
                };
                if (!recordSentAuditsVerified([{ ...disclosure, txHash: provisionalKey as Hex } as never])) {
                  log('warn', 'Deposit', 'Claim disclosure could not be stored locally; asking before the swap', { chainId: depositChainId });
                  if (!live()) throw new Error('This deposit was superseded (the modal was closed or reopened).');
                  const approved = await new Promise<boolean>((resolve) => {
                    setStorageConfirm({ resolve });
                  });
                  if (!approved) throw new Error('Cancelled before the swap was signed.');
                  if (!live()) throw new Error('This deposit was superseded (the modal was closed or reopened).');
                }
                blindSwapClaim = { provisionalKey, disclosure };
              },
              fromChainId: chainId,
              depositChainId,
              inputToken: payToken.address as ViemAddress,
              depositToken: conversionTarget,
              depositAmountWei: amountWei,
              approvalRecovery,
              readApprovalReceipt: async (hash) => {
                const receipt = await publicClient.getTransactionReceipt({ hash: hash as Hex });
                return { success: receipt.status === 'success' };
              },
              // Crossing chains, the same token address is the whole point
              // (bridging ETH into the other chain's ETH pool); within one
              // chain it stays refused as a fee-burning no-op.
              allowSameToken: depositChainId !== chainId,
              // The real allowance held by the route's DECLARED approval
              // address (see runSwapAndDeposit). A read that fails leaves the
              // allowance unknown, which never changes who the spender is.
              readAllowance: async (token, spender) => {
                if (!publicClient || !connectedAddress) return 0n;
                return await publicClient.readContract({
                  address: token as ViemAddress,
                  abi: erc20Abi,
                  functionName: 'allowance',
                  args: [connectedAddress as ViemAddress, spender as ViemAddress],
                }) as bigint;
              },
              // Post-approval dry run: catches the route under-delivering for
              // the deposit (SDK targets the exact amount, routes only
              // guarantee their slippage floor) before gas is spent.
              simulate: async (tx) => {
                if (!publicClient || !connectedAddress) return { ok: true };
                try {
                  await publicClient.call({
                    account: connectedAddress as ViemAddress,
                    to: tx.to as ViemAddress,
                    data: tx.data as `0x${string}`,
                    ...(tx.value ? { value: BigInt(tx.value) } : {}),
                  });
                  return { ok: true };
                } catch (simErr) {
                  // Decoding lives in classifySimulationFailure (module scope),
                  // shared with the plain-deposit dry run below. Behaviour here
                  // is unchanged: swap-flows retries a failed simulation with a
                  // smaller deposit target, so every failure still reports as
                  // not-ok.
                  const { detail } = classifySimulationFailure(simErr);
                  console.log('[SwapDeposit] simulation revert decoded:', detail, 'msg:', simErr instanceof Error ? simErr.message.split('\n').slice(0, 3).join(' | ') : String(simErr));
                  return { ok: false, revertData: detail };
                }
              },
              // Prove the route with the allowance granted to the eth_call
              // only, so a route that cannot deliver is found BEFORE the
              // wallet grants anything real. Falls back (supported: false)
              // when the token's allowance slot cannot be located or the node
              // refuses the override.
              simulateWithAllowance: async (tx, grant) => {
                if (!publicClient || !connectedAddress) return { ok: false, supported: false };
                return await simulateWithAllowanceOverride(
                  async (args) => {
                    try {
                      const result = await publicClient.call({
                        account: args.account as ViemAddress | undefined,
                        to: args.to as ViemAddress,
                        data: args.data as `0x${string}`,
                        ...(args.value !== undefined ? { value: args.value } : {}),
                        stateOverride: args.overrides.map((entry) => ({
                          address: entry.address as ViemAddress,
                          stateDiff: entry.stateDiff.map((slot) => ({
                            slot: slot.slot as `0x${string}`,
                            value: slot.value as `0x${string}`,
                          })),
                        })),
                      });
                      return { ok: true, supported: true, data: result.data as `0x${string}` | undefined };
                    } catch (callErr) {
                      // A node that does not implement state overrides answers
                      // with an invalid-params style error rather than a
                      // revert. Treat that, and only that, as unsupported.
                      if (isUnsupportedOverrideError(callErr)) return { ok: false, supported: false };
                      const { detail } = classifySimulationFailure(callErr);
                      return { ok: false, supported: true, revertData: detail };
                    }
                  },
                  {
                    chainId,
                    tx: { to: tx.to, data: tx.data as `0x${string}`, ...(tx.value ? { value: BigInt(tx.value) } : {}) },
                    owner: connectedAddress as ViemAddress,
                    token: grant.token,
                    spenders: grant.spenders,
                    amount: grant.amount,
                  },
                );
              },
              onStep: (stepName, detail) => {
                setLoadingMessage(
                  detail ?? (stepName === 'prepare'
                    ? 'Finding a route…'
                    : stepName === 'approve'
                      ? `Approving ${displayTokenSymbol(payToken.symbol)}…`
                      : stepName === 'revoke'
                        ? `Setting the ${displayTokenSymbol(payToken.symbol)} approval back to zero (sign in wallet)…`
                        : 'Swapping and depositing (sign in wallet)…'),
                );
              },
              // Show what the route will cost BEFORE the wallet prompt: it is
              // about to ask for an amount of the pay token the user never
              // typed, so naming it is the difference between an informed
              // signature and a blind one.
              display: {
                input: { symbol: payToken.symbol, decimals: payToken.decimals },
                deposit: { symbol: selectedToken.symbol, decimals: selectedToken.decimals },
              },
              confirmPrepared: async (display, routeQuote) => {
                setSwapRouteEstimate(
                  `Spending about ${display.inputAmountText}${display.durationText ? ` · ${display.durationText}` : ''}`,
                );

                // Affordability, against the PAY token — the form's balance
                // rules cover the deposit asset and were skipped for this route.
                const requiredInput = BigInt(routeQuote.estimatedInputAmount || '0x0');
                const payIsNative = payToken.isNative;
                let payBalance: bigint;
                if (payIsNative) {
                  payBalance = await publicClient.getBalance({ address: connectedAddress as ViemAddress });
                } else {
                  payBalance = await publicClient.readContract({
                    address: payToken.address as ViemAddress,
                    abi: erc20Abi,
                    functionName: 'balanceOf',
                    args: [connectedAddress as ViemAddress],
                  }) as bigint;
                }
                // Native gas has to survive too: this route can be two
                // transactions (approval + swap), and a mined approval followed
                // by an unaffordable swap costs gas for nothing.
                const nativeNeeded = payIsNative ? requiredInput + gasReserveWei : gasReserveWei;
                const nativeBalance = payIsNative
                  ? payBalance
                  : await publicClient.getBalance({ address: connectedAddress as ViemAddress });
                if (payBalance < requiredInput) {
                  reportDepositError(
                    `This route needs about ${display.inputAmountText}, more than your ${displayTokenSymbol(payToken.symbol)} balance. Nothing was sent.`,
                  );
                  return false;
                }
                if (nativeBalance < nativeNeeded) {
                  reportDepositError(
                    'Not enough native balance left to cover gas for this route. Nothing was sent.',
                  );
                  return false;
                }

                // Explicit consent to the quoted input before any signature.
                const msgValue = BigInt(routeQuote.msgValue || '0x0');
                const route = {
                  inputUsd: usdFigure(routeQuote.inputAmountUSD),
                  // What the route is expected to hand the deposit call; the unused
                  // slippage buffer above the note comes back, so it is no cost.
                  deliveredUsd: usdFigure(routeQuote.depositAmountUSD),
                  // Value beyond the input itself is the bridge's native fee.
                  nativeFeeWei: payIsNative ? (msgValue > requiredInput ? msgValue - requiredInput : 0n) : msgValue,
                };
                return await new Promise<boolean>((resolve) => {
                  setSwapConfirm({ display, resolve, route });
                });
              },
              // Both transactions go through wagmi, like every other tx in this
              // app. The SDK's own executeSwapAndDeposit is NOT used: it submits
              // via an SDK walletInteractor that ppv2 never wires, so it would
              // throw WalletNotAvailable after the route was already quoted.
              onSwapBroadcast: (hash, routed, amountWei) => {
                // The claim record first and regardless of the run's state: it is
                // the recipient's only route to the money.
                if (blindSwapClaim) {
                  const settled = { ...blindSwapClaim.disclosure, txHash: hash };
                  const kept = recordSentAuditsVerified([settled as never]);
                  if (kept) dropSentAudits(blindSwapClaim.provisionalKey);
                  if (live()) setClaimReceiptUrl(buildSentReceiptUrl([settled as never]));
                  log('info', 'Deposit', 'Blind swap-deposit claim disclosure stored', { txHash: hash, chainId: depositChainId, kept });
                }
                if (!live()) return;
                broadcastSwapHash = hash;
                addSwapPendingRow(hash, routed.pendingNote, amountWei);
              },
              submit: async (tx, kind, onBroadcast) => {
                // A revoke is allowance cleanup, often while unwinding a later
                // failure: it keeps the stage that failure is reported under.
                if (kind !== 'revoke') depositErrorReportRef.current.phase = kind === 'approval' ? 'approve' : 'submit';
                if (!live()) throw new Error(`This deposit was superseded (the modal was closed or reopened). ${nothingSent()}`);
                const result = await submitWalletTransaction(
                  () => sendWalletTx({
                    chainId,
                    to: tx.to as ViemAddress,
                    data: tx.data as Hex,
                    value: tx.value ? BigInt(tx.value) : 0n,
                  }, undefined, () => {
                    if (!live()) throw new Error(`This deposit was superseded (the modal was closed or reopened). ${nothingSent()}`);
                  }),
                  async (hash) => {
                    if (kind !== 'approval' && kind !== 'revoke') depositErrorReportRef.current.phase = 'confirm';
                    setLoadingMessage(
                      kind === 'approval'
                        ? 'Waiting for approval confirmation…'
                        : kind === 'revoke'
                          ? 'Waiting for the approval to be set back to zero…'
                          : 'Waiting for confirmation…',
                    );
                    return publicClient.waitForTransactionReceipt({ hash: hash as Hex, timeout: 180_000 });
                  },
                  onBroadcast,
                );
                if (kind === 'approval') approvalSent = true;
                return result;
              },
              // EIP-5792: approve and swap in one atomic wallet call where this
              // wallet supports it on this chain (MetaMask, Coinbase Wallet).
              // Null, with nothing sent, everywhere else, and the flow above
              // runs step by step as before.
              submitBatch: async (txs, onBroadcast) => {
                if (!live()) throw new Error(`This deposit was superseded (the modal was closed or reopened). ${nothingSent()}`);
                // beforeSwapSubmit has already saved the provisional blind
                // claim backup. onSwapBroadcast re-keys it when the batch
                // exposes its hash, including when that happens only at mining.
                const result = await submitAtomicBatch(
                  {
                    getCapabilities: async (id) => {
                      const caps = await getCapabilities(wagmiConfig, { chainId: id as never });
                      return caps as unknown as Record<string, unknown>;
                    },
                    sendCalls: async ({ chainId: id, calls }) => {
                      // The capability read was async: a modal closed or reopened
                      // meanwhile must not open a signing prompt for this route.
                      if (!live()) throw new BatchNotSubmittedError(`This deposit was superseded (the modal was closed or reopened). ${nothingSent()}`);
                      const account = getAccount(wagmiConfig);
                      if (account.address?.toLowerCase() !== connectedAddress.toLowerCase() || account.chainId !== id) {
                        throw new BatchNotSubmittedError('Wallet or network changed. Continue with the original wallet and network.');
                      }
                      setLoadingMessage('Approve and swap in one step (sign in wallet)…');
                      return await sendCalls(wagmiConfig, {
                        account: connectedAddress,
                        chainId: id as never,
                        forceAtomic: true,
                        calls: calls.map((call) => ({
                          to: call.to as ViemAddress,
                          data: call.data as Hex,
                          value: call.value ? BigInt(call.value) : 0n,
                        })),
                      });
                    },
                    getCallsStatus: async (id) => {
                      setLoadingMessage('Waiting for confirmation…');
                      return await getCallsStatus(wagmiConfig, { id });
                    },
                  },
                  { chainId, calls: txs, onBroadcast },
                );
                return result;
              },
            },
          );
          log('info', 'Deposit', 'Swap-and-deposit confirmed', {
            txHash: swapHash,
            sourceChainId: chainId,
            depositChainId,
            payToken: payToken.symbol,
            estimatedInput: prepared.estimatedInputAmount,
          });
          if (swapHash) setTxHash(swapHash);
          if (swapHash) setTxChainId(chainId);
          // The same optimistic row the ordinary deposit adds, which this path
          // never had: the client already knows what it deposited and where, so
          // the row can be shown from local state without asking anyone. That
          // is what closes Mike's 190 seconds, and it closes it to zero rather
          // than to a faster poll, because it costs no request at all.
          //
          // Keyed on the DEPOSIT chain: a cross-chain shield's note belongs to
          // the destination bucket, the same rule exportAccount follows below.
          // `pools-provider` merges it and drops it the moment a feed row
          // carries the same (chain, tx hash, deposit) — services/feed-reconciliation.ts.
          //
          // A depositFor is the RECIPIENT's deposit, so the payer gets no row;
          // same rule as the ordinary path, for the same reason.
          //
          // Filed under the note's own asset: a share note (ppETH, ppUSDC) is
          // named, valued and scaled as the share, taken together from the SDK's
          // pendingNote, so a swap into ppETH is no longer shown as pending in
          // the legacy ETH pool (services/feed-reconciliation.ts
          // swapDepositPendingAsset). Without that note it stays in the chosen
          // asset, measured in its own decimals. The feed row replaces this one
          // on (chain, tx hash, deposit), a key the asset is no part of.
          // The amount the user confirmed, which a bridged refit can make
          // smaller than the one typed.
          if (swapHash) addSwapPendingRow(swapHash, prepared.pendingNote, depositedWei);
          // The SDK writes the note inside executeSwapAndDeposit, which we
          // don't call, so write it here from what we know, as the ordinary
          // deposit path does. Within one chain the deposit is in the swap
          // transaction our own wallet sent, so its block gives the note's
          // timestamp. Across chains the bridge mints it later on the other
          // chain, and that chain's discovery finds it.
          if (swapHash && !recipientMode && depositChainId === chainId && prepared.pendingNote?.isOwned !== false) {
            try {
              const swapReceipt = await publicClient.getTransactionReceipt({ hash: swapHash as Hex });
              await recordOwnDepositNote(prepared.pendingNote, swapHash as Hex, swapReceipt.blockNumber);
            } catch (noteErr) {
              log('warn', 'Deposit', 'Could not write the swap-deposit note locally; discovery will pick it up', noteErr);
            }
          }
          // Then persist the session. Without this the pending note is lost on
          // reload and only discovery would recover it.
          try {
            // depositChainId, not chainId: a cross-chain note belongs to the
            // destination chain's bucket, which is the only place the balance
            // and activity views read it from.
            await exportAccount(depositSession, { chainId: depositChainId });
          } catch (persistErr) {
            log('error', 'Deposit', 'Failed to persist account after swap-deposit. Notes may be stale after reload', persistErr);
          }
          // This device shielded in this tx (services/own-actions-core.ts): the
          // new note is a Deposit row, never a swap, and the record keeps what
          // the wallet paid for it (services/swap-bookkeeping.ts). A swap FOR
          // someone else is theirs, not ours: stamp it as an outgoing deposit
          // instead, as the plain depositFor does.
          if (swapHash && !recipientMode) {
            try {
              recordShieldSwap({
                sourceChainId: chainId,
                depositChainId,
                txHash: String(swapHash),
                inputToken: payToken.address,
                estimatedInput: prepared.estimatedInputAmount,
                note: prepared.pendingNote ? { commitment: String((prepared.pendingNote as { commitment?: unknown }).commitment ?? '') || null } : null,
                now: Date.now(),
              }, { recordOwnAction, recordSwap });
            } catch { /* local bookkeeping is best-effort; the deposit succeeded */ }
          }
          if (swapHash && recipientMode && connectedAddress) {
            recordOutgoingDeposit({
              payer: connectedAddress.toLowerCase(),
              chainId: depositChainId,
              txHash: String(swapHash).toLowerCase(),
              kind: 'deposit-for',
              timestamp: Date.now(),
            });
          }
          try { await refreshNotes(); } catch { /* balances refresh best-effort */ }
          try {
            await invalidateTransactionCaches(queryClient);
          } catch { /* cache refresh best-effort */ }
          // Cross-chain only: the source tx confirming proves the bridge was
          // dispatched, not that anything arrived. Track it so the success card
          // can say where it actually is, and so the balance refresh can be
          // driven by delivery instead of a guess at how long bridges take.
          if (depositChainId !== chainId && swapHash) {
            const scan = lifiScanUrl(String(swapHash));
            setBridgeProgress({ tone: 'pending', text: 'Checking bridge status…', ...(scan ? { lifiScanUrl: scan } : {}) });
            setBridgeWatch({
              txHash: swapHash,
              fromChainId: chainId,
              toChainId: depositChainId,
              // Our own pending note only: a recipient's is not in this session.
              ...(prepared.pendingNote?.commitment && !recipientMode ? { pendingCommitment: String(prepared.pendingNote.commitment) } : {}),
            });
          }
          if (live()) setStep('success');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log('error', 'Deposit', `Swap-and-deposit failed: ${message}`, err);
          // The deposit can land in a share (conversionDepositTarget routes to
          // the vault router), and the SDK's minimum is then in SHARE units: the
          // same units map as the plain deposit path below, resolved for the
          // deposit chain. Configured twins, as there: this only names units.
          const swapUnitsYield = selectedToken.isNative
            ? getConfiguredNativeYieldDeployment(depositChainId)
            : getConfiguredYieldDepositDeploymentForUnderlying(depositChainId, selectedToken.address);
          const swapOutputUnits = swapUnitsYield
            ? { symbol: swapUnitsYield.underlyingSymbol, decimals: swapUnitsYield.ppUSDCDecimals }
            : { symbol: selectedToken.symbol, decimals: selectedToken.decimals };
          // A swap that reverted shielded nothing: its row comes down. Any
          // other failure after broadcast may still land, so the row stays and
          // the feed reconciles it.
          if (broadcastSwapHash && err instanceof SwapDepositPreflightError && /reverted/i.test(message)) {
            removePendingOwnRow(depositChainId, broadcastSwapHash);
          }
          // An error the orchestrator raised has already been written: it
          // carries what went out, what allowance is standing, and whether
          // setting it back to zero went through. Rewriting it here is how
          // that got lost — the word "rejected" appears in the middle of a
          // message whose point is the allowance that still needs revoking,
          // and the pattern match replaced the whole thing. Match on the error
          // TYPE instead of the text, and only reword what this component
          // itself has to explain.
          const orchestrated = err instanceof SwapDepositPreflightError
            || err instanceof UnexpectedSwapTxError;
          reportDepositError(
            orchestrated
              ? message
              // The SDK re-checks a registered recipient's viewing key before
              // proving, as it does for a plain depositFor.
              : err instanceof Error && err.name === 'DepositRecipientViewingKeyUnregistered'
                ? RECIPIENT_UNREGISTERED_MESSAGE
              : /reject|denied|cancel/i.test(message)
                ? `Transaction was rejected. Nothing was swapped or deposited.${approvalSent ? ' The approval before it already mined and cost gas.' : ''}`
                : isNoRouteError(err)
                  ? `No route can deliver that amount after fees. ${nothingSent()} Try a different amount.`
                  // SDK figures (e.g. "Deposit value … is below the Entrypoint
                  // minimum …") in units, not base units (DEV-430). Same units
                  // map as the plain deposit path below.
                  : `Swap deposit failed: ${sdkErrorText(err, {
                    input: payToken ? { symbol: payToken.symbol, decimals: payToken.decimals } : null,
                    swapInput: payToken ? { symbol: payToken.symbol, decimals: payToken.decimals } : null,
                    funding: { symbol: selectedToken.symbol, decimals: selectedToken.decimals },
                    output: swapOutputUnits,
                  }, message)}`,
          );
          setStep('deposit');
        }
        // No endTx() here — returning out of the try still runs the outer
        // finally, and calling it twice would unbalance the tx-activity gate
        // and leave background polling paused (or resumed early).
        return;
      }

      log('debug', 'Deposit', 'Calling prepareDeposit', {
        tokenId,
        value: amountHex,
        ownerAddress: depositOwnerAddress,
        payerAddress: connectedAddress,
        chainId,
      });
      depositErrorReportRef.current.phase = 'proof';
      setLoadingMessage('Generating proof...');

      // Aave yield routing: flag ON + deployment configured + toggle left ON →
      // build the deposit through the SDK yield session (a standard ppUSDC
      // deposit proof re-targeted at PPRouter.depositExactShares, plus a
      // USDC→router approval sized to the app spend cap, budget + wrap headroom). Any
      // other state takes the exact pre-existing path in the else branch.
      // Re-read the VERIFIED gate at the moment money moves, not the render-time
      // memo. The memo is what the toggle shows; this is what decides where the
      // deposit goes, and it must never be the stale side of a probe race. If
      // the vault failed verification since render, this is false and the
      // deposit shields plainly, which is the safe outcome.
      // ONE live deployment object for everything that follows (namespace,
      // spender, token, logging): the render-time memo may be a probe flip
      // behind (codex, 2026-09-04).
      const liveDeployment = selectedToken.isNative
        ? getNativeYieldDepositDeployment(depositChainId)
        : getYieldDepositDeploymentForUnderlying(depositChainId, selectedToken.address);
      // Re-read, like liveDeployment: a probe that flipped since render decides
      // this too, and it is what says "no approval, fund with value" below.
      const liveYieldIsNative = selectedToken.isNative && liveDeployment?.nativeMode === true;
      const useYieldPath = yieldAvailable && yieldOn && !!liveDeployment;
      depositErrorReportRef.current.isYield = useYieldPath;
      // Vault deposits paused: an asset whose deposits land in a vault is
      // refused here, before anything is prepared, and never shielded plainly
      // into the closed or superseded pool. The configured route (not the
      // verified one) decides, so a pending probe cannot slip past it.
      if (yieldDepositsPaused() && (selectedToken.isNative
        ? getConfiguredNativeYieldDeployment(depositChainId) !== undefined
        : getConfiguredYieldDepositDeploymentForUnderlying(depositChainId, selectedToken.address) !== undefined)) {
        throw new Error(VAULT_DEPOSITS_PAUSED_MESSAGE);
      }
      // The native coin on a chain with a CONFIGURED native-mode route has one
      // way in: the router. If the verified route is not available right now
      // (probe pending or failed) the deposit is refused, never shielded plainly
      // into the superseded legacy pool (Pat, 2026-09-18).
      if (plainNativeDepositRefused({
        isNative: selectedToken.isNative,
        nativeRouteConfigured: getConfiguredNativeYieldDeployment(depositChainId) !== undefined,
        viaYieldRoute: useYieldPath && liveYieldIsNative,
      })) {
        throw new Error(` deposits on this network go through the yield vault, which is not verified right now. Nothing was sent; try again in a moment.`);
      }
      if (!useYieldPath && !selectedToken.isNative && getKnownTokenMetadata(selectedToken.address, depositChainId)?.withdrawOnly) {
        // A closed asset with no verified wrapper right now: never a plain deposit.
        throw new Error(`Deposits of ${displayTokenSymbol(selectedToken.symbol)} are closed on this network and its yield vault is not verified right now. Nothing was sent; try again in a moment.`);
      }
      let yieldPrep: Awaited<ReturnType<NonNullable<typeof session.yield>['deposit']['prepareYieldDeposit']>> | null = null;
      let yieldApprovalCap: bigint | null = null;
      // LAST pre-mutation gate (codex): prepareDeposit durably exports a pending
      // note the moment it runs — after this point the operation is COMMITTED
      // and proceeds to broadcast even if the modal closes (only its UI writes
      // are epoch-guarded).
      if (!live()) { releaseTx(); log('warn', 'Deposit', 'Stale run aborted before prepare'); return; }
      let result;
      if (useYieldPath) {
        // Re-check the exit at the moment money moves: the relayer must list the
        // share, or the note minted here could only leave by ragequit.
        depositErrorReportRef.current.phase = 'relayer-check';
        const exitVerdict = relayerAssetSupport(await fetchRelayerAssetAddresses(depositChainId), liveDeployment!.ppUSDC);
        if (exitVerdict !== 'supported') {
          const refusal = relayerShareExitMessage(exitVerdict, displayTokenSymbol(liveDeployment!.underlyingSymbol)) + ' Nothing was sent.';
          throw exitVerdict === 'unknown' ? new RelayerUnavailableError(refusal) : new Error(refusal);
        }
        depositErrorReportRef.current.phase = 'proof';
        const yieldNs = resolveYieldNamespace(session, liveDeployment!, depositChainId);
        // Underlying the router may pull: budget + wrap headroom (sizeWrapDeposit).
        let yieldSpendCap = amountWei;
        try {
          // Size the shares from the entered USDC budget EXACTLY. The SDK's
          // sharesForUnderlying knocked 0.5% off as a slippage cushion, and since
          // the shares are the fixed leg (they are inside the proof) that cushion
          // was a 0.5% under-deposit: 100 USDC bought 99.49 ppUSDC and 0.50 stayed
          // in the wallet (Ameen + Pat, mainnet, 2026-09-05). A wrap has no
          // slippage; only accrual and rounding move the price, and that
          // headroom now lives in the spend cap (services/yield-deposit-safety.ts).
          const previewShares = await yieldNs.token.previewDeposit(amountWei);
          const sized = sizeWrapDeposit({
            underlying: amountWei,
            // On the native route the spend cap IS msg.value, so the gas for
            // this very transaction has to stay outside it. An ERC-20 deposit
            // pays gas from a balance the allowance never touches; here the
            // headroom branch would otherwise size the cap up to the last wei
            // and the send would fail for gas before the router saw it.
            walletBalance: liveYieldIsNative
              ? (walletBalanceWei > gasReserveWei ? walletBalanceWei - gasReserveWei : 0n)
              : walletBalanceWei,
            previewShares,
            vettingFeeBps: depositVettingFeeBps != null ? BigInt(depositVettingFeeBps) : 0n,
          });
          const shares = sized.shares;
          yieldSpendCap = sized.spendCap;
          yieldPhase = 'prepared';
          log('debug', 'Deposit', 'Calling prepareYieldDeposit', {
            underlyingAmount: amountWei.toString(),
            spendCap: sized.spendCap.toString(),
            shares: shares.toString(),
            ppRouter: liveDeployment!.ppRouter,
          });
          if (recipientMode) {
            // FOR SOMEONE ELSE (DEV-451). The SDK's yield deposit has no
            // recipient, so prove a plain depositFor of the SHARE token and
            // re-target it at the router, which forwards the proof unchanged.
            // The note is in shares of the share token: a blind claim's backup
            // must name those, not the underlying the early build used.
            const shareTokenId = liveDeployment!.ppUSDC.toLowerCase() as ViemAddress;
            const sharesHex = `0x${shares.toString(16)}` as Hex;
            if (blindNoteSecret && blindDepositSecret && blindSenderViewingPubKey) {
              const { createCryptoService, createNoteComputationService } = await import('@/services/sdk-runtime');
              const noteComputation = await createNoteComputationService();
              blindBackup = buildBlindDepositBackup({
                recipient: depositRecipientAddr as ViemAddress,
                tokenId: shareTokenId,
                value: sharesHex,
                noteSecret: blindNoteSecret,
                depositSecret: blindDepositSecret,
                senderViewingPubKey: blindSenderViewingPubKey,
                noteComputation,
                crypto: createCryptoService(),
                randomFill: webRandomFill,
              });
              blindNoteAddressHash = blindBackup.noteAddressHash;
              claimNote = { tokenId: shareTokenId, value: sharesHex };
            }
            if (!live()) { releaseTx(); log('warn', 'Deposit', 'Stale run aborted before the yield depositFor'); return; }
            let preparedFor;
            try {
              preparedFor = await session.prepareDepositFor(
                blindNoteAddressHash !== null && blindBackup !== null
                  ? {
                      tokenId: shareTokenId,
                      value: sharesHex,
                      noteAddressHash: blindNoteAddressHash,
                      noteData: blindBackup.noteData,
                      depositSecret: blindBackup.depositSecret,
                    }
                  : {
                      tokenId: shareTokenId,
                      value: sharesHex,
                      discoveryData: { evmAddress: depositRecipientAddr as ViemAddress },
                    },
              );
            } catch (prepareForErr) {
              if (prepareForErr instanceof Error && prepareForErr.name === 'DepositRecipientViewingKeyUnregistered') {
                throw new Error(RECIPIENT_UNREGISTERED_MESSAGE);
              }
              throw prepareForErr;
            }
            if (!publicClient) throw new Error('No connection to this network to price the deposit. Nothing was sent. Try again.');
            // The router's own quote for these shares: the same read the SDK's
            // self deposit takes, and what the spend cap must cover.
            const [underlyingNeeded] = await publicClient.readContract({
              address: liveDeployment!.ppRouter as ViemAddress,
              abi: PP_ROUTER_QUOTE_ABI,
              functionName: 'quote',
              args: [shares],
            }) as readonly [bigint, bigint];
            yieldPrep = toYieldDepositFor(preparedFor, {
              router: liveDeployment!.ppRouter,
              shares,
              spendCap: yieldSpendCap,
              underlyingNeeded,
              native: liveYieldIsNative,
            }) as unknown as Awaited<ReturnType<NonNullable<typeof session.yield>['deposit']['prepareYieldDeposit']>>;
            log('info', 'Deposit', 'Yield deposit for another address prepared', {
              blind: blindBackup !== null,
              shares: shares.toString(),
            });
          } else {
            yieldPrep = await yieldNs.deposit.prepareYieldDeposit({
              value: shares,
              // Our cap goes into the calldata, so the router's own PPRouter_SlippageExceeded
              // enforces it (SDK PR #398); the exact allowance below is the second lock.
              maxUnderlyingIn: yieldSpendCap,
            });
          }
        } catch (prepareErr) {
          const prepMsg = prepareErr instanceof Error ? prepareErr.message : String(prepareErr);
          log('error', 'Deposit', `prepareYieldDeposit threw: ${prepMsg}`, { err: prepareErr });
          throw prepareErr;
        }
        if (!yieldPrep) throw new Error('prepareYieldDeposit returned nothing.');
        // The SDK binds our cap into the calldata (PR #398). Bind the app's exact allowance to the
        // spend cap (budget + wrap headroom), and refuse a stale/wrong router or
        // a live quote that already exceeds that cap before any signature.
        ({ approvalCap: yieldApprovalCap } = validatePreparedYieldDeposit(
          yieldPrep,
          yieldSpendCap,
          liveDeployment!.ppRouter,
        ));
        if (live()) {
          setPreparedYieldExitDisclosure(yieldExitDisclosure(displayTokenSymbol(liveDeployment!.underlyingSymbol.toUpperCase())));
        }
        // Normalize to the shape the shared submit path below consumes.
        // Native (ppETH): funded with the spend cap as msg.value — which the
        // router treats as the ceiling and refunds down to the quote in the
        // same transaction. No approvalTx: there is no ERC-20 leg to approve,
        // and the allowance lock above does not apply.
        // Since the SDK gained `nativeMode` it builds the payable entry itself,
        // so this call now usually just validates and passes that through; it
        // still re-encodes from the SAME proof and note for an SDK that only
        // produced the ERC-20 form (services/yield-native-deposit.ts).
        const nativeTx = liveYieldIsNative
          ? toNativeYieldDeposit(yieldPrep, { router: liveDeployment!.ppRouter, spendCap: yieldSpendCap })
          : null;
        if (nativeTx) {
          log('debug', 'Deposit', 'Converted the yield deposit to the native entry', {
            ppRouter: liveDeployment!.ppRouter,
            value: yieldSpendCap.toString(),
          });
        }
        result = nativeTx
          ? {
              pendingNote: yieldPrep.pendingNote,
              to: nativeTx.to,
              callData: nativeTx.data,
              msgValue: nativeTx.value,
              approvalTx: undefined,
            }
          : {
              pendingNote: yieldPrep.pendingNote,
              to: yieldPrep.depositTx.to,
              callData: yieldPrep.depositTx.data,
              msgValue: yieldPrep.depositTx.value,
              approvalTx: yieldPrep.approvalTx,
            };
      } else try {
        const prepared = recipientMode
          ? await session.prepareDepositFor(
              // Blind cold-start when the recipient has no viewing key to
              // announce to; the ordinary discoverable form otherwise.
              blindNoteAddressHash !== null && blindBackup !== null
                ? {
                    tokenId,
                    value: amountHex,
                    noteAddressHash: blindNoteAddressHash,
                    // Our announcement and our deposit secret. The SDK binds the
                    // proof context to this noteData and derives the label from
                    // this secret, so what we announced is what gets committed.
                    noteData: blindBackup.noteData,
                    depositSecret: blindBackup.depositSecret,
                  }
                : {
                    tokenId,
                    value: amountHex,
                    discoveryData: { evmAddress: depositRecipientAddr as ViemAddress },
                  },
            )
          : await session.prepareDeposit({
              tokenId,
              value: amountHex,
            });
        // The split SDK returns the deposit as one prepared tx (`depositTx`)
        // instead of flat to/callData/msgValue. Same bytes, so flatten it into
        // the shape the shared submit path below consumes.
        result = {
          pendingNote: prepared.pendingNote,
          to: prepared.depositTx.to,
          callData: prepared.depositTx.data,
          msgValue: prepared.depositTx.value,
          approvalTx: prepared.approvalTx ?? undefined,
        };
      } catch (prepareErr) {
        // The SDK re-checks the recipient's viewing key right before proving.
        // The vendored build does not export the class, so match by name.
        if (prepareErr instanceof Error && prepareErr.name === 'DepositRecipientViewingKeyUnregistered') {
          throw new Error(RECIPIENT_UNREGISTERED_MESSAGE);
        }
        const prepMsg = prepareErr instanceof Error ? prepareErr.message : String(prepareErr);
        const prepStack = prepareErr instanceof Error ? prepareErr.stack : undefined;
        log('error', 'Deposit', `prepareDeposit threw: ${prepMsg}`, {
          stack: prepStack,
          err: prepareErr,
        });
        if (typeof console !== 'undefined' && console.error) {
          console.error('[Deposit] prepareDeposit raw error:', prepareErr);
        }
        throw prepareErr;
      }

      log('debug', 'Deposit', 'prepareDeposit returned', {
        hasResult: !!result,
        hasCallData: !!result?.callData,
        hasApprovalTx: !!result?.approvalTx,
        to: result?.to,
        msgValue: result?.msgValue,
      });

      const preparedAccount = await session.exportAccount();
      log('info', 'Deposit', 'Session state after prepareDeposit', {
        noteCount: preparedAccount.notes.length,
        notes: preparedAccount.notes.map((note) => ({
          commitment: note.commitment,
          tokenId: note.tokenId,
          status: note.status,
          value: note.value,
          txHash: note.txHash,
        })),
      });
      try {
        await exportAccount(session);
      } catch (persistErr) {
        log('error', 'Deposit', 'Failed to persist account after prepareDeposit - notes may be stale after reload', persistErr);
      }

      log('info', 'Deposit', 'prepareDeposit succeeded', {
        to: result.to,
        msgValue: result.msgValue,
        hasApprovalTx: !!result.approvalTx,
      });

      const assertDepositWallet = () => {
        const account = getAccount(wagmiConfig);
        if (!live() || account.address?.toLowerCase() !== connectedAddress.toLowerCase() || account.chainId !== chainId) {
          throw new BatchNotSubmittedError('Wallet or network changed. Continue with the original wallet and network.');
        }
      };
      // Wallet-local capability read only. No public feed or note-derived RPC.
      const walletCaps = !selectedToken.isNative
        ? await walletCapabilities(connector, connectedAddress) : null;
      const chainCaps = (walletCaps as Record<string, Record<string, unknown>> | null)?.[`0x${chainId.toString(16)}`];
      assertDepositWallet();
      const depositApprovals: BatchCall[] = [];
      const approveTokens = async (defer: boolean) => {
        // Step 1: Submit approval tx if needed (ERC-20 tokens).
        //
        // The SDK prepares approvals against the session owner. In key-owned
        // deposit mode the token source is the connected wallet payer instead, so
        // validate allowance for the actual tx sender before sending.
        // Not on the native route: msg.value funds the router, so there is no
        // ERC-20 to approve. Approving WETH here would prompt the user for an
        // allowance that the call they are about to sign never uses.
        if (yieldPrep && liveDeployment && yieldApprovalCap !== null && !liveYieldIsNative) {
          // Yield path: force the payer's underlying→router allowance to EXACTLY
          // the app cap even when an older/infinite allowance is already larger.
          // That exact allowance is the second bound beside the caller-supplied
          // calldata cap (SDK PR #398); an older SDK build still reverts on it.
          const approvalCap = yieldApprovalCap;
          const payerAllowance = await publicClient.readContract({
            address: liveDeployment.underlying as ViemAddress,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [connectedAddress, liveDeployment.ppRouter as ViemAddress],
          }) as bigint;
          log('debug', 'Deposit', 'Checked payer allowance for yield router', {
            payerAllowance: payerAllowance.toString(),
            maxUnderlyingIn: yieldPrep.maxUnderlyingIn.toString(),
            approvalCap: approvalCap.toString(),
          });
          const submitYieldApproval = async (value: bigint, message: string) => {
            depositErrorReportRef.current.phase = 'approve';
            setLoadingMessage(message);
            const approvalHash = await sendWalletTx({
              chainId,
              to: liveDeployment.underlying as ViemAddress,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'approve',
                args: [liveDeployment.ppRouter as ViemAddress, value],
              }) as Hex,
              value: 0n,
            });
            log('info', 'Deposit', 'Yield approval tx submitted, waiting for confirmation', {
              approvalHash,
              value: value.toString(),
            });
            setLoadingMessage('Waiting for approval confirmation...');
            const approvalReceipt = await publicClient.waitForTransactionReceipt({
              hash: approvalHash,
              timeout: 180_000,
            });
            if (approvalReceipt.status !== 'success') {
              approvalSent = true;
              throw new Error('Token approval transaction reverted on-chain. It still cost gas.');
            }
            approvalSent = true;
          };

          const approvalValues = yieldApprovalValues(
            payerAllowance,
            approvalCap,
            selectedToken.symbol,
          );
          if (defer && approvalValues.length > 0) {
            depositApprovals.push(...buildDepositApprovalCalls(liveDeployment.underlying as ViemAddress, liveDeployment.ppRouter as ViemAddress, payerAllowance > 0n && approvalValues[0] !== 0n ? [0n, ...approvalValues] : approvalValues));
            return;
          }
          if (approvalValues.length === 1) {
            try {
              await submitYieldApproval(approvalValues[0], 'Set the token approval to the reviewed amount.');
            } catch (approvalErr) {
              // Some ERC-20s reject a non-zero→non-zero approval even when they
              // are not named USDT. Retry only a contract-style failure. A user
              // rejection or an RPC timeout never triggers surprise prompts.
              if (payerAllowance === 0n || !approvalErrorAllowsZeroReset(approvalErr)) throw approvalErr;
              await submitYieldApproval(0n, 'This token requires clearing its existing approval. Approve 0 first.');
              await submitYieldApproval(approvalCap, 'Now approve the reviewed amount.');
            }
          } else {
            for (const value of approvalValues) {
              await submitYieldApproval(
                value,
                value === 0n
                  ? 'This token requires clearing its existing approval. Approve 0 first.'
                  : 'Now approve the reviewed amount.',
              );
            }
          }

          // Receipt success is not the invariant. Read the actual allowance and
          // require equality, including after an approve-down from infinity.
          const postAllowance = await publicClient.readContract({
            address: liveDeployment.underlying as ViemAddress,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [connectedAddress, liveDeployment.ppRouter as ViemAddress],
          }) as bigint;
          if (postAllowance !== approvalCap) {
            throw new Error('Token approval could not be set to the reviewed spend limit. The deposit was not attempted.');
          }
          log('info', 'Deposit', 'Exact yield approval confirmed', { postAllowance: postAllowance.toString() });
        } else if (!selectedToken.isNative) {
          const entrypointAddress = result.to as ViemAddress;
          const assetConfig = await publicClient.readContract({
            address: entrypointAddress,
            abi: ENTRYPOINT_ASSETS_ABI,
            functionName: 'assets',
            args: [tokenId],
          }) as EntrypointAssetConfig;
          const feeBPS = getVettingFeeBPS(assetConfig);
          const requiredAllowance = amountWei + ((amountWei * feeBPS) / 10_000n);
          const payerAllowance = await publicClient.readContract({
            address: tokenId,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [connectedAddress, entrypointAddress],
          }) as bigint;

          log('debug', 'Deposit', 'Checked payer ERC-20 allowance', {
            tokenId,
            payer: connectedAddress,
            entrypoint: entrypointAddress,
            payerAllowance: payerAllowance.toString(),
            requiredAllowance: requiredAllowance.toString(),
            sdkHadApprovalTx: !!result.approvalTx,
          });

          if (payerAllowance < requiredAllowance) {
            if (defer) {
              // Reset a prior partial allowance inside the same atomic batch,
              // including for tokens that reject non-zero to non-zero approval.
              depositApprovals.push(...buildDepositApprovalCalls(tokenId, entrypointAddress, payerAllowance > 0n ? [0n, requiredAllowance] : [requiredAllowance]));
              return;
            }
            depositErrorReportRef.current.phase = 'approve';
            setLoadingMessage('Requesting token approval...');
            log('info', 'Deposit', 'Submitting payer approval transaction', {
              tokenId,
              payer: connectedAddress,
              entrypoint: entrypointAddress,
              amount: requiredAllowance.toString(),
            });

            const approvalHash = await sendWalletTx({
              chainId,
              to: tokenId,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'approve',
                args: [entrypointAddress, requiredAllowance],
              }) as Hex,
              value: 0n,
            });

            log('info', 'Deposit', 'Approval tx submitted, waiting for confirmation', { approvalHash });
            setLoadingMessage('Waiting for approval confirmation...');

            const approvalReceipt = await publicClient.waitForTransactionReceipt({
              hash: approvalHash,
              timeout: 180_000,
            });
            // A REVERTED approval must stop the flow (codex round 1): the
            // deposit below would just revert too, after burning the user's
            // gas on a doomed transaction.
            if (approvalReceipt.status !== 'success') {
              approvalSent = true;
              throw new Error('Token approval reverted on-chain. It still cost gas, and the deposit was not attempted.');
            }
            approvalSent = true;

            // Trust the ALLOWANCE, not the receipt (code review 2026-08-27).
            // MetaMask and friends let the user edit the spending cap in the
            // prompt, so a *successful* receipt can encode a cap BELOW what this
            // deposit needs — and the deposit below would then be guaranteed to
            // revert, burning the user's gas for nothing. Same guard the yield
            // branch above already had.
            const postAllowance = await publicClient.readContract({
              address: tokenId,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [connectedAddress, entrypointAddress],
            }) as bigint;
            if (postAllowance < requiredAllowance) {
              throw new Error(
                `The approved spending cap (${formatUnits(postAllowance, selectedToken.decimals)} ${displayTokenSymbol(selectedToken.symbol)}) is lower than this deposit needs (${formatUnits(requiredAllowance, selectedToken.decimals)} ${displayTokenSymbol(selectedToken.symbol)}). If you edited the amount in your wallet's approval prompt, approve the full amount and try again. The deposit was not submitted.`,
              );
            }

            log('info', 'Deposit', 'Approval confirmed', { postAllowance: postAllowance.toString() });
          }
        }

      };
      await approveTokens(supportsAtomicBatch(chainCaps));

      // Step 2: Submit deposit tx
      depositErrorReportRef.current.phase = 'submit';
      setLoadingMessage('Submitting deposit transaction...');
      log('info', 'Deposit', 'Submitting deposit transaction', {
        to: result.to,
        msgValue: result.msgValue,
      });

      // Revert diagnostics: dump the exact tx and dry-run it via eth_call so
      // a revert reason lands in the console instead of only showing as a
      // generic warning inside the wallet's simulator.
      const callData = result.callData as Hex;
      console.log('[Deposit][debug] tx about to send', {
        chainId,
        from: connectedAddress,
        to: result.to,
        msgValue: result.msgValue,
        msgValueEth: formatUnits(BigInt(result.msgValue), 18),
        amountEntered: amount,
        amountWei: amountWei.toString(),
        selector: callData?.slice(0, 10),
        dataLength: callData?.length,
        pendingNoteCommitment: result.pendingNote?.commitment,
      });
      // The dry run is a GATE now, but only for one of its two failure modes
      // (code review 2026-08-27 — see classifySimulationFailure):
      //
      //   - the node ran the call and the EVM reverted → refuse to broadcast.
      //     The tx cannot succeed, and sending it only burns gas. This matches
      //     services/swap-flows.ts, which already refuses to submit a swap its
      //     post-approval simulation says will revert.
      //   - the call could not be performed (429 / timeout / dropped socket)
      //     → log and proceed. It is not evidence about the transaction, and
      //     hard-stopping here would block legitimate deposits on an RPC blip;
      //     the public OP endpoint 429s ordinary session traffic already
      //     (QA 2026-08-20).
      //
      // A revert is confirmed with a second call before it blocks: the first
      // can land on a replica lagging behind the approval we just mined, which
      // is the one false positive that would otherwise stop a good deposit.
      if (useYieldPath) yieldPhase = 'deposit';
      const simulateDeposit = async () => {
        let simulationRevertDetail: string | null = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await publicClient.call({
              account: connectedAddress as ViemAddress,
              to: result.to as ViemAddress,
              data: callData,
              value: BigInt(result.msgValue),
            });
            console.log('[Deposit][debug] eth_call simulation OK. Tx should not revert');
            simulationRevertDetail = null;
            break;
          } catch (simErr) {
            const { executionReverted, detail } = classifySimulationFailure(simErr);
            if (!executionReverted) {
              console.error('[Deposit][debug] eth_call simulation could not be performed, not blocking:', detail, simErr);
              simulationRevertDetail = null;
              break;
            }
            console.error(`[Deposit][debug] eth_call simulation REVERTED (attempt ${attempt}/2):`, detail, simErr);
            simulationRevertDetail = detail;
          }
        }
        if (simulationRevertDetail) {
          log('error', 'Deposit', 'Pre-submit simulation reverted, deposit not broadcast', {
            to: result.to,
            revert: simulationRevertDetail,
          });
          // Only name the reason when there IS one — a bare revert() gives
          // nothing to quote, and "(no revert data)" helps nobody.
          const reason = simulationRevertDetail === 'no revert data' || simulationRevertDetail === '0x'
            ? ''
            : ` (${simulationRevertDetail})`;
          // An exact-shares deposit whose quote expired while the wallet prompt
          // waited reverts on the allowance/slippage check. Say that, not the
          // raw revert (Ameen, 2026-09-05).
          if (useYieldPath && isExpiredYieldQuoteError(simulationRevertDetail)) {
            throw new Error(`${YIELD_QUOTE_EXPIRED_MESSAGE} ${nothingSent()}`);
          }
          throw new Error(
            `This deposit would revert on-chain${reason}, so it was not submitted.${approvalSent ? ' The approval before it already mined and cost gas.' : ' No gas was spent.'} Check the amount and try again.`,
          );
        }

      };
      // A deferred approval has not mined yet. The wallet simulates the atomic
      // bundle with its approvals; simulating only the deposit would revert.
      if (depositApprovals.length === 0) await simulateDeposit();

      // BEFORE the wallet prompt, for a blind deposit. Nothing on chain will
      // ever point at this recipient, so this secret is the only route to the
      // money, and every step from here on can lose it: the prompt can hang,
      // the receipt wait can time out, the RPC can fail, the tab can close.
      // Writing it after confirmation - which is where this used to be - left
      // a window in which the deposit landed and the secret did not survive
      // (codex, 2026-09-16).
      //
      // The txHash is not known yet, so the record is keyed by a provisional
      // id and rewritten with the real hash the moment the send resolves. A
      // run that dies in between leaves a findable record rather than nothing.
      let blindProvisionalKey: string | null = null;
      if (blindNoteSecret) {
        const commitment = result.pendingNote?.commitment;
        const label = result.pendingNote?.label;
        // Asserted here rather than skipped later: without these the
        // disclosure cannot be built at all, and discovering that after the
        // money moved is too late. The vendored SDK always returns both for
        // the blind form; this is the guard for the day it does not.
        if (!commitment || !label) {
          throw new Error(`Could not prepare the claim details for this recipient. ${nothingSent()} Try again.`);
        }
        // The announcement we built names a lineage (label) and a commitment.
        // The SDK, given our depositSecret and noteData, must have derived the
        // SAME ones - otherwise the proof commits to a note the backup does not
        // describe and a recovered link would be unspendable. Cheap to check,
        // and the only moment it can still be checked before gas is spent.
        if (
          blindBackup &&
          (String(label).toLowerCase() !== blindBackup.label ||
            String(commitment).toLowerCase() !== blindBackup.commitment)
        ) {
          log('error', 'Deposit', 'Blind backup disagrees with the SDK-prepared note; refusing to broadcast', {
            sdkLabel: label, backupLabel: blindBackup.label, sdkCommitment: commitment, backupCommitment: blindBackup.commitment,
          });
          throw new Error(`The prepared deposit did not match its claim backup. ${nothingSent()} Try again.`);
        }
        blindProvisionalKey = `pending:${String(commitment).toLowerCase()}`;
        const provisional = {
          chainId,
          txHash: blindProvisionalKey as Hex,
          commitment,
          ownerAddress: depositRecipientAddr as ViemAddress,
          noteSecret: blindNoteSecret,
          tokenId: claimNote?.tokenId ?? tokenId,
          value: claimNote?.value ?? amountHex,
          label,
        };
        // WARN, do not refuse (Pat, 2026-09-16). The sender's on-chain backup
        // travels inside this very deposit (blindBackup above), so the chain
        // is the durable copy; the local record is the convenience that lets
        // THIS browser re-copy the link without a scan. A browser that cannot
        // hold it still gets the link on the success screen and can recover
        // it later from the row menu. So say so, recommend against, and let
        // the user decide. Nothing is signed while the gate is up; closing the
        // modal declines it (see the resets), and a decline returns to the
        // form quietly.
        if (!recordSentAuditsVerified([provisional as never])) {
          log('warn', 'Deposit', 'Claim disclosure could not be stored locally; asking before sending', { chainId });
          // A run whose modal already closed must not park a promise nobody
          // can answer: the close handler settles only a gate that exists at
          // close time (codex round 4). Stale here means superseded, silently.
          if (!live()) throw new Error(`This deposit was superseded (the modal was closed or reopened). ${nothingSent()}`);
          const approved = await new Promise<boolean>((resolve) => {
            setStorageConfirm({ resolve });
          });
          if (!approved) throw new Error(`Cancelled before signing. ${nothingSent()}`);
          if (!live()) throw new Error(`This deposit was superseded (the modal was closed or reopened). ${nothingSent()}`);
        }
      }

      // Deposit: estimated gas + 20% (a real ETH deposit used 963,277), the
      // budget when the node cannot estimate, never the wallet's own tier.
      const hash = await submitApprovedDeposit({
        getCapabilities: async () => chainCaps,
        sendCalls: async ({ calls }) => {
          assertDepositWallet();
          setLoadingMessage('Confirm approval and deposit in your wallet...');
          return sendCalls(wagmiConfig, { account: connectedAddress, chainId, forceAtomic: true, calls: calls.map(call => ({ to: call.to as ViemAddress, data: call.data as Hex, value: call.value ? BigInt(call.value) : 0n })) });
        },
        getCallsStatus: async id => {
          if (live()) setLoadingMessage('Waiting for deposit confirmation...');
          return getCallsStatus(wagmiConfig, { id });
        },
      }, {
        chainId, approvals: depositApprovals,
        deposit: { to: result.to, data: callData, value: result.msgValue },
        onBroadcast: hash => { if (live()) { setTxHash(hash); setTxChainId(chainId); } },
        fallback: async () => {
          if (depositApprovals.length > 0) {
            assertDepositWallet();
            await approveTokens(false);
            await simulateDeposit();
          }
          assertDepositWallet();
          return sendWalletTx({ chainId, to: result.to as ViemAddress, data: callData, value: BigInt(result.msgValue) }, DEPOSIT_GAS_BUDGET);
        },
      });
      // No live() abort here: by now prepareDeposit and the claim backup may
      // be durable, and the deposit has always gone through once prepared.

      // Re-key the provisional claim record onto the real tx hash, so the row
      // menu's "Copy payment link" finds it. Done immediately after the send
      // resolves and before anything else can throw.
      if (blindProvisionalKey && blindNoteSecret && result.pendingNote?.commitment && result.pendingNote?.label) {
        const settled = {
          chainId,
          txHash: hash as Hex,
          commitment: result.pendingNote.commitment,
          ownerAddress: depositRecipientAddr as ViemAddress,
          noteSecret: blindNoteSecret,
          tokenId: claimNote?.tokenId ?? tokenId,
          value: claimNote?.value ?? amountHex,
          label: result.pendingNote.label,
        };
        const kept = recordSentAuditsVerified([settled as never]);
        if (kept) dropSentAudits(blindProvisionalKey);
        // The link is available from here on, receipt or no receipt.
        setClaimReceiptUrl(buildSentReceiptUrl([settled as never]));
        log('info', 'Deposit', 'Blind deposit claim disclosure stored', { txHash: hash, chainId, kept });
      }

      // SDK rename: PrepareDepositResult.receipt → pendingNote (after the
       // dev refactor that split prepareTransact returns into pending/owned
       // notes). The shape is { pendingNote: OwnedNote | NotOwnedNote, ... }.
      log('info', 'Deposit', 'Deposit tx submitted', { txHash: hash, commitment: result.pendingNote?.commitment });

      // Show the deposit immediately, as OUR pending operation. A yield deposit
      // shields ppUSDC shares (18 decimals), so mirror the exact live deployment
      // used for preparation and name the activity asset as the share, not as
      // underlying USDC.
      //
      // This row used to be injected into the `globalEvents` react-query cache.
      // That forced the feed polls to pause for the whole transaction (a tick
      // replaced the cache and the row vanished before any note existed), and
      // the address-filtered feed could still return the ASP's row for the same
      // deposit under its own eventId and double it. It is a local ledger entry
      // now; pools-provider merges it and drops it the moment any feed row
      // carries the same (chain, tx hash, deposit). services/feed-reconciliation.ts.
      const optimisticAssetAddress = yieldPrep && liveDeployment
        ? liveDeployment.ppUSDC
        : selectedToken.address;
      const optimisticAssetSymbol = yieldPrep && liveDeployment
        ? getKnownTokenMetadata(liveDeployment.ppUSDC, depositChainId)?.symbol
          ?? `pp${liveDeployment.underlyingSymbol.toUpperCase()}`
        : selectedToken.symbol;
      // A depositFor is the RECIPIENT's deposit: no pending row for the payer
      // (it would read as the payer's own pending balance).
      if (!recipientMode) {
        addPendingOwnRow(pendingDepositRow({
          chainId,
          chainName: chainConfig?.displayName || '',
          address: connectedAddress || '',
          txHash: hash,
          amountRaw: yieldPrep
            ? yieldPrep.sharesValue.toString()
            : parseUnits(amount, selectedToken.decimals).toString(),
          tokenAddress: optimisticAssetAddress,
          tokenSymbol: optimisticAssetSymbol,
          denomination: yieldPrep && liveDeployment
            ? liveDeployment.ppUSDCDecimals
            : selectedToken.decimals,
          now: Date.now(),
        }));
      }
      // Roll back the pending row when the tx did not confirm as success: a
      // reverted/indeterminate deposit must not leave a phantom activity row.
      const removeOptimisticDeposit = () => {
        removePendingOwnRow(chainId, hash);
      };

      depositErrorReportRef.current.phase = 'confirm';
      setLoadingMessage('Waiting for deposit confirmation...');
      let receipt;
      try {
        receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: 180_000,
        });
      } catch (waitErr) {
        // Indeterminate (timeout / RPC error): don't declare success. Drop the
        // optimistic row for EVERY deposit (codex round 2: the yield-only
        // rollback left the now-live baseline row as a phantom) and let chain
        // discovery reconcile the note on the next sync.
        removeOptimisticDeposit();
        throw waitErr;
      }
      // A confirmed revert must not persist the note or keep the optimistic
      // row — for EVERY deposit, not only the yield path (codex round 1: the
      // ordinary path used to persist the prepared note and report success on
      // a reverted deposit, showing a shielded balance that never existed).
      if (receipt.status !== 'success') {
        removeOptimisticDeposit();
        throw new Error(useYieldPath
          ? 'Deposit transaction reverted on-chain. No funds were deposited; gas was spent. If it waited a long time in the wallet, the vault rate may have moved: try again for a fresh quote.'
          : 'Deposit transaction reverted on-chain. No funds were deposited.');
      }

      // Persist/update the note with the actual block timestamp and txHash so
      // the SDK can compute the correct state tree leaf
      // (Poseidon(commitment, timestamp)). The manual wallet-send path calls
      // prepareDeposit(), not executeDeposit(), so the app has to do the same
      // NoteManager write the SDK would normally do after receipt.
      // depositFor: the prepared note is the RECIPIENT's (`isOwned: false`) and
      // must never enter this wallet's NoteManager (it would count as balance
      // and persist someone else's secret). Stamp the confirmed tx instead so
      // balances, counts and row actions know this deposit is not ours.
      const persistOwnNote = !recipientMode && result.pendingNote?.isOwned !== false;
      // Remember that THIS device shielded in this tx, so the row classifier
      // labels the note Deposit while the ASP has not indexed the event yet
      // (services/own-actions-core.ts).
      if (persistOwnNote) {
        recordOwnAction({ kind: 'shield', chainId, txHash: String(hash).toLowerCase(), timestamp: Date.now() });
      }
      if (recipientMode && connectedAddress) {
        recordOutgoingDeposit({
          payer: connectedAddress.toLowerCase(),
          chainId,
          txHash: String(hash).toLowerCase(),
          kind: 'deposit-for',
          timestamp: Date.now(),
        });
        log('info', 'Deposit', 'Deposit for another address confirmed and stamped', { txHash: hash, chainId });
      }
      // The blind-deposit claim disclosure is written BEFORE the wallet prompt
      // and re-keyed onto the real hash the moment the send resolves, both
      // above. Nothing is left to do here: by this point the secret is
      // already durable and the link is already on screen.
      if (persistOwnNote) await recordOwnDepositNote(result.pendingNote, hash as Hex, receipt.blockNumber);

      // Publish the persisted note to React BEFORE the event refetch below: the
      // refetch drops the optimistic Deposit row, and the lineage pass in
      // pools-provider can only re-synthesize it from a note it has seen. With
      // the order reversed the row vanished for a beat and came back (Pat,
      // 2026-09-04).
      if (persistOwnNote) refreshNotes();
      // Re-read the local caches so home, pool-detail, and portfolio all
      // reflect the new deposit without a reload. The feeds catch up on their
      // own cadence.
      await invalidateTransactionCaches(queryClient);
      // Hand the row over: the lineage pass builds a Deposit row from the
      // persisted note (funds projection included), published above, so there
      // is no frame with neither row.
      removeOptimisticDeposit();

      const confirmedAccount = await session.exportAccount();
      log('info', 'Deposit', 'Session state after deposit confirmation', {
        noteCount: confirmedAccount.notes.length,
        notes: confirmedAccount.notes.map((note) => ({
          commitment: note.commitment,
          tokenId: note.tokenId,
          status: note.status,
          value: note.value,
          txHash: note.txHash,
        })),
      });
      try {
        await exportAccount(session);
      } catch (persistErr) {
        log('error', 'Deposit', 'Failed to persist account after deposit - notes may be stale after reload', persistErr);
      }
      // No discovery pass here: the note is already written above, approval
      // promotes it locally (sdk-provider), and the grid's own discovery
      // confirms the rest. A pass timed to this confirmation would tell the
      // ASP and the RPC provider which deposit was this client's.
      refreshNotes();
      setTxHash(hash);
      setTxChainId(chainId);
      if (live()) setStep('success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      log('error', 'Deposit', `Deposit failed: ${message}`, {
        name: err instanceof Error ? err.name : typeof err,
        message,
        stack,
        err,
      });
      if (typeof console !== 'undefined' && console.error) {
        // Mirror raw error to the browser console so the user can read the
        // full stack trace with source maps.
        console.error('[Deposit] raw error:', err);
      }

      // Stale runs must not repaint a reopened modal (codex).
      if (!live()) return;
      // User rejection - back to the form ('superseded' from the swap-submit
      // closure reads as a silent return-to-form, not an error)
      if (message.includes('superseded (the modal')) { setStep('deposit'); return; }
      // The user declined the unsaved-claim warning: their choice, not an
      // error. Back to the form with nothing to report.
      if (message.startsWith('Cancelled before signing')) { setStep('deposit'); return; }
      if (
        message.includes('User rejected') ||
        message.includes('User denied') ||
        message.includes('User cancelled')
      ) {
        setStep('deposit');
        reportDepositError(`Transaction was rejected.${approvalSent ? ' The approval before it already mined and cost gas.' : ''}`, err);
        return;
      }

      const resolvedMessage = sdkError && message.includes('SDK initialization did not complete')
        ? sdkError
        : message;
      // An exact-shares yield deposit whose quote expired (wallet-side allowance
      // or slippage revert, or our own pre-submit refusal) reads as the expiry.
      // The SDK re-quotes AFTER proof generation; when that quote has outgrown the cap
      // sized from our earlier previewDeposit, it refuses before anything is signed.
      // That is the rate moving during proving: say so, not "maxUnderlyingIn …".
      if (yieldPhase === 'prepared' && isCapBelowQuoteError(err)) {
        setStep('deposit');
        reportDepositError(`${YIELD_QUOTE_EXPIRED_MESSAGE} ${nothingSent()}`, err, 'yield-quote');
        return;
      }
      if (yieldPhase === 'deposit' && (isExpiredYieldQuoteError(err) || message.startsWith(YIELD_QUOTE_EXPIRED_MESSAGE))) {
        setStep('deposit');
        reportDepositError(message.startsWith(YIELD_QUOTE_EXPIRED_MESSAGE) ? message : YIELD_QUOTE_EXPIRED_MESSAGE);
        return;
      }
      // Units for the figures below come from the chain the deposit LANDS on.
      // `yieldDeployment` is looked up on the wallet's chain, which is the
      // source of a cross-chain shield, so a mainnet vault reached from BNB
      // Chain read as having no share and its 18-decimal minimum printed at
      // USDC's 6 (review on #122). Display only: the route itself is untouched.
      const unitsPoolChain = (!isSui && crossChainPoolIdRef.current) || chainId;
      // The CONFIGURED twins, not the verified resolvers: this only names units
      // for a sentence, and a figure's scale does not depend on whether the
      // vault probe has answered yet (services/__tests__/yield-resolver-split).
      const unitsYield = unitsPoolChain === chainId
        ? yieldDeployment
        : selectedToken.isNative
          ? getConfiguredNativeYieldDeployment(unitsPoolChain)
          : getConfiguredYieldDepositDeploymentForUnderlying(unitsPoolChain, selectedToken.address);
      // The SDK's BelowMinimumAmount is a validation error carrying two hex
      // amounts in the deposit asset's raw units; users read it verbatim in
      // this toast (prod, 2026-09-05). Say the pay-side minimum instead.
      const friendly = friendlyDepositError(message, {
        payMinWei: depositMinPayWei,
        payMinIsEstimate: depositMinIsEstimate,
        payDecimals: selectedToken.decimals,
        paySymbol: selectedToken.symbol,
        poolDecimals: unitsYield?.ppUSDCDecimals ?? selectedToken.decimals,
        poolIsShare: !!unitsYield,
      }, err instanceof Error ? err.name : undefined);
      // An estimate that the SDK just rejected: try for the live rate again so
      // the next attempt shows the real figure.
      if (friendly && depositMinIsEstimate) void refetchMinAssets();
      // Everything the minimum formatter above does not cover goes through the
      // SDK's structured amounts, in the asset each figure is about.
      // `selectedToken` is the deposit TARGET. On a swap-deposit the wallet
      // spends `payToken` instead, so the spend side and the swap leg are in
      // that; formatting them as the target printed 0.01 ETH as a huge USDC
      // figure. The vault router is funded with the target either way, and the
      // deposit lands in the pool asset, or the share.
      const target = { symbol: selectedToken.symbol, decimals: selectedToken.decimals };
      const spent = swapDepositActive && payToken
        ? { symbol: payToken.symbol, decimals: payToken.decimals }
        : target;
      const shown = resolvedMessage === message
        ? sdkErrorText(err, {
          input: spent,
          swapInput: spent,
          funding: target,
          output: unitsYield
            ? { symbol: unitsYield.underlyingSymbol, decimals: unitsYield.ppUSDCDecimals }
            : target,
        }, resolvedMessage)
        : resolvedMessage;
      reportDepositError(friendly ?? `Deposit failed: ${shown}`, err, 'evm-submit');
      setStep('deposit');
    } finally {
      releaseTx();
    }
  }, [
    walletBalanceWei,
    depositVettingFeeBps,
    amount,
    assertCanDeposit,
    chainId,
    walletChainId,
    wagmiConfig,
    validationError,
    depositMinPayWei,
    depositMinIsEstimate,
    refetchMinAssets,
    connectedAddress,
    connector,
    depositOwnerAddress,
    yieldAvailable,
    yieldOptIn,
    yieldDeployment,
    ensureInitialized,
    exportAccount,
    getCommittedManagers,
    isSui,
    isStellar,
    stellarOwner,
    suiSession,
    stellarSession,
    keyOwnedDeposit,
    log,
    openKeystoreRegistrationModal,
    noteManager,
    poolSession,
    publicClient,
    queryClient,
    refreshNotes,
    sdkError,
    sdkReady,
    selectedToken,
    sendWalletTx,
    switchChainAsync,
    beginTx,
    endTx,
    payToken,
    swapDepositActive,
    reportDepositError,
    createCrossChainShieldSession,
    signTypedDataAsync,
  ]);

  // Same-tick double-press guard — see hooks/use-op-lock.ts.
  const handleConfirm = useMemo(() => withOpLock(handleConfirmUnlocked), [withOpLock, handleConfirmUnlocked]);

  // --- Modal open/close ---

  // Native mock mode: no real flow starts from the pretend account.
  const blockMockFlow = useNativeMockBlock();
  const openDepositModal = useCallback((options?: { tokenSymbol?: string; tokenAddress?: string; initialAmount?: string; recipientAddress?: string }) => {
    depositErrorReportRef.current = { phase: 'validate' };
    if (blockMockFlow()) return;
    opEpochRef.current += 1;
    cancelPendingRelaunch();
    // The wallet-picker and seed-derivation gates are EVM session concerns; the
    // Sui session derives its keys from a wallet signature inside deposit().
    if (!isSui) {
      // Disconnected → open the wallet picker instead of a dead modal (QA-4).
      if (!ensureConnected()) return;
      // Keys not derived yet → one-time signature first, then continue here.
      if (!keysReadyRef.current) {
        openSeedDerivationModal({ onSigned: () => openDepositModal(options) });
        return;
      }
    }
    const initialToken = isStellar ? STELLAR_TOKEN_INFOS[0] : isSui ? SUI_TOKEN_INFOS[0] : resolveSupportedToken(options, chainId);
    if (!initialToken) {
      // Refuse in the asset's own name rather than open on ETH (see resolveSupportedToken).
      reportDepositError(cannotShieldMessage(options ?? {}, chainId));
      log('warn', 'Deposit', 'Open refused: asset not depositable on this chain', { chainId, tokenSymbol: options?.tokenSymbol, tokenAddress: options?.tokenAddress });
      return;
    }
    setStep('deposit');
    setAmount(options?.initialAmount ? sanitizeAmountInput(options.initialAmount, initialToken.decimals) : '');
    setDollarValue('$0.00');
    setSelectedToken(initialToken);
    setDropdownOpen(false);
    // Every MODAL deposit starts as an ordinary same-asset deposit — a
    // leftover pay token from a previous flow would silently route this one
    // through a swap. (The inline hub passes its "Deposit from" choice
    // explicitly per launch via startInlineDeposit.) The destination chain goes
    // with it: a leftover one would hold the cross-chain gates open on a chain
    // with no same-chain route of its own, so a pay token picked HERE would
    // prepare against the other chain's pool using this chain's deposit token.
    setPayToken(null);
    setExternalPayToken(null);
    setCrossChainPoolId(null);
    crossChainPoolIdRef.current = null;
    setBridgeWatch(null);
    setBridgeProgress(null);
    setPayDropdownOpen(false);
    setSwapRouteEstimate(null);
    setSwapConfirm((pending) => { pending?.resolve(false); return null; });
    setStorageConfirm((pending) => { pending?.resolve(false); return null; });
    setTxHash(null);
    setTxChainId(null);
    reportDepositError(null);
    setFeeExpanded(false);
    // Yield default: ON for every new deposit (explicit per-deposit opt-out).
    setYieldOptIn(true);
    // Opening the modal supersedes any inline (hub) deposit surface.
    setInlineActive(false);
    pendingInlineConfirmRef.current = null;
    setDepositRecipient(normalizeDepositRecipient(options?.recipientAddress, isStellar ? stellarOwner : depositOwnerAddress, isStellar));
    setIsOpen(true);
    log('debug', 'Deposit', 'Deposit modal opened', {
      tokenSymbol: initialToken.symbol,
      tokenAddress: initialToken.address,
    });
  }, [blockMockFlow, log, ensureConnected, isSui, isStellar, depositOwnerAddress, chainId, reportDepositError, openSeedDerivationModal, stellarOwner, cancelPendingRelaunch]);

  const closeDepositModal = useCallback(() => {
    opEpochRef.current += 1;
    // A pending Pay-with consent gate holds the flow on an unresolved promise.
    // Closing without settling it would leave the deposit hung mid-flow with
    // the tx-activity gate still held, so treat a close as a decline — safe,
    // because nothing has been signed while the gate is up.
    setSwapConfirm((pending) => {
      pending?.resolve(false);
      return null;
    });
    // Same for the unsaved-claim warning gate.
    setStorageConfirm((pending) => {
      pending?.resolve(false);
      return null;
    });
    setIsOpen(false);
    // Nothing about the next launch should inherit this one's destination.
    setCrossChainPoolId(null);
    crossChainPoolIdRef.current = null;
    // The mobile progress/success sheet presents while isOpen is FALSE (the
    // inline flow never sets it) — Done/X/backdrop must also exit the inline
    // presentation or sheetVisible stays true and the drawer freezes open.
    pendingInlineConfirmRef.current = null;
    setInlineActive(false);
    setStep((s) => (s === 'success' ? 'deposit' : s));
    log('debug', 'Deposit', 'Deposit modal closed');
  }, [log]);
  // The user-facing close (Done, X, backdrop, Escape, back): asks first while
  // an unregistered recipient's claim link is uncopied (DEV-491).
  const requestCloseDepositModal = useCallback(() => guardClaimLeave(closeDepositModal), [guardClaimLeave, closeDepositModal]);

  // --- Inline (no-modal) deposit: the desktop action hub runs the exact same
  // flow, with the hub card as the surface. Same gates as openDepositModal;
  // instead of opening the modal it primes token/amount and goes straight to
  // confirm once that state has committed (the effect below).
  const startInlineDeposit = useCallback((options: {
    tokenSymbol?: string;
    tokenAddress?: string;
    initialAmount?: string;
    payTokenAddress?: string;
    /** See the context type above: a pay token outside this chain's catalog. */
    payTokenExternal?: { symbol: string; address: string; decimals: number; isNative?: boolean; sourceChainId: number };
    poolChainId?: number;
    poolVettingFeeBps?: number;
    recipientAddress?: string;
  }) => {
    // A new launch supersedes any relaunch still parked from an earlier one.
    depositErrorReportRef.current = { phase: 'validate' };
    cancelPendingRelaunch();
    if (blockMockFlow()) return;
    if (!isSui) {
      if (!ensureConnected()) return;
      if (!keysReadyRef.current) {
        openSeedDerivationModal({ onSigned: () => startInlineDeposit(options) });
        return;
      }
    }
    // Decide the MODE before resolving the token, because the two must agree:
    // the deposit token resolves on the pool's chain only if this launch really
    // is cross-chain, and it only is if a pay token actually primed (the bridge
    // leg IS the pay token). Resolving on the destination and then falling back
    // to same-chain would carry the other chain's asset address onto this
    // chain, where it resolves to a DIFFERENT asset — a deposit of something
    // the user never chose.
    const routablePoolId = !isSui
      && options.poolChainId !== undefined
      && options.poolChainId !== chainId
      && crossChainSwapDepositSupported(chainId, options.poolChainId)
      ? options.poolChainId
      : null;
    if (options.poolChainId !== undefined && options.poolChainId !== chainId && routablePoolId === null) {
      reportDepositError('That cross-chain deposit route is unavailable. Nothing was sent.');
      return;
    }
    // NOT swapDepositAvailable: that flag still reflects the PREVIOUS launch's
    // destination (crossChainPoolId is set below, in this same tick), so a
    // first cross-chain launch would drop its pay token.
    const payAllowed = !isSui && !keyOwnedDeposit
      && (swapDepositEnabledForChain(chainId) || routablePoolId !== null);
    // The caller-vouched token wins the lookup when the catalog does not have
    // it, which is the whole point of payTokenExternal: a wallet holding or a
    // pasted address is never in getActionableTokens.
    // Chain-checked before it is trusted (codex P1 #4). The hub keeps the
    // previous chain's walletTokens while a refetch is in flight, so it can
    // hand over the old chain's address AND decimals; those decimals size the
    // LiFi preview and therefore the real deposit target.
    const vouched: TokenInfo | undefined = options.payTokenExternal && !isSui
      && options.payTokenExternal.sourceChainId === chainId
      ? {
          symbol: options.payTokenExternal.symbol,
          address: options.payTokenExternal.address,
          decimals: options.payTokenExternal.decimals,
          isNative: options.payTokenExternal.isNative ?? false,
        }
      : undefined;
    const payCandidate = !isSui && options.payTokenAddress && payAllowed
      ? availableTokens.find((t) => t.address.toLowerCase() === options.payTokenAddress!.toLowerCase())
        ?? (vouched && vouched.address.toLowerCase() === options.payTokenAddress.toLowerCase() ? vouched : undefined)
      : undefined;
    // A caller that asked to bridge and cannot (no pay token on this chain)
    // gets nothing: the UI already told the user it would bridge, so quietly
    // depositing on the wallet's chain instead would be a different operation
    // than the one they confirmed.
    // An explicit conversion must never degrade into spending the target
    // directly when its pay route is disabled or the input is unavailable.
    if (!isSui && options.payTokenAddress && !payCandidate) {
      reportDepositError('That pay token is not available on this network. Nothing was sent.');
      return;
    }
    const crossPoolId = payCandidate ? routablePoolId : null;
    const initialToken = isStellar
      ? STELLAR_TOKEN_INFOS[0]
      : isSui
      ? SUI_TOKEN_INFOS[0]
      : resolveSupportedToken(options, crossPoolId ?? chainId);
    if (!initialToken) {
      // Same rule as the modal: the card named an asset this chain cannot take
      // a deposit in (prod plain USDC is withdraw-only). Say so; never run the
      // flow on the catalog's first asset instead.
      reportDepositError(cannotShieldMessage(options, crossPoolId ?? chainId));
      log('warn', 'Deposit', 'Inline deposit refused: asset not depositable on this chain', { chainId: crossPoolId ?? chainId, tokenSymbol: options.tokenSymbol, tokenAddress: options.tokenAddress });
      return;
    }
    const converting = crossPoolId !== null || (payCandidate && payCandidate.address.toLowerCase() !== initialToken.address.toLowerCase());
    const inlinePoolChainId = crossPoolId ?? chainId;
    const inlinePoolAddress = conversionDepositTarget(initialToken.address, inlinePoolChainId, initialToken.isNative);
    const inlineRefusal = converting
      ? intentTargetRefusal(inlinePoolAddress, inlinePoolChainId, false, inlinePoolChainId !== chainId)
      : null;
    if (inlineRefusal) {
      // The rule's own reason: a closed pool and a coin the bridge cannot
      // deposit need different next steps.
      reportDepositError(`${inlineRefusal} Nothing was sent.`);
      return;
    }
    const primedAmount = options.initialAmount ? sanitizeAmountInput(options.initialAmount, initialToken.decimals) : '';
    if (!primedAmount || !(parseFloat(primedAmount) > 0)) {
      // Nothing to confirm without an amount — the hub validates before
      // calling, so this is just a belt-and-braces refusal.
      return;
    }
    setStep('deposit');
    setAmount(primedAmount);
    setDollarValue('$0.00');
    setSelectedToken(initialToken);
    setDropdownOpen(false);
    // Every deposit starts as an ordinary same-asset deposit unless the hub
    // EXPLICITLY passed a pay token this launch ("Deposit from" — flow 1); a
    // leftover pay token must never silently route a hub deposit through a
    // swap the user didn't ask for THIS time.
    // The same-address refusal only makes sense WITHIN one chain: across chains
    // ETH→ETH (both the native sentinel) and USDC→USDC are exactly what a
    // cross-chain shield is for, and LiFi bridges them. Cross-chain therefore
    // always keeps the candidate, which is what keeps the pay token and the
    // destination in step: crossPoolId set ⇒ a pay token is set.
    const explicitPay = payCandidate
      && (crossPoolId !== null
        || payCandidate.address.toLowerCase() !== initialToken.address.toLowerCase())
      ? payCandidate
      : undefined;
    setExternalPayToken(
      explicitPay && vouched && explicitPay.address.toLowerCase() === vouched.address.toLowerCase()
        ? vouched
        : null,
    );
    setPayToken(explicitPay ?? null);
    setCrossChainPoolId(crossPoolId);
    crossChainPoolIdRef.current = crossPoolId;
    setCrossChainVetting(crossPoolId !== null && options.poolVettingFeeBps !== undefined
      ? { poolChainId: crossPoolId, token: initialToken.address.toLowerCase(), bps: options.poolVettingFeeBps }
      : null);
    // A new deposit gets a clean card. This does stop tracking any bridge still
    // in flight from the PREVIOUS deposit: its balance is still picked up by
    // that deposit's follow-up syncs, the periodic refresh, and the header's
    // sync button. Showing one transfer's progress on another's card would be
    // worse than losing the tracker.
    setBridgeWatch(null);
    setBridgeProgress(null);
    setPayDropdownOpen(false);
    setSwapRouteEstimate(null);
    setSwapConfirm((pending) => { pending?.resolve(false); return null; });
    setStorageConfirm((pending) => { pending?.resolve(false); return null; });
    setTxHash(null);
    setTxChainId(null);
    reportDepositError(null);
    setFeeExpanded(false);
    setYieldOptIn(true);
    setIsOpen(false);
    setInlineActive(true);
    const recipient = normalizeDepositRecipient(options.recipientAddress, isStellar ? stellarOwner : depositOwnerAddress, isStellar);
    setDepositRecipient(recipient);
    pendingInlineConfirmRef.current = { tokenAddress: initialToken.address, amount: primedAmount, recipient };
    // Only a launch that got past the gates above is worth relaunching.
    lastInlineOptionsRef.current = options;
    log('debug', 'Deposit', 'Inline deposit started', {
      tokenSymbol: initialToken.symbol,
      amount: primedAmount,
      forAnotherAddress: recipient !== null,
    });
  }, [blockMockFlow, log, ensureConnected, isSui, isStellar, openSeedDerivationModal, chainId, keyOwnedDeposit, availableTokens, reportDepositError, depositOwnerAddress, stellarOwner, cancelPendingRelaunch]);

  // Bridge delivery tracking for a cross-chain shield. Deliberately the same
  // shape as the swap modal's tracker (shared constants, shared terminal rule),
  // because the two answer the same question about the same LiFi transfer.
  // Read through refs so the poll's lifetime matches the DELIVERY rather than
  // the component: these identities change on ordinary renders, and the effect
  // was being torn down and rebuilt each time, restarting its clock.
  const bridgeDepsRef = useRef({ ensureInitialized, refreshNotes, queryClient, depositOwnerAddress, log });
  useEffect(() => {
    bridgeDepsRef.current = { ensureInitialized, refreshNotes, queryClient, depositOwnerAddress, log };
  }, [ensureInitialized, refreshNotes, queryClient, depositOwnerAddress, log]);
  useEffect(() => {
    if (!bridgeWatch) return;
    let cancelled = false;
    const startedAt = Date.now();
    let lastResyncMs: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => { if (timer) clearTimeout(timer); timer = null; };
    const scan = lifiScanUrl(bridgeWatch.txHash);
    const finish = (progress: { tone: 'pending' | 'done' | 'failed'; text: string; explorerUrl?: string }) => {
      stop();
      setBridgeProgress({ ...progress, ...(scan ? { lifiScanUrl: scan } : {}) });
      setBridgeWatch(null);
    };
    const poll = async () => {
      const elapsed = Date.now() - startedAt;
      // Wall clock, not an attempt count: a counter measures how long this loop
      // has lived, which stopped being the same thing once the effect could be
      // rebuilt by an unrelated render.
      if (elapsed >= BRIDGE_POLL_MAX_MS) {
        finish({
          tone: 'pending',
          text: "Still no bridge update after a while. Check the transaction on the destination chain's explorer.",
        });
        return;
      }
      // The deposit can land while LiFi's index lags, so after a few minutes
      // re-read the notes alongside the status instead of waiting for a
      // terminal answer that is already stale.
      if (bridgeResyncDue(elapsed, lastResyncMs)) {
        lastResyncMs = elapsed;
        try { await bridgeDepsRef.current.refreshNotes(); } catch { /* best-effort */ }
        if (cancelled) return;
      }
      try {
        const session = await bridgeDepsRef.current.ensureInitialized();
        const status: SwapStatusLike = await (session as unknown as {
          getSwapStatus: (p: { txHash: `0x${string}`; fromChainId: number; toChainId: number }) => Promise<SwapStatusLike>;
        }).getSwapStatus({
          txHash: bridgeWatch.txHash as `0x${string}`,
          fromChainId: bridgeWatch.fromChainId,
          toChainId: bridgeWatch.toChainId,
        });
        if (cancelled) return;
        const described = describeSwapStatus(status);
        if (!isTerminalSwapStatus(status)) {
          // NOT_FOUND means LiFi has not indexed the source tx yet, not failure.
          setBridgeProgress({
            tone: described.tone,
            text: described.text,
            ...(status.explorerLink ? { explorerUrl: status.explorerLink } : {}),
            ...(scan ? { lifiScanUrl: scan } : {}),
          });
          return;
        }
        finish({
          tone: described.tone,
          text: described.text,
          ...(status.explorerLink ? { explorerUrl: status.explorerLink } : {}),
        });
        const outcome = bridgeDeliveryOutcome(status);
        // Read from the ref like the rest of the loop: a captured owner would be
        // the one from the render that happened to build this effect, and the
        // stranded-note cleanup below writes storage keyed by it.
        const owner = bridgeDepsRef.current.depositOwnerAddress;
        if (outcome !== 'deposited' && bridgeWatch.pendingCommitment && owner) {
          // The deposit never ran (LiFi recovered the funds to a wallet, or the
          // bridge failed), so the note the SDK persisted PENDING for the
          // destination chain will never confirm. Remove exactly that note; an
          // ACTIVE one with the same commitment would mean it landed and stays.
          try {
            const stored = loadStoredAccountExport(owner, bridgeWatch.toChainId);
            if (stored) {
              const cleaned = withoutStrandedPendingNote(stored, bridgeWatch.pendingCommitment);
              if (cleaned !== stored) {
                saveStoredAccountExport(cleaned, owner, bridgeWatch.toChainId);
                bridgeDepsRef.current.log('info', 'Deposit', 'Removed the stranded pending note after a non-deposited bridge outcome', {
                  chainId: bridgeWatch.toChainId, outcome,
                });
              }
            }
          } catch (cleanupErr) {
            bridgeDepsRef.current.log('warn', 'Deposit', 'Could not remove the stranded pending note', cleanupErr);
          }
          try { await bridgeDepsRef.current.refreshNotes(); } catch { /* best-effort */ }
        }
        if (outcome === 'deposited') {
          // Delivered AND deposited: NOW the destination note exists, so refresh
          // against delivery rather than the fixed timers, which can only guess.
          try { await bridgeDepsRef.current.refreshNotes(); } catch { /* best-effort */ }
          try {
            await invalidateTransactionCaches(bridgeDepsRef.current.queryClient);
          } catch { /* best-effort */ }
        }
      } catch {
        // Transient status failures: keep polling.
      }
    };
    // setTimeout rather than setInterval so the cadence can widen: 7s while it
    // matters, then 30s. The longer window costs fewer requests than the old
    // bounded one did.
    const schedule = () => {
      if (cancelled || timer === null && !bridgeWatch) return;
      timer = setTimeout(() => { void poll().finally(schedule); }, bridgePollIntervalFor(Date.now() - startedAt));
    };
    void poll().finally(schedule);
    return () => { cancelled = true; stop(); };
  }, [bridgeWatch]);

  const resetInlineDeposit = useCallback(() => {
    pendingInlineConfirmRef.current = null;
    cancelPendingRelaunch();
    // The destination belongs to ONE launch. Nothing reaches a confirm through
    // a bare reset today, but leaving it set breaks the invariant the ref
    // exists to hold, and the next caller that confirms after a reset would
    // inherit it.
    setCrossChainPoolId(null);
    crossChainPoolIdRef.current = null;
    setInlineActive(false);
    setStep('deposit');
    reportDepositError(null);
    setTxHash(null);
    setTxChainId(null);
    setDepositRecipient(null);
  }, [cancelPendingRelaunch]);

  // --- The inline receipt belongs to the route it was launched from.
  //
  // `step` only walked back to 'deposit' through an action inside the flow, so
  // "Deposit submitted" was still sitting on the hub after a trip to the
  // portfolio and back (Nathaniel, QA 2026-09-21). Remember the route the
  // receipt was born on; leaving that route retires it.
  //
  // Three things it must not do:
  //  - never while a deposit is in flight ('loading'): the card is the only
  //    report on a transaction that is still being signed and broadcast;
  //  - never to the modal presentation (`isOpen`), which has its own Done/X;
  //  - never while a cross-chain deposit is still bridging. That card carries
  //    the live LiFi progress and is the only place the user watches it, so a
  //    running bridge holds the receipt open until it reports done or failed.
  const successPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (step === 'success' && inlineActive) {
      if (successPathRef.current === null) successPathRef.current = pathname;
    } else {
      successPathRef.current = null;
    }
  }, [step, inlineActive, pathname]);
  useEffect(() => {
    if (step !== 'success' || !inlineActive || isOpen) return;
    const bornOn = successPathRef.current;
    if (bornOn === null || bornOn === pathname) return;
    if (bridgeProgress && bridgeProgress.tone === 'pending') return;
    // An uncopied claim link holds the receipt too (DEV-491): a route change
    // cannot ask first, so the card waits for a guarded exit instead.
    if (claimLinkAtRisk) return;
    resetInlineDeposit();
  }, [pathname, step, inlineActive, isOpen, bridgeProgress, resetInlineDeposit, claimLinkAtRisk]);

  // Relaunch a deposit parked by a cross-chain registration once this render
  // is back on the chain it was launched from, with that chain's catalog.
  useEffect(() => {
    // Belt and braces: every generation bump also clears pendingRelaunch
    // (cancelPendingRelaunch), so a stale one should never be seen here.
    // Every condition is render state, so a change in any of them re-runs this
    // effect; nothing waits on an unrelated render (services/deposit-relaunch.ts).
    if (!pendingRelaunch || !relaunchReady({
      pending: pendingRelaunch,
      currentGen: inlineLaunchGenRef.current,
      chainId,
      walletChainId,
      keysReady,
      tokenCount: availableTokens.length,
    })) return;
    // Consumed by the launch itself: startInlineDeposit calls
    // cancelPendingRelaunch() first, synchronously, which clears it.
    startInlineDeposit(pendingRelaunch.options);
  }, [pendingRelaunch, chainId, walletChainId, keysReady, availableTokens, startInlineDeposit]);

  // Leaving the page drops a parked relaunch: it must not fire on another page.
  const relaunchPathRef = useRef(pathname);
  useEffect(() => {
    if (relaunchPathRef.current === pathname) return;
    relaunchPathRef.current = pathname;
    cancelPendingRelaunch();
  }, [pathname, cancelPendingRelaunch]);

  // Fire the primed inline confirm once the render carrying the primed
  // token/amount has committed — handleConfirm reads provider state, so
  // calling it in the same tick as the setState calls would use stale values.
  useEffect(() => {
    const pending = pendingInlineConfirmRef.current;
    if (!pending || !inlineActive) return;
    if (softPending) return; // the price or the pool minimum is still loading; try again on the next render
    if (selectedToken.address !== pending.tokenAddress || amount !== pending.amount || depositRecipient !== pending.recipient) return;
    pendingInlineConfirmRef.current = null;
    void handleConfirm();
  });

  useEffect(() => {
    if (!isOpen || Platform.OS !== 'web') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The token sheet is a layer ON TOP of the modal: Escape dismisses that
      // layer first (it used to blow the whole deposit away from under the
      // picker). Second Escape closes the modal as before.
      if (dropdownOpen) {
        setDropdownOpen(false);
        return;
      }
      requestCloseDepositModal();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, dropdownOpen, requestCloseDepositModal]);
  // Android back: an open token sheet handles back itself (newest listener
  // wins), so this only closes the modal.
  useBackHandler(isOpen, requestCloseDepositModal);

  // --- Amount change handler ---

  const handleAmountChange = useCallback((text: string) => {
    const sanitized = sanitizeAmountInput(text, selectedToken.decimals);
    setAmount(sanitized);
    const num = parseFloat(sanitized) || 0;
    const usdValue = num * tokenPrice;
    setDollarValue(formatUsdPrecise(usdValue));
  }, [tokenPrice, selectedToken.decimals]);

  // --- Token selection handler ---

  const handleTokenSelect = useCallback((token: TokenInfo) => {
    setSelectedToken(token);
    setDropdownOpen(false);
    // Re-clamp the already-typed amount to the new token's precision so a
    // high-precision value carried over from a finer token (e.g. 18→6) can't
    // survive past the input clamp and shift by a smallest unit at parse time.
    const clamped = sanitizeAmountInput(amount, token.decimals);
    if (clamped !== amount) setAmount(clamped);
    const num = parseFloat(clamped) || 0;
    // Price will be updated reactively via the query
    setDollarValue(formatUsdPrecise(num * tokenPrice));
  }, [amount, tokenPrice]);

  // --- Explorer URL ---

  // Frozen chain decides BOTH the URL and the label — branching on live isSui
  // sends an EVM hash to SuiVision after a post-submit chain switch (codex).
  const explorerChainId = txChainId ?? (isStellar ? STELLAR_TESTNET_ID : isSuiChain ? SUI_TESTNET_ID : chainId);
  const explorerIsSui = explorerChainId === SUI_TESTNET_ID;
  const explorerUrl = txHash
    ? (explorerIsSui ? getSuiExplorerUrl(txHash) : getExplorerTxUrl(explorerChainId, txHash))
    : '';

  // --- Computed values for review/loading/success ---
  const depositAmountFormatted = `${formatAmountText(amount, selectedToken.decimals)} ${displayTokenSymbol(selectedToken.symbol)}`;
  const depositDollarValue = `~${formatUsdPrecise(enteredAmount * tokenPrice)}`;
  // The opt-out fee (Q1) is only ever surfaced when it is BOTH configured and
  // actually enforced on-chain — never advertise a fee no transaction charges
  // (codex finding 4). Until then the fee is 0 and the re-total is a no-op.
  const optOutFeeShown = yieldAvailable && yieldOptOutFeeActive();
  const effectiveOptOutFee = optOutFeeShown ? YIELD_OPT_OUT_FEE : 0;
  const totalCostAmount = computeDepositTotal(
    enteredAmount,
    !yieldAvailable || yieldOn,
    effectiveOptOutFee,
  );
  const totalCostFormatted = `${totalCostAmount} ${displayTokenSymbol(selectedToken.symbol)}`;
  const totalCostDollarValue = `~${formatUsdPrecise(totalCostAmount * tokenPrice)}`;
  const feePricing = useFeePricing(chainId);
  const swapRoute = swapConfirm?.route ?? null;
  const depositFeeBreakdown = useMemo(() => {
    if (isSui || isStellar || enteredAmount <= 0) return null;
    const poolChainId = crossChainShieldActive && crossChainPoolId !== null ? crossChainPoolId : chainId;
    const depositUsd = feePricing.tokenUsdOf(poolChainId, selectedToken.address, selectedToken.symbol) ?? (tokenPrice > 0 ? tokenPrice : null);
    const enteredUsd = depositUsd === null ? null : enteredAmount * depositUsd;
    // The fee is charged by the Entrypoint the deposit lands in.
    const vettingBps = !crossChainShieldActive
      ? depositVettingFeeBps
      : crossChainVetting && crossChainVetting.poolChainId === poolChainId && crossChainVetting.token === selectedToken.address.toLowerCase()
        ? crossChainVetting.bps
        : undefined;
    const vettingUsd = vettingBps == null || enteredUsd === null ? null : (enteredUsd * vettingBps) / 10_000;
    const gasPriceWei = feePricing.gasPriceOf(chainId);
    const nativeUsd = feePricing.nativeUsdOf(chainId);
    const gas: FeeGasReading[] = [{ chainId, gasPriceWei }];
    if (!swapDepositActive) {
      // A cross-chain shield is always paid with a token; until one is set there is nothing to price.
      if (crossChainShieldActive) return null;
      return buildFeeBreakdown({ amountUsd: enteredUsd, networkUsd: gasCostUsd(SHIELD_GAS_UNITS.deposit, gasPriceWei, nativeUsd), swapUsd: vettingUsd, gas });
    }
    // The wallet sends only the source-chain call of a cross-chain shield; the bridge pays the far side.
    const walletGasUsd = gasCostUsd(crossChainShieldActive ? SHIELD_GAS_UNITS.crossChainSource : SHIELD_GAS_UNITS.swapDeposit, gasPriceWei, nativeUsd);
    if (crossChainShieldActive) gas.push({ chainId: poolChainId, gasPriceWei: feePricing.gasPriceOf(poolChainId) });
    // What the swap and bridge keep is known once the route is quoted, from its own figures.
    const routeLossUsd = swapRoute && swapRoute.inputUsd !== null && swapRoute.deliveredUsd !== null
      ? Math.max(0, swapRoute.inputUsd - swapRoute.deliveredUsd)
      : null;
    const bridgeUsd = swapRoute ? tokenUsd(swapRoute.nativeFeeWei, getChainConfig(chainId)?.nativeCurrency.decimals ?? 18, nativeUsd) : 0;
    return buildFeeBreakdown({
      amountUsd: swapRoute?.inputUsd ?? enteredUsd,
      networkUsd: walletGasUsd === null ? null : walletGasUsd + (bridgeUsd ?? 0),
      swapUsd: routeLossUsd === null || vettingUsd === null ? null : routeLossUsd + vettingUsd,
      gas,
    });
  }, [isSui, isStellar, enteredAmount, tokenPrice, feePricing, chainId, crossChainShieldActive, crossChainPoolId, crossChainVetting, selectedToken.address, selectedToken.symbol, swapDepositActive, depositVettingFeeBps, swapRoute]);

  // Re-sends the registration from an explicit tap (one Freighter approval);
  // the next manual Sync does the same for any deposit this card is not for.
  const retryStellarLabels = stellarSession.retryPendingLabels;
  const stellarLabelRetry = useMemo(() => (stellarLabelPending && stellarLabelPending.owner === stellarOwner ? {
    retry: async () => {
      try {
        const { failed, firstError } = await retryStellarLabels([stellarLabelPending.item]);
        if (failed > 0) throw new Error(firstError ?? 'The approval request did not go through.');
        setStellarLabelPending(null);
        errorToast({ title: 'Sent for approval.' });
        return true;
      } catch (caught) {
        const raw = caught instanceof Error ? caught.message : String(caught);
        errorToast({
          title: /reject|denied|cancel|declined/i.test(raw) ? 'Cancelled in Freighter.' : stellarErrorMessage(raw),
          variant: 'destructive',
        });
        return false;
      }
    },
  } : null), [stellarLabelPending, stellarOwner, retryStellarLabels, errorToast]);

  const flow = useMemo<DepositFlowView>(() => ({
    step,
    loadingMessage,
    depositError,
    depositAmountFormatted,
    claimReceiptUrl,
    stellarLabelRetry,
    claimLinkCopied,
    copyClaimLink,
    guardClaimLeave,
    txHash,
    explorerUrl,
    inlineActive,
    recipientAddress: depositRecipient,
    swapRouteEstimate,
    crossChainDestination: crossChainPoolId !== null && crossChainPoolId !== chainId
      ? getChainConfig(crossChainPoolId)?.displayName ?? `chain ${crossChainPoolId}`
      : null,
    bridgeProgress,
    swapConsent: swapConfirm
      ? {
        inputAmountText: swapConfirm.display.inputAmountText,
        inputAmountUSD: swapConfirm.display.inputAmountUSD,
        depositAmountText: swapConfirm.display.depositAmountText,
        durationText: swapConfirm.display.durationText,
        needsApproval: swapConfirm.display.needsApproval,
        paySymbol: payToken?.symbol ?? 'token',
        accept: () => { const { resolve } = swapConfirm; setSwapConfirm(null); resolve(true); },
        decline: () => { const { resolve } = swapConfirm; setSwapConfirm(null); resolve(false); },
      }
      : null,
    storageConsent: storageConfirm
      ? {
        accept: () => { const { resolve } = storageConfirm; setStorageConfirm(null); resolve(true); },
        decline: () => { const { resolve } = storageConfirm; setStorageConfirm(null); resolve(false); },
      }
      : null,
  }), [step, loadingMessage, depositError, depositAmountFormatted, claimReceiptUrl, claimLinkCopied, copyClaimLink, guardClaimLeave, txHash, explorerUrl, inlineActive, stellarLabelRetry, depositRecipient, swapRouteEstimate, crossChainPoolId, chainId, bridgeProgress, swapConfirm, storageConfirm, payToken?.symbol]);

  const contextValue = useMemo<DepositModalContextType>(() => ({
    openDepositModal,
    closeDepositModal,
    isOpen,
    startInlineDeposit,
    resetInlineDeposit,
    flow,
  }), [openDepositModal, closeDepositModal, isOpen, startInlineDeposit, resetInlineDeposit, flow]);

  return (
    <DepositModalContext.Provider value={contextValue}>
      {children}
      <LinkLeaveConfirm
        visible={!!claimLeavePending}
        copy={CLAIM_LINK_LEAVE}
        onCopy={copyClaimLink}
        // Leaving (copied or not) is the user's answer: nothing asks again
        // for this link, and the receipt card may retire.
        onLeave={() => { const pending = claimLeavePending; setClaimLeavePending(null); setClaimLinkCopied(true); pending?.leave(); }}
        onCancel={() => setClaimLeavePending(null)}
        testID="claim-link-leave-confirm"
      />
      {sheetVisible && (
        <View
          // justify branches are mutually exclusive: co-active `justify-center`+`justify-end`
          // resolve by CSS file order on web (center wins) — old style array was later-wins (end).
          className={`inset-0 z-[999999] items-center ${isSheet ? 'justify-end' : 'justify-center'}`}
          // nw-keep(platform-css): web-only position:fixed to anchor the backdrop over scrolling content (empty on native)
          style={WEB_FIXED_POSITION}
        >
          <HubErrorBoundary onRetry={closeDepositModal}>
          {/* Blur overlay */}
          <Pressable
            className={`absolute inset-0 ${isDark ? 'bg-[rgba(0,0,0,0.6)]' : 'bg-[rgba(255,255,255,0.6)]'}`}
            // nw-keep(platform-css): web-only backdrop blur filter (empty on native)
            style={WEB_BLUR_BACKDROP}
            onPress={requestCloseDepositModal}
          />

          {/* Modal — bottom drawer on mobile, centered card on desktop */}
          <Animated.View
            className={`relative items-center overflow-hidden border ${isSheet ? 'rounded-t-card rounded-b-none border-b-0' : 'rounded-card'} ${
              isSheet ? 'w-full max-w-full' : isMobile ? 'w-[95%] max-w-[95%]' : step === 'deposit' ? 'w-[580px] max-w-[95%]' : 'w-[504px] max-w-[95%]'
            } ${
              isSheet ? 'px-[16px] py-[24px] pt-[28px] mb-0' : isMobile ? 'px-[16px] py-[24px]' : step === 'deposit' ? 'px-[24px] py-[36px]' : 'p-[40px]'
            } ${step === 'deposit' ? 'gap-[16px]' : 'gap-[20px]'} ${
              step === 'loading' || step === 'success' ? 'justify-center' : step === 'deposit' && isRoomy ? 'min-h-[560px] justify-start' : ''
            } bg-card-background border-border`}
            // nw-keep(animated): opacity + slide/scale transform are Animated driven by sheetAnim
            // nw-keep(measured-or-inset): deposit-step viewport cap is a runtime measured height
            style={{
              opacity: sheetAnim,
              transform: isSheet
                ? [{ translateY: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }) }]
                : [{ scale: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }],
              ...(step === 'deposit' ? { maxHeight: depositCardMaxHeight(height) } : null),
            }}
          >
            {isSheet && <View className="absolute top-[10px] self-center w-[44px] h-[4px] rounded-control z-[10] bg-border" />}
            {/* Close Button */}

            <Pressable className="absolute top-[11px] right-[11px] w-[24px] h-[24px] items-center justify-center z-[10]" onPress={requestCloseDepositModal}>
              {/* nw-keep(data-color): close glyph stroke is the text theme token into the SVG icon prop */}
              <CloseIcon color={colors.text} />
            </Pressable>

            {step === 'deposit' && (
              /* Input step scrolls inside the viewport-capped card so short
                 or landscape viewports can always reach the CTA (codex P2). */
              <ScrollView
                className="w-full grow-0 shrink"
                contentContainerClassName="items-center gap-[16px]"
                showsVerticalScrollIndicator={false}
              >
                {/* Title */}
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Make a deposit
                </Text>

                {/* Token selector — ONE trigger that opens the combined
                    token + network modal (CoW-style). Presentation polish
                    (80be0d8): richer token cluster (symbol + name) and a
                    chain chip, so the trigger reads like the selector rows.
                    Behavior unchanged. Tap still opens the same selector. */}
                <View className="w-full">
                  <Pressable
                    className="w-full h-[52px] border border-border rounded-control flex-row items-center px-[16px] py-[8px] gap-[12px] bg-card-background"
                    onPress={() => setDropdownOpen(true)}
                    testID="deposit-token-selected"
                    accessibilityRole="button"
                    accessibilityLabel={`Deposit token: ${selectedToken.symbol}`}
                  >
                    <View className="flex-1 flex-row items-center gap-[8px]">
                      <TokenNetworkIcon symbol={selectedToken.symbol} size={24} chainId={isStellar ? STELLAR_TESTNET_ID : isSuiChain ? SUI_TESTNET_ID : chainId} />
                      <View>
                        <Text className={`text-[16px] leading-[18px] font-pp-medium ${selectedToken ? 'text-text' : 'text-[#B8BBBF]'}`}>
                          {displayTokenSymbol(selectedToken.symbol)}
                        </Text>
                        {TOKEN_NAMES[selectedToken.symbol] ? (
                          <Text className="text-[11px] leading-[13px] text-text-secondary font-pp-regular">
                            {TOKEN_NAMES[selectedToken.symbol]}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                    <View className="flex-row items-center gap-[4px] px-[8px] py-[4px] border border-border-light rounded-control">
                      <Text className="text-[12px] leading-[12px] text-text-secondary font-pp-regular">
                        {chainDisplayName}
                      </Text>
                      {/* The NETWORK mark, so it must be a ChainLogo. This was a
                          TokenNetworkIcon hardcoded to 'ETH', i.e. Ethereum's
                          ASSET mark standing in for every chain: Sepolia lost
                          its testnet band, and Optimism / Citrea / BNB all read
                          as Ethereum here even though the label beside them said
                          otherwise (Pat, 2026-08-28). */}
                      <ChainLogo chain={chainLogoChainFor(isStellar ? STELLAR_TESTNET_ID : isSuiChain ? SUI_TESTNET_ID : chainId)} size={18} />
                    </View>
                    <CaretDownIcon color={colors.text} />
                  </Pressable>
                </View>

                {/* Input Section */}
                <View className="w-full gap-[4px]">
                  <View className={`w-full border rounded-control p-[16px] flex-row justify-between bg-card-background ${isMobile ? 'min-h-[104px] h-auto items-start' : 'h-[87px] items-end'} ${validationError && !softPending ? 'border-[#E53935]' : 'border-border-light'}`}>
                    <View className="gap-[6px] flex-1 min-w-0">
                      <TextInput
                        className={`text-[24px] p-0 m-0 font-pp-regular ${amount ? 'text-text' : 'text-[#999999]'}`}
                        // nw-keep(platform-css): web-only outlineStyle:'none' to drop the focus ring (empty on native)
                        style={WEB_NO_OUTLINE}
                        value={amount}
                        placeholder="0"
                        placeholderTextColor="#999999"
                        onChangeText={handleAmountChange}
                        keyboardType="numeric"
                      />
                      <Text className="text-[14px] text-[#999999] font-pp-regular">
                        {dollarValue}
                      </Text>
                    </View>
                    <View className={`items-end justify-start gap-[4px] shrink-0 ${isMobile ? 'max-w-[92px]' : 'max-w-[110px]'}`}>
                      <Text className="text-[14px] leading-[16px] text-[#999999] font-pp-regular">
                        Bal:
                      </Text>
                      <Text className="text-[14px] leading-[16px] text-[#999999] text-right font-pp-regular">
                        {walletBalanceFormatted}
                      </Text>
                    </View>
                  </View>
                  {/* Quick-amount presets */}
                  <View className="flex-row flex-wrap gap-[8px] mt-[10px]">
                    {cappedQuickAmounts({ capUsd: depositCapUsd, priceUsd: tokenPrice, symbol: selectedToken.symbol, fallback: selectedToken.isNative ? QUICK_AMOUNTS_NATIVE : QUICK_AMOUNTS_STABLE }).map((preset) => {
                      const active = amount === preset;
                      return (
                        <Pressable
                          key={preset}
                          className={`px-[12px] py-[6px] rounded-[8px] border ${active ? 'border-tint' : 'border-border-light'}`}
                          // nw-keep(data-color): active chip fill is the tint theme token at 22 (13%) alpha — no className path; inactive is transparent (default)
                          style={active ? { backgroundColor: `${colors.tint}22` } : undefined}
                          onPress={() => handleAmountChange(preset)}
                        >
                          <Text className={`text-[13px] font-pp-regular ${active ? 'text-tint' : 'text-text'}`}>
                            {formatQuickAmount(preset)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <Text className={`text-[12px] font-pp-regular ${validationError ? (softPending ? 'text-text-muted' : 'text-[#E53935]') : 'text-transparent'}`}>
                    {validationError || ' '}
                  </Text>
                </View>

                {/* "Pay with" (guide flow 1) — swap a wallet token into this
                    deposit in one transaction. Shown when the master flag is on
                    and the chain has two configured assets; no RelaySwaps
                    processor is involved, because this route is submitted by the
                    user's own wallet rather than a relayer. */}
                {swapDepositAvailable && payTokenOptions.length > 0 && (
                  <View className="w-full gap-[8px]">
                    <View className="flex-row items-center justify-between gap-[8px]">
                      <Text className="text-[13px] text-text-secondary font-pp-medium">Deposit from</Text>
                      {!!payToken && (
                        <Pressable onPress={() => setPayToken(null)} hitSlop={8}>
                          <Text className="text-[12px] text-tint underline font-pp-medium">Clear</Text>
                        </Pressable>
                      )}
                    </View>
                    <Pressable
                      className="w-full flex-row items-center gap-[10px] rounded-control border border-border-light bg-card-background px-[14px] py-[11px]"
                      onPress={() => setPayDropdownOpen(true)}
                      testID="deposit-pay-with"
                    >
                      <View className="flex-1 flex-row items-center gap-[8px]">
                        {payToken ? (
                          <>
                            <TokenNetworkIcon symbol={payToken.symbol} size={20} chainId={chainId} />
                            <Text className="text-[14px] text-text font-pp-regular">{displayTokenSymbol(payToken.symbol)}</Text>
                          </>
                        ) : (
                          <Text className="text-[14px] text-text-secondary font-pp-regular">
                            {displayTokenSymbol(selectedToken.symbol)} (no swap)
                          </Text>
                        )}
                      </View>
                      <CaretDownIcon color={colors.text} />
                    </Pressable>
                    {swapDepositActive && payToken && (
                      <Text className="text-[12px] leading-[17px] text-text-secondary font-pp-regular">
                        You&apos;ll deposit {amount || '0'} {displayTokenSymbol(selectedToken.symbol)}; your wallet spends {displayTokenSymbol(payToken.symbol)}. The exact amount spent depends on the route and is shown by your wallet before you sign.
                      </Text>
                    )}
                  </View>
                )}

                {/* Aave yield toggle (D1/A1) — with no review step, the choice
                    lives on the form and re-totals the line below in place. */}
                {yieldAvailable && !yieldForced && (
                  <YieldBlock
                    optIn={yieldOptIn}
                    onToggle={setYieldOptIn}
                    apyPercent={YIELD_APY_PERCENT}
                  />
                )}
                {yieldForced && (
                  <Text className="text-[12px] leading-[16px] text-text-secondary font-pp-regular">
                    {currentYieldExitDisclosure}
                  </Text>
                )}

                {/* Cost summary — only when it says more than the amount
                    already does (an enforced opt-out fee changes the total). */}
                {optOutFeeShown && (
                  <View className="w-full border border-border-light p-[12px] gap-[6px] bg-card-background">
                    <YieldCostRow
                      optIn={yieldOn}
                      optOutFee={YIELD_OPT_OUT_FEE}
                      symbol={selectedToken.symbol}
                    />
                    <Text className="text-[14px] leading-[18px] text-text font-pp-bold">
                      Total: {totalCostFormatted} ({totalCostDollarValue})
                    </Text>
                  </View>
                )}

                <FeeWarning breakdown={depositFeeBreakdown} testID="deposit-fee-warning" />

                {/* Price Fetch Error */}
                {priceError && (
                  <Text className="text-[12px] font-pp-regular text-[#E5A035]">
                    Unable to fetch {displayTokenSymbol(selectedToken.symbol)} price. USD values may be inaccurate.
                  </Text>
                )}


                {/* Key-owned deposit: say exactly where the money lands. */}
                {keyOwnedDeposit && (
                  <Text className="text-text-secondary font-pp-regular text-[12px] leading-[17px]">
                    Depositing to your account key {depositOwnerAddress ? truncateAddress(depositOwnerAddress) : ''}
                    {depositOwnerAddress ? <CopyIconButton value={depositOwnerAddress} /> : null}
                    , paying from wallet {connectedAddress ? truncateAddress(connectedAddress) : '(connect one)'}
                    {connectedAddress ? <CopyIconButton value={connectedAddress} /> : null}.
                  </Text>
                )}

                {/* Deposit button — straight to confirm, no review step. */}
                <View className="w-full items-center pt-[16px]">
                  <Pressable
                    className={`border rounded-control px-[20px] py-[10px] items-center justify-center bg-card-background ${canReview ? 'border-[#B8BBBF] opacity-100' : 'border-[#E6E6E6] opacity-50'}`}
                    onPress={() => {
                      if (canReview) {
                        reportDepositError(null);
                        void handleConfirm();
                      }
                    }}
                    disabled={!canReview}
                  >
                    <Text className="text-[14px] text-text font-pp-medium">
                      Deposit
                    </Text>
                  </Pressable>
                </View>
              </ScrollView>
            )}

            {step === 'loading' && (
              <>
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Depositing
                </Text>

                {/* Staged tracker instead of the old spinner: the phase is
                    derived from the real status message (Prepare → Prove →
                    Submit → Confirm), so the row always says where the flow
                    actually is. */}
                <FlowProgress message={loadingMessage} />

                {/* Route cost, once the quote exists: the wallet is about to ask
                    for an amount of the pay token the user never typed. */}
                {swapRouteEstimate && !swapConfirm ? (
                  <Text className="w-full text-center text-[12px] text-text-secondary font-pp-regular">
                    {swapRouteEstimate}
                  </Text>
                ) : null}

                {/* Consent gate. Nothing has been signed at this point: the
                    route is quoted and the flow is parked on this promise until
                    the user accepts the input amount they never typed. */}
                {swapConfirm ? (
                  <View className="w-full gap-[10px] rounded-control border border-border-light p-[16px]">
                    <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                      <Text className="text-[13px] text-text-secondary font-pp-medium">You pay (est.)</Text>
                      <Text className="text-[13px] text-text font-pp-bold">
                        {swapConfirm.display.inputAmountText}
                        {swapConfirm.display.inputAmountUSD ? ` · ${swapConfirm.display.inputAmountUSD}` : ''}
                      </Text>
                    </View>
                    <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                      <Text className="text-[13px] text-text-secondary font-pp-medium">You shield</Text>
                      <Text className="text-[13px] text-text font-pp-regular">{swapConfirm.display.depositAmountText}</Text>
                    </View>
                    {swapConfirm.display.durationText ? (
                      <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                        <Text className="text-[13px] text-text-secondary font-pp-medium">Estimated time</Text>
                        <Text className="text-[13px] text-text font-pp-regular">{swapConfirm.display.durationText}</Text>
                      </View>
                    ) : null}
                    <Text className="text-[12px] leading-[16px] text-text-secondary font-pp-regular">
                      The exact amount spent depends on the route and can move within slippage.
                      {swapConfirm.display.needsApproval
                        ? ` Two transactions: a ${payToken?.symbol ?? 'token'} approval first, then the swap.`
                        : ' One transaction.'}
                    </Text>
                    <Text className="text-[12px] leading-[16px] text-text-secondary font-pp-regular">
                      {SWAP_DEPOSIT_REFUND_NOTE}
                    </Text>
                    <FeeWarning breakdown={depositFeeBreakdown} testID="deposit-route-fee-warning" />
                    <View className="flex-row flex-wrap gap-[10px]">
                      <Pressable
                        className="min-w-[100px] items-center rounded-control border border-border-light px-[16px] py-[10px]"
                        onPress={() => { const { resolve } = swapConfirm; setSwapConfirm(null); resolve(false); }}
                      >
                        <Text className="text-[13px] text-text font-pp-medium">Cancel</Text>
                      </Pressable>
                      <Pressable
                        className="min-w-[140px] grow items-center rounded-control bg-button-primary px-[16px] py-[10px]"
                        onPress={() => { const { resolve } = swapConfirm; setSwapConfirm(null); resolve(true); }}
                      >
                        <Text className="text-[13px] text-button-primary-text font-pp-medium">Confirm and sign</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
                {/* Unsaved-claim warning: this browser could not store the
                    recipient's claim link. The chain has the backup; the user
                    decides whether to go on without the local copy. */}
                {storageConfirm ? (
                  <View className="w-full gap-[10px] rounded-control border border-warning bg-warning-bg p-[16px]">
                    <Text className="text-[13px] text-warning font-pp-medium">{UNSAVED_CLAIM_WARNING.title}</Text>
                    <Text className="text-[12px] leading-[16px] text-text-secondary font-pp-regular">{UNSAVED_CLAIM_WARNING.body}</Text>
                    <View className="flex-row flex-wrap gap-[10px]">
                      <Pressable
                        className="min-w-[100px] items-center rounded-control border border-border-light px-[16px] py-[10px]"
                        onPress={() => { const { resolve } = storageConfirm; setStorageConfirm(null); resolve(false); }}
                      >
                        <Text className="text-[13px] text-text font-pp-medium">{UNSAVED_CLAIM_WARNING.cancel}</Text>
                      </Pressable>
                      <Pressable
                        className="min-w-[140px] grow items-center rounded-control bg-button-primary px-[16px] py-[10px]"
                        onPress={() => { const { resolve } = storageConfirm; setStorageConfirm(null); resolve(true); }}
                      >
                        <Text className="text-[13px] text-button-primary-text font-pp-medium">{UNSAVED_CLAIM_WARNING.proceed}</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}

                <View className="items-center gap-[5px]">
                  <Text className="text-[24px] text-text font-pp-regular">
                    {depositAmountFormatted}
                  </Text>
                </View>

                {txHash && explorerUrl ? (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => Linking.openURL(explorerUrl)}>
                    <Text className="text-[14px] text-[#3B82F6] underline font-pp-medium">
                      {explorerIsSui ? 'View on Explorer' : `View on ${getExplorerName(explorerChainId)}`}
                    </Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={explorerIsSui ? 'SuiVision' : getExplorerName(explorerChainId)} />
                  </View>
                ) : null}
              </>
            )}

            {step === 'success' && (
              <>
                <Text className="text-[24px] text-center w-full text-text font-pp-sans-bold">
                  Deposit Successful
                </Text>

                <View className="items-center gap-[16px] py-[20px]">
                  <CheckCircleIcon color={colors.success} />
                  <Text className="text-[16px] text-center text-success font-pp-medium">
                    Transaction submitted
                  </Text>
                </View>

                <View className="items-center gap-[5px]">
                  <Text className="text-[24px] text-text font-pp-regular">
                    {depositAmountFormatted}
                  </Text>
                  <Text className="text-[14px] text-[#737373] font-pp-regular">
                    {depositRecipient
                      // A blind deposit announces nothing on chain, so the
                      // usual "they will find it" line would be a lie: without
                      // the link below there is no next sync that finds this.
                      ? claimReceiptUrl
                        ? `deposited for ${shortAddress(depositRecipient)}. Send them the claim link below so they can receive it`
                        : `deposited for ${shortAddress(depositRecipient)}. They can discover it on their next sync`
                      : 'deposited to Privacy Pool'}
                  </Text>
                  {preparedYieldExitDisclosure ? (
                    <Text className="max-w-[340px] text-center text-[12px] leading-[17px] text-text-secondary font-pp-regular">
                      {preparedYieldExitDisclosure}
                    </Text>
                  ) : null}
                </View>

                {claimReceiptUrl ? (
                  /* The claim link is the point of this card (DEV-491): a
                     small bordered button under the receipt was easy to miss,
                     and nothing else gets the recipient their money. */
                  <View className="w-full gap-[10px] rounded-control border border-border bg-background-secondary p-[14px]">
                    <Text className="text-center text-[13px] leading-[19px] text-text font-pp-medium">
                      {CLAIM_LINK_INSTRUCTION}
                    </Text>
                    <Text numberOfLines={1} className="text-center text-[12px] text-text-secondary font-pp-regular" testID="deposit-claim-link-preview">
                      {previewNoteReceiptUrl(claimReceiptUrl)}
                    </Text>
                    <Pressable
                      className="w-full items-center justify-center rounded-control bg-button-primary px-[16px] py-[14px]"
                      testID="deposit-copy-claim-link"
                      onPress={() => {
                        void (async () => {
                          if (await copyClaimLink()) return;
                          errorToast({
                            title: 'Could not copy. The link is also on the transaction row, under Recover claim link.',
                            variant: 'destructive',
                          });
                        })();
                      }}
                    >
                      <Text className="text-[15px] text-button-primary-text font-pp-semi-bold">
                        {claimLinkCopied ? 'Copied ✓' : 'Copy claim link'}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}

                {stellarLabelRetry ? <StellarLabelRetryNotice retry={stellarLabelRetry.retry} /> : null}

                {txHash && explorerUrl ? (
                  <View className="flex-row items-center gap-[6px]">
<Pressable onPress={() => Linking.openURL(explorerUrl)}>
                    <Text className="text-[14px] text-[#3B82F6] underline font-pp-medium">
                      {explorerIsSui ? 'View on Explorer' : `View on ${getExplorerName(explorerChainId)}`}
                    </Text>
                  </Pressable>
                    <ExplorerPrivacyHint explorerName={explorerIsSui ? 'SuiVision' : getExplorerName(explorerChainId)} />
                  </View>
                ) : null}

                <View className="flex-row gap-[12px] items-center">
                  <Pressable
                    className="border rounded-control px-[20px] py-[10px] items-center justify-center border-[#B8BBBF] bg-card-background"
                    onPress={requestCloseDepositModal}
                  >
                    <Text className="text-[14px] text-text font-pp-medium">
                      Done
                    </Text>
                  </Pressable>
                </View>
              </>
            )}

            {/* Footer */}
            <View className="flex-row items-center gap-[16px]">
              <Pressable onPress={() => Linking.openURL(DEPOSIT_FAQ_URL)}>
                <Text className="text-[12px] text-[#4D4D4D] font-pp-regular">
                  FAQ
                </Text>
              </Pressable>
              <View className="w-[1px] h-[12px] bg-[#4D4D4D]" />
              <Pressable onPress={() => Linking.openURL(SUPPORT_FORM_URL)}>
                <Text className="text-[12px] text-[#4D4D4D] font-pp-regular">
                  Support
                </Text>
              </Pressable>
              <View className="w-[1px] h-[12px] bg-[#4D4D4D]" />
              <Pressable onPress={() => Linking.openURL(SUPPORT_TELEGRAM_URL)} testID="deposit-support-telegram">
                <Text className="text-[12px] text-[#4D4D4D] font-pp-regular">
                  Telegram
                </Text>
              </Pressable>
            </View>
          </Animated.View>
          </HubErrorBoundary>
        </View>
      )}

      {/* Token picker — a layer ON TOP of the deposit modal: full-screen on
          phones, centered card on desktop. Search, paste-any-address (resolved
          on-chain), the wallet's real balances/USD values, and a per-row chip
          saying how the asset can enter the pool. Only ASP/app-supported
          networks are listed (Sepolia for now); the "active" network is the
          app-wide chain selection (Sui via the chain router, EVM keyed off the
          wagmi chain id).

          SELECTION SEMANTICS ARE UNCHANGED from the previous
          TokenNetworkSelector (still used by the swap modal): the sheet hands
          back a configured asset, we resolve it against `availableTokens` and
          route it through the same handleTokenSelect, so the Sui/EVM validity
          effect and the amount re-clamp behave exactly as before. */}
      {isOpen && dropdownOpen && (
        <TokenSelectSheet
          tokens={[
            // Stellar rows carry their chain: the sheet's chainId is the EVM
            // read chain, and the network filter compares against it.
            ...availableTokens.map((t) => ({ ...t, name: TOKEN_NAMES[t.symbol], ...(isStellar ? { chainId: STELLAR_TESTNET_ID } : {}) })),
            ...comingSoonTokens.map((t) => ({
              symbol: t.symbol,
              address: t.address,
              decimals: t.decimals,
              isNative: t.isNative,
              name: TOKEN_NAMES[t.symbol],
              comingSoon: true,
              depositPaused: t.depositPaused === true,
            })),
          ]}
          networks={supportedNetworks}
          selectedAddress={selectedToken.address}
          activeNetworkId={isStellar ? STELLAR_TESTNET_ID : isSuiChain ? SUI_TESTNET_ID : chainId}
          chainId={chainId}
          // Non-EVM: no EVM balance reads or swap routes. Stellar shows no
          // wallet figure here (the sheet's native read is Sui's), the form
          // below shows the Freighter balance.
          isSui={isSui}
          balanceMode={isStellar ? 'none' : 'wallet'}
          onSelectToken={(t) => {
            const token = availableTokens.find((x) => x.address === t.address);
            if (token) handleTokenSelect(token);
          }}
          // null = the user cleared the chip; this sheet lists ONE chain's
          // assets, so there is nothing to widen to — keep the chain.
          onSelectNetwork={(id) => { if (id !== null) selectChain(id); setDropdownOpen(false); }}
          onClose={() => setDropdownOpen(false)}
        />
      )}

      {/* "Pay with" picker (flow 1). Same sheet, but the network pane is inert:
          a swap-into-deposit sources the input token on the SAME chain as the
          pool, so switching chains here would abandon the deposit form. */}
      {isOpen && payDropdownOpen && (
        <TokenSelectSheet
          tokens={payTokenOptions.map((t) => ({ ...t, name: TOKEN_NAMES[t.symbol] }))}
          networks={supportedNetworks}
          selectedAddress={payToken?.address ?? ''}
          activeNetworkId={chainId}
          chainId={chainId}
          isSui={false}
          balanceMode="wallet"
          onSelectToken={(t) => {
            const token = payTokenOptions.find((x) => x.address === t.address);
            if (token) setPayToken(token);
            setPayDropdownOpen(false);
          }}
          onSelectNetwork={() => { /* same-chain by construction */ }}
          onClose={() => setPayDropdownOpen(false)}
        />
      )}
    </DepositModalContext.Provider>
  );
}
