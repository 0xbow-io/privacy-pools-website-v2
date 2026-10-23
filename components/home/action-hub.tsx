import { spendableBalanceLabel } from '@/services/spendable-balance-label';
import { useShareAmountField } from '@/hooks/use-share-amount-field';
import { useBalanceDisplay } from '@/hooks/use-balance-display';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import { SWAP_DEPOSIT_REFUND_NOTE } from '@/services/swap-deposit-copy';
import { ENS_UNSUPPORTED_MESSAGE, isPotentialEnsName } from '@/services/ens';
import { ExplorerPrivacyHint, explorerNameFromUrl } from '@/components/ui/explorer-privacy-hint';
import { isSupersededLegacyPool, poolDisplayLabel } from '@/config/pool-paths';
import { presetExceedsWithdrawMax } from '@/services/withdraw-preset-guard';
import { shieldHeadroomRoomText } from '@/services/shield-headroom-copy';
import { policedHttp } from '@/services/egress-transport';
import { UNSAVED_CLAIM_WARNING } from '@/services/unsaved-claim-warning-copy';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CARD_SHADOW, WEB_NO_OUTLINE } from '@/components/ui/web-style-shims';
import { HoverHint } from '@/components/ui/hover-hint';
import { ActivityIndicator, Animated, Easing, Linking, Platform, Pressable, ScrollView as RNScrollView, Text, TextInput, useWindowDimensions, View, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useIsFocused, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useAccount, useBalance, useEstimateFeesPerGas, usePublicClient, useReadContract } from 'wagmi';
import { useConnectWallet, useSuiClientQuery, useWallets } from '@mysten/dapp-kit';
import { createPublicClient, erc20Abi, formatUnits, parseUnits } from 'viem';
import { Colors, Glow, TokenHues } from '@/constants/theme';
import { TAB_HIGHLIGHT_MOTION } from '@/constants/motion';
import { useTheme } from '@/components/theme-provider';
import { StellarWalletOption } from '@/components/stellar-wallet-option';
import { usePools } from '@/components/pools-provider';
import { getActionableTokens, getDepositableTokens, getDepositComingSoonTokens, getKnownTokenMetadata, getTokenMetadataBySymbol, NATIVE_ASSET_ADDRESS } from '@/config/tokens';
import {
  QUICK_AMOUNTS_NATIVE,
  QUICK_AMOUNTS_STABLE,
  TOKEN_NAMES,
  checkRecipientRegistration,
  useDepositModal,
} from '@/components/deposit-modal-provider';
import { isCheckableRecipient, LEARN_MORE_UNREGISTERED_LABEL, recipientDepositConflict, recipientRegistrationHint, UNREGISTERED_DEPOSIT_DOCS_URL, type RecipientRegistrationState } from '@/services/recipient-registration-hint';
import {
  ENTRYPOINT_ASSETS_ABI,
  getMinimumDepositAmount,
  getVettingFeeBPS,
  type EntrypointAssetConfig,
} from '@/services/entrypoint-assets';
import { useQuery } from '@tanstack/react-query';
import { ACTIVE_ENVIRONMENT } from '@/config/environments';
import { cappedQuickAmounts, checkDepositCap } from '@/services/deposit-cap';
import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { resolveConfiguredEntrypoint } from '@/services/pool-entrypoint';
import { MoreWalletsButton, useWalletPicker, WalletConnectQr, WalletDeepLinkList, WalletLinksPreparing, WalletNotOpened, WalletOptionContent } from '@/components/wallet-connect-modal-provider';
import { PasskeySignInPanel } from '@/components/passkey-sign-in-panel';
import { usePasskeyAccount } from '@/components/passkey-account-context';
import { AccountKeySignIn } from '@/components/account-key-sign-in';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { useWithdrawModal } from '@/components/withdraw-modal-provider';
import { useTransferModal } from '@/components/transfer-modal-provider';
import { useSwapModal } from '@/components/swap-modal-provider';
import { usePaymentRequestModal } from '@/components/payment-request-modal-provider';
import { crossChainReshieldSupported, crossChainSwapDepositSupported, getSwapDestinationChains, getSwapOutputTokens, intentSwapInputSupported, getSwapProcessorAddress, intentSwapsEnabledForChain, swapChainUnavailableReason, swapDepositEnabledForChain, swapInputUnits, type SwapTokenInfo } from '@/config/intent-swaps';
import { swapDestinationNetworks, swapSourcePoolReason } from '@/services/widget-chain-lists';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useToast } from '@/components/toast-provider';
import { previewNoteReceiptUrl } from '@/services/note-receipt-preview';
import { CLAIM_LINK_INSTRUCTION } from '@/services/link-leave-guard';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { useReceiveSetup } from '@/hooks/use-receive-setup';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { FINISH_SETUP_PRIMARY, RECEIVE_WARNING } from '@/services/receive-setup';
import { getConfiguredYieldDeploymentForAsset } from '@/config/yield';
import { payWrapsIntoPool as payWrapsIntoPoolRule } from '@/services/shield-pay-routing';
import { swapSurfaceEnabled } from '@/config/intent-lockdown';
import { formatDepositMinimum, PREVIEW_MINT_ABI, requiredUnderlyingForMinShares, scaleUnits } from '@/services/deposit-limits';
import { conversionBelowMinimum, conversionFundingUnits } from '@/services/shield-conversion-units';
import { fitAmountFontSize, sanitizeAmountInput, parseTokenAmount } from '@/services/token-amount';
import { fiatEntryAvailable, formatUsdLabel, sanitizeUsdInput, shieldDestinationLabel, tokenToUsdText, usdChipLabel, usdToTokenAmount } from '@/services/hub-fiat-entry';
import { getUiParam, pushUiParamEntry, retireUiParamEntry, rebaseUiParamEntry, subscribeUiUrl } from '@/components/ui-url-events';
import { useShareYield } from '@/hooks/use-share-yield';
import { useYieldVaultProbeVersion } from '@/hooks/use-yield-vault-probe';
import { displayTokenSymbol, isShareSymbol, shareRedemptionDisclosure } from '@/services/share-display';
import { formatTokenBalance, isStablecoin } from '@/services/token-format';
import { conversionFundingToken, targetAcceptsConversion } from '@/config/intent-targets';
import { getYieldShareToken } from '@/services/share-yield';
import { compactPhoneLayout } from '@/services/header-nav';
import { ctaRevealDelta } from '@/services/action-hub-fit';
import { ShieldYieldSummary } from '@/components/home/shield-yield-summary';
import { FlowProgress } from '@/components/ui/flow-progress';
import { TokenMark, TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { PairArrow } from '@/components/ui/pair-arrow';
import { holdingsChainName, isHoldingsOnlyChain, WALLET_ROW_CHAIN_IDS, type WalletToken } from '@/services/wallet-tokens';
import { useWalletTokens } from '@/components/wallet-tokens-provider';
import { listShieldPools, defaultPoolFor, type ShieldPool } from '@/services/shield-pools';
import { fetchLifiContractCallDeliverable } from '@/services/lifi-quote';
import { useSwapPreview } from '@/hooks/use-swap-preview';
import { useShareRates } from '@/hooks/use-share-rates';
import { previewInputAmount, previewIsIdentity } from '@/services/swap-preview-input';
import { formatSwapExitEstimate } from '@/services/swap-exit-estimate';
import { sizeConvertingDeposit } from '@/services/cross-pay-sizing';
import { useTxActivity } from '@/components/tx-activity-provider';
import { INLINE_OP_HOST_ID } from '@/components/inline-op-portal';
import { requestTokenSheet } from '@/services/token-sheet-host';
import { registerSwapTabHandoff, clearSwapSendDraft, type SwapTabHandoffRequest } from '@/services/swap-handoff';
import { swapTabRecipientRoute } from '@/services/swap-tab-recipient';
import { inlineWithdrawTokenToPush } from '@/services/inline-withdraw-token-sync';
import { hubTokenCatalog, preferredHubToken, heldSymbolsFor, isYieldShareOnChain, NO_HOLDINGS, emptySpendToken, type HubAction, type HubHoldings } from '@/services/hub-token-catalog';
import { getChainConfig, isTestnetChain, supportedChainIds } from '@/config/chains';
import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { useStellarBalance } from '@/hooks/use-stellar-balance';
import { useExplorePanel } from '@/components/home/explore-panel-context';
import { useWalletUnlockGate } from '@/hooks/use-wallet-unlock-gate';
import { StellarLabelRetryNotice } from '@/components/stellar-label-retry';
import { isStellarAccountAddress } from '@/services/stellar/stellar-request';
import { useBackHandler } from '@/hooks/use-back-handler';
import { NATIVE_MOCK_ACTIVE } from '@/constants/native-mock';
import { getNativeMockWalletBalance } from '@/services/native-mock-data';
import { maxShieldAmountWei } from '@/services/wallet-tx-fees';
import { createLayoutPassBudget, createWidthDamper } from '@/services/layout-pass-budget';
import { Pill } from '@/components/ui/pill';
import { FeeWarning } from '@/components/fee-warning';
import { ShieldElsewherePanel } from '@/components/home/shield-elsewhere-panel';
import { SHIELD_GAS_UNITS } from '@/config/fee-warnings';
import { useFeePricing } from '@/hooks/use-fee-pricing';
import { buildFeeBreakdown, gasCostUsd, type FeeGasReading } from '@/services/fee-warning';
import { shieldElsewhere } from '@/services/shield-elsewhere';

// Shared content-zone floor = the tallest tab's natural height, so every tab
// lands on the same card height. Keep this in step with the real tallest tab:
// too low and a short tab shrinks the card, too high and the tallest tab gets
// dead space under it.
//
// Measured (1440px, disconnected): Swap is the tallest tab, at 440 with a
// RelaySwaps processor configured. Without one the tab is not offered at all.
const HUB_ZONE_MIN_H = 440;
// Gap between pager pages — visible only mid-swipe (it lives in the card's
// clipped overflow, so a settled page shows no inset at all).
const PAGE_GUTTER = 28;
// Slack between the pager's clip edge and the page content. The content used
// to start exactly on the horizontal ScrollView's clip edge, and on scaled
// displays the scroll offset lands on a fractional device pixel, so every
// 1px left border on the inline forms (warning box, chips, inputs, checkboxes)
// was eaten by the clip (Pat, 2026-08-29). Content stays aligned with the
// card; only the clip box grows.
const PAGE_EDGE = 2;
/** One page's width, which is also the scroll stride. */
const pageStride = (pagerW: number): number => pagerW + PAGE_GUTTER + PAGE_EDGE;

type Action = HubAction;
type HubToken = { symbol: string; decimals: number; isNative: boolean; yieldShare?: unknown; superseded?: boolean };

// On Sui the pool serves exactly one asset: native SUI in MIST (9 decimals).
// Offering the EVM list would leak over-precision amounts into the Sui flows.
const SUI_TOKENS: HubToken[] = [
  { symbol: 'SUI', decimals: 9, isNative: true },
];
// Stellar likewise: native XLM in stroops (7 decimals).
const STELLAR_TOKENS: HubToken[] = [
  { symbol: 'XLM', decimals: 7, isNative: true },
];
// XLM chips: all at or above this pool's 1 XLM minimum deposit.
const QUICK_AMOUNTS_XLM = ['1', '10', '50', '100', '500'];

const ACTIONS: { key: Action; label: string; cta: string }[] = [
  { key: 'shield', label: 'Shield', cta: 'Shield' },
  { key: 'withdraw', label: 'Withdraw', cta: 'Withdraw' },
  { key: 'send', label: 'Send', cta: 'Send privately' },
  // Intent swaps: flag-gated (EXPO_PUBLIC_INTENT_SWAPS) and EVM-only — the
  // tab is filtered out at render time when the flag is off or Sui is active.
  { key: 'swap', label: 'Swap', cta: 'Swap privately' },
  { key: 'request', label: 'Request', cta: 'Create a request' },
];

// RN-web only style for stripping the browser focus ring; cast needed for
// React Native Web compatibility (web-only CSS property).

/** 0x + 40 hex — the same shape the swap modal validates against. */
const SWAP_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The zero address is well-formed but is never a real destination. */
const SWAP_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// RN-Web 0.21 DOES convert inline shadow* to a web box-shadow (preprocess →
// createBoxShadowValue), so the StyleSheet baseline renders the card/CTA glows
// on web too — gating them native-only drops a real (but sub-tolerance:
// radius 20-32 at 0.1-0.25 alpha) web shadow; accepted and documented in
// workflows/plans/nativewind-p2-gates.md. The selected-tab glow below is the
// one that crossed tolerance, so it gets an explicit web boxShadow instead.
const NATIVE_SHADOW = Platform.OS !== 'web';
const WEB = Platform.OS === 'web';
const PICKER_TRANSITION_MS = 220;

/**
 * The front door. One centered card, Uniswap-shaped: pick an action, pick a
 * token, type a number, press the big green button. Everything heavier
 * (quotes, proofs, confirmations) stays in the battle-tested flows behind it —
 * this card is the calm surface that launches them, pre-filled.
 */
export function ActionHub({
  landing = false,
  onEngage,
  onInputFocus,
  onInputBlur,
  onTargetHeight,
}: {
  /** Simplify visitor controls and captions; entered amounts expand the Shield form. */
  landing?: boolean;
  onEngage?: () => void;
  /**
   * The amount field's own focus/blur pair. Kept separate from onEngage, which
   * also fires from button presses that never produce a blur: the page uses
   * these two to swap the marketing story out while someone is typing and back
   * in when they stop, and a one-way onEngage would strand it swapped out.
   */
  onInputFocus?: () => void;
  onInputBlur?: () => void;
  /**
   * The height the card is settling to, reported once per change. On web the
   * card animates its height, so a layout measurement can catch a frame of the
   * face it is leaving; this value never does.
   */
  onTargetHeight?: (height: number) => void;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { data, isLoading: poolsLoading } = usePools();
  const { openDepositModal, startInlineDeposit, resetInlineDeposit, flow: depositFlow } = useDepositModal();
  const { width: winWidth } = useWindowDimensions();
  // Phone web (the bottom tab bar is up): a tighter widget so the primary
  // button lands above the fold at 360x740 and up (Ameen, 2026-10-15).
  // Desktop and native keep their spacing.
  const tight = Platform.OS === 'web' && compactPhoneLayout(winWidth);
  const heroText = tight ? 'text-[34px] leading-[42px]' : 'text-[44px] leading-[52px]';
  const outText = tight ? 'text-[26px] leading-[32px]' : 'text-[44px] leading-[52px]';
  const outCard = tight ? 'gap-[6px] px-[16px] py-[12px]' : 'gap-[12px] px-[16px] py-[20px]';
  const { openWithdrawModal, closeWithdrawModal, inlineActive: withdrawInline, isOpen: withdrawIsOpen, inlineStep: withdrawStep, syncInlineAmount: syncWithdrawAmount, inlineAmount: withdrawAmount, inlineToken: withdrawToken, syncInlineToken: syncWithdrawToken, spendabilityLoading: withdrawSpendabilityLoading, spendabilityError: withdrawSpendabilityError, retrySpendability, getSpendableBalanceWei: getWithdrawSpendableBalanceWei, getWithdrawMaxWei } = useWithdrawModal();
  const { openTransferModal, closeTransferModal, inlineActive: transferInline, isOpen: transferIsOpen, syncInlineAmount: syncTransferAmount, getTransferMaxWei, inlineStep: transferStep, inlineAmount: transferAmount, inlineToken: transferToken, syncInlineToken: syncTransferToken } = useTransferModal();
  const { openSwapModal, closeSwapModal, isOpen: swapIsOpen, inlineActive: swapInline, inlineStep: swapStep, inlineSend: swapInlineSend, inlineRecipientRegistration: swapRecipientRegistration, syncInlineForm: syncSwapForm } = useSwapModal();
  const {
    openRequestPaymentModal, closePaymentRequestModal,
    inlineActive: requestInline, isOpen: requestIsOpen,
    requestToken, requestAmount, requestCreated,
    syncInlineRequestForm: syncRequestForm,
  } = usePaymentRequestModal();
  // Desktop web runs every operation INSIDE this card (modal-less); the
  // providers re-parent their step content into the host View below.
  const inlineOps = Platform.OS === 'web';

  // The active tab lives in the URL (`/?action=shield|withdraw|send|request`)
  // so each action is deep-linkable. Tab presses use replace semantics —
  // flipping tabs shouldn't stack browser history. `deposit` is accepted as
  // an alias for shield.
  const router = useRouter();
  // The web navigator RETAINS previous stack screens: it hides them with
  // display:none but keeps rendering their children, so a pool-page hub left
  // behind on Shield still runs its effects and still sees this shared
  // Withdraw/Send/Request/Swap provider. Its one-flow invariant then closed
  // the FOCUSED hub's flow, whose 50ms retry reopened it, and so on: an
  // open/close loop in which the widget's CTA is briefly replaced by the empty
  // inline host and paints nothing. That is the flashing button (Pat's
  // recording, 2026-09-04; codex reproduced 29 open/close cycles in 1.5s with
  // two hubs, 1 open and 0 closes with these guards). Only the focused hub may
  // open, close or host a flow.
  const isFocused = useIsFocused();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ action?: string | string[] }>();
  const rawAction = Array.isArray(params.action) ? params.action[0] : params.action;
  // expo-router hydrates search params ASYNC on a (re)mount: browser-back to
  // /?action=withdraw rendered one Shield frame first, then slid to Withdraw
  // once the params landed. The URL itself is already correct synchronously —
  // read it directly as the fallback so the first frame starts on the right tab.
  const urlAction = Platform.OS === 'web' && rawAction === undefined ? getUiParam('action') : null;
  const effectiveAction = rawAction ?? urlAction ?? undefined;
  const normalizedAction = effectiveAction === 'deposit' ? 'shield' : effectiveAction;
  const requestedAction: Action = ACTIONS.some((a) => a.key === normalizedAction)
    ? (normalizedAction as Action)
    : 'shield';

  // Tabs lock while ANY operation is in flight (txPending covers the modal
  // flows — withdraw/send/etc — via their beginTx/endTx; the inline deposit's
  // loading step is checked directly since the Sui path doesn't beginTx, and
  // so is an executing swap, whose flow has no beginTx either) and unlock the
  // moment it completes, fails, or is dismissed.
  const { txPending } = useTxActivity();
  // The Send tab's private swap-send counts too: on a narrow web width its
  // executing step leaves the inline host for a sheet, so swapInline is false
  // while it proves.
  const swapExecuting = (swapInline || swapInlineSend) && swapStep === 'executing';
  const tabsDisabled = txPending || (depositFlow.inlineActive && depositFlow.step === 'loading') || swapExecuting;
  // Whether the amount field currently owns focus, and the blur reporter that
  // survives its removal. The ref callback must keep ONE identity for the
  // component's life: a fresh arrow each render would make React call it with
  // null on every keystroke and report a blur mid-typing.
  const amountFieldFocused = useRef(false);
  const onInputBlurRef = useRef(onInputBlur);
  useEffect(() => { onInputBlurRef.current = onInputBlur; }, [onInputBlur]);
  const amountFieldRef = useCallback((node: unknown) => {
    if (node || !amountFieldFocused.current) return;
    amountFieldFocused.current = false;
    onInputBlurRef.current?.();
  }, []);
  // Each page's amount field width, so a long exact figure (Max on an
  // 18-decimals pool) shrinks to fit beside the pool pill instead of clipping.
  const [amountFieldWidths, setAmountFieldWidths] = useState<Partial<Record<Action, number>>>({});

  // Pager callbacks read these through refs so the scroll handler stays
  // stable while the resolved action/setter live later in the component.
  const actionRef = useRef<Action>('shield');
  const setActionRef = useRef<(a: Action) => void>(() => {});
  const setAction = (a: Action) => {
    if (tabsDisabled) return;
    // A pager-settle callback queued before this route lost focus must not
    // close the incoming screen's flow (same shared-provider hazard).
    if (typeof navigation?.isFocused === 'function' && !navigation.isFocused()) return;
    // Re-selecting an editing form keeps its provider. Still request the URL:
    // this click may supersede another tab press whose params are pending.
    // Completed flows can use the tab to start again.
    const completed = (depositFlow.inlineActive && depositFlow.step === 'success')
      || (withdrawInline && withdrawStep === 'success')
      || (transferInline && transferStep === 'success')
      || (requestInline && requestCreated)
      || (swapInline && swapStep === 'success');
    // Leaving the inline success panel via a tab returns the card to the
    // form — otherwise the panel kept rendering over every tab and the bar
    // read as dead.
    if (depositFlow.inlineActive && depositFlow.step !== 'loading' && (a !== actionRef.current || completed)) {
      resetInlineDeposit();
      if (depositFlow.step === 'success') {
        setAmount('');
        refetchWalletBalance();
      }
    }
    // A different tab's layout effect transfers ownership before paint.
    // Keeping the old form until its route changes avoids a blank interim
    // render while Expo applies the new URL. Re-selecting success resets it.
    if (a === actionRef.current && completed) {
      if (withdrawInline) closeWithdrawModal();
      if (transferInline) closeTransferModal();
      if (requestInline) closePaymentRequestModal();
      if (swapInline) closeSwapModal();
    }
    // The panel param lives in RAW history (the drawer pushes it outside the
    // router), so a bare setParams rebuilds the URL without it — a tab click
    // in the split view collapsed the panel. Carry the live value through.
    const livePanel = Platform.OS === 'web' && typeof window !== 'undefined' ? getUiParam('panel') : null;
    router.setParams(livePanel ? { action: a, panel: livePanel } : { action: a });
  };
  setActionRef.current = setAction;
  const panel = useExplorePanel();
  // Per-tab amounts (QA 2026-08-18): each action keeps its own entry — 0.1
  // typed on Shield must not prefill Withdraw. One map, keyed by the live
  // action (via actionRef so functional updates hit the tab that's showing).
  const [amounts, setAmounts] = useState<Partial<Record<Action, string>>>({});
  const setAmount = useCallback((next: string | ((prev: string) => string)) => {
    setAmounts((m) => {
      const key = actionRef.current;
      const prev = m[key] ?? '';
      const value = typeof next === 'function' ? next(prev) : next;
      return value === prev ? m : { ...m, [key]: value };
    });
  }, []);
  // Same write, for a tab named explicitly. The flows below settle and get
  // reopened while the user may be looking at another tab, so those writes
  // must not land on whichever card happens to be visible.
  const setAmountFor = useCallback((key: Action, value: string) => {
    setAmounts((m) => ((m[key] ?? '') === value ? m : { ...m, [key]: value }));
  }, []);

  // Unified chain/wallet routing: the hub must treat a connected Sui wallet as
  // connected (wagmi alone reports Sui-only users as disconnected) and offer
  // the ACTIVE chain's asset list, not the EVM one.
  const { isSui: isSuiChain, isStellar, selectChain, activeChainId } = useChainRouter();
  // "Not an EVM chain": Sui and Stellar share every EVM-only gate below (one
  // native asset, no swaps, no yield, no LiFi, no requests, no depositFor).
  // The few places the two differ (asset, wallet balance, connect) branch on
  // `isSuiChain` / `isStellar` explicitly.
  const isSui = isSuiChain || isStellar;
  const stellarWallet = useStellarWallet();
  const { data: stellarBalance, refetch: refetchStellarBalance } = useStellarBalance(isStellar && stellarWallet.isConnected ? stellarWallet.address : null);
  const { toast } = useToast();
  // Full asset/network picker for the deposit form — same sheet the modal
  // used; the sheet itself staying a layer is fine per product call.
  const [tokenSheetOpen, setTokenSheetOpen] = useState(false);
  // Pay sheet: null = NO chain filter, which is the default (Pat, 2026-08-18 —
  // the picker opens on every chain's assets); a number is an explicit pick.
  const [payNetwork, setPayNetwork] = useState<number | null>(null);
  // Optional swap recipient, collapsed behind a wallet icon on the Swap tab and
  // forwarded to the swap modal (which validates it) on launch.
  // Optional Shield recipient ("Deposit to another address", SDK depositFor):
  // collapsed behind the same wallet icon as the swap recipient. The deposit
  // provider owns the registration check and the money path; this is a
  // pass-through, and a collapsed field means "my own wallet".
  const [shieldRecipientOpen, setShieldRecipientOpen] = useState(false);
  const [shieldRecipient, setShieldRecipient] = useState('');
  // The Swap tab's recipient (DEV-510, grep [swap-deposit-recipient]): the
  // swapped output lands as a shielded note FOR that account
  // (reshield-and-transfer, the Send tab's private swap-send). Collapsed means
  // a note of your own. It is never a wallet payout; that is Withdraw.
  const [swapRecipientOpen, setSwapRecipientOpen] = useState(false);
  const [swapRecipient, setSwapRecipient] = useState('');
  // The asset being swapped INTO. A swap with no output token is not a swap,
  // which is what the tab used to offer — null means "pick one" and the CTA
  // stays disabled. Held by address so a chain switch can invalidate it.
  const [swapOutAddress, setSwapOutAddress] = useState<string | null>(null);
  const [swapOutSheetOpen, setSwapOutSheetOpen] = useState(false);
  // "All chains" on the receive sheet: list every destination's tokens at once.
  const [swapOutSheetAllChains, setSwapOutSheetAllChains] = useState(false);
  // The Request tab's asset picker. Its own flag and its own publisher below:
  // the shield sheet lists wallet holdings and other chains' pool assets, and a
  // request can only ever emit THIS chain's pool catalog.
  const [requestSheetOpen, setRequestSheetOpen] = useState(false);
  // Chain filter chip inside the request sheet; null = list every chain.
  const [requestSheetNetwork, setRequestSheetNetwork] = useState<number | null>(null);

  const { isConnected: walletConnected, address: unifiedAddress } = useMultiChainWallet();
  // Request warns (without blocking) while the account can't receive privately.
  const { partial: receivePartial, canFinish: canFinishSetup } = useReceiveSetup();
  const { openFinishSetup } = useKeystoreRegistrationModal();
  // A hidden recipient must neither block Connect Wallet nor reach a deposit.
  // Stellar deposits for another REGISTERED Stellar account (G...); Sui has no depositFor.
  const shieldRecipientEnabled = shieldRecipientOpen && !isSuiChain && (!landing || walletConnected);
  const shieldRecipientInvalid = shieldRecipientEnabled
    && (isStellar
      ? !isStellarAccountAddress(shieldRecipient.trim())
      : !SWAP_ADDRESS_RE.test(shieldRecipient.trim())
        || shieldRecipient.trim().toLowerCase() === SWAP_ZERO_ADDRESS);
  const suiWallets = useWallets();
  const { mutate: suiConnect } = useConnectWallet();

  // Intent swaps: gated on the flag AND a configured RelaySwaps processor
  // for this chain (fail closed), and EVM-only (no LiFi path on Sui). The
  // tab is hidden and a deep-linked ?action=swap degrades to shield.
  // Gate the Swap tab on the chain the swap modal ACTS ON (the app's
  // selection) — gating on the wagmi store chain advertised a tab whose modal
  // then ran against a different chain whenever the two split.
  const swapAvailable = intentSwapsEnabledForChain(activeChainId) && !isSui;
  // A chain without a working intent route has no Swap destination to offer.
  const swapSurface = swapSurfaceEnabled();
  const swapVisible = swapSurface && swapAvailable;
  const visibleActions = useMemo(
    () => ACTIONS.filter((a) => a.key !== 'swap' || swapVisible),
    [swapVisible],
  );
  const action: Action = requestedAction === 'swap' && !swapVisible ? 'shield' : requestedAction;

  // Each action remembers its asset. Panel picks apply once to the current
  // action; a fallback on another tab must not overwrite a saved Shield pick.
  const panelSelection = panel?.selection ?? null;
  const [assetSelection, setAssetSelection] = useState(() => ({
    byAction: {
      shield: landing ? 'USDC' : 'ETH',
      ...(panelSelection?.assetSymbol ? { [action]: panelSelection.assetSymbol } : {}),
    } as Partial<Record<Action, string>>,
    panelSelection,
  }));
  if (panelSelection !== assetSelection.panelSelection) {
    setAssetSelection({
      byAction: panelSelection?.assetSymbol
        ? { ...assetSelection.byAction, [action]: panelSelection.assetSymbol }
        : assetSelection.byAction,
      panelSelection,
    });
  }
  const token = assetSelection.byAction[action] ?? (action === 'shield' && landing ? 'USDC' : action === 'withdraw' || action === 'send' ? emptySpendToken(activeChainId)?.symbol ?? 'ETH' : 'ETH');
  const setToken = useCallback((symbol: string) => {
    setAssetSelection((previous) => ({
      ...previous,
      byAction: { ...previous.byAction, [actionRef.current]: symbol },
    }));
    panel?.selectAsset({ assetSymbol: symbol });
  }, [panel]);

  // At most ONE inline flow may own the card, and which one is decided by the
  // tab in the URL. A tab press already dismisses the previous flow, but every
  // other way the tab can change bypasses that handler: the mobile bottom bar
  // pushes `/?action=…` straight into the router, a deep link lands on a tab
  // directly, and browser back/forward rewrites the param behind our back. When
  // the tab moved that way with a flow still open, the old flow stayed mounted
  // and the new one mounted below it, so Withdraw drew the Send pair AND the
  // withdraw pair: two arrows, two recipient fields, two CTAs. So make it an
  // invariant of the URL rather than a side effect of the tab handler.
  //
  // Only inline flows are considered: `inlineActive` requires an open with
  // `{ inline: true }`, which is this card's own doing, so a mobile modal the
  // user opened over the page is never touched. Skipped while the tabs are
  // locked, so a proof or relay in flight is never yanked out from under them.
  useLayoutEffect(() => {
    // A RETAINED hub (hidden route) must never close the focused one's flow:
    // the provider is shared and its `action` is its own route's, so a pool
    // page left on Shield closed every Withdraw the home hub opened.
    if (!isFocused || tabsDisabled) return;
    if (action !== 'withdraw' && withdrawInline) closeWithdrawModal();
    if (action !== 'send' && transferInline) closeTransferModal();
    if (action !== 'request' && requestInline) closePaymentRequestModal();
    // A private swap-send from the Send tab belongs to Send, not to Swap.
    if (swapInline && (swapInlineSend ? action !== 'send' : action !== 'swap')) closeSwapModal();
  }, [
    action, isFocused, tabsDisabled, withdrawInline, transferInline, requestInline, swapInline, swapInlineSend,
    closeWithdrawModal, closeTransferModal, closePaymentRequestModal, closeSwapModal,
  ]);

  // --- Pager wiring (tabs switch in place; touch pans) ---
  actionRef.current = action;
  const amount = amounts[action] ?? '';

  // DEV-553 (Mike, Android MetaMask webview): with an amount typed, a
  // validation line and the recommended row can push the CTA behind the
  // floating tab bar. On phone web, once the keyboard is down (blur, a chip,
  // a tab change), bring the CTA into view above the bar. Layout only: no
  // request is made or timed by this.
  const [ctaRevealTick, setCtaRevealTick] = useState(0);
  // After blur the page leaves typing mode and grows back below the hub over
  // the next renders; until then there is nothing to scroll.
  const CTA_REVEAL_DELAY_MS = 300;
  useEffect(() => {
    if (!WEB || !tight || amountFieldFocused.current) return;
    if (!(parseFloat(amount) > 0)) return;
    let raf = 0;
    const timer = setTimeout(() => {
      raf = requestAnimationFrame(() => {
        // Refocused during the delay: the keyboard is back up, leave the page be.
        if (amountFieldFocused.current) return;
        // Looked up when it runs: the pager remounts pages, so a ref captured
        // earlier can point at a detached node.
        const node = document.querySelector<HTMLElement>(`[data-testid="hub-cta-${action}"]`);
        if (!node) return;
        const rect = node.getBoundingClientRect();
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const delta = ctaRevealDelta(viewportHeight, rect.top, rect.bottom);
        if (delta <= 0) return;
        // The page's own vertical scroller (the home ScrollView). scrollBy on
        // it, so the horizontal pager is never moved.
        let scroller: HTMLElement | null = node.parentElement;
        while (scroller) {
          const overflowY = getComputedStyle(scroller).overflowY;
          if ((overflowY === 'auto' || overflowY === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
          scroller = scroller.parentElement;
        }
        (scroller ?? document.scrollingElement ?? document.documentElement).scrollBy({ top: delta, behavior: 'smooth' });
      });
    }, CTA_REVEAL_DELAY_MS);
    return () => { clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [tight, action, amount, ctaRevealTick]);

  // A completed send leaves the form on screen (the flow closes on Done and the
  // hub reopens it below), and the reopen carries the hub's amount straight back
  // in — so the amount outlived the transfer it belonged to, standing in both
  // the input and the flow's "Recipient receives" card, while the recipient
  // beside it was cleared. Reported 2026-08-24, reproduced on-chain.
  //
  // Cleared when the settled flow CLOSES, not when it succeeds: the amount card
  // stays on screen through the success panel, so clearing on the way in would
  // blank the figure the panel is reporting. The prepaint reopen below also
  // discards a completed amount before the provider resets its step.
  useEffect(() => {
    if (transferStep !== 'success' || transferIsOpen) return;
    setAmountFor('send', '');
  }, [transferStep, transferIsOpen, setAmountFor]);

  // The other half of the same disagreement: the flow can be opened with an
  // amount the hub never typed (a payment link, an activity row, a deep link
  // carrying `amount`). The hub owns the visible input inline, so without this
  // it reads 0 while the flow's receive card shows the real figure. Adopt it
  // only while the FORM is showing and only when the hub has nothing of its
  // own — never overwrite what the user typed, and never fight the clear above.
  useEffect(() => {
    if (!transferInline || transferStep !== 'select-notes' || !transferAmount) return;
    // Copy and retire the echo token on the first provider figure after a
    // push, whatever it is: a DIFFERENT figure (Max, the 75% escape) is adopted
    // AND clears the token, so a later provider figure equal to the old push
    // is no longer mistaken for an echo (codex, 2026-09-04, round 2).
    const transferEcho = pushedTransferRef.current;
    pushedTransferRef.current = null;
    if (transferAmount === transferEcho) return; // our own echo, consumed
    setAmounts((m) => (m.send === transferAmount ? m : { ...m, send: transferAmount }));
  }, [transferInline, transferStep, transferAmount]);

  // Withdraw is the same card with the same two copies of the amount, so it
  // settles and adopts the same way. Its form step is called 'withdraw'.
  useEffect(() => {
    if (withdrawStep !== 'success' || withdrawIsOpen) return;
    setAmountFor('withdraw', '');
  }, [withdrawStep, withdrawIsOpen, setAmountFor]);
  useEffect(() => {
    if (!withdrawInline || withdrawStep !== 'withdraw' || !withdrawAmount) return;
    const withdrawEcho = pushedWithdrawRef.current;
    pushedWithdrawRef.current = null;
    if (withdrawAmount === withdrawEcho) return; // our own echo, consumed (see Send above)
    setAmounts((m) => (m.withdraw === withdrawAmount ? m : { ...m, withdraw: withdrawAmount }));
  }, [withdrawInline, withdrawStep, withdrawAmount]);
  /**
   * The last amount the HUB pushed into each provider.
   *
   * The card and the inline flow keep two copies of the figure, and the mirror
   * effects below adopt the provider's copy. They used to adopt it only while
   * the card's own copy was empty, which meant anything the PROVIDER computed
   * after the first keystroke never reached the card: QA #4, where the 75% tab
   * moved the receive box while the big number stayed on the full balance. Max
   * and the presets had the same hole.
   *
   * Dropping that guard outright would fight the user's typing instead: each
   * keystroke pushes down, the provider echoes back a keystroke late, and the
   * echo would overwrite what they had just typed. So the guard becomes "ignore
   * the echo of my own push", which blocks exactly the loop and nothing else.
   *
   * The echo is CONSUMED (the ref is cleared) the moment it is matched. Left
   * set, the ref kept the last typed text forever, and a later figure the
   * provider computed on its own (Max, a preset, the 75% escape) that happened
   * to equal it was thrown away as "my echo" (codex, 2026-09-04).
   */
  const pushedWithdrawRef = useRef<string | null>(null);
  const pushedTransferRef = useRef<string | null>(null);
  const pushWithdrawAmount = useCallback((text: string) => {
    pushedWithdrawRef.current = text;
    syncWithdrawAmount(text);
  }, [syncWithdrawAmount]);
  const pushTransferAmount = useCallback((text: string) => {
    pushedTransferRef.current = text;
    syncTransferAmount(text);
  }, [syncTransferAmount]);

  const [pagerW, setPagerW] = useState(0);
  // Continuous scroll position drives the shared tab-highlight pill, so the
  // highlight flows between titles in sync with the page under the finger.
  const pagerScrollX = useRef(new Animated.Value(0)).current;
  const [tabsW, setTabsW] = useState(0);
  // Per-tab measured x + width. The tabs are content-proportional (see the tab
  // strip below), so the sliding highlight can no longer be derived from one
  // uniform cell width: it reads the real geometry of each tab instead.
  const [tabLayouts, setTabLayouts] = useState<({ x: number; w: number } | undefined)[]>([]);
  const setTabLayout = useCallback((i: number, x: number, w: number) => {
    if (w <= 0) return;
    setTabLayouts((prev) => {
      const cur = prev[i];
      // onLayout fires on every layout pass; without this equality guard the
      // setState would re-render, re-measure, and loop.
      if (cur && Math.abs(cur.x - x) < 0.5 && Math.abs(cur.w - w) < 0.5) return prev;
      const next = prev.slice();
      next[i] = { x, w };
      return next;
    });
  }, []);
  const pagerRef = useRef<RNScrollView | null>(null);
  const actionIndex = visibleActions.findIndex((x) => x.key === action);
  // Clicks/history own the selected tab. Scroll events may change it only
  // after a real drag or wheel gesture: layout reflow and scroll-snap also
  // emit scroll events, and must never turn Send into Request on resize.
  const reducedMotion = WEB && typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pillPlacedForW = useRef(0);
  const previousActionIndex = useRef(actionIndex);
  const pagerUserScrolling = useRef(false);
  const pagerScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // RN Web can deliver its trailing scroll event through an older callback.
  // Resolve that event against the current geometry, not the old page width.
  const pagerGeometry = useRef({ pagerW, visibleActions });
  pagerGeometry.current = { pagerW, visibleActions };
  useLayoutEffect(() => {
    if (!isFocused) return;
    const wasGesture = pagerUserScrolling.current;
    let contentFade: Animation | undefined;
    const actionChanged = previousActionIndex.current !== actionIndex;
    previousActionIndex.current = actionIndex;
    pagerUserScrolling.current = false;
    if (pagerScrollTimer.current) clearTimeout(pagerScrollTimer.current);
    if (pagerW > 0 && actionIndex >= 0) {
      const target = actionIndex * pageStride(pagerW);
      const firstLayoutAtWidth = pillPlacedForW.current !== pagerW;
      // A tab click changes the form in place. Only direct gestures pan the
      // pages; programmatic scroll events never get to select another tab.
      pagerRef.current?.scrollTo({ x: target, animated: false });
      // Keep the form visible throughout: a small opacity settle softens the
      // replacement without flashing blank or travelling between pages.
      const frame = WEB ? pagerFrameNode.current as unknown as HTMLElement | null : null;
      if (actionChanged && !wasGesture && !firstLayoutAtWidth && !reducedMotion && frame?.animate) {
        contentFade = frame.animate([{ opacity: 0.85 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
      }
      pillPlacedForW.current = pagerW;
      if (firstLayoutAtWidth || reducedMotion || !actionChanged) {
        pagerScrollX.setValue(target);
      } else {
        Animated.timing(pagerScrollX, {
          toValue: target,
          duration: TAB_HIGHLIGHT_MOTION.duration,
          easing: TAB_HIGHLIGHT_MOTION.easing,
          useNativeDriver: false,
        }).start();
      }
    }
    return () => {
      contentFade?.cancel();
      pagerScrollX.stopAnimation();
      if (pagerScrollTimer.current) clearTimeout(pagerScrollTimer.current);
    };
  }, [actionIndex, pagerW, pagerScrollX, reducedMotion, visibleActions, isFocused]);
  const onPagerScroll = useCallback((e: { nativeEvent: { contentOffset: { x: number } } }) => {
    if (!pagerUserScrolling.current) return;
    const x = e.nativeEvent.contentOffset.x;
    pagerScrollX.setValue(x);
    if (pagerScrollTimer.current) clearTimeout(pagerScrollTimer.current);
    pagerScrollTimer.current = setTimeout(() => {
      if (!pagerUserScrolling.current) return;
      const { pagerW, visibleActions } = pagerGeometry.current;
      const idx = Math.round(x / Math.max(1, pageStride(pagerW)));
      const next = visibleActions[idx];
      if (next && next.key !== actionRef.current) setActionRef.current(next.key);
    }, 90);
  }, [pagerScrollX]);
  const onPagerDragStart = useCallback(() => {
    pagerScrollX.stopAnimation();
    pagerUserScrolling.current = true;
  }, [pagerScrollX]);

  // Shield offers only assets a NEW deposit may target; Withdraw and Send also
  // list withdraw-only legacy assets (plain USDC / USDT on prod), because the
  // notes already in those pools are real and must stay spendable.
  // Shield / Send / Request / Swap headline the money ("USDC", held as ppUSDC).
  // Withdraw hands the SHARE token itself to the wallet, so it names the share:
  // the Entrypoint pays out ppUSDC, not USDC (no in-app router redemption yet).
  // Every tab, Withdraw included: a share reads as its underlying. Withdraw
  // used to keep the raw share name because the payout WAS the share; it now
  // always unwraps through the PPRouter (Pat, 2026-09-05).
  const hubYieldProbeVersion = useYieldVaultProbeVersion();
  // What the account holds SHIELDED on this chain, and whether that is KNOWN
  // yet (services/hub-token-catalog.ts): the spend tabs offer
  // exactly those (plus the native asset as the resting default), like their
  // source picker does. Anything else would let a pick made on another tab
  // survive the switch.
  const holdings = useMemo<HubHoldings>(
    () => ({ symbols: heldSymbolsFor(data.myPools, activeChainId), ready: data.holdingsReady }),
    [data.myPools, data.holdingsReady, activeChainId],
  );
  // Past its form step a Withdraw / Send reports on the asset it spent, so the
  // card keeps that asset even after a full spend drops it from the holdings.
  const spendTokenPinned = (action === 'withdraw' && withdrawInline && withdrawStep !== 'withdraw')
    || (action === 'send' && transferInline && transferStep !== 'select-notes');
  const pinnedSymbol = spendTokenPinned ? token.toUpperCase() : null;
  const catalogHoldings = useMemo<HubHoldings>(
    () => (pinnedSymbol && holdings.ready && !holdings.symbols.has(pinnedSymbol)
      ? { ...holdings, symbols: new Set([...holdings.symbols, pinnedSymbol]) }
      : holdings),
    [holdings, pinnedSymbol],
  );
  // Each tab has its OWN option list, and the validity effect below resets a
  // selection the current tab does not offer to tokens[0] (the native asset).
  // Both were too permissive, so picks leaked across tabs (Pat, 2026-09-05:
  // ppUSDC picked for Withdraw came back as the Shield pay token; USDC picked
  // for Shield came back as the Withdraw source):
  //   - Shield pays IN an asset the wallet holds. A share (ppUSDC) is never
  //     paid in - the router mints it from its underlying - so it is not a
  //     Shield option even though getDepositableTokens lists it as a pool.
  //   - Withdraw / Send spend what the account HOLDS here.
  //   - Request names what a plain Entrypoint deposit may pay.
  const evmTokens = useMemo<HubToken[]>(
    () => hubTokenCatalog(action, activeChainId, catalogHoldings)
      .map((t) => ({ symbol: t.symbol, decimals: t.decimals, isNative: t.isNative, yieldShare: t.yieldShare, superseded: t.superseded })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the probe version is a change signal: a verified yield underlying joins Shield's list when its vault verifies
    [activeChainId, action, hubYieldProbeVersion, catalogHoldings],
  );
  const tokens = isStellar ? STELLAR_TOKENS : isSui ? SUI_TOKENS : evmTokens.length > 0 ? evmTokens : getActionableTokens(activeChainId).filter((t) => !isSupersededLegacyPool(t.symbol, activeChainId));
  // Wallet (Alchemy) pay-token symbols currently allowed as the card token on
  // the Shield tab — maintained by the shield block further down; a ref so
  // the validity effect just below can consult it without a TDZ.
  const extAllowedRef = useRef<Set<string>>(new Set());
  // Keep the picked token valid for the active chain — a stale EVM pick on Sui
  // would sanitize amounts at EVM precision (over-precision SUI input parses
  // to 0n / truncates downstream).
  useEffect(() => {
    const selected = tokens.find((t) => t.symbol === token);
    const spending = action === 'withdraw' || action === 'send';
    if (spendTokenPinned) return;
    const preferred = preferredHubToken(evmTokens, holdings);
    if (selected && (!spending || !holdings.ready || holdings.symbols.has(token.toUpperCase()) || !preferred || !holdings.symbols.has(preferred.symbol.toUpperCase()))) return;
    // Shield-tab pay tokens picked from the wallet (Alchemy) or pasted live outside the
    // configured list; the exemption is Shield-only, so a paste made there cannot
    // keep an unheld token selected on Withdraw / Send (codex on 3b6fea4).
    if (action === 'shield' && !isSui && extAllowedRef.current.has(token)) return;
    const fallback = spending ? preferred ?? tokens[0] : tokens[0];
    setToken(fallback.symbol);
    // A spent amount means nothing in another asset.
    setAmount((a) => (spending ? '' : sanitizeAmountInput(a, fallback.decimals)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSui, token, action, tokens, evmTokens, holdings, spendTokenPinned]);

  const tokenMeta = tokens.find((t) => t.symbol === token) ?? tokens[0];
  // The Sui shape (HubToken) carries no address, and needs none: that chain has
  // one asset, so its symbol is unambiguous. Everywhere else the address is what
  // identifies a pool, because ppETH and legacy ETH share the display name.
  const tokenMetaAddress = 'address' in tokenMeta ? tokenMeta.address : undefined;
  const hue = TokenHues[colorScheme][tokenMeta.symbol] ?? TokenHues[colorScheme].ETH;

  // (Moved below the shield-pool block: on the Shield tab the figure tracks
  // the DESTINATION pool, not the pay token.)

  // Wallet balance for the Shield tab (the max you can deposit). wagmi v3's
  // useBalance is native-only, so ERC-20s read balanceOf directly — same
  // pattern as the deposit modal. Sui reads the dapp-kit balance instead.
  const { address: connectedAddress } = useAccount();
  // The chain whose assets this form represents = the selected pool's chain.
  const chainId = activeChainId;
  // Registration state of the typed recipient, checked while typing so the
  // form says what is about to happen BEFORE Shield is pressed: a deposit to
  // an unregistered address works, but it ends in a one-time claim link the
  // sender must deliver, which is a different experience from the
  // announce-and-forget deposit to a registered one (Mike, 2026-09-22). Same
  // tri-state precheck the deposit modal runs at submit; 'unknown' stays
  // quiet here and the modal still refuses. The answer is keyed on the exact
  // text + chain and the state is DERIVED from that key, so a stale answer
  // never paints and nothing is set synchronously inside the effect.
  // Not on Stellar: there the SDK's own keystore read inside the deposit is
  // the check (an unregistered account is refused before signing), the same
  // as a Stellar Send, so typing never makes a request naming the address.
  const shieldRecipientKey = shieldRecipientEnabled && !isStellar && isCheckableRecipient(shieldRecipient)
    ? `${chainId}:${shieldRecipient.trim().toLowerCase()}`
    : null;
  const [shieldRecipientCheck, setShieldRecipientCheck] = useState<{ key: string; result: 'registered' | 'unregistered' | 'unknown' } | null>(null);
  useEffect(() => {
    if (!shieldRecipientKey) return;
    let cancelled = false;
    const recipient = shieldRecipientKey.slice(shieldRecipientKey.indexOf(':') + 1) as `0x${string}`;
    // Debounced past the last keystroke.
    const timer = setTimeout(() => {
      void checkRecipientRegistration(chainId, recipient).then((result) => {
        if (!cancelled) setShieldRecipientCheck({ key: shieldRecipientKey, result });
      });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [shieldRecipientKey, chainId]);
  const shieldRecipientRegistration: RecipientRegistrationState = !shieldRecipientKey
    ? 'idle'
    : shieldRecipientCheck?.key === shieldRecipientKey ? shieldRecipientCheck.result : 'checking';
  const shieldRecipientHint = !shieldRecipientEnabled
    ? null
    : isStellar
      ? { text: 'They need a private account on Stellar already.', learnMore: false, tone: 'muted' as const }
      : recipientRegistrationHint(shieldRecipientRegistration, getChainConfig(chainId)?.displayName);
  // Keep the root-level token sheet in sync with local state. Rendering it here
  // would trap its fixed-position scrim inside the hero's transform (see the
  // note at the end of this component), so the host paints it instead.
  // --- Swap output ("You receive") ---
  //
  // Candidates are this chain's configured swap outputs minus the asset being
  // spent: a same-token swap is just a withdrawal.
  // Where the output is delivered: the pool chain by default, any chain the
  // swap route reaches otherwise (a cross-chain Send lands here with one). A
  // reshield only crosses for pairs the SDK serves, so the list narrows then.
  const [swapDestChoice, setSwapDestChoice] = useState<number>(chainId);
  // The Swap tab is private-only (a reshield: the output is a new note of your
  // own; paying a wallet is the Withdraw tab's job), so it only crosses for the
  // pairs the SDK can reshield across.
  const swapDestinations = useMemo<number[]>(() => {
    if (isSui || !intentSwapsEnabledForChain(chainId)) return [chainId];
    const allowed = getSwapDestinationChains(chainId)
      .filter((id) => id === chainId || crossChainReshieldSupported(chainId, id));
    return allowed.includes(chainId) ? allowed : [chainId, ...allowed];
  }, [chainId, isSui]);
  useEffect(() => {
    if (!swapDestinations.includes(swapDestChoice)) setSwapDestChoice(chainId);
  }, [swapDestinations, swapDestChoice, chainId]);
  // Destinations that can actually receive this sale, in list order. On a chain
  // whose only swap asset is the one being spent (prod mainnet: ETH) the pool
  // chain offers nothing, and the button stayed disabled with "Select token"
  // although the sheet had BNB Chain rows to show (Pat, 2026-09-04). The pill
  // opens whenever ANY destination has a row, and only these are offered as
  // networks in the sheet.
  const swapDeliverableDestinations = useMemo<number[]>(() => {
    const sellAddress = (getTokenMetadataBySymbol(tokenMeta.symbol, chainId)?.address ?? '').toLowerCase();
    return swapDestinations.filter((dest) => getSwapOutputTokens(dest, chainId)
      .some((t) => dest !== chainId || t.address.toLowerCase() !== sellAddress));
  }, [swapDestinations, chainId, tokenMeta.symbol]);
  // The delivery chain in force: the user's choice when it can receive the sale,
  // otherwise the first destination that can. Derived rather than snapped in an
  // effect, so an explicit pick is never overridden and no render shows an
  // empty pair (codex on daa77f4).
  const swapDestChainId = swapDeliverableDestinations.includes(swapDestChoice)
    ? swapDestChoice
    : (swapDeliverableDestinations[0] ?? swapDestChoice);
  const swapCrossChain = swapDestChainId !== chainId;
  const swapOutCandidates = useMemo<SwapTokenInfo[]>(
    () => getSwapOutputTokens(swapDestChainId, chainId).filter(
      // Same chain: minus the asset being spent (that swap is a withdrawal).
      // Another chain: the same asset is a legitimate delivery.
      (t) => swapDestChainId !== chainId
        || t.address.toLowerCase() !== (getTokenMetadataBySymbol(tokenMeta.symbol, chainId)?.address ?? '').toLowerCase(),
    ),
    [swapDestChainId, chainId, tokenMeta.symbol],
  );
  const swapOutToken = useMemo(
    () => swapOutCandidates.find((t) => t.address.toLowerCase() === (swapOutAddress ?? '').toLowerCase()) ?? null,
    [swapOutCandidates, swapOutAddress],
  );
  // Reverse the pair from the seam arrow (Pat, 2026-09-03). Only when the
  // token being bought is itself a pool asset on THIS chain: the sell side is
  // always a shielded balance here, so a cross-chain delivery or an output the
  // pool does not hold has no mirror image to swap into.
  const swapReverseTarget = useMemo(
    () => (!swapOutToken || swapDestChainId !== chainId)
      ? null
      : (tokens.find((t) => t.symbol === swapOutToken.symbol) ?? null),
    [swapOutToken, swapDestChainId, chainId, tokens],
  );
  const reverseSwapPair = useCallback(() => {
    if (!swapReverseTarget) return;
    const previousIn = getTokenMetadataBySymbol(tokenMeta.symbol, chainId)?.address ?? null;
    setToken(swapReverseTarget.symbol);
    // The typed figure now denominates the new sell token; trim it to that
    // token's decimals rather than carrying an impossible fraction over.
    setAmount((current) => sanitizeAmountInput(current, swapReverseTarget.decimals));
    setSwapOutAddress(previousIn);
  }, [swapReverseTarget, tokenMeta.symbol, chainId]);
  // Default to the first candidate, and drop a selection the current input or
  // chain has invalidated — otherwise switching the input to the token you were
  // buying would leave a swap pointing at itself.
  useEffect(() => {
    if (swapOutCandidates.length === 0) {
      if (swapOutAddress !== null) setSwapOutAddress(null);
      return;
    }
    if (!swapOutToken) setSwapOutAddress(swapOutCandidates[0].address);
  }, [swapOutCandidates, swapOutToken, swapOutAddress]);

  // The Swap tab's flow draws under this card and validates/quotes what the
  // card shows: push every card edit (amount, pair, destination, recipient)
  // into it. Idempotent, and the provider ignores it past the input step.
  useEffect(() => {
    // The Send tab's swap-send keeps the pair the Send form chose.
    if (!swapInline || swapInlineSend || swapStep !== 'input') return;
    syncSwapForm({
      amount,
      tokenAddress: tokenMetaAddress,
      tokenSymbol: tokenMeta.symbol,
      outputTokenAddress: swapOutToken?.address ?? null,
      destinationChainId: swapDestChainId,
      // The flow validates, checks registration and routes it. An open row
      // that is empty stays "a note of your own".
      recipient: swapRecipientOpen ? swapRecipient.trim() : '',
      recipientOpen: swapRecipientOpen && swapRecipient.trim() !== '',
    });
  }, [swapInline, swapInlineSend, swapStep, syncSwapForm, amount, tokenMetaAddress, tokenMeta.symbol, swapOutToken, swapDestChainId, swapRecipientOpen, swapRecipient]);
  // A settled private swap-send spent the Send amount, the same as a settled
  // transfer: the Send form it returns to starts empty.
  useEffect(() => {
    if (swapInlineSend && swapStep === 'success') {
      setAmountFor('send', '');
      clearSwapSendDraft();
    }
  }, [swapInlineSend, swapStep, setAmountFor]);
  // A settled Swap tab payment closes its recipient row too, so the next swap
  // goes to your own account unless the row is opened again.
  useEffect(() => {
    if (!swapInlineSend && swapStep === 'success') {
      setSwapRecipientOpen(false);
      setSwapRecipient('');
    }
  }, [swapInlineSend, swapStep]);
  // Send gets the same live token push (DEV-469). Opening once was not enough:
  // the flow opened on the home chain's token, the provider snapped that to
  // its own default on the wallet's chain, and the pill (BNB) and the spent
  // asset (ppUSDT) split until an explicit pick. `transferToken` is a dep so a
  // snap landing after this push in the same commit is pushed over again.
  // Focused hub only: a retained one shares the provider with its own pill.
  useEffect(() => {
    if (!isFocused || action !== 'send' || !transferInline || transferStep !== 'select-notes' || isSui) return;
    if (tokenMeta.symbol !== transferToken) syncTransferToken(tokenMeta.symbol);
  }, [isFocused, action, transferInline, transferStep, isSui, tokenMeta.symbol, transferToken, syncTransferToken]);
  // Withdraw gets the same push (DEV-531). The flow opened under the native
  // asset while holdings loaded, the card then moved to USDT, and the flow kept
  // checking, routing and quoting BNB ("0.0000 BNB", "BNB → ETH").
  useEffect(() => {
    const next = inlineWithdrawTokenToPush({
      focused: isFocused, action, inline: withdrawInline, step: withdrawStep, isSui,
      hubSymbol: tokenMeta.symbol, flowSymbol: withdrawToken, chainTokens: tokens,
    });
    if (next) syncWithdrawToken(next);
  }, [isFocused, action, withdrawInline, withdrawStep, isSui, tokenMeta.symbol, withdrawToken, tokens, syncWithdrawToken]);
  // Leaving the inline success panel clears the amount, like withdraw.
  useEffect(() => {
    if (swapStep !== 'success' || swapIsOpen) return;
    setAmountFor('swap', '');
  }, [swapStep, swapIsOpen, setAmountFor]);
  // "~ what you receive" on the Swap tab before Review: the pair's LiFi
  // exact-in estimate on the typed amount. The binding quote (relayer fee,
  // slippage floor) still comes at Review; the card says so.
  const swapAmountWei = (() => { try { return parseTokenAmount(amount || '0', tokenMeta.decimals); } catch { return 0n; } })();
  // A share has no market of its own: the swap redeems it to its underlying
  // and deposits the output back as a share. Price the preview the same way,
  // underlying to underlying, or every mainnet pair (all shares) stays "—"
  // (QA 2026-09-24).
  const { rateFor: shareRateFor } = useShareRates();
  const swapFromAddress = getTokenMetadataBySymbol(tokenMeta.symbol, chainId)?.address ?? '';
  const swapFromFunding = swapFromAddress ? conversionFundingToken(swapFromAddress, chainId) : '';
  const swapFromIsShare = !!swapFromAddress && swapFromFunding.toLowerCase() !== swapFromAddress.toLowerCase();
  const swapPreviewInWei = previewInputAmount(swapAmountWei, swapFromIsShare, shareRateFor(chainId, swapFromAddress));
  const swapToFunding = swapOutToken ? conversionFundingToken(swapOutToken.address, swapDestChainId) : '';
  const swapOutUnits = swapOutToken
    ? swapInputUnits(swapDestChainId, swapOutToken.address, { symbol: swapOutToken.symbol, decimals: swapOutToken.decimals })
    : null;
  const swapPreviewIdentity = !!swapFromFunding && !!swapToFunding
    && previewIsIdentity(swapFromFunding, swapToFunding, chainId, swapDestChainId);
  const swapPreview = useSwapPreview({
    enabled: action === 'swap' && !isSui && !!swapOutToken && swapAmountWei > 0n
      && swapPreviewInWei !== null && swapPreviewInWei > 0n && !swapPreviewIdentity
      && intentSwapInputSupported(chainId, swapFromAddress),
    chainId,
    toChainId: swapDestChainId,
    fromToken: swapFromFunding || null,
    toToken: swapToFunding || null,
    fromAmountWei: swapPreviewInWei ?? 0n,
    fromAddress: getSwapProcessorAddress(chainId) ?? unifiedAddress ?? null,
    // A cross-chain swap deposits on arrival: price the route that can run
    // that call, net of its bridge fee, not the cheapest plain bridge.
    destinationCall: swapCrossChain,
  });
  const swapPreviewText = !swapOutUnits
    ? null
    : swapPreviewIdentity && swapPreviewInWei !== null && swapPreviewInWei > 0n
      ? `~${formatSwapExitEstimate(swapPreviewInWei, swapOutUnits.decimals)}`
      : swapPreview.status === 'ok'
        ? `~${formatSwapExitEstimate(swapPreview.toAmount, swapOutUnits.decimals)}`
        : null;
  // A bridge fee charged on top of the tokens (Stargate's LayerZero fee into
  // Ethereum runs ~$8 to $9). It is netted out of the estimate above, and named
  // so a small swap that lands under the pool minimum is not a surprise at review.
  const swapBridgeFeeText = swapPreview.status === 'ok' && swapPreview.bridgeFeeUsd && swapPreview.bridgeFeeUsd >= 0.5
    ? swapPreview.bridgeFeeUsd.toFixed(2)
    : null;

  // A swap-send to YOUR OWN account is a private reshield: the Swap tab,
  // prefilled with the pair and the destination. The auto-open below mounts the
  // flow pinned to reshield.
  //
  // A request may name a recipient (DEV-510, grep [swap-deposit-recipient]):
  // taken only for an output the private route can deliver to them
  // (services/swap-tab-recipient.ts, a plain pick mapped to its pool share
  // first). Anything else is refused, never a quiet note of your own.
  const swapTabHandoffRef = useRef<(req: SwapTabHandoffRequest) => boolean>(() => false);
  swapTabHandoffRef.current = (req) => {
    if (!inlineOps || !swapAvailable || isSui || tabsDisabled) return false;
    if (req.tokenSymbol && !intentSwapInputSupported(chainId, getTokenMetadataBySymbol(req.tokenSymbol, chainId)?.address ?? '')) return false;
    const dest = req.destinationChainId !== undefined
      && req.destinationChainId !== chainId
      && getSwapDestinationChains(chainId).includes(req.destinationChainId)
      && crossChainReshieldSupported(chainId, req.destinationChainId)
      ? req.destinationChainId
      : chainId;
    // A destination this build cannot reshield across, or an output that
    // chain cannot deliver, is refused rather than defaulted: the caller then
    // takes the public route and says so.
    if (req.destinationChainId !== undefined && req.destinationChainId !== chainId && dest === chainId) return false;
    const handedRecipient = req.recipient?.trim() ?? '';
    let wanted = req.outputTokenAddress?.toLowerCase();
    if (handedRecipient) {
      const route = swapTabRecipientRoute({
        poolChainId: chainId,
        destinationChainId: dest,
        outputTokenAddress: req.outputTokenAddress,
        recipient: handedRecipient,
        ownAddresses: [connectedAddress, sessionAddress],
      });
      if (route.kind === 'invalid' || route.kind === 'refused') return false;
      if (route.kind === 'reshield-transfer') wanted = route.outputTokenAddress.toLowerCase();
    }
    const output = wanted ? getSwapOutputTokens(dest, chainId).find((t) => t.address.toLowerCase() === wanted) : undefined;
    if (wanted && !output) return false;
    setSwapRecipientOpen(!!handedRecipient);
    setSwapRecipient(handedRecipient);
    const sellToken = req.tokenSymbol;
    if (sellToken) {
      setAssetSelection((previous) => ({
        ...previous,
        byAction: { ...previous.byAction, swap: sellToken },
      }));
    }
    setAmountFor('swap', req.initialAmount ?? '');
    setSwapDestChoice(dest);
    setSwapOutAddress(output?.address ?? null);
    setAction('swap');
    return true;
  };
  useEffect(() => registerSwapTabHandoff((req) => swapTabHandoffRef.current(req)), []);

  // --- Deposit-centric Shield tab (2026-08-18 redesign) ---
  //
  // The amount card is denominated in the PAY token (what the wallet holds,
  // any token — real balances via Alchemy when the key + network allow), and
  // the destination POOL is a secondary row below with a smart default:
  // same-token pool on the same chain, else the chain's native pool, else
  // Ethereum's ETH pool (services/shield-pools.ts). A pay token that isn't
  // the pool asset converts via LiFi in the one wallet transaction (flow 1 —
  // no relayer, no RelaySwaps), previewed inline and bound at consent.
  //
  // Every served chain's holdings, fetched from the moment a wallet connects
  // and on a fixed cadence that keeps running for the app's whole session —
  // not just while this component is mounted (components/wallet-tokens-provider).
  // Read by chain, so the pay sheet can list the network picked in it while
  // the wallet switch is still pending, and the card keeps the wallet chain's.
  const walletTokensOn = useWalletTokens();
  const walletTokens = useMemo(() => walletTokensOn(chainId), [walletTokensOn, chainId]);
  /**
   * Tokens the user PASTED, kept apart from the fetched ones and keyed by chain.
   *
   * Every Alchemy refetch REPLACES the whole list, so a pasted row added to it
   * is erased by any refetch that was already in flight when the user pasted
   * (codex P1 #3). Held separately and merged, so the wallet list stays the
   * wallet list and a paste cannot be raced away.
   */
  const [pastedTokens, setPastedTokens] = useState<{ chainId: number; token: WalletToken }[]>([]);
  const walletAndPasted = useMemo(() => {
    const pasted = pastedTokens.filter((e) => e.chainId === chainId).map((e) => e.token);
    const merged = pasted.length === 0 ? walletTokens : [
      ...pasted.filter((pt) => !walletTokens.some((w) => w.address.toLowerCase() === pt.address.toLowerCase())),
      ...walletTokens,
    ];
    // A yield share the wallet holds (an earlier plain share payout) is not
    // something Shield pays in either: the deposit modal resolves a share to
    // its underlying, so offering it here would denominate the card in a
    // token the deposit does not pay (codex P2 on 7974a5e). By address.
    return merged.filter((t) => !isYieldShareOnChain(t.address, chainId));
  }, [walletTokens, pastedTokens, chainId]);
  // Feed the top-of-file token-validity effect (it runs before this block
  // exists in source order, so it reads a ref, not the state) and re-validate
  // an ext pick the tab switch / refetch invalidated.
  useEffect(() => {
    extAllowedRef.current = new Set(walletAndPasted.map((w) => w.symbol));
    const extOk = action === 'shield' && !isSui && extAllowedRef.current.has(token);
    if (spendTokenPinned) return;
    if (!tokens.some((t) => t.symbol === token) && !extOk) {
      const fallback = tokens[0];
      const spending = action === 'withdraw' || action === 'send';
      setToken(fallback.symbol);
      setAmount((a) => (spending ? '' : sanitizeAmountInput(a, fallback.decimals)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAndPasted, token, tokens, action, isSui, spendTokenPinned]);
  /**
   * Address of the pay token the user EXPLICITLY picked from the sheet.
   *
   * Kept because the card's token state is only a symbol, which cannot tell a
   * pasted lookalike apart from the pool asset it imitates.
   */
  const [payPick, setPayPick] = useState<{ address: string; chainId: number } | null>(null);
  // A wallet token OUTSIDE the configured pool assets, when picked as the
  // card token. Null in every other tab/state, so payMeta === tokenMeta there.
  //
  // Address-keyed FIRST, because symbols are not identities. The card's token
  // state is a symbol, and the fallback below additionally requires the symbol
  // to be absent from the pool assets - so a pasted token whose symbol collides
  // with a pool asset (a fake "USDC") failed that test and silently resolved to
  // the REAL USDC, spending a different asset than the one the user picked.
  // Allowing pasted tokens (and so, deliberately, lookalikes) is exactly what
  // makes that reachable, so the explicit pick is remembered by address and
  // wins. The pick carries its chain, so a stale one stops applying on its own.
  const extPayToken = useMemo(
    () => {
      if (action !== 'shield' || isSui) return null;
      // Carries the chain it was made on, so a stale pick simply stops applying
      // instead of needing an effect to clear it. (An effect calling setState
      // synchronously is a cascading render, and the linter is right to say so.)
      if (payPick && payPick.chainId === activeChainId) {
        const picked = walletAndPasted.find((w) => w.address.toLowerCase() === payPick.address.toLowerCase());
        // Compared by ADDRESS against the real catalog: `tokens` carries only
        // symbols, which is the very ambiguity being fixed here.
        // Depositable catalog, not the full registry: a wallet's plain USDC on
        // prod is an EXTERNAL pay token now (converted on the way in), not a
        // pool asset, because deposits of it are closed.
        const isPoolAsset = picked
          && getDepositableTokens(activeChainId).some((t) => t.address.toLowerCase() === picked.address.toLowerCase());
        if (picked && !isPoolAsset) return picked;
      }
      return walletAndPasted.find((w) => w.symbol === token && !tokens.some((t) => t.symbol === w.symbol)) ?? null;
    },
    [action, isSui, walletAndPasted, token, tokens, payPick, activeChainId],
  );
  const payMeta: { symbol: string; decimals: number; logoUrl?: string } = extPayToken
    ? { symbol: extPayToken.symbol, decimals: extPayToken.decimals, logoUrl: (extPayToken as { logoUrl?: string }).logoUrl }
    : tokenMeta;

  // Destination pool: explicit pick, else the defaulting rule. Cleared when
  // the pay token or chain changes so the rule re-applies.
  const [shieldPoolPick, setShieldPoolPick] = useState<{ chainId: number; symbol: string } | null>(null);
  // With the intent surface locked (config/intent-lockdown.ts) the destination
  // cannot be chosen: picking any pool other than the pay token's own is a
  // cross-asset or cross-chain conversion, and both are off. The pool follows
  // the pay token through defaultPoolFor, which lands a yield underlying in its
  // share's pool (USDC into ppUSDC). A pick that survived from an unlocked
  // session is ignored rather than honoured (Pat, 2026-09-05).
  const poolPickEnabled = swapSurfaceEnabled();
  const shieldPool = useMemo<ShieldPool | null>(() => {
    if (isSui) return null;
    if (shieldPoolPick && poolPickEnabled) {
      const picked = listShieldPools().find(
        (p) => p.chainId === shieldPoolPick.chainId && p.symbol === shieldPoolPick.symbol,
      );
      if (picked) return picked;
    }
    try { return defaultPoolFor(payMeta.symbol, chainId); } catch { return null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- verified routes change when the vault probe completes.
  }, [isSui, shieldPoolPick, poolPickEnabled, payMeta.symbol, chainId, hubYieldProbeVersion]);
  // Live on-chain APY when the Shield target is a yield-bearing share
  // (ppUSDC / ppUSDT on prod). Null for every plain asset.
  const shieldShareYield = useShareYield({ chainId: shieldPool?.chainId, tokenAddress: shieldPool?.address });
  const shieldHasYield = !!getYieldShareToken(shieldPool?.chainId, shieldPool?.address);
  // An explicit pool pick is FULLY sticky (QA 2026-08-18: 'don't switch pool
  // automatically if I change it once manually') — only another manual pick
  // replaces it. The defaulting rule covers the no-pick state; a pick parked
  // on a different chain than the active one renders a caption and blocks
  // confirm until the network matches.
  // Pay ≠ pool asset ⇒ the deposit converts via LiFi. Only offered where
  // flow 1 can route (master flag + assets) and on the pool's own chain.
  // Read here rather than further down: the cross-chain gate below needs the
  // identity mode, and the deposit flow refuses a key-owned cross-chain shield
  // (the session owns the note while the wallet only pays, so the LiFi route
  // would be quoted against the wrong address).
  const { identityMode, keysReady, sessionAddress } = usePoolSession();
  // The Swap tab's recipient row, decided against the real route lists
  // (DEV-510). The flow re-checks all of it, plus registration at Review.
  const swapRecipientRoute = swapTabRecipientRoute({
    poolChainId: chainId,
    destinationChainId: swapDestChainId,
    outputTokenAddress: swapOutToken?.address,
    outputIsNative: swapOutToken?.isNative,
    recipient: swapRecipientOpen ? swapRecipient : '',
    ownAddresses: [connectedAddress, sessionAddress],
  });
  // Unregistered is served with a claim link after an explicit opt-in (DEV-511).
  // The flow draws that hint and the opt-in under this row; until the box is
  // ticked the CTA stays dead.
  const swapRecipientNote = swapRecipientRoute.kind === 'refused'
    ? swapRecipientRoute.reason
    : swapRecipientRoute.kind === 'reshield-transfer' && swapRecipientRegistration === 'checking'
        ? 'Checking whether this address is registered…'
        : swapRecipientRoute.kind === 'reshield-transfer' && swapRecipientRegistration === 'unknown'
          ? 'Couldn’t check this address right now. Try again in a moment.'
          : null;
  const swapRecipientBlocks = swapRecipientRoute.kind === 'invalid' || swapRecipientRoute.kind === 'refused'
    || (swapRecipientRoute.kind === 'reshield-transfer' && swapRecipientRegistration === 'unknown');
  // Launch deposit cap on the Shield card, judged on the PAY side (amount and
  // pay token), which is what the user types here; the dollar value is what
  // the cap is about, and a cross-pay shield deposits about that value. Same
  // query key as the deposit modal, so the price is fetched once. The card
  // draws its own inline messages, so the provider's check (which still runs
  // on the press) would otherwise stay invisible until Shield is pressed
  // (Pat, 2026-09-03: 1000 USDC on prod showed no limit).
  // Testnet XLM has no price and no launch cap (see deposit-modal-provider).
  const shieldCapUsd = isStellar ? undefined : ACTIVE_ENVIRONMENT.maxDepositUsd;
  // Every price on this card comes off the public-feed grid, never a query.
  //
  // The e2e privacy gate caught the reason on 2026-09-18: a per-tab
  // `useQuery(['tokenPrice', symbol])` fires the moment its `enabled` flips or
  // its key changes, so simply OPENING the Withdraw tab sent a
  // /global/public/token-prices request that no background poll explained.
  // The payload carries no address and no amount, but WHEN it happens is the
  // leak: it tells the ASP this client just started preparing a withdrawal.
  // The grid has no refetch and no enabled, so a component cannot cause a
  // request at all (hooks/use-all-chains-price-map.ts), which kills the class
  // rather than this one instance.
  const hubPriceMap = useAllChainsPriceMap(chainId);
  const balanceDisplay = useBalanceDisplay(chainId);
  // The grid is empty until the first tick lands. That is "still loading", not
  // "no price": the cap must not fail closed and grey out Shield on first
  // paint, and the dollar line must not flash.
  const hubPricePending = Object.keys(hubPriceMap).length === 0;
  // A share has no row of its own in the feed, so every lookup here reads the
  // underlying, as the withdraw and dollar-entry paths below already do.
  const shieldPayPrice = hubPriceMap[displayTokenSymbol(payMeta.symbol)] ?? 0;
  const shieldPayPricePending = hubPricePending;
  const shieldCapVerdict = useMemo(() => {
    if (shieldCapUsd === undefined || isSui) return null;
    const v = checkDepositCap({
      amount: parseFloat(amount) || 0,
      symbol: payMeta.symbol,
      priceUsd: shieldPayPrice,
      capUsd: shieldCapUsd,
      pricePending: shieldPayPricePending,
    });
    return v.ok ? null : v;
  }, [shieldCapUsd, isSui, amount, payMeta.symbol, shieldPayPrice, shieldPayPricePending]);
  // The cap is a REFUSAL, not a hint. The provider re-checks on press and
  // throws DepositCapError, so a live CTA over the limit only buys the user a
  // modal that immediately refuses (Mike, 2026-09-18: 0.05 ETH against a
  // $100 / 0.0385 ETH cap, "Shield ETH" still black and pressable). `pending`
  // is the price feed still in flight and stays pressable, because it resolves
  // on its own and the press path checks again anyway; `no-price` and
  // `invalid` block, matching checkDepositCap's fail-closed stance.
  const shieldCapBlocksDeposit = !!shieldCapVerdict && shieldCapVerdict.reason !== 'pending';
  const shieldPresets = useMemo(
    () => cappedQuickAmounts({
      capUsd: shieldCapUsd,
      priceUsd: shieldPayPrice,
      symbol: payMeta.symbol,
      fallback: payMeta.symbol === 'USDC' || payMeta.symbol === 'USDT' ? QUICK_AMOUNTS_STABLE : QUICK_AMOUNTS_NATIVE,
    }),
    [shieldCapUsd, shieldPayPrice, payMeta.symbol],
  );
  // Withdraw chips are the SAME dollar-anchored figures as Shield's (Mike,
  // 2026-09-18): 10 / 25 / 50 / 100% of the launch cap at the withdraw
  // asset's price, so a withdrawal blends into the same round-dollar crowd a
  // deposit does. Before this they were the fixed 0.1 / 1 / 5 / 10 / 100 list,
  // which nothing else in the pool used. Priced on the pool asset (a share
  // prices through its underlying, see price-service); the fixed list stands
  // in only while no price is known or no cap is configured, as on Shield.
  // Priced as the underlying, like fiatSymbol below: a share has no feed row.
  const withdrawPriceSymbol = displayTokenSymbol(tokenMeta.symbol);
  // Off the grid, not a query: this key changes with the withdraw POOL, so as a
  // query it fetched when the user picked a pool as well as when they opened
  // the tab. Both are the timing channel the gate flagged.
  const withdrawTokenPrice = hubPriceMap[withdrawPriceSymbol] ?? 0;
  const withdrawPresets = useMemo(
    () => cappedQuickAmounts({
      capUsd: shieldCapUsd,
      priceUsd: withdrawTokenPrice,
      // The DISPLAY symbol, same as the price lookup above. On prod the pool
      // asset is ppUSDC / ppUSDT, and cappedQuickAmounts leans on
      // isStablecoin() when the price read returns 0: isStablecoin('ppUSDC')
      // is false, so a blinked price handed a stablecoin pool the native
      // 0.1 / 1 / 5 list instead of 100 / 1000.
      symbol: withdrawPriceSymbol,
      fallback: isStablecoin(withdrawPriceSymbol) ? QUICK_AMOUNTS_STABLE : QUICK_AMOUNTS_NATIVE,
    }),
    [shieldCapUsd, withdrawTokenPrice, withdrawPriceSymbol],
  );
  // Dollar entry across the hub (Mike, 2026-09-18): a non-stablecoin asset
  // shows the figure's dollar value in grey under it on every tab; tapping it
  // swaps the roles so the figure is typed in dollars, the token amount is the
  // grey line and the recommended chips read in dollars. The TOKEN amount
  // stays each flow's source of truth: dollar keystrokes are converted into it
  // at the current price (services/hub-fiat-entry.ts), and any OTHER writer of
  // the amount (a preset, tap-to-max, a token switch, a tab switch) re-derives
  // the dollar text here. The ref remembers the amount the last dollar
  // keystroke produced, so that write is told apart from the others and does
  // not round-trip the user's own digits.
  //
  // Priced per tab: Shield types the PAY token, Request the request token,
  // Withdraw / Send / Swap the source pool asset (a share prices through its
  // underlying, see price-service). Shield reuses the cap check's query.
  //
  // A share (ppETH, ppUSDC) is priced as its UNDERLYING: the ASP feed has no
  // row for the share, so getPrice('ppETH') answered 0 and the line never
  // showed on the spend tabs of a yield pool - which on prod is every ETH
  // tab. The share amount already reads as ≈ underlying everywhere
  // (tokenAmountLabel), so a dollar figure at the underlying's price is the
  // same approximation the rest of the surface makes.
  const fiatAsset = action === 'shield' ? payMeta.symbol : action === 'request' ? requestToken.symbol : tokenMeta.symbol;
  const fiatSymbol = displayTokenSymbol(fiatAsset);
  const fiatDecimals = action === 'shield' ? payMeta.decimals : action === 'request' ? requestToken.decimals : tokenMeta.decimals;
  // THE one the gate caught: as a query this was `enabled: action !== 'shield'`,
  // and shield is the landing tab, so the flag flipped the instant the user
  // opened Withdraw and sent a token-prices request right then. Off the grid it
  // is a map read, so no tab switch, pool pick or token change can emit
  // anything.
  const shareFiatEntry = isShareSymbol(fiatAsset) && (action === 'withdraw' || action === 'send');
  const fiatShareRate = isShareSymbol(fiatAsset) ? shareRateFor(chainId, getTokenMetadataBySymbol(fiatAsset, chainId)?.address) : undefined;
  const fiatTokenPrice = (fiatShareRate
    ? hubPriceMap[fiatShareRate.underlying.toLowerCase()] ?? hubPriceMap[fiatShareRate.underlyingSymbol] ?? hubPriceMap[fiatSymbol]
    : hubPriceMap[fiatSymbol]) ?? 0;
  const fiatPrice = action === 'shield' ? shieldPayPrice : fiatTokenPrice;
  const fiatAvailable = isShareSymbol(fiatAsset)
    ? !!fiatShareRate && fiatShareRate.assetsPerShare > 0n && Number.isFinite(fiatPrice) && fiatPrice > 0
    : fiatEntryAvailable({ symbol: fiatSymbol, priceUsd: fiatPrice, isSui });
  // One switch for the whole hub: someone who thinks in dollars thinks in
  // dollars on every tab. A stablecoin tab simply shows no line (and types
  // the token), and the choice is waiting on the next priced asset.
  const [fiatMode, setFiatMode] = useState(false);
  const fiatEntry = fiatAvailable && fiatMode && (!isShareSymbol(fiatAsset) || shareFiatEntry);
  const [usdInput, setUsdInput] = useState('');
  // What the last dollar keystroke derived, AND the price it derived it at.
  // The amount text alone is not enough: switching the token keeps the amount
  // string (the switch only truncates decimals), so a guard on text alone
  // early-returns on the new price and leaves the headline reading the old
  // asset's dollars. The figure submitted is right, the dollars shown are a
  // lie, and on Withdraw nothing else catches it.
  const fiatDerived = useRef<{ amount: string; price: number } | null>(null);
  const activeAmountText = action === 'request' ? requestAmount : amount;
  useEffect(() => {
    if (fiatDerived.current?.amount === activeAmountText && fiatDerived.current.price === fiatPrice) return;
    fiatDerived.current = null;
    setUsdInput(isShareSymbol(fiatAsset)
      ? tokenToUsdText(String(balanceDisplay(activeAmountText || '0', fiatAsset, chainId).usd), 1)
      : tokenToUsdText(activeAmountText, fiatPrice));
  }, [activeAmountText, fiatPrice, fiatAsset, chainId, balanceDisplay]);
  const { openSeedDerivationModal } = useSeedDerivationModal();
  // A wallet identity whose keystore is not derived yet. An account-key identity
  // initializes itself, so it is never "locked" in this sense.
  // EVM session lock only: Sui and Stellar unlock inside their own flows.
  const sessionLocked = !isSui && identityMode === 'wallet' && !keysReady;
  // Stellar: Freighter connected but the account not unlocked yet, so the
  // shielded figures are not known. Say so instead of showing 0.
  const { stellarLocked, unlockStellar } = useWalletUnlockGate();
  // Cross-chain shield: the pool sits on a different chain than the wallet and
  // LiFi can bridge into it. Flow 1 is ONE LiFi contract-calls transaction, so
  // both ends have to be LiFi networks (today: Ethereum ⇄ OP only). The
  // key-owned exclusion mirrors the deposit flow's, so the hub never promises a
  // bridge the confirm path will refuse.
  const crossChainShield = action === 'shield' && !isSui && !!shieldPool
    && identityMode !== 'key'
    && shieldPool.chainId !== chainId
    && crossChainSwapDepositSupported(chainId, shieldPool.chainId);
  // Pay ≠ pool asset, OR the pool is on another chain ⇒ the deposit routes
  // through LiFi instead of depositing 1:1. The chain clause matters even for
  // the SAME symbol: bridging ETH into the OP ETH pool is still a route, and
  // treating it as 1:1 would deposit on the wrong chain.
  const payTokenAddr = extPayToken?.address ?? getTokenMetadataBySymbol(payMeta.symbol, chainId)?.address;
  // "Does this deposit need a swap?" decided by ADDRESS, not symbol (codex #2).
  // A lookalike whose ticker matches the destination pool (a fake "USDC" into
  // the USDC pool) compared equal on symbol, so it was classified as a DIRECT
  // deposit and the scam token would have been sent straight at the real pool.
  // Falls back to the symbol test only when an address is genuinely unknown.
  // Paying a yield share's UNDERLYING is that pool's ordinary deposit, not a
  // conversion: the PPRouter wraps USDC into ppUSDC (USDT into ppUSDT) inside
  // the same transaction, which is exactly what the deposit flow does with
  // getYieldDepositDeploymentForUnderlying. Without this the hub called it a
  // LiFi conversion, found no route into a share and refused with "Converting
  // USDT isn't available on this network" - on the one pool that asset CAN
  // enter (Pat, 2026-09-04, mainnet USDT into ppUSDT).
  // services/shield-pay-routing.ts owns the rule, and the test imports the same
  // module: reproducing it in a test file is how the 2026-09-12 regression got
  // through a suite that already covered the 2026-09-04 one.
  const payWrapsIntoPool = !!shieldPool && payWrapsIntoPoolRule({
    payChainId: chainId,
    poolChainId: shieldPool.chainId,
    poolAddress: shieldPool.address,
    payAddress: payTokenAddr ?? undefined,
  });
  const payIsPoolAsset = payWrapsIntoPool || (payTokenAddr && shieldPool
    ? payTokenAddr.toLowerCase() === shieldPool.address.toLowerCase()
    : payMeta.symbol === shieldPool?.symbol);
  const crossPayShield = action === 'shield' && !isSui && !!shieldPool
    && (!payIsPoolAsset || crossChainShield);
  // A conversion (other pay token, or another chain) ends in ONE deposit call on
  // the pool's chain: the Entrypoint for a plain pool, the PPRouter for a share.
  // When the asset is withdraw-only (prod USDC, deposits closed; it goes in only
  // through the PPRouter, directly), no conversion may target it (codex,
  // 2026-09-04). Paying from another chain means the bridge executes that call,
  // which a plain native coin cannot take (services/entrypoint-only-route.ts).
  const shieldPoolClosed = !!shieldPool
    && !targetAcceptsConversion(
      getKnownTokenMetadata(shieldPool.address, shieldPool.chainId),
      shieldPool.chainId,
      isSupersededLegacyPool(shieldPool.symbol, shieldPool.chainId),
      shieldPool.chainId !== chainId,
    );
  const crossPayAllowed = !!shieldPool && !shieldPoolClosed
    && (crossChainShield
      || (shieldPool.chainId === chainId && swapDepositEnabledForChain(chainId)));
  // A deposit for someone else works with the pool's own token, yield pools
  // included (DEV-451), and since DEV-489 when paying with another token or
  // from another network too. Only an account-key session is refused, here
  // instead of after Shield (services/recipient-registration-hint.ts).
  // Stellar has one plain XLM pool, so there is nothing to refuse there.
  const shieldRecipientConflict = shieldRecipientEnabled && shieldPool && !isStellar
    ? recipientDepositConflict({ keySession: identityMode === 'key' })
    : null;
  // Live exact-in conversion preview (display-only; the SDK re-quotes
  // exact-out at prepare, targeting toAmountMin so the solved-back input
  // stays within what was typed, modulo slippage).
  const shieldQuoteKey = JSON.stringify([
    chainId, connectedAddress?.toLowerCase(), payTokenAddr?.toLowerCase(), amount, payMeta.decimals,
    shieldPool?.chainId, shieldPool?.address.toLowerCase(),
  ]);
  const [rawShieldQuote, setShieldQuote] = useState<{
    status: 'idle' | 'loading' | 'ok' | 'none'; toAmount?: bigint; toAmountMin?: bigint;
    /** Bridge fee paid on top of the input, in USD (the LayerZero native fee). */
    nativeFeeUsd?: number;
    /** A previous pay budget must not size a deposit under the current form. */
    requestKey?: string;
  }>({ status: 'idle' });
  // Effects reset the quote after render. Until then, changing either end or
  // the pay budget must invalidate the old figure synchronously, before the
  // CTA can turn it into a deposit amount.
  const shieldQuote = useMemo(() => {
    if (rawShieldQuote.status !== 'ok') return rawShieldQuote;
    const fresh = rawShieldQuote.requestKey === shieldQuoteKey;
    return fresh ? rawShieldQuote : { status: 'loading' as const };
  }, [rawShieldQuote, shieldQuoteKey]);
  const shieldQuoteSeqRef = useRef(0);
  useEffect(() => {
    const seq = ++shieldQuoteSeqRef.current;
    if (!crossPayShield || !crossPayAllowed || !shieldPool || !connectedAddress || !payTokenAddr) {
      setShieldQuote({ status: 'idle' });
      return;
    }
    let amtWei = 0n;
    try { amtWei = amount ? parseUnits(amount, payMeta.decimals) : 0n; } catch { amtWei = 0n; }
    if (amtWei <= 0n) { setShieldQuote({ status: 'idle' }); return; }
    setShieldQuote({ status: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Price through the endpoint that will EXECUTE (contractCalls), at the
      // slippage the SDK will send. The plain /v1/quote picks the cheapest of
      // all bridges; cross-chain that promised 0.242 USDC while the only
      // executable route delivered 0.226, and the SDK's exact-out ask failed
      // with LiFi 404/1003 (Pat, 2026-08-29). services/cross-pay-sizing.ts.
      fetchLifiContractCallDeliverable({
        chainId,
        // The pool's chain, which for a cross-chain shield is not the wallet's.
        toChainId: shieldPool.chainId,
        fromToken: payTokenAddr,
        // What the swap must DELIVER, which for a yield pool is its underlying
        // (or the coin in native mode): a DEX has no liquidity for the share,
        // and the router mints it from what LiFi hands over.
        toToken: conversionFundingToken(shieldPool.address, shieldPool.chainId),
        fromAmountWei: amtWei,
        fromAddress: connectedAddress,
        slippage: shieldPool.chainId === chainId ? 0.01 : 0.03,
        signal: controller.signal,
      }).then((q) => {
        if (shieldQuoteSeqRef.current !== seq) return;
        setShieldQuote(q
          ? { status: 'ok', toAmount: q.toAmount, toAmountMin: q.deliverableMin, nativeFeeUsd: q.nativeFeeUsd, requestKey: shieldQuoteKey }
          : { status: 'none' });
      }).catch(() => {
        if (shieldQuoteSeqRef.current === seq) setShieldQuote({ status: 'none' });
      });
    }, 450);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [crossPayShield, crossPayAllowed, shieldPool, connectedAddress, payTokenAddr, amount, payMeta.decimals, chainId, shieldQuoteKey]);
  // The pool picker sheet — shared by two surfaces: the Shield tab's
  // DESTINATION pool row and the Withdraw tab's SOURCE pool pill (2026-08-18:
  // withdraw mirrors shield's chain/pool logic).
  const [poolSheetOpen, setPoolSheetOpen] = useState(false);
  // null = no chain filter, the DEFAULT: the picker opens on every chain's
  // pools (Pat, 2026-08-18). A number is an explicit pick.
  const [poolSheetNetwork, setPoolSheetNetwork] = useState<number | null>(null);
  const [poolSheetMode, setPoolSheetMode] = useState<'shield' | 'withdraw' | 'send' | 'swap'>('shield');

  // RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
  // amounts, validation, quotes, relayer and on-chain values stay in shares
  // (exact strings/bigints). Never convert an amount to underlying and back,
  // never feed a displayed underlying figure into an operation.
  // Display headlines use underlying through shareBalanceDisplay; shares appear
  // only in the (i) hint, in fields labelled with the share symbol, or while the
  // rate is unknown. Never print a share count under the underlying symbol.
  // What the "Shielded" figure describes: the DESTINATION pool on the Shield
  // tab (the pay token may not even have a pool), the card token elsewhere.
  const shieldTargetSymbol = action === 'shield' && !isSui && shieldPool ? shieldPool.symbol : tokenMeta.symbol;
  // Which chain the "Shielded" figure describes: the destination pool's on the
  // Shield tab (it can sit on another chain), else the chain being acted on.
  const shieldFigureChainId = action === 'shield' && !isSui && shieldPool ? shieldPool.chainId : activeChainId;
  const shielded = useMemo(() => {
    // Chain-matched: the Shielded figure and its tap-to-max describe the
    // chain being acted on; myPools spans chains now.
    const pool = data.myPools.find(
      (p) => p.name.toUpperCase() === shieldTargetSymbol.toUpperCase() && p.chainId === shieldFigureChainId,
    );
    const balance = pool ? parseFloat(pool.balanceToken) || 0 : 0;
    const pending = pool ? parseFloat(pool.pendingToken) || 0 : 0;
    // Display uses the rounded floats; max-fill must use the exact decimal so
    // a rounded-up 4dp figure can never overdraw the real note balance.
    const exact = pool?.balanceTokenExact ?? '0';
    // A dust balance (exact > 0) must not display as a bare 0 — "Shielded 0"
    // next to a fillMax that would fill 0.00001 reads as a contradiction.
    const dust = balance === 0 && /[1-9]/.test(exact);
    return { balance, pending, exact, dust };
  }, [data.myPools, shieldTargetSymbol, shieldFigureChainId]);
  // Per-PAGE figures. The pager renders every visible tab, not just the live
  // one, and the derivations above key off the LIVE `action`: on a converting
  // Shield (pool USDC on Optimism, paying ETH) the Send/Swap pages painted
  // "Shielded balance 0 ETH" and "+23.295 ETH pending" — the pool's figures
  // under the card token — during every slide and permanently in the a11y
  // tree (audit, 2026-08-29). Each page now derives its own target.
  const pageFigures = useMemo(() => {
    const out = {} as Record<Action, { symbol: string; chainId: number; shielded: { balance: number; pending: number; exact: string; dust: boolean } }>;
    for (const a of ['shield', 'withdraw', 'send', 'swap', 'request'] as Action[]) {
      const symbol = a === 'shield' && !isSui && shieldPool ? shieldPool.symbol : tokenMeta.symbol;
      const cid = a === 'shield' && !isSui && shieldPool ? shieldPool.chainId : activeChainId;
      const pool = data.myPools.find((p) => p.name.toUpperCase() === symbol.toUpperCase() && p.chainId === cid);
      const balance = pool ? parseFloat(pool.balanceToken) || 0 : 0;
      const pending = pool ? parseFloat(pool.pendingToken) || 0 : 0;
      const exact = pool?.balanceTokenExact ?? '0';
      out[a] = { symbol, chainId: cid, shielded: { balance, pending, exact, dust: balance === 0 && /[1-9]/.test(exact) } };
    }
    return out;
  }, [data.myPools, isSui, shieldPool, tokenMeta.symbol, activeChainId]);
  // Withdraw's loading flag and max must describe the SAME association-set
  // answer. PoolsProvider has an independent readiness cycle and deliberately
  // trusts ACTIVE notes before it resolves, so pairing its number with the
  // withdraw provider's flag could expose/fill an unproved balance.
  const withdrawSpendableWei = getWithdrawSpendableBalanceWei(tokenMeta.symbol);
  const withdrawMaxWei = getWithdrawMaxWei(tokenMeta.symbol);
  const withdrawBalanceUnavailable = withdrawSpendabilityError !== null;
  const withdrawBalanceLoading = !withdrawBalanceUnavailable && (
    withdrawSpendabilityLoading
    || withdrawSpendableWei === null
    || withdrawMaxWei === null
  );
  const withdrawBalanceBlocked = withdrawBalanceLoading || withdrawBalanceUnavailable;
  const withdrawSpendableExact = withdrawSpendableWei === null
    ? '0'
    : formatUnits(withdrawSpendableWei, tokenMeta.decimals);
  const withdrawMaxExact = withdrawMaxWei === null
    ? '0'
    : formatUnits(withdrawMaxWei, tokenMeta.decimals);
  const withdrawSpendableBalance = parseFloat(withdrawSpendableExact) || 0;

  const publishTokenSheet = useCallback(() => {
    if (!tokenSheetOpen) {
      requestTokenSheet(null);
      return;
    }
    // The same per-tab catalog the card uses (hubTokenCatalog): Shield never
    // lists a share as something to pay in; the spend tabs list what the
    // account holds here.
    const actionable = hubTokenCatalog(action, chainId, holdings);
    // Shield: the picker lists what the wallet actually HOLDS (Alchemy),
    // after the configured pool assets. Any of them can pay for the deposit;
    // non-pool tokens convert via LiFi (flow 1).
    // Pools that have not opened yet (mainnet ETH): listed, disabled, with the
    // "Available soon" line. They are NOT in `actionable`, so without this they
    // would fall through to the wallet rows below and be offered as a token to
    // CONVERT on the way in — which is a different, currently locked, product.
    const comingSoonRows = action === 'shield' && !isSui
      ? getDepositComingSoonTokens(chainId).map((t) => ({
        symbol: t.symbol,
        address: t.address,
        decimals: t.decimals,
        isNative: t.isNative,
        chainId,
        name: TOKEN_NAMES[t.symbol],
        comingSoon: true,
        poolAsset: true,
      }))
      : [];
    // Wallet rows: every chain the wallet list covers while no network is
    // picked, else just the picked one (even before the wallet has switched
    // to it). Each is tagged with its chain, so the sheet reads its balance
    // there and a pick switches the wallet first.
    const walletRowChains = payNetwork !== null
      ? [payNetwork]
      : [chainId, ...WALLET_ROW_CHAIN_IDS.filter((id) => id !== chainId)];
    const extRows = action === 'shield' && !isSui
      ? walletRowChains.flatMap((rowChain) => {
        // A holdings-only chain (DEV-521) has no catalog here: asking for one
        // returns the FALLBACK chain's, whose native ETH shares the 0xeee…
        // sentinel and filtered out the very ETH-on-Optimism row this is for.
        const holdingsOnly = isHoldingsOnlyChain(rowChain);
        const pools = holdingsOnly
          ? []
          : rowChain === chainId
            ? [...actionable, ...comingSoonRows]
            : [...hubTokenCatalog('shield', rowChain, NO_HOLDINGS), ...getDepositComingSoonTokens(rowChain)];
        const held = rowChain === chainId
          ? walletAndPasted
          : holdingsOnly
            ? walletTokensOn(rowChain)
            : walletTokensOn(rowChain).filter((w) => !isYieldShareOnChain(w.address, rowChain));
        return held
          .filter((w) => !pools.some((x) => x.address.toLowerCase() === w.address.toLowerCase()))
          .map((w) => ({ ...w, chainId: rowChain }));
      })
      : [];
    // Pool assets of the other EVM chains, each tagged with its chain so the
    // sheet reads each balance on the right one: all of them with the network
    // filter cleared, or just the picked network's while the wallet switch to
    // it is still pending.
    const crossChainActionable = action === 'shield' && payNetwork !== chainId
      ? supportedChainIds
        .filter((id) => getChainConfig(id)?.chainType === 'evm' && id !== chainId
          && (payNetwork === null || id === payNetwork))
        .flatMap((id) => hubTokenCatalog('shield', id, NO_HOLDINGS).map((t) => ({
          symbol: t.symbol,
          address: t.address,
          decimals: t.decimals,
          // isNative decides which balance read answers for the row, and it
          // labels the native asset instead of printing its sentinel address.
          isNative: t.isNative,
          chainId: id,
          name: TOKEN_NAMES[t.symbol],
          poolAsset: true,
        })))
      : [];
    const sheetTokens = [
      // `poolAsset` marks the catalog rows so the grouped pay sheet can list
      // the pools the wallet does not hold under their own heading instead
      // of dropping them (Mike, 2026-09-18).
      ...actionable.map((t) => ({ ...t, chainId, name: TOKEN_NAMES[t.symbol], poolAsset: true })),
      ...comingSoonRows,
      // `suspicious` rides along so the sheet can withhold scam-shaped rows
      // behind its reveal instead of listing them beside real holdings.
      ...extRows.map((w) => ({
        symbol: w.symbol,
        address: w.address,
        decimals: w.decimals,
        isNative: w.address === NATIVE_ASSET_ADDRESS.toLowerCase(),
        chainId: w.chainId,
        name: w.name,
        logoUrl: (w as { logoUrl?: string }).logoUrl,
        // Alchemy's figure, for the rows the sheet does not read on-chain
        // (the ones behind the suspicious reveal until it is opened).
        walletBalance: Number(formatUnits(w.balance, w.decimals)),
        ...(w.suspicious ? { suspicious: true } : {}),
        // A chain with no pool here (DEV-521): listed with the wallet poll's
        // balance and value, not selectable, and says why.
        ...(isHoldingsOnlyChain(w.chainId)
          ? {
            unavailableReason: `No pool on ${holdingsChainName(w.chainId) ?? 'this chain'} yet`,
            ...(w.usdValue != null ? { walletUsdValue: w.usdValue } : {}),
          }
          : {}),
      })),
      ...crossChainActionable,
    ];
    requestTokenSheet({
      tokens: sheetTokens,
      // The ONE sheet that may adopt a pasted token: the Shield PAY sheet, and
      // only where the flow that consumes it actually runs (web inline). The
      // native path falls through to a modal whose pay picker cannot adopt one,
      // so offering it there would open a deposit denominated in the wrong
      // asset (codex P1 #5).
      allowCustomSelection: action === 'shield' && !isSui && Platform.OS === 'web',
      // Shield pays FROM the wallet: a row with nothing in it is a deposit that
      // cannot be funded, so the pay list holds only what the wallet has (Pat,
      // 2026-09-04). The spend tabs rank by the shielded figure instead, and
      // every destination picker keeps its zero rows - what you receive has no
      // reason to be something you already hold.
      hideZeroBalances: action === 'shield',
      networks: supportedChainIds
        .filter((id) => getChainConfig(id)?.chainType === 'evm' || id === chainId)
        .map((id) => ({ id, name: getChainConfig(id)?.displayName ?? `Chain ${id}` })),
      selectedAddress: extPayToken?.address ?? getTokenMetadataBySymbol(tokenMeta.symbol, chainId)?.address ?? '',
      selectedChainId: chainId,
      activeNetworkId: payNetwork,
      chainId,
      isSui,
      onSelectToken: (t) => {
        const match = sheetTokens.find(
          (x) => x.address.toLowerCase() === t.address.toLowerCase() && x.chainId === (t.chainId ?? chainId),
        ) ?? sheetTokens.find((x) => x.address.toLowerCase() === t.address.toLowerCase());
        setTokenSheetOpen(false);
        setPayNetwork(null);
        if (!match) {
          // A token the user PASTED. The sheet resolves its symbol/decimals
          // on-chain and hands the row back, but it is in none of our lists, so
          // this used to `return` and the pick was a silent no-op: the sheet
          // closed and nothing changed (QA B-c, where a pasted LINK could not
          // be used to pay). Adopting it here is deliberate policy (Pat,
          // 2026-08-31): pasting a contract address is an explicit, voluntary
          // act, so it bypasses the scam heuristic that hides AIRDROPPED
          // lookalikes the user never asked for. `suspicious` is never set on
          // a pasted row for that reason.
          //
          // Registered as a wallet token in the SAME tick as setToken, because
          // the validity effect above bounces any symbol missing from
          // walletTokens back to a pool asset. Balance is left at 0 and unpriced
          // here; the deposit flow reads the real one itself.
          if (isSui || !t.address || (t.chainId !== undefined && t.chainId !== chainId)) return;
          const pasted: WalletToken = {
            symbol: t.symbol,
            name: t.name ?? t.symbol,
            address: t.address.toLowerCase(),
            decimals: t.decimals,
            balance: 0n,
            usdValue: null,
          };
          // Written to the ref BEFORE the state updates. The token-validity
          // effect near the top of this file reads this ref and runs BEFORE the
          // effect that populates it, so on the paste tick it would otherwise
          // see the old set and queue a bounce back to the pool asset that the
          // later effect cannot cancel (codex P1 #3). A ref write is synchronous
          // and beats both.
          // A registered yield share is not something Shield pays in (the
          // router mints it from its underlying), so a pasted ppUSDC is refused
          // HERE, before anything is selected, instead of being adopted and
          // then silently reset to the native asset (codex P3 on 3b6fea4). The
          // previous token and amount stay as they were.
          if (isYieldShareOnChain(t.address, chainId)) {
            toast({ title: `This asset cannot fund a deposit. Select ${displayTokenSymbol(t.symbol)} instead.`, variant: 'warning' });
            return;
          }
          extAllowedRef.current = new Set([...extAllowedRef.current, pasted.symbol]);
          setPastedTokens((prev) => (
            prev.some((e) => e.chainId === chainId && e.token.address === pasted.address)
              ? prev
              : [...prev, { chainId, token: pasted }]
          ));
          setPayPick({ address: t.address, chainId });
          setToken(t.symbol);
          setAmount((a) => sanitizeAmountInput(a, t.decimals));
          return;
        }
        void (async () => {
          // A pay token from another chain: the wallet has to be on that chain
          // to spend it (flow 1 is same-chain), so switch first and only adopt
          // the token if the switch actually commits.
          if (match.chainId !== chainId) {
            const outcome = await selectChain(match.chainId);
            if (outcome !== 'committed') return;
          }
          if (!('poolAsset' in match)) extAllowedRef.current = new Set([...extAllowedRef.current, match.symbol]);
          setPayPick({ address: match.address, chainId: match.chainId ?? chainId });
          setToken(match.symbol);
          setAmount((a) => sanitizeAmountInput(a, match.decimals));
        })();
      },
      // Keep the sheet OPEN across a network pick: selectChain commits (or
      // prompts the wallet), chainId updates, and this publisher re-fires
      // with the new chain's tokens — closing here read as a dead click.
      // null = back to every chain (the default); a pick also moves the app to
      // that chain, since paying is same-chain only.
      onSelectNetwork: (id) => {
        setPayNetwork(id);
        if (id !== null) void selectChain(id);
      },
      onClose: () => { setTokenSheetOpen(false); setPayNetwork(null); },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the probe version is a change signal: an open Shield sheet republishes when a yield underlying verifies
  }, [tokenSheetOpen, chainId, isSui, tokenMeta.symbol, setToken, selectChain, action, walletAndPasted, walletTokensOn, extPayToken, payNetwork, holdings, hubYieldProbeVersion]);

  // The swap-output picker shares that host: rendered here its scrim would be
  // clipped to the widget for exactly the same reason.
  const publishSwapOutSheet = useCallback(() => {
    if (!swapOutSheetOpen) return false;
    // Every destination's tokens, each row tagged with its chain; the sheet's
    // network tab narrows to one, and "All chains" (activeNetworkId null) shows
    // the whole list so a row can be picked across chains (Pat, 2026-09-03).
    const sellAddress = (getTokenMetadataBySymbol(tokenMeta.symbol, chainId)?.address ?? '').toLowerCase();
    const allCandidates = swapDestinations.flatMap((dest) => getSwapOutputTokens(dest, chainId)
      // Same chain: minus the asset being spent (that swap is a withdrawal).
      .filter((t) => dest !== chainId || t.address.toLowerCase() !== sellAddress)
      .map((t) => ({ ...t, chainId: dest, name: t.name ?? TOKEN_NAMES[t.symbol] })));
    requestTokenSheet({
      tokens: allCandidates,
      // Rows carry the DESTINATION chain: the sheet filters rows by
      // `t.chainId ?? chainId` against the active network tab, and `chainId`
      // below is the pool chain, so a cross-chain destination (mainnet pool,
      // Optimism delivery) filtered every candidate out and showed "No tokens
      // to show" (Pat, 2026-09-03). The receive side is a delivery list, not a
      // balance: nothing here depends on what the user holds.
      balanceMode: 'none',
      // Only destinations with a row to pick: a network with nothing to
      // receive would be an offer the pill cannot honour (codex on daa77f4).
      networks: swapDestinationNetworks(
        swapDeliverableDestinations,
        supportedChainIds.filter((id) => getChainConfig(id)?.chainType === 'evm'),
        chainId,
        (id) => swapChainUnavailableReason(id, 'destination', chainId),
        (id) => getChainConfig(id)?.displayName ?? `Chain ${id}`,
      ),
      selectedAddress: swapOutToken?.address ?? '',
      activeNetworkId: swapOutSheetAllChains ? null : swapDestChainId,
      chainId,
      isSui,
      title: 'You receive',
      onSelectToken: (t) => {
        // A row picked under "All chains" may live on another destination:
        // move the destination with it, then the default-pick effect keeps
        // this address because it is in the new chain's candidates.
        const dest = t.chainId ?? swapDestChainId;
        if (dest !== swapDestChainId) setSwapDestChoice(dest);
        setSwapOutAddress(t.address);
        setSwapOutSheetAllChains(false);
        setSwapOutSheetOpen(false);
      },
      // The token list re-derives from the destination; the default-pick
      // effect keeps a selection that chain cannot serve from lingering.
      onSelectNetwork: (id) => {
        if (id === null) { setSwapOutSheetAllChains(true); return; }
        if (!swapDeliverableDestinations.includes(id)) return;
        setSwapOutSheetAllChains(false);
        // The output can be someone else's now: the recipient row under the
        // card names them (DEV-510, grep [swap-deposit-recipient]).
        setSwapDestChoice(id);
      },
      onClose: () => { setSwapOutSheetAllChains(false); setSwapOutSheetOpen(false); },
    });
    return true;
  }, [swapOutSheetOpen, swapOutSheetAllChains, swapOutToken, tokenMeta.symbol, chainId, isSui, swapDestinations, swapDestChainId]);

  // The pay-from picker behind the Shield tab's swap-pair card. Same host,
  // same shape; lists this build's POOLS grouped by chain. Picking a pool on
  // another chain drives the normal chain switch first, so the wallet and
  // the deposit land on the same chain.
  // The Request tab's asset picker. Deliberately NOT publishTokenSheet: that
  // one appends Alchemy wallet rows and its onSelectToken writes the HUB's
  // token. A request can only name an asset that HAS a pool to be paid into,
  // which is exactly listShieldPools() — every chain's pool assets.
  //
  // Cross-chain by design (Pat, 2026-08-31): the PAYER fulfils a request, so
  // the creator not holding the asset says nothing about whether they may ask
  // for it. Listing only the active chain made "get paid in USDC on Optimism"
  // impossible for someone sitting on Sepolia, which is the whole point of the
  // feature. Two things make that safe:
  //   - every row carries its own chainId, and the pick drives the normal
  //     chain switch BEFORE the token is written. Every EVM chain's native
  //     asset shares one sentinel address, so an address alone is ambiguous;
  //     the switch means the provider always resolves it against the catalog
  //     the payload will actually name.
  //   - balanceMode 'none': the creator's own holdings are irrelevant here, and
  //     a "—" against every other chain's asset read as "not available to you".
  const publishRequestSheet = useCallback(() => {
    if (!requestSheetOpen) return false;
    const pools = listShieldPools();
    requestTokenSheet({
      tokens: pools.map((p) => ({
        symbol: p.symbol,
        address: p.address,
        decimals: p.decimals,
        chainId: p.chainId,
        name: `${poolDisplayLabel(p.symbol, p.chainId)} Pool`,
      })),
      networks: [...new Set(pools.map((p) => p.chainId))].map((id) => ({
        id,
        name: getChainConfig(id)?.displayName ?? `Chain ${id}`,
      })),
      selectedAddress: requestToken.address,
      // The selection's own chain: an address alone is ambiguous across chains
      // (shared native sentinel), so the sheet needs this to tick the right row.
      selectedChainId: requestToken.chainId,
      activeNetworkId: requestSheetNetwork,
      chainId: requestSheetNetwork ?? chainId,
      isSui,
      title: 'Request',
      balanceMode: 'none',
      onSelectToken: (t) => {
        const targetChain = t.chainId ?? requestSheetNetwork ?? chainId;
        setRequestSheetOpen(false);
        setRequestSheetNetwork(null);
        void (async () => {
          if (targetChain !== chainId) {
            // The payload, the keystore lookup and the SDK session are all
            // scoped to the app's active chain, so the switch has to COMMIT
            // before the token is written. A refused switch keeps the old
            // asset rather than creating a request the create path would
            // stamp with the wrong chain.
            const outcome = await selectChain(targetChain);
            if (outcome !== 'committed') return;
          }
          // The sheet hands back the object we passed, so this address is the
          // catalog's own string — which the provider's exact-case find needs.
          syncRequestForm({ tokenAddress: t.address as `0x${string}`, tokenChainId: targetChain });
        })();
      },
      onSelectNetwork: (id) => setRequestSheetNetwork(id),
      onClose: () => { setRequestSheetOpen(false); setRequestSheetNetwork(null); },
    });
    return true;
  }, [requestSheetOpen, requestSheetNetwork, chainId, isSui, requestToken.address, requestToken.chainId, selectChain, syncRequestForm]);

  const publishPoolSheet = useCallback(() => {
    if (!poolSheetOpen) return false;
    const shieldPools = listShieldPools().filter((pool) => {
      if (isSupersededLegacyPool(pool.symbol, pool.chainId)) return false;
      // The selected pay asset may enter its own yield pool directly. Every
      // other destination needs a supported conversion final leg.
      const direct = pool.chainId === chainId && (pool.address.toLowerCase() === payTokenAddr?.toLowerCase()
        || payWrapsIntoPoolRule({ payChainId: chainId, poolChainId: pool.chainId, poolAddress: pool.address, payAddress: payTokenAddr }));
      return direct || (identityMode !== 'key'
        && targetAcceptsConversion(getKnownTokenMetadata(pool.address, pool.chainId), pool.chainId, false, pool.chainId !== chainId)
        && (pool.chainId === chainId ? swapDepositEnabledForChain(chainId) : crossChainSwapDepositSupported(chainId, pool.chainId)));
    });
    // Spending draws on every pool the account holds notes in, including a
    // withdraw-only legacy asset (prod plain USDC) that listShieldPools no
    // longer offers as a deposit target (codex, 2026-09-04).
    const heldPools: ShieldPool[] = data.myPools.flatMap((m) => {
      const chain = getChainConfig(m.chainId);
      const meta = getTokenMetadataBySymbol(m.name, m.chainId);
      if (!chain || chain.chainType !== 'evm' || !meta) return [];
      return [{ chainId: m.chainId, chainName: chain.displayName ?? `Chain ${m.chainId}`, symbol: meta.symbol, address: meta.address, decimals: meta.decimals }];
    });
    // Swap: a held pool on a chain (or in an asset) swaps cannot run from yet
    // stays listed, greyed out with the reason, rather than missing (Mike, #276).
    const pools: (ShieldPool & { unavailableReason?: string })[] = poolSheetMode === 'shield'
      ? shieldPools
      : poolSheetMode !== 'swap'
        ? heldPools
        : heldPools.map((pool) => {
          const reason = swapSourcePoolReason(
            intentSwapInputSupported(pool.chainId, pool.address),
            swapChainUnavailableReason(pool.chainId, 'source'),
          );
          return reason ? { ...pool, unavailableReason: reason } : pool;
        });
    const networkIds = [...new Set([...shieldPools, ...heldPools].map((p) => p.chainId))];
    // undefined = the user cleared the chain filter: list every chain's pools.
    const sheetNetwork = poolSheetNetwork;
    // Spending (withdraw/send/swap) can only draw on pools that actually HOLD
    // something for this account, so those sheets list exactly those — no
    // wallet-token rows, no empty pools (Pat, 2026-08-18).
    const spendMode = poolSheetMode !== 'shield';
    const shieldedFor = (p: { symbol: string; chainId: number }) => data.myPools.find(
      (m) => m.name.toUpperCase() === p.symbol.toUpperCase() && m.chainId === p.chainId,
    );
    const listed = spendMode
      ? pools.filter((p) => (parseFloat(shieldedFor(p)?.balanceTokenExact ?? '0') || 0) > 0 || (parseFloat(shieldedFor(p)?.pendingTokenExact ?? '0') || 0) > 0)
      : pools;
    requestTokenSheet({
      // Every listed pool carries its own chain: with no chain selected the
      // sheet shows them all, ranked by the figure it is about.
      tokens: listed.map((p) => ({
        symbol: p.symbol,
        address: p.address,
        decimals: p.decimals,
        chainId: p.chainId,
        name: `${poolDisplayLabel(p.symbol, p.chainId)} Pool`,
        ...(p.unavailableReason ? { unavailableReason: p.unavailableReason } : {}),
      })),
      networks: networkIds.map((id) => ({ id, name: getChainConfig(id)?.displayName ?? `Chain ${id}` })),
      selectedAddress: spendMode
        ? (sheetNetwork === null || sheetNetwork === chainId
          ? getTokenMetadataBySymbol(tokenMeta.symbol, chainId)?.address ?? ''
          : '')
        : shieldPool && (sheetNetwork === null || shieldPool.chainId === sheetNetwork) ? shieldPool.address : '',
      // The selection's own chain: an address alone is ambiguous across chains
      // (shared native sentinel), so the sheet needs this to check the right row.
      selectedChainId: spendMode ? chainId : shieldPool?.chainId ?? chainId,
      activeNetworkId: sheetNetwork,
      // On-chain reads + the swap gate still need a concrete chain; with the
      // filter cleared that is the chain the app is acting on.
      chainId: sheetNetwork ?? chainId,
      isSui,
      // Spend sheets are about the SHIELDED figure; a wallet balance next to it
      // described money this flow cannot move.
      balanceMode: spendMode ? 'shielded' : 'wallet',
      title: poolSheetMode === 'withdraw' ? 'Withdraw from pool' : poolSheetMode === 'send' ? 'Send from pool' : poolSheetMode === 'swap' ? 'Swap from pool' : 'Deposit in pool',
      onSelectToken: (t) => {
        // With the filter cleared the row itself carries the chain (the list
        // spans several), so the pick decides the target — not the sheet.
        const targetChain = t.chainId ?? sheetNetwork ?? chainId;
        const mode = poolSheetMode;
        setPoolSheetOpen(false);
        setPoolSheetNetwork(null);
        void (async () => {
          // A routable cross-chain shield deliberately does NOT switch: the pay
          // token, the wallet and the LiFi transaction stay on this chain while
          // the pool (and the note) live on the other one. Everything else —
          // every spend, and any pair LiFi cannot bridge — still needs the
          // wallet on the pool's chain.
          // Web only, and never in key mode: those are the two surfaces whose
          // shield CTA actually runs the cross-chain flow. On native the CTA
          // falls through to the modal, which resolves the deposit token on the
          // WALLET's chain — keeping the wallet here would deposit into this
          // chain's pool while the card promised a bridge. In key mode the
          // deposit flow refuses cross-chain outright, so not switching would
          // strand the user on a CTA that only says "switch networks".
          const keepChainForCrossChainShield = mode === 'shield'
            && Platform.OS === 'web'
            && identityMode !== 'key'
            && crossChainSwapDepositSupported(chainId, targetChain);
          if (targetChain !== chainId && !keepChainForCrossChainShield) {
            const outcome = await selectChain(targetChain);
            if (outcome !== 'committed') return; // refused switch = keep the old pool
            if (mode === 'shield') {
              // Not routable: the pay token re-resolves onto the pool's chain,
              // so say it instead of silently repointing the symbol.
              const chainName = getChainConfig(targetChain)?.displayName ?? `chain ${targetChain}`;
              toast({ title: `Pool is on ${chainName}. You now pay from your ${chainName} balance.` });
            }
          }
          if (mode !== 'shield') {
            if (mode === 'withdraw' && withdrawInline && withdrawStep === 'loading') return;
            // Source pool (withdraw/send/swap): the card token IS the asset
            // being spent; the open inline flow re-opens under it (same as
            // the old chips did).
            setToken(t.symbol);
            setAmount((a) => sanitizeAmountInput(a, t.decimals));
            if (mode === 'withdraw' && withdrawInline) {
              openWithdrawModal(undefined, { tokenSymbol: t.symbol, amount: amount || undefined, inline: true });
            } else if (mode === 'send' && transferInline) {
              openTransferModal({ tokenSymbol: t.symbol as 'ETH' | 'USDC' | 'USDT', amount: amount || undefined, inline: true });
            }
            return;
          }
          setShieldPoolPick({ chainId: targetChain, symbol: t.symbol });
        })();
      },
      onSelectNetwork: (id) => setPoolSheetNetwork(id),
      onClose: () => { setPoolSheetOpen(false); setPoolSheetNetwork(null); },
    });
    return true;
  }, [poolSheetOpen, poolSheetNetwork, poolSheetMode, shieldPool, payTokenAddr, chainId, isSui, selectChain, tokenMeta.symbol, amount, withdrawInline, withdrawStep, openWithdrawModal, transferInline, openTransferModal, setToken, toast, data.myPools, identityMode]);

  useEffect(() => {
    // One host, three possible sheets — whichever picker the user just tapped
    // wins while open; the asset picker is the fallback.
    if (!publishSwapOutSheet() && !publishPoolSheet() && !publishRequestSheet()) publishTokenSheet();
    // Retract on unmount so a sheet can't outlive the hub that asked for it.
    return () => requestTokenSheet(null);
  }, [publishTokenSheet, publishSwapOutSheet, publishPoolSheet, publishRequestSheet]);
  const tokenAddress = useMemo(() => {
    // Alchemy-picked pay tokens live outside the config registry — use their
    // own address; native resolves to undefined either way (useBalance path).
    const addr = extPayToken?.address ?? getTokenMetadataBySymbol(tokenMeta.symbol, chainId)?.address;
    return addr?.toLowerCase() === NATIVE_ASSET_ADDRESS.toLowerCase() ? undefined : (addr as `0x${string}` | undefined);
  }, [extPayToken, tokenMeta.symbol, chainId]);
  const { data: nativeBalance, refetch: refetchNativeBalance } = useBalance({
    address: connectedAddress,
    chainId,
    // refetchInterval: the figure is the tap-to-max source and the "exceeds
    // your wallet balance" guard, and it only polls while the query is
    // enabled (connected, on the Shield tab) — one eth_getBalance per tick.
    query: { enabled: !isSui && !!connectedAddress && action === 'shield' && !tokenAddress, refetchInterval: 20_000 },
  });
  const { data: erc20BalanceRaw, refetch: refetchErc20Balance } = useReadContract({
    abi: erc20Abi,
    address: tokenAddress,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress] : undefined,
    chainId,
    query: { enabled: !isSui && !!connectedAddress && !!tokenAddress && action === 'shield', refetchInterval: 20_000 },
  });
  const { data: suiBalanceData, refetch: refetchSuiBalance } = useSuiClientQuery(
    'getBalance',
    { owner: unifiedAddress ?? '' },
    // Data readiness only: a tab-gated first fetch would mark the moment the
    // Shield tab opened (docs/privacy-request-discipline.md).
    { enabled: isSuiChain && !!unifiedAddress },
  );
  // The wallet just paid for a deposit — the cached balance reads are stale
  // the moment the tx lands. Refetched when the inline flow reaches success
  // (and again on "New deposit") so the form never shows the pre-deposit
  // balance.
  const refetchWalletBalance = useCallback(() => {
    void refetchNativeBalance();
    void refetchErc20Balance();
    void refetchSuiBalance();
    // The Freighter account's own balance after its own deposit: the network
    // already saw that deposit come from this account, so this read adds
    // nothing an observer did not have (same reasoning as the EVM reads).
    if (isStellar) void refetchStellarBalance();
  }, [refetchNativeBalance, refetchErc20Balance, refetchSuiBalance, isStellar, refetchStellarBalance]);

  // Vetting fee for the picked asset — the info the modal's review used to
  // carry, now shown live on the form. Read from the entrypoint's on-chain
  // asset config (fail-soft: no row while unknown).
  // Pinned: an unpinned usePublicClient() reads whatever chain the WALLET is
  // on, which is not necessarily the chain the app is acting on.
  const publicClient = usePublicClient({ chainId: chainId });
  // The vetting fee belongs to the DEPOSIT asset — the destination pool on
  // the redesigned Shield tab — not to whatever token pays for it.
  const feeAssetAddress = (action === 'shield' && !isSui && shieldPool
    ? shieldPool.address
    : tokenAddress ?? NATIVE_ASSET_ADDRESS) as `0x${string}`;
  // ...and it is configured on the POOL's entrypoint, which for a cross-chain
  // shield is not the wallet's chain. Reading the source entrypoint for a
  // destination asset hits an unconfigured slot and answers "no fee, no
  // minimum" — understating the cost and dropping the minimum check that keeps
  // the far-end deposit from reverting.
  const feeChainId = action === 'shield' && !isSui && shieldPool ? shieldPool.chainId : chainId;
  const { data: hubAssetConfig } = useQuery({
    queryKey: ['hub-vetting-fee', feeChainId, feeAssetAddress],
    enabled: !isSui && action === 'shield' && (feeChainId === chainId ? !!publicClient : true),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const entrypoint = await resolveConfiguredEntrypoint(feeChainId);
      if (!entrypoint) return null;
      // Reads only, so a bare transport is enough — no chain object needed.
      const feeRpcUrl = getChainConfig(feeChainId)?.rpcUrl;
      const client = feeChainId === chainId
        ? publicClient
        : (feeRpcUrl ? createPublicClient({ transport: policedHttp(feeRpcUrl) }) : null);
      if (!client) return null;
      const cfg = await client.readContract({
        address: entrypoint as `0x${string}`,
        abi: ENTRYPOINT_ASSETS_ABI,
        functionName: 'assets',
        args: [feeAssetAddress],
      }) as EntrypointAssetConfig;
      return {
        vettingFeeBps: Number(getVettingFeeBPS(cfg)),
        minAmountWei: getMinimumDepositAmount(cfg),
      };
    },
  });
  const vettingFeeBps = hubAssetConfig?.vettingFeeBps;
  // For a wrapped deposit (pay USDT, pool ppUSDT) the Entrypoint minimum is in
  // SHARES. Convert it to the pay asset at the vault's live rate with
  // previewMint (services/deposit-limits.ts). Comparing the pay amount to the
  // share minimum 1:1 let a 10 USDT deposit through that minted ~9.95 shares
  // and reverted with the SDK's raw BelowMinimumAmount (prod, 2026-09-05).
  const hubMinShares = payWrapsIntoPool && hubAssetConfig?.minAmountWei != null && hubAssetConfig.minAmountWei > 0n
    ? hubAssetConfig.minAmountWei
    : null;
  const { data: hubMinAssets, isError: hubMinAssetsError } = useQuery({
    queryKey: ['hub-min-preview-mint', feeChainId, feeAssetAddress, hubMinShares?.toString()],
    enabled: !isSui && action === 'shield' && hubMinShares != null && (feeChainId === chainId ? !!publicClient : true),
    staleTime: 60_000,
    queryFn: async () => {
      const feeRpcUrl = getChainConfig(feeChainId)?.rpcUrl;
      const client = feeChainId === chainId
        ? publicClient
        : (feeRpcUrl ? createPublicClient({ transport: policedHttp(feeRpcUrl) }) : null);
      if (!client) return null;
      const assets = await client.readContract({
        address: feeAssetAddress,
        abi: PREVIEW_MINT_ABI,
        functionName: 'previewMint',
        args: [hubMinShares!],
      });
      return (assets as bigint).toString();
    },
  });
  /**
   * The units a CONVERSION into this pool is quoted, sized and displayed in.
   *
   * LiFi is asked to deliver the pool's funding token, which for a share pool
   * is its underlying (or the coin in native mode), because no DEX holds the
   * share and the router mints it from what arrives. So every figure that comes
   * back from that quote is in the underlying, not in the pool's own token, and
   * on mainnet USDC that is 6 decimals against the share's 18.
   *
   * Reading those figures with the pool's decimals divided them by 1e12: the
   * preview rendered "0", the minimum check refused ~13.74 USDC as below 10,
   * and the deposit sizing would have asked for dust. Same shape as
   * `shapeReshieldForDisplay`: the number came from one token and its decimals
   * from another. It only appeared once share pools became conversion targets
   * (2026-09-21), because before that the funding token WAS the pool token and
   * the two agreed by accident.
   */
  const shieldFundingUnits = useMemo(() => {
    if (!shieldPool) return null;
    return conversionFundingUnits(
      getConfiguredYieldDeploymentForAsset(shieldPool.chainId, shieldPool.address),
      { decimals: shieldPool.decimals, symbol: shieldPool.symbol },
    );
  }, [shieldPool]);

  // What shielding costs beyond the amount: the wallet's gas, and for a
  // conversion what the swap and bridge keep, priced off the feeds.
  const feePricing = useFeePricing(chainId);
  const shieldAmountUsd = useMemo(() => {
    if (action !== 'shield' || isSui) return null;
    const amt = parseFloat(amount) || 0;
    const payUsd = feePricing.tokenUsdOf(chainId, payTokenAddr ?? NATIVE_ASSET_ADDRESS, payMeta.symbol);
    return amt > 0 && payUsd ? amt * payUsd : null;
  }, [action, isSui, amount, feePricing, chainId, payTokenAddr, payMeta.symbol]);
  const shieldFeeBreakdown = useMemo(() => {
    if (shieldAmountUsd === null || !shieldPool || vettingFeeBps == null) return null;
    const gasUnits = crossChainShield ? SHIELD_GAS_UNITS.crossChainSource : crossPayShield ? SHIELD_GAS_UNITS.swapDeposit : SHIELD_GAS_UNITS.deposit;
    const sourceGas = feePricing.gasPriceOf(chainId);
    const walletGasUsd = gasCostUsd(gasUnits, sourceGas, feePricing.nativeUsdOf(chainId));
    if (walletGasUsd === null) return null;
    const readings: FeeGasReading[] = [{ chainId, gasPriceWei: sourceGas }];
    if (!crossPayShield) {
      return buildFeeBreakdown({ amountUsd: shieldAmountUsd, networkUsd: walletGasUsd, swapUsd: (shieldAmountUsd * vettingFeeBps) / 10_000, gas: readings });
    }
    if (shieldQuote.status !== 'ok' || shieldQuote.toAmount == null || !shieldFundingUnits) return null;
    const fundingUsd = feePricing.tokenUsdOf(shieldPool.chainId, conversionFundingToken(shieldPool.address, shieldPool.chainId), shieldFundingUnits.symbol);
    const deliveredUsd = (Number(formatUnits(shieldQuote.toAmount, shieldFundingUnits.decimals)) || 0) * (fundingUsd ?? 0);
    const swapUsd = fundingUsd === null ? null : Math.max(0, shieldAmountUsd - deliveredUsd);
    if (crossChainShield) readings.push({ chainId: shieldPool.chainId, gasPriceWei: feePricing.gasPriceOf(shieldPool.chainId) });
    return buildFeeBreakdown({
      amountUsd: shieldAmountUsd,
      networkUsd: walletGasUsd + (shieldQuote.nativeFeeUsd ?? 0),
      swapUsd: swapUsd === null ? null : swapUsd + (deliveredUsd * vettingFeeBps) / 10_000,
      gas: readings,
    });
  }, [shieldAmountUsd, shieldPool, vettingFeeBps, crossChainShield, crossPayShield, feePricing, chainId, shieldQuote, shieldFundingUnits]);
  // A small shield on an expensive chain points at the chains it could land
  // on for less, through the cross-chain shield (which runs inline on web).
  const shieldElsewhereSuggestion = useMemo(() => {
    if (action !== 'shield' || isSui || Platform.OS !== 'web' || identityMode === 'key' || !poolPickEnabled) return null;
    if (!shieldPool || shieldPool.chainId !== chainId) return null;
    return shieldElsewhere({
      sourceChainId: chainId,
      sourceChainName: getChainConfig(chainId)?.displayName ?? `Chain ${chainId}`,
      amountUsd: shieldAmountUsd,
      directGasUnits: crossPayShield ? SHIELD_GAS_UNITS.swapDeposit : SHIELD_GAS_UNITS.deposit,
      pools: listShieldPools().filter((p) => !isSupersededLegacyPool(p.symbol, p.chainId) && isTestnetChain(p.chainId) === isTestnetChain(chainId)),
      gasPriceOf: feePricing.gasPriceOf,
      nativeUsdOf: feePricing.nativeUsdOf,
      routeAvailable: crossChainSwapDepositSupported,
      poolAccepts: (p) => targetAcceptsConversion(getKnownTokenMetadata(p.address, p.chainId), p.chainId, false, true),
    });
  }, [action, isSui, identityMode, poolPickEnabled, shieldPool, chainId, shieldAmountUsd, crossPayShield, feePricing]);

  /**
   * The entrypoint minimum expressed in those same funding units, so the
   * conversion branch compares two figures denominated in one token.
   *
   * `previewMint` at the live rate when it is readable, the configured decimals
   * otherwise; both are already computed above for the wrapped-pay branch, this
   * just drops that branch's `payWrapsIntoPool` gate, which a conversion never
   * satisfies (paying ETH does not wrap into the USDC pool).
   */
  const shieldMinFundingWei = useMemo<bigint | null>(() => {
    const min = hubAssetConfig?.minAmountWei;
    if (min == null || min <= 0n || !shieldPool) return min ?? null;
    const deployment = getConfiguredYieldDeploymentForAsset(shieldPool.chainId, shieldPool.address);
    if (!deployment || deployment.nativeMode === true) return min;
    const assets = hubMinAssets != null
      ? BigInt(hubMinAssets)
      : hubMinAssetsError
        ? scaleUnits(min, deployment.ppUSDCDecimals, deployment.underlyingDecimals)
        : null;
    if (assets == null) return null;
    return requiredUnderlyingForMinShares({
      assetsForMinShares: assets,
      underlyingDecimals: deployment.underlyingDecimals,
      underlyingSymbol: deployment.underlyingSymbol,
    });
  }, [hubAssetConfig, shieldPool, hubMinAssets, hubMinAssetsError]);

  // The minimum in the PAY asset's units (null while a wrapped conversion is
  // still loading; the provider's own gate covers confirm meanwhile).
  const shieldMinPayWei = useMemo<bigint | null>(() => {
    const min = hubAssetConfig?.minAmountWei;
    if (min == null || min <= 0n || !shieldPool || !payWrapsIntoPool) return min ?? null;
    // Configured, to stay in step with payWrapsIntoPool above: the decimals and
    // symbols this scales by are config facts. Reading the verified resolver
    // here while the gate above read the configured one would compare a
    // share-denominated (18 dp) minimum against a 6 dp pay amount.
    const deployment = getConfiguredYieldDeploymentForAsset(shieldPool.chainId, shieldPool.address);
    if (!deployment) return min;
    const assets = hubMinAssets != null
      ? BigInt(hubMinAssets)
      : hubMinAssetsError
        ? scaleUnits(min, deployment.ppUSDCDecimals, deployment.underlyingDecimals)
        : null;
    if (assets == null) return null;
    return requiredUnderlyingForMinShares({
      assetsForMinShares: assets,
      underlyingDecimals: deployment.underlyingDecimals,
      underlyingSymbol: deployment.underlyingSymbol,
    });
  }, [hubAssetConfig, shieldPool, payWrapsIntoPool, hubMinAssets, hubMinAssetsError]);
  // Entrypoint minimum for the DEPOSIT asset: the contract reverts below it.
  // Same-token / wrapped: compare the entered PAY amount to the pay-side
  // minimum; cross-pay: compare the quoted deposit target (the min applies to
  // what lands in the pool, not the pay side).
  const shieldBelowMin = (() => {
    if (isSui || action !== 'shield' || !shieldPool) return false;
    const min = hubAssetConfig?.minAmountWei;
    if (min == null || min <= 0n) return false;
    if (crossPayShield) {
      // Both sides in the FUNDING token: the quote delivers the underlying, so
      // comparing it against the share-denominated `min` rejected every USDC
      // conversion (13_740_000 < 10e18).
      if (shieldQuote.status !== 'ok') return false;
      return conversionBelowMinimum(shieldQuote.toAmount, shieldMinFundingWei);
    }
    if (shieldMinPayWei == null) return false;
    try {
      const wei = parseUnits(amount || '0', payMeta.decimals);
      return wei > 0n && wei < shieldMinPayWei;
    } catch { return false; }
  })();
  useEffect(() => {
    // Inline AND modal shields: the step is shared. One read at success, then
    // two delayed re-reads — Mike (2026-08-25) shielded and the form kept the
    // pre-deposit balance: the single refetch raced a lagging RPC replica (or
    // fired while the tab's query was disabled) and nothing ever asked again.
    if (depositFlow.step !== 'success') return;
    refetchWalletBalance();
    const t1 = setTimeout(refetchWalletBalance, 4_000);
    const t2 = setTimeout(refetchWalletBalance, 12_000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [depositFlow.step, refetchWalletBalance]);
  // Loading-state truth for the figures below: a query that is enabled but
  // has no data yet must render a dash, not a false zero.
  // Native mock mode shows the mock account's public balance instead.
  const mockWalletBalance = NATIVE_MOCK_ACTIVE && !isSui && !isStellar ? getNativeMockWalletBalance(payMeta.symbol) : null;
  const walletBalanceLoading = mockWalletBalance != null ? false : isStellar
    ? (stellarWallet.isConnected && stellarBalance == null)
    : isSui
    ? (!!unifiedAddress && suiBalanceData == null)
    : (!!connectedAddress && (tokenAddress ? erc20BalanceRaw == null : nativeBalance == null));
  const walletBalanceText = mockWalletBalance ?? (isStellar
    ? (stellarBalance ? formatUnits(stellarBalance.spendable, 7) : '0')
    : isSui
    ? (suiBalanceData ? formatUnits(BigInt(suiBalanceData.totalBalance), 9) : '0')
    : tokenAddress
      ? (erc20BalanceRaw != null ? formatUnits(erc20BalanceRaw as bigint, payMeta.decimals) : '0')
      : (nativeBalance ? formatUnits(nativeBalance.value, nativeBalance.decimals) : '0'));

  // --- Fee-aware Shield max (QA 2026-08-18) ---
  //
  // Tapping the balance must produce an amount the deposit can actually pay:
  // the wallet is charged amount + the vetting fee ON TOP (ERC-20 allowance =
  // amount + fee; native msgValue likewise), and a native pay token also
  // funds the ZK deposit's gas from the same balance. Cross-pay (flow 1,
  // swap-into-deposit) spends the pay token 1:1 into the route — the LiFi
  // route fee and the vetting fee both come out of the CONVERTED amount, so
  // only the (heavier) gas reserve applies to the pay side.
  const { data: hubFeeData } = useEstimateFeesPerGas({
    chainId,
    // eth_gasPrice, the same read the deposit check prices its reserve from.
    type: 'legacy',
    query: { enabled: action === 'shield' && !isSui && walletConnected },
  });
  const shieldMaxWei = useMemo<bigint | null>(() => {
    if (isSui || action !== 'shield') return null;
    // Native mock mode: size the max from the balance on screen.
    const balanceWei = mockWalletBalance != null
      ? parseUnits(mockWalletBalance, payMeta.decimals)
      : tokenAddress
        ? ((erc20BalanceRaw as bigint | undefined) ?? 0n)
        : nativeBalance?.value ?? 0n;
    // ONE helper with the deposit check (DEV-542), so Max always passes it.
    return maxShieldAmountWei({
      balanceWei,
      payIsNative: !tokenAddress,
      gasPriceWei: hubFeeData?.gasPrice,
      chainId,
      crossPay: crossPayShield,
      vettingFeeBps,
    });
  }, [isSui, action, tokenAddress, erc20BalanceRaw, nativeBalance, crossPayShield, hubFeeData, vettingFeeBps, mockWalletBalance, payMeta.decimals, chainId]);
  const shieldMaxText = shieldMaxWei != null ? formatUnits(shieldMaxWei, payMeta.decimals) : walletBalanceText;

  // Tap-to-max: the balance line is the max button. Shield fills the wallet
  // balance net of the vetting fee + gas reserve; send fills the transfer
  // flow's fee-aware cap while the inline flow is open (note caps + the
  // relayer fee, which rides ON TOP of the amount); withdraw/swap fill the
  // exact shielded balance — the withdraw provider treats a full-balance
  // entry as gross (relayer fees come out of the final amount), and swap
  // fees are charged on the output.
  // Send's Max is the one-transfer cap for THIS token, whether or not the
  // flow is open yet: the whole shielded balance can exceed what one transfer
  // can carry when notes are fragmented (codex #3).
  const sendMaxText = (() => {
    if (action !== 'send') return null;
    const cap = getTransferMaxWei(tokenMeta.symbol);
    return cap == null ? null : formatUnits(cap, tokenMeta.decimals);
  })();
  const maxText = action === 'shield'
    ? shieldMaxText
    : action === 'withdraw'
      ? withdrawMaxExact
    : action === 'send'
      ? (sendMaxText ?? shielded.exact)
      : shielded.exact;
  const amountField = useShareAmountField({ amount, symbol: tokenMeta.symbol, chainId, maxSharesExact: maxText, capKnown: action === 'withdraw' ? !withdrawBalanceBlocked && withdrawMaxWei !== null : action === 'send' ? sendMaxText !== null && !poolsLoading : true,
    onAmountResolved: (shares) => {
      setAmount(shares);
      if (withdrawInline) pushWithdrawAmount(shares);
      else if (transferInline) pushTransferAmount(shares);
    }, underlyingEntry: action === 'withdraw' || action === 'send' });
  const fillMax = () => {
    // Withdraw's max is the shielded balance, and while the association set is
    // still loading that figure is not yet provable — filling it would seed the
    // form with an amount the flow immediately rejects (Pat, 2026-08-28).
    if (action === 'withdraw' && withdrawBalanceBlocked) return;
    const next = sanitizeAmountInput(maxText, payMeta.decimals);
    setAmount(next);
    // The open inline flow keeps its OWN amount state — push the max into it
    // like typed input and the presets do, or the provider validates/quotes
    // the stale amount while the hub displays the max (GLM review, bug 1).
    if (withdrawInline) pushWithdrawAmount(next);
    else if (transferInline) pushTransferAmount(next);
  };

  // Measure natural content while the outer card animates to the active face.
  const picker = useWalletPicker();
  const { available: passkeyAvailable } = usePasskeyAccount();
  const [showAccountKey, setShowAccountKey] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Mobile: create the WalletConnect pairing as the picker opens.
  const preparePairing = picker.prepare;
  useEffect(() => {
    if (pickerOpen) preparePairing();
  }, [pickerOpen, preparePairing]);
  const [pageHeights, setPageHeights] = useState<Partial<Record<Action, number>>>({});
  const [formHeight, setFormHeight] = useState<number>();
  const [pickerHeight, setPickerHeight] = useState<number>();
  const cardHeight = pickerOpen ? pickerHeight : formHeight;
  const formNode = useRef<View>(null);
  const pickerNode = useRef<View>(null);
  const pagerFrameNode = useRef<View>(null);
  const pageNodes = useRef<Partial<Record<Action, View | null>>>({});
  const [heightMotionReady, setHeightMotionReady] = useState(false);

  // Web onLayout is asynchronous. Resolve the initial pager and active face
  // before paint so the card never displays its tabs-only intermediate height.
  // Each write re-runs this effect before paint, and width and height can feed
  // each other (the window scrollbar coming and going rewraps the page), so the
  // corrections are capped per frame. Past the cap the effect waits for the
  // next frame and the pages' onLayout instead of looping until React throws
  // #185 (Swap tab crash, 2026-10-21). See services/layout-pass-budget.ts.
  const measureBudget = useRef(createLayoutPassBudget());
  const measureBudgetFrame = useRef<number | null>(null);
  // Damps the same cycle at frame rate (onLayout included): a width that
  // quickly flips back by a scrollbar's worth is the scrollbar, the pager holds
  // the narrower for a moment. Bigger or slower changes are followed.
  const pagerWidthDamper = useRef(createWidthDamper());
  const takeMeasurePass = () => {
    if (measureBudgetFrame.current === null && typeof requestAnimationFrame === 'function') {
      measureBudgetFrame.current = requestAnimationFrame(() => {
        measureBudgetFrame.current = null;
        measureBudget.current.reset();
      });
    }
    return measureBudget.current.take();
  };
  useEffect(() => () => {
    if (measureBudgetFrame.current !== null) cancelAnimationFrame(measureBudgetFrame.current);
  }, []);
  // A window resize is a real width change, never the scrollbar cycle.
  useEffect(() => {
    if (!WEB || typeof window === 'undefined') return;
    const release = () => pagerWidthDamper.current.release();
    window.addEventListener('resize', release);
    return () => window.removeEventListener('resize', release);
  }, []);
  useLayoutEffect(() => {
    if (!WEB || !isFocused) return;
    const frame = pagerFrameNode.current as unknown as HTMLElement | null;
    if (!frame) return;
    const width = frame.offsetWidth - 2 * PAGE_EDGE;
    if (width <= 0) return;
    if (width !== pagerW) {
      const nextWidth = pagerWidthDamper.current.next(width, pagerW);
      if (nextWidth !== null) {
        if (takeMeasurePass()) setPagerW(nextWidth);
        return;
      }
    }
    const page = pageNodes.current[action] as unknown as HTMLElement | null;
    if (!page) return;
    const height = page.offsetHeight;
    if (height <= 0) return;
    if (height !== pageHeights[action]) {
      if (takeMeasurePass()) setPageHeights(previous => (previous[action] === height ? previous : { ...previous, [action]: height }));
      return;
    }
    const form = formNode.current as unknown as HTMLElement | null;
    const back = pickerNode.current as unknown as HTMLElement | null;
    if (form && form.offsetHeight > 0) setFormHeight(form.offsetHeight);
    if (back && back.offsetHeight > 0) setPickerHeight(back.offsetHeight);
  }, [pagerW, action, pageHeights, isFocused, withdrawInline, transferInline, requestInline, swapInline]);

  useEffect(() => {
    if (!WEB) return;
    if (!isFocused) {
      setHeightMotionReady(false);
      return;
    }
    if (formHeight === undefined || heightMotionReady) return;
    const frame = requestAnimationFrame(() => setHeightMotionReady(true));
    return () => cancelAnimationFrame(frame);
  }, [formHeight, heightMotionReady, isFocused]);

  // The card clips its faces (overflow hidden, height pinned to the active
  // face), yet a browser still scrolls a clipped box to bring a focused
  // descendant into view. Pressing Withdraw did exactly that and slid the tab
  // bar out of the card. A clip box should never scroll, so undo it.
  const hubCardRef = useRef<View>(null);
  useEffect(() => {
    if (!WEB) return;
    const node = hubCardRef.current as unknown as HTMLElement | null;
    if (!node) return;
    const unscroll = () => { if (node.scrollTop !== 0) node.scrollTop = 0; };
    node.addEventListener('scroll', unscroll);
    return () => node.removeEventListener('scroll', unscroll);
  }, []);

  const onTargetHeightRef = useRef(onTargetHeight);
  useLayoutEffect(() => {
    onTargetHeightRef.current = onTargetHeight;
  });
  useEffect(() => {
    // +2 for the card's border, matching its style height below.
    if (WEB && isFocused && cardHeight !== undefined) onTargetHeightRef.current?.(cardHeight + 2);
  }, [cardHeight, isFocused]);

  const [pickerFade] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const reduce = Platform.OS === 'web'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animation = Animated.timing(pickerFade, {
      toValue: pickerOpen ? 1 : 0,
      duration: reduce ? 0 : PICKER_TRANSITION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [pickerOpen, pickerFade]);
  // Any usable account acquired elsewhere in the app closes this picker too.
  const pickerAccountReady = walletConnected || (!isSui && identityMode === 'key');
  useEffect(() => {
    if (pickerAccountReady && pickerOpen) {
      setPickerOpen(false);
      setShowAccountKey(false);
      picker.reset();
      retireUiParamEntry('connect');
    }
  }, [pickerAccountReady, pickerOpen, picker.reset]);
  const frontOpacity = pickerFade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const backOpacity = pickerFade;
  const closePicker = () => {
    // Never gate this on pendingId: a rejected WalletConnect deep-link can
    // leave connectAsync hanging until the proposal expires, which would
    // wedge the back link. Abandoning the attempt is safe — reset() clears
    // the picker, and a late success still closes it via the isConnected
    // effect.
    setPickerOpen(false);
    setShowAccountKey(false);
    picker.reset();
    retireUiParamEntry('connect');
  };

  // The wallet picker lives in the URL (`/?connect=1`, a marked entry):
  // browser back returns to the action form; forward reopens the picker.
  // Escape mirrors the back link.
  // First sync of this mount: used to tell a fresh page load (which must not
  // open the picker) from in-session history navigation (which must).
  const connectParamSeenRef = useRef(false);
  const lastConnectIntentRef = useRef(false);
  const isConnectedRef = useRef(walletConnected);
  isConnectedRef.current = walletConnected;
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const sync = () => {
      const wantsFlip = getUiParam('connect') === '1' && !isConnectedRef.current;
      if (lastConnectIntentRef.current === wantsFlip) return;
      lastConnectIntentRef.current = wantsFlip;
      setPickerOpen(wantsFlip);
      // Notify the parent outside React's state updater, which runs during render.
      if (wantsFlip) onEngage?.();
      else {
        setShowAccountKey(false);
        picker.reset();
      }
    };
    // A FRESH page load must not land on the wallet picker. `connect=1` sticks
    // around in the URL, so reloading (or reopening) a link that still carries it
    // turned the card over to the picker with nobody having asked for it. Drop
    // the stale param on the first sync instead, and let in-session back/forward
    // keep working from there.
    if (!connectParamSeenRef.current) {
      connectParamSeenRef.current = true;
      // Retire it and fall through: with the param gone, the sync below settles
      // the card on the shield face by itself.
      if (getUiParam('connect') === '1') retireUiParamEntry('connect');
    }
    if (getUiParam('connect') === '1' && !isConnectedRef.current) rebaseUiParamEntry('connect');
    sync();
    return subscribeUiUrl(sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'web' || !pickerOpen || typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePicker();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen]);
  useBackHandler(pickerOpen, closePicker);

  const launch = () => {
    // An account-key session covers the relayed EVM actions (withdraw / send /
    // request); shield still needs a wallet and falls through to its own
    // connect gate inside the deposit modal. `walletConnected` is the unified
    // (EVM or Sui) state — a Sui-only user is connected here. The account-key
    // bypass is EVM-ONLY: on active Sui every action needs the dapp-kit Sui
    // account, so a key session without a Sui wallet must still route through
    // the Wallet-Standard connect below instead of opening a dead Sui modal.
    const canLaunchWithAccountKey = !isSui && identityMode === 'key';
    if (!walletConnected && !canLaunchWithAccountKey) {
      if (isStellar) {
        // Active Stellar chain: Freighter, or send the user to get it.
        if (stellarWallet.isAvailable) {
          void stellarWallet.connect();
        } else if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.open('https://www.freighter.app', '_blank', 'noopener');
        }
        return;
      }
      if (isSui) {
        // Active Sui chain: the EVM picker can't connect a Sui wallet — go
        // through the Wallet Standard (Slush-preferring, same as the header).
        const wallet =
          suiWallets.find((w) => /slush/i.test(w.name)) ??
          suiWallets.find((w) => /sui/i.test(w.name)) ??
          suiWallets[0];
        if (wallet) {
          suiConnect({ wallet });
        } else if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.open('https://slush.app', '_blank', 'noopener');
        }
        return;
      }
      picker.reset();
      if (Platform.OS === 'web') {
        // The URL subscriber owns the transition and parent engage signal.
        pushUiParamEntry('connect', '1');
      } else {
        onEngage?.();
        setPickerOpen(true);
      }
      return;
    }
    switch (action) {
      case 'shield': {
        // An OPEN recipient field must hold a usable address before anything
        // launches; a collapsed one means the user's own wallet.
        if (shieldRecipientInvalid) {
          toast({ title: 'Enter the full address to deposit to, or close the field.', variant: 'destructive' });
          return;
        }
        if (shieldRecipientConflict) {
          toast({ title: shieldRecipientConflict, variant: 'destructive' });
          return;
        }
        const shieldFor = shieldRecipientEnabled ? shieldRecipient.trim() : undefined;
        // Desktop: NO modal, ever — the whole deposit runs inside this card
        // with the staged progress panel, straight to confirm. No amount yet
        // just asks for one inline (the card already has the input). Mobile
        // keeps the bottom drawer.
        if (Platform.OS === 'web' && !isSui) {
          if (!amount || !(parseFloat(amount) > 0)) {
            toast({ title: 'Enter an amount to shield first.', variant: 'destructive' });
            return;
          }
          const pool = shieldPool;
          if (!pool) {
            toast({ title: 'No pool configured for this network.', variant: 'destructive' });
            return;
          }
          // Balance gate BEFORE any flow starts: the pay amount is typed in
          // the wallet token, so an over-balance entry can be refused here
          // instead of after route-finding (QA 2026-08-18: 10 USDC typed on a
          // 0-USDC wallet reached 'Finding a route').
          if (walletConnected && !walletBalanceLoading) {
            const held = parseFloat(walletBalanceText) || 0;
            if ((parseFloat(amount) || 0) > held) {
              toast({
                title: `That's more ${displayTokenSymbol(payMeta.symbol)} than your wallet holds on ${getChainConfig(chainId)?.displayName ?? 'this network'} (${held.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${displayTokenSymbol(payMeta.symbol)}).`,
                variant: 'destructive',
              });
              return;
            }
          }
          if (pool.chainId !== chainId && !crossChainShield) {
            // Pool picks switch the chain, so this only happens mid-switch or
            // for a pair LiFi cannot bridge.
            toast({ title: `Switch to ${pool.chainName} to deposit in this pool.`, variant: 'destructive' });
            return;
          }
          if (!crossPayShield) {
            // 1:1 — the typed amount IS the deposit amount.
            startInlineDeposit({ tokenSymbol: pool.symbol, initialAmount: amount, recipientAddress: shieldFor });
            return;
          }
          // Converting deposit: the SDK's flow 1 quotes EXACT-OUT, so hand it
          // the preview's slippage floor as the deposit target — the solved-
          // back pay-token input stays at or under what was typed, and the
          // consent card still shows the exact figures before signing.
          if (!crossPayAllowed) {
            toast({ title: `Converting ${displayTokenSymbol(payMeta.symbol)} isn't available on this network.`, variant: 'destructive' });
            return;
          }
          if (shieldQuote.status !== 'ok' || !shieldQuote.toAmountMin || !payTokenAddr) {
            toast({
              title: shieldQuote.status === 'loading' ? 'Still pricing the conversion. One moment.' : `No conversion route for ${displayTokenSymbol(payMeta.symbol)} here.`,
              variant: 'destructive',
            });
            return;
          }
          // Shave the exact-out target a further 0.75% below the preview's
          // slippage floor: the exact-out solve-back re-adds fees on top of
          // the exact-in estimate, so targeting toAmountMin verbatim asked
          // for MORE pay token than was typed (QA 2026-08-18: typed 10 USDC,
          // route needed 10.045). The consent card still shows exact figures.
          // Net of the destination pool's vetting fee too: the SDK sizes the
          // contract call as deposit + fee, and that total has to fit inside
          // what the executable route guarantees (services/cross-pay-sizing.ts).
          const depositTarget = sizeConvertingDeposit({
            deliverableMin: shieldQuote.toAmountMin,
            vettingFeeBps: vettingFeeBps ?? 100,
          });
          if (depositTarget <= 0n) {
            toast({ title: 'This amount is too small for a bridge route after fees. Try a larger amount.', variant: 'destructive' });
            return;
          }
          startInlineDeposit({
            tokenSymbol: pool.symbol,
            tokenAddress: pool.address,
            // depositTarget is sized from the quote's toAmountMin, so it is in
            // the FUNDING token's units (the underlying for a share pool), not
            // the pool's. Formatting it with the pool's decimals asked for dust.
            initialAmount: formatUnits(depositTarget, shieldFundingUnits?.decimals ?? pool.decimals),
            payTokenAddress: payTokenAddr,
            // A pay token the catalog does not know (a wallet holding, or an
            // address the user pasted). The deposit provider scopes its pay
            // token to getActionableTokens, so without this the pick is refused
            // and then cleared (QA B-c). The hub has already resolved the
            // symbol/decimals, so it vouches for them here.
            ...(extPayToken
              ? {
                  payTokenExternal: {
                    symbol: extPayToken.symbol,
                    address: extPayToken.address,
                    decimals: extPayToken.decimals,
                    isNative: extPayToken.address.toLowerCase() === NATIVE_ASSET_ADDRESS.toLowerCase(),
                    // The chain this metadata was resolved on. The provider
                    // refuses a voucher minted elsewhere rather than trusting a
                    // stale address/decimals pair.
                    sourceChainId: chainId,
                  },
                }
              : {}),
            // Only set when the pool is elsewhere; the deposit flow re-checks
            // routability and falls back to same-chain otherwise.
            ...(crossChainShield ? { poolChainId: pool.chainId, poolVettingFeeBps: vettingFeeBps } : {}),
            // DEV-489: the swap lands as the recipient's deposit (the SDK's
            // swap-and-deposit embeds their depositFor proof).
            recipientAddress: shieldFor,
          });
        } else if (Platform.OS === 'web') {
          startInlineDeposit({ tokenSymbol: tokenMeta.symbol, initialAmount: amount, recipientAddress: shieldFor });
        } else {
          openDepositModal({ tokenSymbol: tokenMeta.symbol, initialAmount: amount || undefined, recipientAddress: shieldFor });
        }
        break;
      }
      case 'withdraw':
        // Locked keystore: ask for the signature on THIS press. An inline open
        // deliberately skips the unlock (so a tab switch can show the form), so
        // without this the press only mounted the flow and the user had to press
        // a second, identical-looking button to be asked to sign in.
        if (sessionLocked) {
          openSeedDerivationModal({
            onSigned: () => openWithdrawModal(undefined, { tokenSymbol: tokenMeta.symbol, amount: amount || undefined, inline: inlineOps }),
          });
          return;
        }
        openWithdrawModal(undefined, { tokenSymbol: tokenMeta.symbol, amount: amount || undefined, inline: inlineOps });
        break;
      case 'send':
        if (sessionLocked) {
          openSeedDerivationModal({
            onSigned: () => openTransferModal({
              ...(isSui ? {} : { tokenSymbol: tokenMeta.symbol as 'ETH' | 'USDC' | 'USDT' }),
              amount: amount || undefined,
              inline: inlineOps,
            }),
          });
          return;
        }
        // The transfer modal forces SUI in Sui mode; only EVM passes a token.
        openTransferModal({
          ...(isSui ? {} : { tokenSymbol: tokenMeta.symbol as 'ETH' | 'USDC' | 'USDT' }),
          amount: amount || undefined,
          inline: inlineOps,
        });
        break;
      case 'swap':
        // Flag+processor gated + EVM-only; the flow re-checks and refuses to
        // open otherwise. Private-only: the output is a new note of your own
        // (a swap that pays a wallet is the Withdraw tab's receive-as).
        {
          const swapRequest = {
            // Address first: ppETH and the legacy ETH pool share the display
            // name "ETH", so a symbol cannot say which of them this is.
            tokenAddress: tokenMetaAddress,
            tokenSymbol: tokenMeta.symbol,
            initialAmount: amount || undefined,
            ...(swapOutToken ? { outputTokenAddress: swapOutToken.address } : {}),
            ...(swapCrossChain ? { destinationChainId: swapDestChainId } : {}),
            // The inline flow takes the recipient from the card's sync; a
            // modal open (no inline host) carries it here.
            ...(!inlineOps && swapRecipientRoute.kind === 'reshield-transfer'
              ? { recipient: swapRecipientRoute.recipient, outputTokenAddress: swapRecipientRoute.outputTokenAddress }
              : {}),
            mode: 'reshield' as const,
            inline: inlineOps,
          };
          // Locked keystore: ask for the signature on THIS press (an inline
          // open skips the unlock so a tab switch can show the form).
          if (inlineOps && sessionLocked) {
            openSeedDerivationModal({ onSigned: () => { openSwapModal(swapRequest); } });
            return;
          }
          openSwapModal(swapRequest);
        }
        break;
      case 'request':
        openRequestPaymentModal({ inline: inlineOps });
        break;
    }
  };

  // The full operation form from the get-go: selecting a tab opens the flow
  // inline immediately when the session can (connected + keys derived).
  // Locked/disconnected sessions keep the simple form; the CTA walks the
  // gates and then lands inline. The previous tab's flow is already closed by
  // the time this runs (the one-flow invariant above handles every way the
  // tab can move), so this only ever opens the
  // flow for the tab that now owns the card.
  // Read current values on watchdog retries too: the user may type or switch
  // assets while a provider is becoming ready.
  const swapRefusedRef = useRef<{ key: string; at: number } | null>(null);
  const autoOpenLatest = useRef({
    amount, tokenSymbol: tokenMeta.symbol, isSui,
    withdrawInline, withdrawIsOpen, withdrawStep, transferInline, transferIsOpen, transferStep, requestInline, requestIsOpen,
    swapInline, swapIsOpen, swapInlineSend, swapAvailable, chainId,
    swapOutAddress: swapOutToken?.address, swapDestChainId, swapCrossChain,
  });
  autoOpenLatest.current = {
    amount, tokenSymbol: tokenMeta.symbol, isSui,
    withdrawInline, withdrawIsOpen, withdrawStep, transferInline, transferIsOpen, transferStep, requestInline, requestIsOpen,
    swapInline, swapIsOpen, swapInlineSend, swapAvailable, chainId,
    swapOutAddress: swapOutToken?.address, swapDestChainId, swapCrossChain,
  };
  useLayoutEffect(() => {
    // An executing swap is NOT txPending (the swap flow has no beginTx), so
    // gate on it here too: a URL-driven tab change during its proving must
    // not mount a second inline flow next to it (two hosts, one id; Kimi bug 1).
    if (!inlineOps || txPending || pickerOpen || swapExecuting) return;
    // An account-key session has no wallet but CAN run the relayed EVM flows.
    // Bailing on `walletConnected` alone meant the inline flow never opened for
    // one, so Withdraw and Send rendered the hub's amount card with no receive
    // side, no recipient field and no exact-amount checkbox — the halves that
    // live in the provider (Pat, 2026-09-01). Same EVM-only reasoning as
    // launch(): shield still needs a wallet and has its own gate, and on Sui a
    // key session must still connect a Sui wallet.
    if (!walletConnected && !(!isSui && identityMode === 'key')) return;
    // Only the focused route opens flows into the shared provider.
    if (!isFocused) return;
    const tick = () => {
      // Live re-check: a timer armed before this route lost focus still fires
      // after the blur, before the effect cleanup runs.
      if (typeof navigation?.isFocused === 'function' && !navigation.isFocused()) return;
      const latest = autoOpenLatest.current;
      // Watchdog retries use the currently selected action and form state.
      if (actionRef.current === 'withdraw' && !latest.withdrawInline && !latest.withdrawIsOpen) {
        openWithdrawModal(undefined, { tokenSymbol: latest.tokenSymbol, amount: latest.withdrawStep === 'success' ? undefined : latest.amount || undefined, inline: true });
      } else if (actionRef.current === 'send' && !latest.transferInline && !latest.transferIsOpen && !latest.swapInlineSend) {
        openTransferModal({
          ...(latest.isSui ? {} : { tokenSymbol: latest.tokenSymbol as 'ETH' | 'USDC' | 'USDT' }),
          amount: latest.transferStep === 'success' ? undefined : latest.amount || undefined,
          inline: true,
        });
      } else if (actionRef.current === 'request' && !latest.requestInline && !latest.requestIsOpen) {
        openRequestPaymentModal({ inline: true });
      } else if (actionRef.current === 'swap' && latest.swapAvailable && !latest.isSui && !latest.swapInline && !latest.swapIsOpen) {
        // The swap flow's slippage / review / result draw under the card; the
        // card owns the pair. Private-only: pinned to reshield.
        const request = {
          tokenSymbol: latest.tokenSymbol,
          initialAmount: latest.amount || undefined,
          ...(latest.swapOutAddress ? { outputTokenAddress: latest.swapOutAddress } : {}),
          ...(latest.swapCrossChain ? { destinationChainId: latest.swapDestChainId } : {}),
          mode: 'reshield' as const,
          inline: true,
        };
        // The flow refuses a request it cannot serve. Some refusals are
        // transient (the provider's chain still catching up after a switch,
        // the gate flipping on), so the same request IS asked again, just not
        // every 600ms: a 3s back-off keeps the warn log quiet without ever
        // leaving the tab flow-less. A changed request is asked at once.
        // Keyed by what decides serviceability: the pair, destination and
        // chain. Not the amount, so typing does not re-ask (and re-log).
        const { initialAmount: _typedAmount, ...keyed } = request;
        const key = JSON.stringify({ chainId: latest.chainId, ...keyed });
        const refused = swapRefusedRef.current;
        if (refused && refused.key === key && Date.now() - refused.at < 3000) return;
        if (!openSwapModal(request)) swapRefusedRef.current = { key, at: Date.now() };
        else swapRefusedRef.current = null;
      }
    };
    // Mount the complete inline form before paint. Delaying the first open
    // exposed a temporary CTA, then an empty portal, then the actual inputs.
    // Keep the idempotent retry for provider readiness changes.
    tick();
    const watchdog = setInterval(tick, 600);
    return () => clearInterval(watchdog);
    // Deliberately NOT keyed on `amount`/token: those sync live below without
    // reopening (which would reset the flow while the user types).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedAction, inlineOps, txPending, pickerOpen, walletConnected, isSui, identityMode, withdrawInline, transferInline, requestInline, swapInline, swapInlineSend, swapStep, swapExecuting, isFocused, navigation]);

  // Signing out returns the card to its visitor face, as the page does with its
  // panels: a settled flow (a success or error panel, a form) no longer belongs
  // to anyone, and the opener above will not replace it while signed out. A
  // flow still in flight is left to finish first. The reset is latched until it
  // can run, so a sign-out seen mid-flight or while unfocused is not lost.
  // Flows close by `isOpen`, not `inlineActive`: mobile shows the success panel
  // in a sheet, which reports as not inline.
  const signedIn = walletConnected || !!sessionAddress;
  const wasSignedInRef = useRef(signedIn);
  const signOutResetPendingRef = useRef(false);
  useEffect(() => {
    if (wasSignedInRef.current && !signedIn) signOutResetPendingRef.current = true;
    if (signedIn) signOutResetPendingRef.current = false;
    wasSignedInRef.current = signedIn;
    // The providers are shared with retained hubs; only the focused one closes.
    if (!signOutResetPendingRef.current || tabsDisabled || !isFocused) return;
    signOutResetPendingRef.current = false;
    setAmounts({});
    setUsdInput('');
    setShieldRecipientOpen(false);
    setShieldRecipient('');
    setSwapRecipientOpen(false);
    setSwapRecipient('');
    if (depositFlow.inlineActive) resetInlineDeposit();
    if (withdrawIsOpen) closeWithdrawModal();
    if (transferIsOpen) closeTransferModal();
    if (requestIsOpen) closePaymentRequestModal();
    if (swapIsOpen) closeSwapModal();
    if (action !== 'shield') router.setParams({ action: 'shield' });
  }, [
    signedIn, tabsDisabled, isFocused, action, router,
    depositFlow.inlineActive, withdrawIsOpen, transferIsOpen, requestIsOpen, swapIsOpen,
    resetInlineDeposit, closeWithdrawModal, closeTransferModal, closePaymentRequestModal, closeSwapModal,
  ]);

  const cardSurface = {
    backgroundColor: colors.cardBackground,
    borderColor: colors.border,
  };

  const renderZone = (a: Action) => {
    const { symbol: pageTargetSymbol, chainId: pageChainId, shielded: pageShielded } = pageFigures[a];
    const pagePool = data.myPools.find((p) => p.name.toUpperCase() === pageTargetSymbol.toUpperCase() && p.chainId === pageChainId);
    const pageBalanceView = balanceDisplay(a === 'withdraw' ? withdrawSpendableExact : pageShielded.exact, pageTargetSymbol, pageChainId, pagePool?.tokenAddress);
    const pagePendingView = balanceDisplay(pagePool?.pendingTokenExact ?? '0', pageTargetSymbol, pageChainId, pagePool?.tokenAddress);
    // The single source for the CTA's dead state. It used to be written twice
    // inline (once for `disabled`, once for the opacity class), which is how a
    // condition can be added to the look and not to the behaviour.
    // Still pricing the conversion: a press could only answer "one moment",
    // so the CTA is dead until the quote lands.
    const shieldPricing = crossPayShield && crossPayAllowed && shieldQuote.status === 'loading';
    const ctaDisabled = ((a === 'withdraw' || a === 'send') && !!amountField.error)
      || (a === 'swap' && (!swapOutToken || swapRecipientBlocks))
      || (a === 'shield' && (shieldRecipientInvalid || shieldCapBlocksDeposit || shieldPricing));
    const compactShield = landing && a === 'shield' && !amount && !shieldRecipientEnabled;
    const active = ACTIONS.find((x) => x.key === a)!;
    // A settling deposit keeps the FORM on screen (input visible, disabled)
    // and swaps only the bottom half (presets/fee/info/CTA) for the progress
    // panel — a full swap left the tall zone mostly empty. A failed tx
    // bounces the provider's step back to the form, restoring the controls.
    const shieldBusy = a === 'shield' && depositFlow.inlineActive && winWidth > 540 && depositFlow.step === 'loading';
    // Withdraw past the form (review/loading): the amount is locked into the
    // quote/proof, so the card stays visible but inert.
    const withdrawBusy = a === 'withdraw' && withdrawInline && (withdrawStep === 'review' || withdrawStep === 'loading');
    // Swap past the form: the pair is frozen in the quote/proof; its review,
    // progress and result draw in the host under the (inert) amount card.
    const swapBusy = a === 'swap' && swapInline && !swapInlineSend && swapStep !== 'input';
    // Send past the form: 'select-notes' IS the form (amount, recipient, note
    // picker); every later step has the amount bound into the proof, so the
    // card stays visible but inert. Same shape as swap. A failed transfer
    // returns the provider to 'review', which is still past the form and still
    // inert on purpose — the way back to the amount is that screen's Back,
    // which sets 'select-notes' and restores the controls.
    const sendBusy = a === 'send' && ((transferInline && transferStep !== 'select-notes')
      // The private swap-send runs under the Send card with the pair and amount
      // the Send form chose; its Edit returns to that form.
      || swapInlineSend);
    const zoneBusy = shieldBusy || withdrawBusy || sendBusy || swapBusy;
    // Is there a portfolio to send someone to after a deposit? Same gate as
    // the header entry, so the receipt never points at a redirect. It also
    // decides which of the receipt's two buttons carries the border.
    const portfolioCtaShown = !isSui;
    const isRequestCard = a === 'request';
    // Whether this face shows the recommended-amount chips (the same test the
    // header slot runs); drives the header's alignment too, since the chips
    // come with a caption line above them.
    // The pager renders every face, but the price and the dollar-mode
    // availability above are the ACTIVE tab's: only that face wears them, or
    // an offscreen Request face on USDC would show a dollar line meant for
    // Shield's ETH.
    const zoneFiatAvailable = a === action && fiatAvailable && (!shareFiatEntry || amountField.usdAvailable);
    const zoneFiatEntry = a === action && fiatEntry && (!shareFiatEntry || amountField.usdAvailable);
    // Send has no chips (Mike, 2026-09-18): a transfer is for the amount
    // someone is owed, not a privacy-shaped round figure.
    const presetsShown = !compactShield && ((a === 'shield' && !shieldBusy) || a === 'withdraw') && !isSui;
    // The grey line under the figure in dollar mode: the token amount, worded
    // the way this face words its asset (a share carries its ≈).
    const fiatTokenLine = a === 'shield'
      ? `${amount || '0'} ${displayTokenSymbol(payMeta.symbol)}`
      : a === 'request'
        ? `${requestAmount || '0'} ${isShareSymbol(requestToken.symbol) ? requestToken.symbol : displayTokenSymbol(requestToken.symbol)}`
        : `${amountField.value || '0'} ${amountField.symbol}`;
    // A created request is frozen into its payload and its pay link: the figure
    // stays visible but inert. The PILL stays live — switching the token is the
    // documented way back to the form.
    const requestFrozen = isRequestCard && requestCreated;
    // The overlay owns the form while it is up (a re-issue, or ?modal=request):
    // the card behind shows the same figures but cannot edit them.
    const requestOverlayOwns = isRequestCard && requestIsOpen && !requestInline;
    // The amount presets, shared by Shield / Withdraw / Send. Built here so
    // the header can caption them without duplicating the chip. In dollar
    // mode a chip reads as dollars but still fills the token preset, which
    // the dollar text then follows.
    const presetChips = (a === 'shield' ? shieldPresets : withdrawPresets).map((preset) => {
      const activePreset = a === 'withdraw' && isShareSymbol(tokenMeta.symbol) ? amountField.value === preset : amount === preset;
      // Withdraw: a preset above the spendable ceiling is greyed
      // and answers a tap with the ceiling instead of filling an
      // amount the form would only reject (QA 2026-09-18). An
      // unresolved ceiling leaves the chips as they were.
      const outOfReach = a === 'withdraw' && !withdrawBalanceBlocked && withdrawMaxWei !== null
        && (amountField.presetExceedsMax(preset)
          ?? presetExceedsWithdrawMax(preset, withdrawMaxWei, tokenMeta.decimals));
      return (
        <Pressable
          key={preset}
          accessibilityState={{ disabled: outOfReach || (a === 'withdraw' && withdrawBalanceBlocked) }}
          disabled={a === 'withdraw' && withdrawBalanceBlocked}
          onPress={() => {
            if (outOfReach && withdrawMaxWei !== null) {
              toast({ title: `You can withdraw up to ${spendableBalanceLabel(formatUnits(withdrawMaxWei, tokenMeta.decimals), tokenMeta.symbol, () => balanceDisplay(formatUnits(withdrawMaxWei, tokenMeta.decimals), tokenMeta.symbol, chainId).text)}.`, variant: 'warning' });
              return;
            }
            const next = a === 'withdraw' ? amountField.toShares(preset) : preset;
            setAmount(next);
            if (withdrawInline) pushWithdrawAmount(next);
            else if (transferInline) pushTransferAmount(next);
          }}
          // nw-keep(data-color): active chip fill is a runtime tint token at ~13% alpha; minWidth keeps 1- and 3-digit chips the same box
          style={[{ minWidth: 34 }, activePreset ? { backgroundColor: `${colors.tint}22` } : null]}
          // bg-card-background, not transparent: inside the grey
          // amount card a border-border-light-only chip disappears
          // (the old row sat on the white page).
          className={`items-center rounded-[6px] border px-[7px] py-[3px] ${activePreset ? 'border-tint' : 'border-border bg-card-background'} ${outOfReach ? 'opacity-40' : ''}`}
        >
          <Text className={`text-[11px] font-pp-regular ${activePreset ? 'text-tint' : outOfReach ? 'text-text-secondary' : 'text-text'}`}>
            {zoneFiatEntry ? usdChipLabel(preset, fiatPrice) : a === 'withdraw' && isShareSymbol(tokenMeta.symbol) ? `${preset} ${amountField.symbol}` : preset}
          </Text>
        </Pressable>
      );
    });
    return (
      <>
      {a === 'shield' && depositFlow.inlineActive && winWidth > 540 && depositFlow.step === 'success' ? (
        /* Inline deposit success (desktop, no modal): a minimal settled
           state. All flow state lives in the deposit provider. Same
           min-height as the form zone so the card never jumps. */
        /* nw-keep(measured-or-inset): same shared zone height as the form above */
        <View className="justify-center gap-[10px] rounded-inner bg-background-secondary px-[16px] py-[18px]" style={{ minHeight: HUB_ZONE_MIN_H }}>
              <Text className="text-center font-pp-sans-semi-bold text-[15px] text-text">
                Deposit submitted
              </Text>
              <Text className="text-center font-pp-sans text-[13px] leading-[19px] text-text-secondary">
                {depositFlow.crossChainDestination && !depositFlow.recipientAddress
                  ? `${depositFlow.depositAmountFormatted} is on its way to ${depositFlow.crossChainDestination}. It shows up in your ${depositFlow.crossChainDestination} balance once it arrives, then needs approval.`
                  : depositFlow.recipientAddress
                    // An unregistered recipient discovers NOTHING: the deposit
                    // announced no note, so the link below is the only way they
                    // ever see this money. Promising a next-sync discovery here
                    // is the one sentence that would make a sender close this
                    // card and lose it.
                    ? depositFlow.claimReceiptUrl
                      ? `${depositFlow.depositAmountFormatted} ${depositFlow.crossChainDestination ? `is on its way to ${depositFlow.crossChainDestination}` : 'was shielded'} for ${depositFlow.recipientAddress.slice(0, 6)}...${depositFlow.recipientAddress.slice(-4)}. They have not set up Privacy Pools yet, so send them the claim link below.`
                      : `${depositFlow.depositAmountFormatted} ${depositFlow.crossChainDestination ? `is on its way to ${depositFlow.crossChainDestination}` : 'was shielded'} for ${depositFlow.recipientAddress.slice(0, 6)}...${depositFlow.recipientAddress.slice(-4)}. They can discover it on their next sync. Then it needs approval.`
                    : `${depositFlow.depositAmountFormatted} is pending approval. Spendable once approved.`}
              </Text>
              {depositFlow.claimReceiptUrl ? (
                /* The claim link leads this card (DEV-491); leaving it
                   uncopied asks first (depositFlow.guardClaimLeave). */
                <View className="w-full gap-[8px] rounded-inner border border-border bg-card-background p-[12px]">
                  <Text className="text-center font-pp-sans-medium text-[13px] leading-[19px] text-text">
                    {CLAIM_LINK_INSTRUCTION}
                  </Text>
                  <Text numberOfLines={1} className="text-center font-pp-sans text-[12px] text-text-secondary" testID="hub-claim-link-preview">
                    {previewNoteReceiptUrl(depositFlow.claimReceiptUrl)}
                  </Text>
                  <Pressable
                    className="w-full items-center justify-center rounded-inner bg-button-primary py-[14px] active:bg-button-primary-pressed"
                    testID="hub-copy-claim-link"
                    onPress={() => {
                      void (async () => {
                        if (await depositFlow.copyClaimLink()) return;
                        toast({
                          title: 'Could not copy. The link is also on the transaction row, under Recover claim link.',
                          variant: 'destructive',
                        });
                      })();
                    }}
                  >
                    <Text className="font-pp-sans-semi-bold text-[14px] text-button-primary-text">
                      {depositFlow.claimLinkCopied ? 'Copied ✓' : 'Copy claim link'}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
              {depositFlow.stellarLabelRetry ? <StellarLabelRetryNotice retry={depositFlow.stellarLabelRetry.retry} /> : null}
              {/* No redemption line here. It describes what happens at WITHDRAW
                  time, which is where the withdraw card already says it
                  (shareRedemptionDisclosure), and on a deposit receipt it read
                  as a condition on the deposit (Nathaniel, QA 2026-09-21). */}
              {/* Live bridge state, polled from LiFi. Without it the card above
                  is the last word the user ever gets on a transfer that takes
                  minutes. */}
              {depositFlow.bridgeProgress ? (
                <Text
                  className={`text-center font-pp-sans text-[12px] leading-[17px] ${
                    depositFlow.bridgeProgress.tone === 'failed'
                      ? 'text-[#E53935]'
                      : depositFlow.bridgeProgress.tone === 'done'
                        ? 'text-success'
                        : 'text-text-muted'
                  }`}
                >
                  {depositFlow.bridgeProgress.text}
                </Text>
              ) : null}
              {depositFlow.bridgeProgress?.explorerUrl ? (
                <View className="flex-row items-center justify-center gap-[6px]">
<Pressable
                  className="items-center py-[2px]"
                  onPress={() => Linking.openURL(depositFlow.bridgeProgress!.explorerUrl!)}
                >
                  <Text className="font-pp-sans-medium text-[13px] text-primary">Track transfer ↗</Text>
                </Pressable>
                  <ExplorerPrivacyHint explorerName={explorerNameFromUrl(depositFlow.bridgeProgress?.explorerUrl)} />
                </View>
              ) : null}
              {/* While the bridge runs: LI.FI Scan for the source tx, so a
                  slow delivery can be watched rather than feared. */}
              {depositFlow.bridgeProgress?.tone === 'pending' && depositFlow.bridgeProgress.lifiScanUrl ? (
                <View className="flex-row items-center justify-center gap-[6px]">
<Pressable
                  className="items-center py-[2px]"
                  onPress={() => Linking.openURL(depositFlow.bridgeProgress!.lifiScanUrl!)}
                  testID="bridge-lifi-scan-link"
                >
                  <Text className="font-pp-sans-medium text-[13px] text-primary">Track on LI.FI Scan ↗</Text>
                </Pressable>
                  <ExplorerPrivacyHint explorerName={explorerNameFromUrl(depositFlow.bridgeProgress?.lifiScanUrl)} />
                </View>
              ) : null}
              {depositFlow.explorerUrl ? (
                <View className="flex-row items-center justify-center gap-[6px]">
<Pressable className="items-center py-[2px]" onPress={() => Linking.openURL(depositFlow.explorerUrl)}>
                  <Text className="font-pp-sans-medium text-[13px] text-primary">View transaction ↗</Text>
                </Pressable>
                  <ExplorerPrivacyHint explorerName={explorerNameFromUrl(depositFlow.explorerUrl)} />
                </View>
              ) : null}
              {/* One primary, and it is the way onward: the Portfolio page is
                  the balances-and-positions dashboard (Nathaniel, QA
                  2026-09-04: "should have a button to go to dashboard"). It
                  carries the border; "New deposit" and "View transaction" are
                  text links beside it. Before this all three read alike and
                  the bordered one was "New deposit", so the loudest thing on a
                  receipt was starting over (Nathaniel, QA 2026-09-21).
                  Where the portfolio gate is off (Sui, or the flag) there is
                  no dashboard to send anyone to, so "New deposit" takes the
                  border back rather than leaving the card with no primary. */}
              <Pressable
                className={portfolioCtaShown
                  ? 'items-center py-[2px]'
                  : 'items-center rounded-inner border border-border py-[12px] active:bg-background-secondary'}
                onPress={() => depositFlow.guardClaimLeave(() => {
                  resetInlineDeposit();
                  setAmount('');
                  refetchWalletBalance();
                })}
              >
                <Text className={portfolioCtaShown
                  ? 'font-pp-sans-medium text-[13px] text-primary'
                  : 'font-pp-sans-semi-bold text-[14px] text-text'}>
                  New deposit
                </Text>
              </Pressable>
              {portfolioCtaShown ? (
                <Pressable
                  className="items-center rounded-inner border border-border py-[12px] active:bg-background-secondary"
                  onPress={() => depositFlow.guardClaimLeave(() => router.push('/portfolio'))}
                  testID="hub-deposit-success-portfolio"
                >
                  <Text className="font-pp-sans-semi-bold text-[14px] text-text">Go to portfolio</Text>
                </Pressable>
              ) : null}
        </View>
      ) : (
      /* The zone hugs its content (the equal-height-across-tabs requirement
         was dropped 2026-08-18): the CTA sits right below the last row. */
      <View className="gap-[16px]">
      {/* While an operation settles the card stays visible but inert. */}
        <View pointerEvents={zoneBusy ? 'none' : 'auto'} className={`${tight ? 'gap-[10px] py-[14px]' : 'gap-[14px] py-[20px]'} rounded-inner border border-border-light bg-surface-raised px-[16px]`}>
          {/* With chips the right slot is two lines (caption + chips): the
              label sits on the chip line, not centred between the two. */}
          <View className={`flex-row flex-wrap ${presetsShown ? 'items-end' : 'items-center'} justify-between gap-[8px]`}>
            <Text className="font-pp-sans-medium text-[14px] text-text-secondary">
              {a === 'shield' ? 'Shield' : a === 'withdraw' ? 'Withdraw' : a === 'swap' ? 'You swap' : a === 'request' ? 'Request' : 'Amount to send'}
            </Text>
            <View className="flex-row flex-wrap items-center justify-end gap-[6px] shrink">
              {/* EVM amount tabs (2026-08-18 layout): the presets shrink into
                  the header slot; the selector pill rides the amount row
                  below, aligned with the figure. Swap has no presets. */}
              {compactShield ? null : presetsShown ? (
                // "Recommended amounts" caption over the chips (Mike,
                // 2026-09-18): the chips are privacy suggestions, not a
                // keypad, and nothing said what they were. The why is one
                // hover away on the glyph.
                <View className="items-end gap-[3px]">
                  <View className="flex-row items-center gap-[3px]">
                    <Text className="font-pp-sans text-[10.5px] text-text-muted">Recommended amounts</Text>
                    <HoverHint
                      hint="Blend into the crowd smoothly by using a recommended amount."
                      testID="hub-recommended-amounts-hint"
                    >
                      {/* nw-keep(data-color): glyph colour is a runtime theme token (vector-icon sink) */}
                      <Ionicons name="information-circle-outline" size={12} color={colors.textMuted} />
                    </HoverHint>
                  </View>
                  <View className="flex-row flex-wrap items-center justify-end gap-[6px]">
                    {presetChips}
                  </View>
                </View>
              ) : (a === 'swap' || a === 'request' || a === 'send') && !isSui ? null : tokens.map((t) => {
                const selected = t.symbol === tokenMeta.symbol;
                const h = TokenHues[colorScheme][t.symbol] ?? TokenHues[colorScheme].ETH;
                return (
                  <Pressable
                    key={t.symbol}
                    onPress={() => {
                      if (withdrawInline && withdrawStep === 'loading') return;
                      setToken(t.symbol);
                      setAmount((a) => sanitizeAmountInput(a, t.decimals));
                      // Inline flows re-open under the new token (their token
                      // switch resets quotes/consent the same way).
                      if (withdrawInline) {
                        openWithdrawModal(undefined, { tokenSymbol: t.symbol, amount: amount || undefined, inline: true });
                      } else if (transferInline && !isSui) {
                        openTransferModal({ tokenSymbol: t.symbol as 'ETH' | 'USDC' | 'USDT', amount: amount || undefined, inline: true });
                      }
                    }}
                    className="flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px]"
                    // nw-keep(data-color): asset tint background with the shared neutral control border
                    style={{
                      backgroundColor: selected ? h.bg : 'transparent',
                      borderColor: colors.border,
                    }}
                  >
                    <TokenMark symbol={t.symbol} size={14} />
                    {/* nw-keep(data-color): selected pill text uses the runtime hue; unselected falls to the theme token */}
                    <Text className="font-pp-sans-semi-bold text-[12px]" style={{ color: selected ? h.fg : colors.textSecondary }}>
                      {a === 'withdraw' || a === 'send' || a === 'swap' ? poolDisplayLabel(t.symbol, chainId) : displayTokenSymbol(t.symbol)}
                    </Text>
                  </Pressable>
                );
              })}
              {/* Sui shield keeps the '•••' door to the sheet (EVM shield's
                  selector pill on the amount row replaces it). */}
              {a === 'shield' && isSuiChain && (
                <Pressable
                  onPress={() => setTokenSheetOpen(true)}
                  accessibilityLabel="All assets"
                  className="flex-row items-center rounded-pill border px-[10px] py-[5px]"
                  // nw-keep(data-color): unselected pill border matches the token pills
                  style={{ borderColor: colors.border }}
                >
                  {/* nw-keep(data-color): runtime theme token */}
                  <Text className="font-pp-sans-semi-bold text-[12px]" style={{ color: colors.textSecondary }}>
                    •••
                  </Text>
                </Pressable>
              )}
            </View>
          </View>

          <View className="flex-row items-center justify-between gap-[8px]">
          {zoneFiatEntry ? (
            <Text testID="hub-fiat-prefix" className={`py-[2px] font-pp-sans-bold ${heroText} tracking-[-1px] text-text-secondary`}>$</Text>
          ) : null}
          <TextInput
            value={zoneFiatEntry ? shareFiatEntry ? amountField.usdValue : usdInput : isRequestCard ? requestAmount : amountField.value}
            onChangeText={(text) => {
              // Request: the provider owns the figure (it is the value the
              // created payload carries), so push instead of storing a second
              // copy here. It sanitises with the REQUEST token's decimals —
              // payMeta is the hub's pool asset and would be the wrong scale.
              // Dollar mode: the keystroke is dollars; the flow's amount is
              // the token it buys at the current price, pushed wherever a
              // token keystroke would go.
              if (zoneFiatEntry) {
                if (shareFiatEntry) {
                  const shares = amountField.toShares(text, 'usd');
                  setAmount(shares);
                  if (withdrawInline) pushWithdrawAmount(shares);
                  else if (transferInline) pushTransferAmount(shares);
                  return;
                }
                const usd = sanitizeUsdInput(text);
                const next = usdToTokenAmount(usd, fiatPrice, fiatDecimals);
                fiatDerived.current = { amount: next, price: fiatPrice };
                setUsdInput(usd);
                if (isRequestCard) { syncRequestForm({ amount: next }); return; }
                setAmount(next);
                if (withdrawInline) pushWithdrawAmount(next);
                else if (transferInline) pushTransferAmount(next);
                return;
              }
              if (isRequestCard) { syncRequestForm({ amount: text }); return; }
              const shares = a === 'shield' ? text : amountField.toShares(text);
              setAmount(sanitizeAmountInput(shares, payMeta.decimals));
              // Inline flows still receive exact shares, never displayed text.
              if (withdrawInline) pushWithdrawAmount(shares);
              else if (transferInline) pushTransferAmount(shares);
            }}
            testID="hub-amount-input"
            // React does not deliver onBlur when reconciliation REMOVES a
            // focused input (a deposit-success swap, a resize that changes
            // which pages exist). Without this the page would stay in typing
            // mode for the rest of the visit. A stable ref callback is the
            // node's own lifecycle: React calls it with null exactly once, on
            // unmount, so an input that dies focused still reports its blur.
            ref={amountFieldRef}
            onFocus={() => { amountFieldFocused.current = true; onEngage?.(); onInputFocus?.(); }}
            onBlur={() => { amountFieldFocused.current = false; onInputBlur?.(); setCtaRevealTick((n) => n + 1); }}
            placeholder="0"
            // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
            placeholderTextColor={colors.textMuted}
            keyboardType="numeric"
            editable={!zoneBusy && !requestFrozen && !requestOverlayOwns}
            onLayout={(e) => {
              const w = Math.round(e.nativeEvent.layout.width);
              setAmountFieldWidths((m) => (m[a] === w ? m : { ...m, [a]: w }));
            }}
            className={`min-w-0 flex-1 py-[2px] font-pp-sans-bold ${heroText} tracking-[-1px] text-text`}
            // nw-keep(platform-css): web-only focus-ring removal (outlineStyle) — null on native
            // nw-keep(measured-or-inset): font size shrinks to the measured field width for long figures
            style={[WEB_NO_OUTLINE, {
              fontSize: fitAmountFontSize(
                zoneFiatEntry ? shareFiatEntry ? amountField.usdValue : usdInput : isRequestCard ? requestAmount : amountField.value,
                amountFieldWidths[a] ?? 0,
                tight ? 34 : 44,
              ),
            }]}
          />
          {/* Selector pill on the amount row, aligned with the figure
              (2026-08-18 layout): withdraw/send/swap = the source POOL
              (chain-grouped sheet); shield = the PAY token (Alchemy-fed
              sheet). */}
          {(a === 'withdraw' || a === 'send' || a === 'swap') && !isSui ? (
            <Pressable
              onPress={() => { setPoolSheetMode(a as 'withdraw' | 'send' | 'swap'); setPoolSheetOpen(true); }}
              accessibilityRole="button"
              accessibilityLabel={`${a === 'withdraw' ? 'Withdraw from' : a === 'send' ? 'Send from' : 'Swap from'} pool: ${poolDisplayLabel(tokenMeta.symbol, chainId)} on ${getChainConfig(chainId)?.displayName ?? ''}`}
              testID="hub-withdraw-pool"
              className="flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px]"
              // nw-keep(data-color): asset tint background with the shared neutral control border
              style={{ backgroundColor: hue.bg, borderColor: colors.border }}
            >
              {/* Symbol only: the chain lives in the icon's badge (bigger mark
                  = bigger badge); the full pool/chain wording stays in the
                  accessibility label. */}
              <TokenNetworkIcon symbol={tokenMeta.symbol} size={28} badgeSize={16} badgeTestnetLabel={false} chainId={chainId} />
              {/* nw-keep(data-color): per-asset runtime hue */}
              <Text className="font-pp-sans-semi-bold text-[15px]" style={{ color: hue.fg }}>
                {amountField.symbol}
              </Text>
              {/* nw-keep(data-color): caret color is a runtime theme token (vector-icon sink) */}
              <Ionicons name="chevron-down" size={14} color={colors.text} />
            </Pressable>
          ) : a === 'shield' && !shieldBusy && !isSui ? (
            <Pressable
              onPress={() => setTokenSheetOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`Pay token: ${displayTokenSymbol(payMeta.symbol)}`}
              testID="hub-shield-pay-token"
              className="flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px]"
              // nw-keep(data-color): asset tint background with the shared neutral control border
              style={{
                backgroundColor: (TokenHues[colorScheme][payMeta.symbol] ?? TokenHues[colorScheme].ETH).bg,
                borderColor: colors.border,
              }}
            >
              <TokenNetworkIcon symbol={payMeta.symbol} size={28} badgeSize={16} badgeTestnetLabel={false} chainId={chainId} logoUri={payMeta.logoUrl} />
              {/* nw-keep(data-color): pill text uses the runtime per-asset hue */}
              <Text className="font-pp-sans-semi-bold text-[15px]" style={{ color: (TokenHues[colorScheme][payMeta.symbol] ?? TokenHues[colorScheme].ETH).fg }}>
                {displayTokenSymbol(payMeta.symbol)}
              </Text>
              {/* nw-keep(data-color): caret color is a runtime theme token (vector-icon sink) */}
              <Ionicons name="chevron-down" size={14} color={colors.text} />
            </Pressable>
          ) : a === 'request' && !isSui ? (
            // Sui/Stellar: the header chip names the one token already, and
            // this picker was inert there, so showing both read as a duplicate.
            <Pressable
              onPress={isSui || requestOverlayOwns ? undefined : () => setRequestSheetOpen(true)}
              disabled={isSui || requestOverlayOwns}
              accessibilityRole="button"
              accessibilityLabel={`Request in ${displayTokenSymbol(requestToken.symbol)}`}
              testID="hub-request-token"
              className="flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px]"
              // nw-keep(data-color): asset tint background with the shared neutral control border
              style={{
                backgroundColor: (TokenHues[colorScheme][requestToken.symbol] ?? TokenHues[colorScheme].ETH).bg,
                borderColor: colors.border,
              }}
            >
              <TokenNetworkIcon symbol={requestToken.symbol} size={28} badgeSize={16} badgeTestnetLabel={false} chainId={requestToken.chainId} />
              {/* nw-keep(data-color): pill text uses the runtime per-asset hue */}
              <Text className="font-pp-sans-semi-bold text-[15px]" style={{ color: (TokenHues[colorScheme][requestToken.symbol] ?? TokenHues[colorScheme].ETH).fg }}>
                {isShareSymbol(requestToken.symbol) ? requestToken.symbol : displayTokenSymbol(requestToken.symbol)}
              </Text>
              {/* Sui requests are always native SUI (the create path emits
                  0x2::sui::SUI): no sheet, so no caret. */}
              {isSui ? null : (
                /* nw-keep(data-color): caret color is a runtime theme token (vector-icon sink) */
                <Ionicons name="chevron-down" size={14} color={colors.text} />
              )}
            </Pressable>
          ) : null}
          </View>

          {/* The dollar line under the figure (Mike, 2026-09-18): a non-
              stablecoin asset shows the amount's dollar value in grey;
              tapping it swaps the two so dollars are typed and the token
              amount becomes the grey line. Stablecoins skip it, their figure
              already reads as dollars. Hidden wherever the input is inert
              (a settling flow, a created request) and on the compact
              landing face. */}
          {zoneFiatAvailable && !compactShield && !zoneBusy && !requestFrozen && !requestOverlayOwns ? (
            <Pressable
              onPress={isShareSymbol(fiatAsset) && !shareFiatEntry ? undefined : () => setFiatMode((m) => !m)}
              accessibilityRole="button"
              accessibilityLabel={fiatMode ? 'Enter the amount in tokens' : 'Enter the amount in dollars'}
              hitSlop={6}
              testID="hub-fiat-toggle"
              className="-mt-[8px] flex-row items-center gap-[4px] self-start"
            >
              <Text className="font-pp-mono text-[13px] text-text-muted">
                {zoneFiatEntry ? fiatTokenLine : formatUsdLabel(isShareSymbol(fiatAsset) ? shareFiatEntry ? amountField.usdValue : String(balanceDisplay(activeAmountText || '0', fiatAsset, chainId).usd) : usdInput)}
              </Text>
              {/* nw-keep(data-color): swap glyph colour is a runtime theme token (vector-icon sink) */}
              <Ionicons name="swap-vertical" size={12} color={colors.textMuted} />
            </Pressable>
          ) : null}

          {a === action && (a === 'withdraw' || a === 'send') && amountField.error ? (
            <Text className="font-pp-sans text-[12px] text-danger">{amountField.error}</Text>
          ) : null}
          {/* flex-NOwrap + min-w-0 on the right text: wrapping would grow the
              card (both reviews reproduced it with long balance+pending at
              390px. NumberOfLines maps to nowrap, so without min-w-0 the
              text's min-content width forbids shrinking and forces a wrap). */}
          {/* flex-NOwrap + min-w-0 on the right text: wrapping would grow the
              card (both reviews reproduced it with long balance+pending at
              390px. NumberOfLines maps to nowrap, so without min-w-0 the
              text's min-content width forbids shrinking and forces a wrap). */}
          {/* No balance row on Request: the amount is what someone ELSE pays,
              so there is nothing to max, and fillMax would seed the
              requester's own shielded figure. */}
          {a !== 'request' && !compactShield ? (
          <View className="flex-row flex-nowrap items-center justify-between gap-[8px]">
            {/* Tapping the balance fills the input with the max amount. */}
            <Pressable
              onPress={stellarLocked && a !== 'shield' ? unlockStellar : a === 'withdraw' && withdrawBalanceUnavailable ? retrySpendability : fillMax}
              disabled={a === 'withdraw' && withdrawBalanceLoading}
              accessibilityRole="button"
              accessibilityState={{ disabled: a === 'withdraw' && withdrawBalanceLoading }}
              hitSlop={6}
              className="flex-row items-baseline gap-[12px]"
            >
              <Text className="font-pp-sans text-[12.5px] text-text-secondary">
                {/* Withdraw waits on the association set: until it answers, the
                    figure is not provably spendable, so say loading instead of
                    presenting a number tap-to-max would then reject. */}
                {a === 'shield'
                  ? 'Wallet balance'
                  : a === 'withdraw' && withdrawBalanceUnavailable
                    ? 'Shielded balance unavailable'
                    : a === 'withdraw' && withdrawBalanceLoading
                      ? 'Loading shielded balance…'
                      : 'Shielded balance'}
              </Text>
              <Text className="font-pp-mono text-[12.5px] text-primary">
                {a === 'shield'
                  ? (walletBalanceLoading
                    ? '—'
                    // walletBalanceText is the PAY token's balance (formatted with
                    // payMeta.decimals), so it wears payMeta's symbol: an Alchemy-
                    // picked pay token is not the card token (audit, 2026-08-29).
                    : `${formatTokenBalance(parseFloat(walletBalanceText) || 0, displayTokenSymbol(payMeta.symbol))} ${displayTokenSymbol(payMeta.symbol)}`)
                  : stellarLocked
                    ? 'Sign in'
                  : a === 'withdraw'
                    ? (withdrawBalanceUnavailable
                      ? 'Retry'
                      : withdrawBalanceLoading
                        ? '—'
                        : spendableBalanceLabel(withdrawSpendableExact, pageTargetSymbol, () => pageBalanceView.text))
                    : (poolsLoading
                      ? '—'
                      : pageBalanceView.text)}
              </Text>
            </Pressable>
            {a !== 'shield' && !poolsLoading && !stellarLocked && !(a === 'withdraw' && withdrawBalanceBlocked) ? <ShareCountHint hint={pageBalanceView.hint} /> : null}
            {a === 'shield' ? (
              // The other side of the same row: what is ALREADY shielded, so
              // depositing doesn't require opening My balances to know where
              // you stand. One line, shrink-to-fit — the row must not wrap,
              // because wrapping would grow the card. Pending is NOT inline:
              // wallet Balance + Shielded + "+0.5 USDC pending" overloaded the
              // row and the suffix truncated to "p…" (Pat, 2026-09-02). It is a
              // hover/press hint on the Shielded figure instead, flagged by a
              // small amber dot so there is something to hover.
              <HoverHint
                hint={!poolsLoading ? [pageBalanceView.hint, pageShielded.pending > 0 ? `+${pagePendingView.text} pending. ${pagePendingView.hint ?? ''}` : null].filter(Boolean).join(' ') || null : null}
                testID="hub-shielded-pending-hint"
              >
                <Text
                  numberOfLines={1}
                  testID="hub-shielded-inline"
                  className="min-w-0 shrink font-pp-sans text-[12.5px] text-text-secondary"
                >
                  Shielded{' '}
                  <Text className="font-pp-mono text-[12.5px] text-text">
                    {/* The figure is looked up by the POOL asset (pageTargetSymbol),
                        so it must be labelled with it too. Labelling it with the
                        pay token read "0 ETH" for a USDC pool paid in ETH
                        (Pat, 2026-08-29). */}
                    {stellarLocked
                      ? 'sign in to view'
                      : poolsLoading
                      ? '—'
                      : pageBalanceView.text}
                  </Text>
                  {!poolsLoading && pageBalanceView.hint ? <Text className="text-text-muted">{' ⓘ'}</Text> : null}
                  {!poolsLoading && pageShielded.pending > 0 ? (
                    // The affordance: a pending amount exists, hover or tap for it.
                    <Text className="text-[12.5px] text-warning">{' ●'}</Text>
                  ) : null}
                </Text>
              </HoverHint>
            ) : pageShielded.pending > 0 ? (
              <View className="flex-row items-center gap-[4px]">
                <Pill tone="warning" label={`+${pagePendingView.text} pending`} />
                <ShareCountHint hint={pagePendingView.hint} />
              </View>
            ) : null}
          </View>
          ) : null}

        </View>

      {/* Signed out there is no inline form to carry the explainer (the
          provider's own lives in its request block), so the card says it. The
          gate is walletConnected, not !requestInline: the auto-open effect
          bails when disconnected, and gating on requestInline would flash this
          while the inline provider is becoming ready. */}
      {a === 'request' && !walletConnected ? (
        <View className="gap-[6px] rounded-inner bg-background-secondary px-[16px] py-[26px]">
          <Text className="font-pp-sans-semi-bold text-[17px] text-text">Get paid privately</Text>
          <Text className="font-pp-sans text-[13px] leading-[19px] text-text-secondary">
            Share a request link. The payer never sees your balance or history.
          </Text>
        </View>
      ) : null}

      {a === 'request' && walletConnected && !isSui && receivePartial && canFinishSetup ? (
        <View
          testID="request-finish-setup-warning"
          className="flex-row items-center gap-[8px] rounded-inner border border-warning bg-warning-bg px-[12px] py-[10px]"
        >
          <Text className="min-w-0 flex-1 font-pp-sans text-[12px] leading-[17px] text-text">{RECEIVE_WARNING}</Text>
          <Pressable
            className="rounded-control bg-button-primary px-[12px] py-[6px]"
            accessibilityRole="button"
            onPress={() => openFinishSetup()}
          >
            <Text className="font-pp-sans-semi-bold text-[12px] text-button-primary-text">{FINISH_SETUP_PRIMARY}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Quick presets — the modal's amounts, native vs stable scale. EVM
          shield/withdraw moved theirs into the card header (2026-08-18
          layout); this row remains for Send and Sui shield. */}
      {((a === 'shield' && !shieldBusy) || a === 'send') && isSui && (
        <View className="flex-row flex-wrap gap-[6px]">
          {(isStellar ? QUICK_AMOUNTS_XLM : tokenMeta.symbol === 'USDC' || tokenMeta.symbol === 'USDT' ? QUICK_AMOUNTS_STABLE : QUICK_AMOUNTS_NATIVE).map((preset) => {
            const activePreset = amount === preset;
            return (
              <Pressable
                key={preset}
                onPress={() => {
                  setAmount(preset);
                  // The open inline flow follows the preset like typed input.
                  if (transferInline) pushTransferAmount(preset);
                }}
                // nw-keep(data-color): active chip fill is a runtime tint token at ~13% alpha (matches the withdraw chips);
                // minWidth is runtime so 1- and 3-digit chips render the same box
                style={[{ minWidth: 50 }, activePreset ? { backgroundColor: `${colors.tint}22` } : null]}
                className={`items-center px-[12px] py-[6px] rounded-[8px] border ${activePreset ? 'border-tint' : 'border-border-light bg-transparent'}`}
              >
                <Text className={`text-[13px] font-pp-regular ${activePreset ? 'text-tint' : 'text-text'}`}>
                  {preset}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* Destination pool as the OUT card (Uniswap pair, 2026-08-18): the
          amount card above is the pay side, this is what lands in the pool,
          and the arrow straddling the seam says which way the value moves.
          Picking a pool on another chain switches the chain first. */}
      {a === 'shield' && !shieldBusy && !isSui && shieldPool && (
        <>
          {/* nw-keep(data-color): arrow glyph color is a runtime theme token (vector-icon sink) */}
          {!compactShield && <PairArrow color={colors.text} icon="shield-outline" />}
          <View className={`${outCard} rounded-inner bg-background-secondary`}>
            {/* Header mirrors the pay card: the label sits top-right (where
                the presets sit above), the pill rides the figure row below. */}
            {!compactShield && <View className="flex-row flex-wrap items-center justify-end gap-[8px]">
              <Text className="font-pp-sans-medium text-[12px] text-text-muted">{shieldDestinationLabel(shieldPool)}</Text>
            </View>}
            <View className="flex-row items-center justify-between gap-[8px]">
              {/* What lands in the pool: the entered amount 1:1; a live quote
                  estimate when the pay token converts; an honest dash while
                  the figure is unknown. */}
              <Text className={compactShield ? 'min-w-0 flex-1 font-pp-sans-medium text-[14px] text-text-secondary' : `min-w-0 flex-1 py-[2px] font-pp-sans-bold ${outText} tracking-[-1px] text-text-muted`} numberOfLines={1}>
                {compactShield ? shieldDestinationLabel(shieldPool) : crossPayShield
                  ? (shieldQuote.status === 'ok' && shieldPool
                    // The quote's units, not the pool's: see shieldFundingUnits.
                    ? `≈ ${parseFloat(formatUnits(shieldQuote.toAmount!, shieldFundingUnits?.decimals ?? shieldPool.decimals)).toLocaleString('en-US', { maximumFractionDigits: 6 })}`
                    : '—')
                  : (amount || '0')}
              </Text>
              <Pressable
                onPress={() => { if (!poolPickEnabled) return; setPoolSheetMode('shield'); setPoolSheetOpen(true); }}
                disabled={!poolPickEnabled}
                accessibilityRole="button"
                accessibilityState={{ disabled: !poolPickEnabled }}
                accessibilityLabel={poolPickEnabled
                  ? `Deposit in pool: ${poolDisplayLabel(shieldPool.symbol, shieldPool.chainId)} on ${shieldPool.chainName}`
                  : `Deposits into the ${poolDisplayLabel(shieldPool.symbol, shieldPool.chainId)} pool on ${shieldPool.chainName}`}
                testID="hub-shield-pool"
                className="flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px]"
                // nw-keep(data-color): asset tint background with the shared neutral control border
                style={{
                  backgroundColor: (TokenHues[colorScheme][shieldPool.symbol] ?? TokenHues[colorScheme].ETH).bg,
                  borderColor: colors.border,
                }}
              >
                {/* Symbol only (the row label names the chain); the chain
                    also lives in the icon's badge. */}
                <TokenNetworkIcon symbol={shieldPool.symbol} size={28} badgeSize={16} badgeTestnetLabel={false} chainId={shieldPool.chainId} />
                {/* nw-keep(data-color): per-asset runtime hue, falling back to ETH's */}
                <Text className="font-pp-sans-semi-bold text-[15px]" style={{ color: (TokenHues[colorScheme][shieldPool.symbol] ?? TokenHues[colorScheme].ETH).fg }}>
                  {poolDisplayLabel(shieldPool.symbol, shieldPool.chainId)}
                </Text>
                {/* No caret while the destination is fixed: a caret promises a
                    menu, and there is none to open. */}
                {poolPickEnabled && (
                  /* nw-keep(data-color): caret color is a runtime theme token (vector-icon sink) */
                  <Ionicons name="chevron-down" size={14} color={colors.text} />
                )}
              </Pressable>
            </View>
            {/* Footer mirrors the pay card's balance row: fee picture on the
                left, the one-tap own-pool suggestion on the right (with a
                manual pick armed we offer, never auto-switch — QA 2026-08-18). */}
            {(!landing || walletConnected || shieldPoolPick) && ((vettingFeeBps != null && vettingFeeBps > 0) || shieldPoolPick) && (
              <View className="flex-row flex-nowrap items-center justify-between gap-[8px]">
                {vettingFeeBps != null && vettingFeeBps > 0 ? (
                  <Text numberOfLines={1} className="min-w-0 shrink font-pp-sans text-[11.5px] leading-[16px] text-text-muted">
                    {`Vetting fee ${(vettingFeeBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`}
                  </Text>
                ) : <View />}
                {shieldPoolPick && (() => {
                  let suggestion: ShieldPool | null = null;
                  try { suggestion = defaultPoolFor(payMeta.symbol, chainId); } catch { suggestion = null; }
                  if (!suggestion || !shieldPool) return null;
                  // Only the SAME-token pool is worth suggesting; the rule's
                  // native / Ethereum fallbacks are not "this token's own pool".
                  if (suggestion.symbol !== payMeta.symbol) return null;
                  if (suggestion.chainId === shieldPool.chainId && suggestion.symbol === shieldPool.symbol) return null;
                  return (
                    <Pressable
                      onPress={() => setShieldPoolPick({ chainId: suggestion!.chainId, symbol: suggestion!.symbol })}
                      accessibilityRole="button"
                      testID="hub-shield-pool-suggestion"
                    >
                      <Text className="font-pp-sans-medium text-[12px] text-tint underline">
                        Switch {displayTokenSymbol(suggestion.symbol)} on {suggestion.chainName}
                      </Text>
                    </Pressable>
                  );
                })()}
              </View>
            )}
          </View>
        </>
      )}

      {/* Optional recipient (depositFor): a deposit for another address. A
          registered one is announced to; an unregistered one ends in a claim
          link, and the hint under the field says so while typing. Collapsed by
          default; collapsing clears it so a half-typed address can never be
          forwarded from a hidden field. */}
      {a === 'shield' && !isSuiChain && !shieldBusy && (!landing || walletConnected) && (
        <View className="gap-[8px]">
          <View className="flex-row items-center gap-[8px]">
            <Text className="flex-1 font-pp-sans text-[13px] text-text-secondary">
              {shieldRecipientOpen ? 'Deposit to' : 'Shielding to your own wallet'}
            </Text>
            <Pressable
              onPress={() => {
                setShieldRecipientOpen((open) => {
                  if (open) setShieldRecipient('');
                  return !open;
                });
              }}
              accessibilityRole="button"
              accessibilityState={{ expanded: shieldRecipientOpen }}
              accessibilityLabel={shieldRecipientOpen ? 'Shield to my own wallet' : 'Deposit to another address'}
              testID="hub-shield-recipient-toggle"
              hitSlop={8}
              className={`h-[28px] w-[28px] items-center justify-center rounded-[8px] border ${shieldRecipientOpen ? 'border-tint bg-primary-soft' : 'border-border-light'}`}
            >
              {/* nw-keep(data-color): wallet glyph color is a runtime theme token (vector-icon sink) */}
              <Ionicons name="wallet-outline" size={15} color={shieldRecipientOpen ? colors.primary : colors.textMuted} />
            </Pressable>
          </View>
          {shieldRecipientOpen ? (
            <TextInput
              className={`w-full rounded-control border px-[14px] py-[11px] font-pp-regular text-[14px] text-text ${shieldRecipient && (isStellar ? !isStellarAccountAddress(shieldRecipient.trim()) : !SWAP_ADDRESS_RE.test(shieldRecipient.trim())) ? 'border-danger' : 'border-border-light'}`}
              // nw-keep(platform-css): web-only outlineStyle:'none' removes the focus ring — no className path; empty on native
              style={WEB_NO_OUTLINE}
              value={shieldRecipient}
              onChangeText={setShieldRecipient}
              // Any EVM address: a registered one is announced to, an
              // unregistered one gets a claim link (the hint below says which).
              placeholder={isStellar ? 'G… (Stellar account)' : '0x… (any EVM address)'}
              // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              testID="hub-shield-recipient-input"
            />
          ) : null}
          {/* DEV-570: no ENS on any recipient field (never looked up). */}
          {shieldRecipientOpen && !isStellar && isPotentialEnsName(shieldRecipient) ? (
            <Text className="font-pp-sans text-[12px] leading-[17px] text-danger" testID="hub-shield-recipient-ens">{ENS_UNSUPPORTED_MESSAGE}</Text>
          ) : null}
          {shieldRecipientOpen && shieldRecipientConflict ? (
            <Text className="font-pp-sans text-[12px] leading-[17px] text-warning" testID="hub-shield-recipient-conflict">
              {shieldRecipientConflict}
            </Text>
          ) : shieldRecipientOpen && shieldRecipientHint ? (
            <View className="gap-[2px]" testID="hub-shield-recipient-hint">
              <Text className={`font-pp-sans text-[12px] leading-[17px] ${shieldRecipientHint.tone === 'warning' ? 'text-warning' : 'text-text-muted'}`}>
                {shieldRecipientHint.text}
              </Text>
              {shieldRecipientHint.learnMore ? (
                <Pressable
                  onPress={() => Linking.openURL(UNREGISTERED_DEPOSIT_DOCS_URL)}
                  accessibilityRole="link"
                  hitSlop={6}
                  testID="hub-shield-recipient-learn-more"
                >
                  <Text className="font-pp-sans-medium text-[12px] leading-[17px] text-primary underline">{LEARN_MORE_UNREGISTERED_LABEL}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      )}

      {/* Below the entrypoint minimum: the contract reverts under
          config.minAmount — say so on the form. */}
      {a === 'shield' && !shieldBusy && !isSui && shieldBelowMin && shieldPool && (
        <Text className="font-pp-sans text-[12px] text-[#E53935]">
          {/* In the asset the user typed, rounded up to what they can type; a
              conversion is measured in what the swap DELIVERS into the pool,
              and must quote the same figure the check above enforces, or it
              says "10" while refusing 10.02. */}
          {crossPayShield
            ? formatDepositMinimum(
              shieldMinFundingWei ?? hubAssetConfig!.minAmountWei,
              shieldFundingUnits?.decimals ?? shieldPool.decimals,
              shieldFundingUnits?.symbol ?? shieldPool.symbol,
            )
            : shieldMinPayWei == null
              ? formatDepositMinimum(hubAssetConfig!.minAmountWei, shieldPool.decimals, shieldPool.symbol)
              : formatDepositMinimum(shieldMinPayWei, payMeta.decimals, payMeta.symbol)}.
        </Text>
      )}

      {/* Launch cap, while typing. Muted while the price is still loading,
          red once judged; the over-balance line below yields to it so the card
          never stacks two red lines. */}
      {a === 'shield' && !shieldBusy && !isSui && shieldCapVerdict && (
        <Text
          className={`font-pp-sans text-[12px] ${shieldCapVerdict.reason === 'pending' ? 'text-text-muted' : 'text-[#E53935]'}`}
          testID="hub-shield-cap"
        >
          {shieldCapVerdict.message}
        </Text>
      )}

      {/* Over-balance entries surface on the form, not only at confirm.
          Compares against the fee-aware max — the wallet must cover the
          vetting fee (and gas, for a native pay token) on top of the amount.
          (Below the pair: a row between the cards would break the arrow's
          overlap.) */}
      {a === 'shield' && !shieldBusy && !isSui && walletConnected && !walletBalanceLoading
        && !shieldCapBlocksDeposit
        && (parseFloat(amount) || 0) > (parseFloat(shieldMaxText) || 0) && (
        <Text className="font-pp-sans text-[12px] text-[#E53935]">
          {(parseFloat(amount) || 0) > (parseFloat(walletBalanceText) || 0)
            ? `Exceeds your wallet balance (${(parseFloat(walletBalanceText) || 0).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${displayTokenSymbol(payMeta.symbol)}).`
            : `Leave room for ${shieldHeadroomRoomText({ vettingFeeBps, crossPayShield, payIsNative: !tokenAddress })}. You can shield up to ${(parseFloat(shieldMaxText) || 0).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${displayTokenSymbol(payMeta.symbol)}.`}
        </Text>
      )}

      {/* A sticky pool pick parked on another chain than the active one:
          state it (the SDK's flow 1 is same-chain only). */}
      {a === 'shield' && !shieldBusy && !isSui && shieldPool && shieldPool.chainId !== chainId && !crossChainShield && (
        <Text className="font-pp-sans text-[12px] leading-[17px] text-warning">
          This pool is on {shieldPool.chainName}. Paying from {getChainConfig(chainId)?.displayName ?? 'this network'} isn&apos;t routable. Switch to {shieldPool.chainName} to deposit.
        </Text>
      )}

      {a === 'shield' && !shieldBusy && !isSui && shieldFeeBreakdown && shieldFeeBreakdown.level !== 'none' && (
        <FeeWarning breakdown={shieldFeeBreakdown} testID="hub-shield-fee-warning" />
      )}
      {a === 'shield' && !shieldBusy && shieldElsewhereSuggestion && (
        <ShieldElsewherePanel
          suggestion={shieldElsewhereSuggestion}
          sourceChainName={getChainConfig(chainId)?.displayName ?? 'this network'}
          walletTokensOn={walletTokensOn}
          onPick={(poolChainId, symbol) => setShieldPoolPick({ chainId: poolChainId, symbol })}
        />
      )}

      {/* Routable cross-chain shield: say what is about to happen, since the
          wallet stays on this chain while the note lands on the other. */}
      {a === 'shield' && !shieldBusy && crossChainShield && shieldPool && (
        <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">
          Bridging from {getChainConfig(chainId)?.displayName ?? 'this network'} into the {displayTokenSymbol(shieldPool.symbol)} pool on {shieldPool.chainName}. One transaction, and it can take a few minutes to arrive.
        </Text>
      )}

      {/* Conversion caption — hidden in the 1:1 common case AND once a quote
          landed (the OUT card's ≈ figure says it all); one terse line only
          while the conversion is unavailable, unpriced, or still pricing. */}
      {a === 'shield' && !shieldBusy && shieldPricing && (
        <View className="flex-row items-center gap-[5px]" accessibilityLabel="Pricing the conversion">
          {/* nw-keep(data-color): spinner tint is a theme token into
              RN's ActivityIndicator (no className path). */}
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">Pricing the conversion…</Text>
        </View>
      )}
      {a === 'shield' && !shieldBusy && crossPayShield && !shieldPricing && !(landing && !walletConnected && shieldPool && displayTokenSymbol(shieldPool.symbol) === payMeta.symbol) && !(crossPayAllowed && shieldQuote.status === 'ok') && (
        <Text className={`font-pp-sans text-[12px] leading-[17px] ${shieldQuote.status === 'none' ? 'text-warning' : 'text-text-secondary'}`}>
          {!crossPayAllowed
            /* displayTokenSymbol, not the raw pool symbol: a share pool's symbol is
               ppUSDT, and "Pick ppUSDT" sends the user after an asset no
               wallet holds — shares live in the pool as notes. The depositable
               asset is the underlying the PPRouter wraps, which is exactly
               what displayTokenSymbol names on Shield (prod, 2026-09-04). */
            ? `Converting ${displayTokenSymbol(payMeta.symbol)} isn't available on this network. Pick ${shieldPool ? displayTokenSymbol(shieldPool.symbol) : 'the pool asset'} to deposit directly.`
            : shieldQuote.status === 'none'
              ? `No conversion route for ${displayTokenSymbol(payMeta.symbol)} here.`
              : !connectedAddress
                  ? 'Connect a wallet to price the conversion.'
                  : 'Enter an amount to price the conversion.'}
        </Text>
      )}

      {/* Reserve the live-rate row while it loads so the CTA keeps its position. */}
      {a === 'shield' && !shieldBusy && shieldHasYield && (
        <ShieldYieldSummary
          netApyPercent={shieldShareYield.yield?.netApyPercent}
          loading={shieldShareYield.loading}
          showDisclosure={!tight && (!landing || walletConnected)}
          compact={tight}
        />
      )}
      {/* Withdrawing a share note ALWAYS redeems through the PPRouter (share
          in, underlying out); when the route is unavailable the flow refuses
          rather than paying the share, so this can promise the underlying
          (Pat, 2026-09-05). */}
      {a === 'withdraw' && !isSui && isShareSymbol(pageTargetSymbol) && (
        /* pb-[22px]: the receive card that follows is seamed to the card above
           by PairArrow, whose -28 top margin reaches 16px past the 12px gap
           and into whatever sits here. With this line in the seam the globe
           chip landed on the word "vault" (Nathaniel, QA 2026-09-21). The
           padding is inside the text box, so the chip overlaps empty space
           instead of glyphs, at every width and however many lines it wraps
           to. */
        <Text className="pb-[22px] font-pp-sans text-[12px] leading-[17px] text-text-secondary">
          {shareRedemptionDisclosure(pageTargetSymbol)}
        </Text>
      )}
      {/* The "Pending until approved" explainer box lived here until QA
          2026-08-17 — removed as noise; the pending state itself still shows
          on the balance once a deposit lands. */}
      {a === 'swap' && !swapBusy && (
        <View className="gap-[12px]">
          {/* The pair, Uniswap-shaped: the amount card above is the sell side,
              this is the buy side, and the arrow straddling the seam says
              which way the value moves. Without an output token the tab was
              offering a "swap" with nothing to swap INTO. */}
          {/* nw-keep(data-color): arrow glyph color is a runtime theme token (vector-icon sink) */}
          <PairArrow
            color={colors.text}
            icon={swapReverseTarget ? 'swap-vertical' : 'arrow-down'}
            onPress={swapReverseTarget ? reverseSwapPair : undefined}
            accessibilityLabel="Reverse the swap pair"
            testID="hub-swap-reverse"
          />
          <View className={`${outCard} rounded-inner bg-background-secondary`}>
            <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
              <Text className="font-pp-sans-medium text-[12px] text-text-muted">
                You receive privately
              </Text>
              {swapCrossChain ? (
                <Text className="font-pp-sans-medium text-[12px] text-text-muted">
                  on {getChainConfig(swapDestChainId)?.displayName ?? `Chain ${swapDestChainId}`}
                </Text>
              ) : null}
            </View>
            <View className="flex-row items-center justify-between gap-[8px]">
              {/* A LiFi estimate on the typed amount, labelled as one; a dash
                  until it lands. The binding figure is Review's quote. */}
              <Text className={`min-w-0 flex-1 py-[2px] font-pp-sans-bold ${outText} tracking-[-1px] text-text-muted`} numberOfLines={1} adjustsFontSizeToFit>
                {swapPreviewText ?? '—'}
              </Text>
              <Pressable
                onPress={() => { if (swapDeliverableDestinations.length > 0) setSwapOutSheetOpen(true); }}
                disabled={swapDeliverableDestinations.length === 0}
                accessibilityRole="button"
                accessibilityLabel="Choose the token to receive"
                testID="hub-swap-out-token"
                className="flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px]"
                // nw-keep(data-color): asset tint background with the shared neutral control border
                style={{
                  backgroundColor: swapOutToken
                    ? (TokenHues[colorScheme][displayTokenSymbol(swapOutToken.symbol)] ?? TokenHues[colorScheme].ETH).bg
                    : 'transparent',
                  borderColor: colors.border,
                }}
              >
                {swapOutToken ? (
                  <>
                    {/* Same mark, text and caret sizes as the sell-side pill
                        above and as shield/withdraw/send: the buy side used a
                        7px dot and 12px text, which read as a lesser control
                        next to its own amount (Pat, 2026-08-31). The badge
                        carries the DESTINATION chain, so it also says where a
                        cross-chain output lands. */}
                    <TokenNetworkIcon symbol={swapOutToken.symbol} size={28} badgeSize={16} badgeTestnetLabel={false} chainId={swapDestChainId} />
                    {/* nw-keep(data-color): selected pill text uses the runtime hue */}
                    <Text
                      className="font-pp-sans-semi-bold text-[15px]"
                      style={{ color: (TokenHues[colorScheme][displayTokenSymbol(swapOutToken.symbol)] ?? TokenHues[colorScheme].ETH).fg }}
                    >
                      {/* The coin, never the share: a conversion into a vault
                          receives USDC held in it, and no pp asset is named to
                          the user (services/share-display.ts). The hue and the
                          mark follow the same name. */}
                      {displayTokenSymbol(swapOutToken.symbol)}
                    </Text>
                  </>
                ) : (
                  /* nw-keep(data-color): runtime theme token */
                  <Text className="font-pp-sans-semi-bold text-[15px]" style={{ color: colors.textSecondary }}>
                    Select token
                  </Text>
                )}
                {/* nw-keep(data-color): caret color is a runtime theme token (vector-icon sink) */}
                <Ionicons name="chevron-down" size={14} color={swapOutToken ? colors.text : colors.textSecondary} />
              </Pressable>
            </View>

            <View className="flex-row flex-wrap items-center gap-[6px]">
              {(() => {
                const note = swapPreviewText
                  ? swapBridgeFeeText
                    ? `Estimate, after a ~$${swapBridgeFeeText} bridge fee. The exact rate is quoted at review.`
                    : 'Estimate. The exact rate is quoted at review; relayer and swap fees come out of the amount you swap.'
                  : 'Quoted at review, once the route is priced. Relayer and swap fees come out of the amount you swap.';
                // Phone web: the long note folds into a hint behind a short label.
                return tight ? (
                  <HoverHint hint={note} wrap testID="hub-swap-quote-hint">
                    <View className="flex-row items-center gap-[4px]">
                      <Text className="font-pp-sans text-[12.5px] text-text-secondary">{swapPreviewText
                        ? swapBridgeFeeText ? `Estimate, after a ~$${swapBridgeFeeText} bridge fee` : 'Estimate, after fees'
                        : 'Quoted at review, after fees'}</Text>
                      {/* nw-keep(data-color): glyph colour is a runtime theme token (vector-icon sink) */}
                      <Ionicons name="information-circle-outline" size={12} color={colors.textMuted} />
                    </View>
                  </HoverHint>
                ) : (
                  <Text className="font-pp-sans text-[12.5px] text-text-secondary">{note}</Text>
                );
              })()}
            </View>
          </View>

          {/* Recipient (DEV-510, grep [swap-deposit-recipient]): the output is
              a shielded note for a registered account (reshield-and-transfer).
              Collapsed is a note of your own. Never a wallet payout. */}
          <View className="gap-[8px]">
            <View className="flex-row items-center gap-[8px]">
              <Text className="flex-1 font-pp-sans text-[13px] text-text-secondary">
                {swapRecipientOpen ? 'Send privately to' : 'Swapping to your own account'}
              </Text>
              <Pressable
                onPress={() => {
                  setSwapRecipientOpen((open) => {
                    if (open) setSwapRecipient('');
                    return !open;
                  });
                }}
                accessibilityRole="button"
                accessibilityState={{ expanded: swapRecipientOpen }}
                accessibilityLabel={swapRecipientOpen ? 'Swap to my own account' : 'Send the output privately to another address'}
                testID="hub-swap-recipient-toggle"
                hitSlop={8}
                className={`h-[28px] w-[28px] items-center justify-center rounded-[8px] border ${swapRecipientOpen ? 'border-tint bg-primary-soft' : 'border-border-light'}`}
              >
                {/* nw-keep(data-color): wallet glyph color is a runtime theme token (vector-icon sink) */}
                <Ionicons name="wallet-outline" size={15} color={swapRecipientOpen ? colors.primary : colors.textMuted} />
              </Pressable>
            </View>
            {swapRecipientOpen ? (
              <TextInput
                className={`w-full rounded-control border px-[14px] py-[11px] font-pp-regular text-[14px] text-text ${swapRecipient && swapRecipientRoute.kind === 'invalid' ? 'border-danger' : 'border-border-light'}`}
                // nw-keep(platform-css): web-only outlineStyle:'none' removes the focus ring — no className path; empty on native
                style={WEB_NO_OUTLINE}
                value={swapRecipient}
                onChangeText={setSwapRecipient}
                placeholder="0x… (registered account)"
                // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                testID="hub-swap-recipient-input"
              />
            ) : null}
            {/* DEV-570: no ENS on any recipient field (never looked up). */}
            {swapRecipientOpen && isPotentialEnsName(swapRecipient) ? (
              <Text className="font-pp-sans text-[12px] leading-[17px] text-danger" testID="hub-swap-recipient-ens">{ENS_UNSUPPORTED_MESSAGE}</Text>
            ) : null}
            {swapRecipientOpen && swapRecipientNote ? (
              <Text
                className={`font-pp-sans text-[12px] leading-[17px] ${swapRecipientBlocks ? 'text-warning' : 'text-text-muted'}`}
                testID="hub-swap-recipient-hint"
              >
                {swapRecipientNote}
              </Text>
            ) : null}
          </View>

        </View>
      )}
      {/* Request joins the split: the amount card above is the hub's, the rest
          of the form (sign intent, Create Request, the pay link) draws here.
          This branch also REPLACES the hub CTA, which is what keeps the
          provider's own "Create Request" the only one on screen. */}
      {((a === 'withdraw' && withdrawInline) || (a === 'send' && (transferInline || swapInlineSend)) || (a === 'swap' && swapInline && !swapInlineSend) || (a === 'request' && requestInline)) ? (
        /* The operation's extra inputs/info (recipient, receive-as, fees,
           anonymity set, review) draw here, right under the amount card,
           absorbing the zone's remaining height.

           Only the FOCUSED hub's ACTIVE page advertises the shared host id:
           every pager page is mounted and a retained route keeps rendering, so
           an unguarded nativeID put several `pp-inline-op-host` divs in one
           document and the portal's getElementById could pick a hidden one -
           the form then drew into a display:none screen (codex). */
        <View
          nativeID={isFocused && a === action ? INLINE_OP_HOST_ID : undefined}
          className="w-full grow justify-start"
        />
      ) : shieldBusy ? (
        /* Progress replaces presets/info/CTA under the (inert) amount card. */
        <View className="grow justify-center gap-[10px] rounded-inner bg-background-secondary px-[16px] py-[18px]">
          <Text className="text-center font-pp-sans-semi-bold text-[15px] text-text">
            Depositing {depositFlow.depositAmountFormatted}
          </Text>
          <FlowProgress message={depositFlow.loadingMessage} />
          {/* "Deposit from" route cost, once the quote exists — the wallet is
              about to ask for an amount of the paying token the user never typed. */}
          {depositFlow.swapRouteEstimate && !depositFlow.swapConsent ? (
            <Text className="text-center font-pp-sans text-[12px] text-text-secondary">
              {depositFlow.swapRouteEstimate}
            </Text>
          ) : null}
          {/* Consent gate (flow 1): nothing signed yet — the flow is parked on
              this answer. Without it here, an inline swap-deposit would hang:
              the modal's own consent card never renders inline on desktop. */}
          {depositFlow.swapConsent ? (
            <View className="w-full gap-[10px] rounded-inner border border-border-light bg-card-background p-[14px]">
              <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                <Text className="font-pp-sans-medium text-[13px] text-text-secondary">You pay (est.)</Text>
                <Text className="font-pp-sans-bold text-[13px] text-text">
                  {depositFlow.swapConsent.inputAmountText}
                  {depositFlow.swapConsent.inputAmountUSD ? ` · ${depositFlow.swapConsent.inputAmountUSD}` : ''}
                </Text>
              </View>
              <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                <Text className="font-pp-sans-medium text-[13px] text-text-secondary">You shield</Text>
                <Text className="font-pp-sans text-[13px] text-text">{depositFlow.swapConsent.depositAmountText}</Text>
              </View>
              {depositFlow.swapConsent.durationText ? (
                <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
                  <Text className="font-pp-sans-medium text-[13px] text-text-secondary">Est. time</Text>
                  <Text className="font-pp-sans text-[13px] text-text">{depositFlow.swapConsent.durationText}</Text>
                </View>
              ) : null}
              {depositFlow.swapConsent.needsApproval ? (
                <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">
                  Two transactions: a {depositFlow.swapConsent.paySymbol} approval first, then the swap.
                </Text>
              ) : null}
              {/* DEV-436: the wallet preview shows the unused slippage come back. */}
              <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">
                {SWAP_DEPOSIT_REFUND_NOTE}
              </Text>
              <View className="flex-row justify-end gap-[8px]">
                <Pressable
                  onPress={depositFlow.swapConsent.decline}
                  className="items-center rounded-[8px] border border-border-light px-[14px] py-[8px]"
                >
                  <Text className="font-pp-sans-medium text-[13px] text-text">Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={depositFlow.swapConsent.accept}
                  className="items-center rounded-[8px] bg-button-primary px-[14px] py-[8px] active:bg-button-primary-pressed"
                >
                  <Text className="font-pp-sans-medium text-[13px] text-button-primary-text">Continue</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {/* Unsaved-claim warning (same gate the modal renders): this browser
              could not store the recipient's claim link; the chain has the
              backup, the user decides. Without this the inline flow would hang
              on the parked promise with no visible way to answer it. */}
          {depositFlow.storageConsent ? (
            <View className="w-full gap-[10px] rounded-inner border border-warning bg-warning-bg p-[14px]">
              <Text className="font-pp-sans-medium text-[13px] text-warning">{UNSAVED_CLAIM_WARNING.title}</Text>
              <Text className="font-pp-sans text-[12px] leading-[17px] text-text-secondary">{UNSAVED_CLAIM_WARNING.body}</Text>
              <View className="flex-row justify-end gap-[8px]">
                <Pressable
                  onPress={depositFlow.storageConsent.decline}
                  className="items-center rounded-[8px] border border-border-light px-[14px] py-[8px]"
                >
                  <Text className="font-pp-sans-medium text-[13px] text-text">{UNSAVED_CLAIM_WARNING.cancel}</Text>
                </Pressable>
                <Pressable
                  onPress={depositFlow.storageConsent.accept}
                  className="items-center rounded-[8px] bg-button-primary px-[14px] py-[8px] active:bg-button-primary-pressed"
                >
                  <Text className="font-pp-sans-medium text-[13px] text-button-primary-text">{UNSAVED_CLAIM_WARNING.proceed}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      ) : (
      <>
      <Pressable
        onPress={launch}
        testID={`hub-cta-${a}`}
        accessibilityRole="button"
        // Background + pressed swap are class-authored: a `style` FUNCTION on a
        // className'd Pressable is wrapped into an array by css-interop and never
        // invoked (Pressable only calls a top-level style function), which dropped
        // the fill. bg-* + active: reproduce buttonPrimary / buttonPrimaryPressed.
        // A swap with no output token cannot be built, so the CTA refuses it
        // rather than opening a modal that would immediately have nothing to
        // quote.
        disabled={ctaDisabled}
        className={`items-center rounded-control py-[16px] bg-button-primary ${ctaDisabled ? 'opacity-40' : 'active:bg-button-primary-pressed'}`}
        // nw-keep(data-color): glow shadowColor is the button-primary theme token (non-class sink)
        // nw-keep(platform-css): CTA glow gated to native (NATIVE_SHADOW) — the baseline's web CTA glow (RN-Web converts shadow* → box-shadow) is sub-tolerance and accepted dropped; see p2-gates.md
        style={[NATIVE_SHADOW ? {
          shadowColor: colors.buttonPrimary,
          shadowOpacity: 0.25,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 0 },
          elevation: 4,
        } : null]}
      >
        <Text className="font-pp-sans-semi-bold text-[16px] tracking-[0.1px] text-button-primary-text">
          {/* An account-key session IS signed in; it just has no wallet. It
              covers the relayed actions (withdraw / send / request) on its own,
              and shield alone needs a wallet to pay from, which `launch` hands
              to the deposit modal's connect gate. Saying "Get Started" there
              told a signed-in user they were signed out, and the wallet prompt
              that followed read as a bug rather than the requirement it is (QA
              A-f, Matthew). Name the requirement instead. EVM only: on Sui a
              key session has no relayed bypass, so the press connects a Sui
              wallet and the onboarding wording is still the true one. */}
          {!walletConnected && active.key === 'shield' && identityMode === 'key' && !isSui
            ? `Connect a wallet to shield ${displayTokenSymbol(pageTargetSymbol)}`
            : !walletConnected && active.key === 'shield'
              ? `Get Started Shielding ${displayTokenSymbol(pageTargetSymbol)}`
              : active.key === 'shield' ? `${active.cta} ${displayTokenSymbol(pageTargetSymbol)}` : active.cta}
        </Text>
      </Pressable>

      {/* Below the CTA (Uniswap-style info line): what leaves the wallet on
          the left, the absolute vetting fee on the right. Same-token: total =
          amount + fee on top. Cross-pay: the wallet spends the entered pay
          amount 1:1 and the fee comes out of the CONVERTED amount, so the fee
          is the quote's ≈ figure. */}
      {a === 'shield' && !shieldBusy && !isSui && vettingFeeBps != null && (!compactShield || vettingFeeBps > 0) && (() => {
        const amt = parseFloat(amount) || 0;
        const totalText = crossPayShield
          ? `${amt.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${displayTokenSymbol(payMeta.symbol)}`
          : `${(amt * (1 + vettingFeeBps / 10000)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${displayTokenSymbol(pageTargetSymbol)}`;
        const feeText = vettingFeeBps === 0
          ? null
          : amt <= 0
            ? `Vetting fee 0 ${displayTokenSymbol(pageTargetSymbol)}`
            : crossPayShield
              ? (shieldQuote.status === 'ok' && shieldQuote.toAmount != null && shieldPool
                ? `Vetting fee ≈ ${parseFloat(formatUnits((shieldQuote.toAmount * BigInt(vettingFeeBps)) / 10_000n, shieldPool.decimals)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${displayTokenSymbol(shieldPool.symbol)}`
                : null)
              : `Vetting fee ${(amt * (vettingFeeBps / 10000)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${displayTokenSymbol(pageTargetSymbol)}`;
        return (
          <View className="flex-row flex-nowrap items-center justify-between gap-[8px] px-[2px]">
            {!compactShield && <Text numberOfLines={1} className="min-w-0 shrink font-pp-sans text-[12px] text-text-muted">
              Total sent amount {totalText}
            </Text>}
            {feeText ? (
              <Text numberOfLines={1} className="font-pp-sans text-[12px] text-text-muted">{feeText}</Text>
            ) : null}
          </View>
        );
      })()}

      </>
      )}
      </View>
      )}
      </>
    );
  };

  return (
    // nw-keep(platform-css): natural face measurements drive one animated card height.
    <View
      testID="hub-card"
      ref={hubCardRef}
      className="w-full overflow-hidden rounded-card border"
      style={[
        cardSurface,
        // The shared soft shadow every card and dropdown wears.
        CARD_SHADOW,
        WEB ? {
          display: 'grid', gridTemplateRows: 'max-content',
          height: cardHeight === undefined ? undefined : cardHeight + 2,
          transition: reducedMotion || !heightMotionReady ? 'none' : `height ${PICKER_TRANSITION_MS}ms cubic-bezier(0.32, 0, 0.2, 1)`,
        } as unknown as ViewStyle : undefined,
      ]}
    >
      {/* Inactive faces stay mounted for the crossfade without setting card height. */}
      <Animated.View
        pointerEvents={pickerOpen ? 'none' : 'auto'}
        aria-hidden={pickerOpen}
        ref={(node) => {
          formNode.current = node as View | null;
          if (WEB && node) (node as unknown as HTMLElement).inert = pickerOpen;
        }}
        onLayout={(event) => {
          if (!isFocused) return;
          const height = WEB && formNode.current
            ? (formNode.current as unknown as HTMLElement).offsetHeight
            : event.nativeEvent.layout.height;
          if (height > 0 && (!WEB || pageHeights[action] !== undefined)) setFormHeight(height);
        }}
        className={`w-full ${tight ? 'gap-[14px] p-[14px]' : 'gap-[24px] p-[20px]'}${pickerOpen && !WEB ? ' absolute inset-0 overflow-hidden' : ''}`}
        // nw-keep(animated): shared-cell face crossfade, with reduced-motion handling.
        style={[
          WEB ? { gridArea: '1 / 1', minWidth: 0, alignSelf: 'start' } as unknown as ViewStyle : undefined,
          { opacity: frontOpacity },
        ]}
      >
      {/* Action tabs — ONE shared highlight pill glides between titles,
          driven by the pager's live scroll offset (finger drags included). */}
      <View
        className="relative flex-row rounded-pill bg-background-secondary p-[4px]"
        onLayout={(e) => { if (isFocused && e.nativeEvent.layout.width > 0) setTabsW(Math.round(e.nativeEvent.layout.width)); }}
      >
        {tabsW > 0 && pagerW > 0 && visibleActions.length > 0 && (() => {
          const n = visibleActions.length;
          // Every tab must have reported its geometry, and a stale array from a
          // previous tab count would place the pill on the wrong label.
          const laid = tabLayouts.slice(0, n);
          if (laid.length < n || laid.some((l) => !l)) return null;
          const cells = laid as { x: number; w: number }[];
          const stride = pageStride(pagerW);
          // n === 1 would collapse the interpolation range; the single tab's
          // own geometry is the answer.
          const input = n > 1 ? cells.map((_, i) => i * stride) : [0, 1];
          const xs = n > 1 ? cells.map((c) => c.x) : [cells[0].x, cells[0].x];
          const ws = n > 1 ? cells.map((c) => c.w) : [cells[0].w, cells[0].w];
          return (
            // nw-keep(animated): pill x and width ride the pager scroll (Animated interpolate)
            <Animated.View
              pointerEvents="none"
              className={`absolute rounded-pill ${colorScheme === 'dark' ? 'bg-[#343434]' : 'bg-card-background'}`}
              style={[
                // left: 0 pins the translateX base to the row's border box —
                // without it an absolute child keeps its STATIC flex position
                // (after the 4px padding), shifting the pill right by 4px at
                // every index. The measured x is already row-relative and
                // includes that padding.
                { top: 4, bottom: 4, left: 0 },
                WEB
                  ? { boxShadow: colorScheme === 'dark' ? 'none' : '0px 2px 8px color-mix(in srgb, var(--pp-glow) 12%, transparent)' } as unknown as object
                  : { shadowColor: Glow.light, shadowOpacity: colorScheme === 'dark' ? 0 : 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: colorScheme === 'dark' ? 0 : 2 },
                {
                  width: pagerScrollX.interpolate({ inputRange: input, outputRange: ws, extrapolate: 'clamp' }),
                  transform: [{
                    translateX: pagerScrollX.interpolate({ inputRange: input, outputRange: xs, extrapolate: 'clamp' }),
                  }],
                },
              ]}
            />
          );
        })()}
        {visibleActions.map((a, i) => {
          const selected = a.key === action;
          return (
            <Pressable
              key={a.key}
              testID={`hub-tab-${a.key}`}
              accessibilityRole="tab"
              accessibilityState={{ selected, disabled: tabsDisabled }}
              onPress={() => depositFlow.guardClaimLeave(() => setAction(a.key))}
              disabled={tabsDisabled}
              onLayout={(e) => setTabLayout(i, e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
              className={`items-center rounded-pill px-[6px] py-[9px]${tabsDisabled && !selected ? ' opacity-40' : ''}`}
              // Equal share of the LEFTOVER space, not equal cells: with flex-1
              // every tab was as wide as the widest label, so "Withdraw" (59px
              // of text) filled its 60px cell edge to edge on a phone while
              // "Send" floated in 14px of slack. Growing from the content
              // instead gives all five the same gutter at every width.
              // nw-keep(measured-or-inset): content-proportional flex, no class equivalent
              style={{ flexGrow: 1, flexShrink: 1, flexBasis: 'auto' }}
            >
              <Text
                numberOfLines={1}
                className={`font-pp-sans-medium text-[14px] ${selected ? 'text-text' : 'text-text-secondary'}`}
              >
                {a.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* The zone renders as PAGES in a snap pager: content pans with the
          finger (native browser scroll-snap on web); tab presses select
          the page in place. renderZone draws one tab's content. */}
      <View
        ref={pagerFrameNode}
        testID="hub-pager-frame"
        // self-stretch, not w-full: a percentage width ignores the negative
        // margins, stretch grows the box by them, so the frame is content +
        // 2 * PAGE_EDGE and the measured pager width stays the content width.
        className="self-stretch overflow-hidden"
        // The clip box extends PAGE_EDGE past the content on both sides (the
        // padding puts the content back where it was); the measured pager
        // width is the content width, so the padding is taken back out.
        // nw-keep(measured-or-inset): edge slack around the measured pager
        style={{ marginHorizontal: -PAGE_EDGE, paddingHorizontal: PAGE_EDGE, ...(WEB ? { height: pageHeights[action] } : {}) }}
        onLayout={(e) => { if (!isFocused || e.nativeEvent.layout.width <= 2 * PAGE_EDGE) return; const nextWidth = pagerWidthDamper.current.next(Math.round(e.nativeEvent.layout.width) - 2 * PAGE_EDGE, pagerW); if (nextWidth !== null) setPagerW(nextWidth); }}
      >
        {pagerW > 0 && (
          <RNScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            decelerationRate="fast"
            /* nw-keep(measured-or-inset): pager width is measured from the viewport; the
               ScrollView starts PAGE_EDGE left of the content so its clip edge does too */
            style={{ width: pageStride(pagerW), marginLeft: -PAGE_EDGE }}
            onScroll={onPagerScroll}
            onScrollBeginDrag={onPagerDragStart}
            onTouchStart={onPagerDragStart}
            // While an operation locks the tabs, swiping must not desync the
            // pager from the URL-selected tab either.
            scrollEnabled={!tabsDisabled}
            scrollEventThrottle={32}
            // Web: a mouse-wheel pan fires neither drag nor touch events.
            {...(WEB ? ({ onWheel: onPagerDragStart } as object) : null)}
          >
            {visibleActions.map((x) => (
              <View
                key={x.key}
                testID={`hub-page-${x.key}`}
                ref={(node) => { pageNodes.current[x.key] = node; }}
                /* nw-keep(measured-or-inset): each page is exactly one measured pager width */
                style={{ width: pageStride(pagerW), paddingLeft: PAGE_EDGE, paddingRight: PAGE_GUTTER, alignSelf: 'flex-start' }}
                onLayout={(event) => {
                  if (!isFocused) return;
                  const node = pageNodes.current[x.key] as unknown as HTMLElement | null;
                  const height = WEB && node ? node.offsetHeight : event.nativeEvent.layout.height;
                  if (height <= 0) return;
                  setPageHeights((previous) => previous[x.key] === height ? previous : { ...previous, [x.key]: height });
                }}
                className="gap-[12px]"
                // Every page stays mounted (the pager scrolls between them),
                // so a screen reader on the Send tab could still walk the
                // Shield page's off-screen text. Hide inactive pages from the
                // a11y tree on every platform; visuals are untouched.
                aria-hidden={x.key !== action}
                accessibilityElementsHidden={x.key !== action}
                importantForAccessibility={x.key === action ? 'auto' : 'no-hide-descendants'}
              >
                {renderZone(x.key)}
              </View>
            ))}
          </RNScrollView>
        )}
      </View>
      </Animated.View>

      {/* Back face — the wallet picker. */}
      <Animated.View
        pointerEvents={pickerOpen ? 'auto' : 'none'}
        aria-hidden={!pickerOpen}
        ref={(node) => {
          pickerNode.current = node as View | null;
          if (WEB && node) (node as unknown as HTMLElement).inert = !pickerOpen;
        }}
        onLayout={(event) => {
          if (!isFocused) return;
          const node = pickerNode.current as unknown as HTMLElement | null;
          const height = WEB && node ? node.offsetHeight : event.nativeEvent.layout.height;
          if (height > 0) setPickerHeight(height);
        }}
        className={`w-full gap-[24px] p-[24px]${!pickerOpen && !WEB ? ' absolute inset-0 overflow-hidden' : ''}`}
        // nw-keep(animated): shared-cell face crossfade, with reduced-motion handling.
        style={[
          WEB ? { gridArea: '1 / 1', minWidth: 0, alignSelf: 'start' } as unknown as ViewStyle : undefined,
          { opacity: backOpacity },
        ]}
      >
        <View className="items-center gap-[12px] pt-[8px] pb-[4px]">
          {!picker.wcUri && <View className="mb-[8px] h-[48px] w-[48px] items-center justify-center rounded-inner bg-background-secondary">
            {/* nw-keep(data-color): wallet glyph color is the primary theme token into the vector-icon sink */}
            <Ionicons name="wallet-outline" size={22} color={colors.primary} />
          </View>}
          <Text className="font-pp-sans-medium text-[24px] text-center text-text">
            {picker.wcUri ? (picker.wcView === 'wallets' ? 'Open your wallet' : 'Scan with your wallet') : picker.options.length === 0 && !showAccountKey && !passkeyAvailable ? 'No wallet detected' : 'Connect a wallet'}
          </Text>
          {!picker.wcUri && <Text className="max-w-[320px] text-center font-pp-sans text-[14px] leading-[22px] text-text-secondary">
            {picker.options.length === 0 && !showAccountKey && !picker.wcUri && !passkeyAvailable ? 'Get a wallet to start shielding, or open this page in your wallet’s browser.' : 'Your keys stay yours. Choose how to connect.'}
          </Text>}
        </View>

        {/* Native: passkey sign-in + account picker first, as in the modal. Renders nothing on web. */}
        {!showAccountKey && !picker.wcUri && <PasskeySignInPanel colors={colors} onDone={closePicker} />}

        {showAccountKey ? (
          <AccountKeySignIn colors={colors} onDone={closePicker} />
        ) : picker.wcUri ? (
          picker.wcView === 'wallets'
            ? <WalletDeepLinkList uri={picker.wcUri} onShowQr={picker.showQr} onBack={picker.reset} />
            : <WalletConnectQr uri={picker.wcUri} onBack={picker.reset} />
        ) : picker.options.length === 0 ? (
          <View className="gap-[16px]">
            <View className="gap-[8px]">
              {[
                { name: 'MetaMask', url: 'https://metamask.io' },
                { name: 'Ambire', url: 'https://ambire.com' },
              ].map((wallet) => (
                <Pressable
                  key={wallet.name}
                  accessibilityRole="link"
                  onPress={() => { void Linking.openURL(wallet.url); }}
                  className="min-h-[52px] flex-row items-center justify-between rounded-control border border-border-light bg-background-secondary px-[16px] py-[14px] hover:opacity-80 active:opacity-70"
                >
                  <Text className="font-pp-sans-medium text-[14px] text-text">Get {wallet.name}</Text>
                  <Ionicons name="open-outline" size={16} color={colors.textSecondary} />
                </Pressable>
              ))}
            </View>
            <StellarWalletOption className="flex-row items-center gap-[11px] rounded-inner border border-border-light bg-background-secondary px-[13px] py-[12px] active:bg-primary-soft" onConnected={closePicker} />
            <Pressable onPress={() => setShowAccountKey(true)} accessibilityRole="button" className="min-h-[44px] items-center justify-center rounded-control hover:opacity-80 active:opacity-70">
              <Text className="font-pp-sans-medium text-[13px] text-text-secondary underline">Sign in with an account key</Text>
            </Pressable>
          </View>
        ) : (
          <View className="gap-[8px]">
            {picker.preparingLinks && <WalletLinksPreparing />}
            {picker.shownOptions.map((option) => {
              const isPending = picker.isOptionPending(option);
              const disabled = picker.isOptionDisabled(option);
              return (
                <Pressable
                  key={option.uid}
                  onPress={() => picker.select(option)}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityState={{ disabled, busy: isPending }}
                  // Background + pressed swap are class-authored: a `style` FUNCTION on a
                  // className'd Pressable is wrapped into an array by css-interop's web runtime
                  // and never invoked (RN-Web Pressable only calls a top-level style function),
                  // which dropped both the resting and pressed fill (same bug as the CTA, 4f1a734).
                  className={`flex-row items-center gap-[11px] rounded-inner border bg-background-secondary px-[13px] py-[12px] active:bg-primary-soft ${isPending ? 'border-primary' : 'border-border-light'} ${disabled ? 'opacity-[0.45]' : 'opacity-100'}`}
                >
                  <WalletOptionContent option={option} isPending={isPending} />
                </Pressable>
              );
            })}
            {picker.moreCount > 0 && <MoreWalletsButton label={picker.moreLabel} onPress={picker.expandMore} />}
            {picker.notOpened && <WalletNotOpened {...picker.notOpened} />}
            <StellarWalletOption className="flex-row items-center gap-[11px] rounded-inner border border-border-light bg-background-secondary px-[13px] py-[12px] active:bg-primary-soft" onConnected={closePicker} />
            {/* Wallet-less path: sign in with an exported account key. */}
            <Pressable onPress={() => setShowAccountKey(true)} hitSlop={8}>
              <Text className="py-[6px] text-center font-pp-sans-medium text-[12px] text-text-secondary underline">
                Or sign in with an account key (no wallet)
              </Text>
            </Pressable>
          </View>
        )}

        {picker.error && (
          <Text className="text-center font-pp-sans text-[12px] text-danger">{picker.error}</Text>
        )}

        {!picker.wcUri && <Pressable onPress={closePicker} accessibilityRole="button" className="min-h-[44px] flex-row items-center justify-center gap-[8px]" hitSlop={8}>
          {/* nw-keep(data-color): back-arrow color is the primary theme token into the vector-icon sink */}
          <Ionicons name="arrow-back" size={13} color={colors.primary} />
          <Text className="font-pp-sans-semi-bold text-[12.5px] text-primary">
            Back to shielding
          </Text>
        </Pressable>}
      </Animated.View>

      {/* The asset/network picker is NOT rendered here. This card sits inside a
          transformed Animated.View (the hero parallax in home-screen.tsx), and a
          transformed ancestor becomes the containing block for position:fixed —
          so a sheet painted here had its full-screen scrim clipped to the
          widget, leaving the rest of the page undimmed. It is published to the
          root-level host instead (services/token-sheet-host.ts); the effect
          below keeps that publication in sync with local state. */}
    </View>
  );
}
