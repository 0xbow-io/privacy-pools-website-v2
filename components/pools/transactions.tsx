import { formatUnits } from 'viem';
// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
import { useShareFreeBalanceDisplay } from '@/hooks/use-balance-display';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import React, { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import { DROPDOWN_SHADOW, WEB_FIXED_POSITION } from '@/components/ui/web-style-shims';
import { View, Text, Pressable, Platform, Linking, Animated, Easing, Alert, useWindowDimensions } from 'react-native';
import { Modal } from '@/components/ui/modal';
import { useLayoutWidth } from '@/components/home/explore-panel-context';
import { formatShortDate, formatShortTime } from '@/services/display-date';
import {
  transactionBaseType,
  transactionTypeColor,
  transactionTypeGlyph,
} from '@/services/transaction-visuals';
import type { ViewStyle } from 'react-native';
import { HoverHint } from '@/components/ui/hover-hint';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';

// Web-only style: position 'fixed' is valid in react-native-web but not in RN types.
import Svg, { Path, Circle } from 'react-native-svg';
import { ScrollView } from 'react-native';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useWalletUnlockGate } from '@/hooks/use-wallet-unlock-gate';
import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { findStellarSentClaim } from '@/services/stellar/stellar-account';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { Card } from '@/components/ui/card';
import { TooltipPortal } from '@/components/ui/tooltip-portal';
import { AddressWithExplorer, CopyIconButton } from '@/components/ui/copy-address';
import { BlockchainFilter, type ChainFilterOption } from '@/components/pools/blockchain-filter';
import { Colors, Fonts, FontWeights } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useDrawerHost, launchFromDrawer } from '@/components/home/drawer-host';
import { getUiParam, pushUiParamEntry, retireUiParamEntry, rebaseUiParamEntry, subscribeUiUrl } from '@/components/ui-url-events';
import { usePools, type Transaction } from '@/components/pools-provider';
import { useRagequitModal } from '@/components/ragequit-modal-provider';
import { useWithdrawModal } from '@/components/withdraw-modal-provider';
import { useAccountRecoveryModal } from '@/components/account-recovery-modal-provider';
import { useNotes } from '@/hooks/use-notes';
import { registerDebugSnapshot } from '@/services/debug-snapshots';
import { NoteStatus } from '@/services/sdk-types';
import { FUNDS_REASON_COPY, FUNDS_STATE_LABEL, STATUS_FILTER_HINTS, STATUS_FILTER_OPTIONS, fundsChipText, isLiveNoteStatus, matchesStatusFilter } from '@/services/funds-state';
import { fullySpentDepositTxHashesByChain, type SpendableNoteLike } from '@/services/fully-spent';
import { rowTypeLabel } from '@/services/row-type-label';
import { withPublicSwapRows } from '@/services/swap-route-evidence';
import { anyLeg, debugSafeRow, fundedBySwap, hexKey, isSwapRow, rowLegs, swapLegTexts, swapOutputDepositView, swapPendingLabel, viaSwapRoute, type RowLeg, type SwapLeg } from '@/services/swap-rows';
import { lifiScanUrl } from '@/services/lifi-scan';
import { showMoreLabel } from '@/services/explore-pools';
import { recordedTransferPayee } from '@/services/transfer-payee';
import { PairArrow } from '@/components/ui/pair-arrow';
import { Pill } from '@/components/ui/pill';
import { getExplorerTxUrl, getExplorerAddressUrl, getExplorerName, getChainConfig, isTestnetChain, STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { useMyTransactionOwnership } from '@/hooks/use-my-transaction-ownership';
import { useSdkContext } from '@/components/sdk-provider';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { pendingRowActionStep, type PendingRowAction } from '@/services/row-chain-action';
import { ChainBadge, TokenNetworkIcon, hasTokenMark } from '@/components/ui/token-network-icon';
import { tokenAmountLabel, displayTokenSymbol, isShareSymbol} from '@/services/share-display';
import { stableRowKeys } from '@/services/row-keys';
import { shareNumberAsUnderlying, underlyingPriceFor } from '@/services/share-rates';
import { formatUsd, formatUsdPrecise } from '@/services/format-fiat';
import { useShareRates } from '@/hooks/use-share-rates';
import { TransactionRowMenu, type TransactionRowMenuItem } from '@/components/pools/transaction-row-menu';
import { ExplorerPrivacyHint, explorerPrivacyText } from '@/components/ui/explorer-privacy-hint';
import { classifyTransfer, computeUserTransferAmount, mergeMyTransactions, withLineageTransfers } from '@/services/transfer-direction';
import { activityHeaderCount } from '@/services/global-events-pages';
import { findPaidRequest } from '@/services/paid-requests-store';
import { priceFromMap } from '@/services/price-map-merge';
import { phoneTransactionRows } from '@/services/header-nav';
import { findWithdrawFee } from '@/services/withdraw-fees-store';
import { relayerFeeFor, relayerFeeUsdNote } from '@/services/relayer-fee-row';
import { findWithdrawRecipient } from '@/services/withdraw-recipients-store';
import { formatFeeUnits } from '@/services/relay-fee-split';
import { detailAmountDigits, isStablecoin } from '@/services/token-format';
import { encodePaymentReceiptPayloadForUrl, type PaymentReceiptPayload } from '@/services/payment-request-codec';
import { PAY_URL_BASE } from '@/config/env';

// Same base the payment-request modal uses for its share links: the brand
// domain when configured, else this session's own origin.
function receiptLinkBase(): string {
  if (PAY_URL_BASE) return PAY_URL_BASE;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return '';
}
import { buildSentTxHashSet, findSentTransfer } from '@/services/sent-transfers-store';
import { findSentAuditsForRow } from '@/services/audit-store';
import { buildRecoveredClaimUrl, buildSentReceiptUrl } from '@/services/note-receipt';
import { recoverBlindDepositClaims } from '@/services/blind-deposit-recovery';
import { findSealedClaimsForTx } from '@/services/swap-send-claim-store';
import { claimRecoveryOutcome, claimsFromLoadedCiphertexts, openSwapSendClaim, SWAP_SEND_NO_CLAIM_IN_TX } from '@/services/swap-send-claim';
import { decryptBlindDepositBackup, type BackupCryptoLike } from '@/services/blind-deposit-backup';
import { noteCiphertextsFor } from '@/services/note-ciphertexts';
import { recordOutgoingDeposit } from '@/services/outgoing-deposits-store';
import { useToast } from '@/components/toast-provider';
import { buildOwnedNoteKey, buildSentPaymentKey, buildOriginProofForTarget, canProveOrigin } from '@/services/audit-receipt';
import { useAuditExport } from '@/components/audit-export-modal-provider';
import { useOriginProof } from '@/components/origin-proof-modal-provider';
import { getTokenMetadata, formatTokenBalance } from '@/config/tokens';
import { consolidationHeadline, isFeeAmountRow } from '@/services/self-transfer-row';

/** Where a Transfer's amount goes while my spends on its chain are still being
 *  classified: the row may yet be mine, so it is not "Private" yet. */
const TRANSFER_RESOLVING_COPY = 'Loading';

// nw-keep(svg-or-canvas): every fill/stroke below is SVG artwork — brand/status
// literals and the caller `color` prop feed the react-native-svg paths (no className path).
/**
 * Exact wei behind a row whose amount is the relayer fee (isFeeAmountRow),
 * for formatFeeUnits.
 *
 * `rawAmount` is the string the row was built from; `tokenAmount` is already a
 * lossy float, so re-deriving wei from it would reintroduce the rounding this
 * row exists to avoid. Falls back to 0n rather than throwing: a malformed
 * amount must not blank the whole transactions table.
 */
/** An exact on-chain figure in the detail's number style (detailAmountDigits). */


function feeRowWei(tx: { rawAmount?: string }): bigint {
  return rawWei(tx.rawAmount);
}

function rawWei(raw: string | undefined): bigint {
  try {
    return BigInt(raw ?? '0');
  } catch {
    return 0n;
  }
}

function ChevronDownIcon({ color = '#282828' }: { color?: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
      <Path d="M6.17917 7.15411L10 10.9749L13.8208 7.15411L15 8.33328L10 13.3333L5 8.33328L6.17917 7.15411Z" fill={color} />
    </Svg>
  );
}

function CheckmarkIcon({ color = '#00ACC4' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path fillRule="evenodd" clipRule="evenodd" d="M8.00003 1C9.85655 1 11.6375 1.73705 12.9502 3.0498C14.263 4.36256 15 6.14348 15 8C15 9.38438 14.5894 10.7376 13.8203 11.8887C13.0512 13.0398 11.9578 13.937 10.6787 14.4668C9.39976 14.9966 7.99256 15.1352 6.6348 14.8652C5.27693 14.5951 4.0288 13.9292 3.04984 12.9502C2.07087 11.9712 1.40489 10.7231 1.1348 9.36523C0.86479 8.00747 1.00347 6.60027 1.53324 5.32129C2.06305 4.04223 2.96024 2.94884 4.11136 2.17969C5.26245 1.41062 6.61566 1 8.00003 1ZM10.2959 2.45703C9.19959 2.00293 7.993 1.88373 6.82913 2.11523C5.66538 2.34679 4.59688 2.91878 3.75784 3.75781C2.91881 4.59685 2.34682 5.66535 2.11527 6.8291C1.88376 7.99296 2.00296 9.19956 2.45706 10.2959C2.91119 11.3923 3.68033 12.33 4.66702 12.9893C5.65361 13.6483 6.81354 14 8.00003 14C9.59133 14 11.117 13.3674 12.2422 12.2422C13.3674 11.117 14 9.5913 14 8C14 6.81351 13.6484 5.65358 12.9893 4.66699C12.33 3.6803 11.3923 2.91116 10.2959 2.45703ZM11.5 6.20703L7.00003 10.707L4.50003 8.20605L5.20609 7.5L7.00003 9.29297L10.793 5.5L11.5 6.20703Z" fill={color} />
    </Svg>
  );
}

function RagequitIcon({ color = '#BA6B5D' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d="M10 2H13V14H10M6 5L3 8L6 11M3 8H11" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function ExitIcon({ color = '#4D4D4D' }: { color?: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 14 14" fill="none">
      <Path fillRule="evenodd" clipRule="evenodd" d="M4.85059 0.350582L5.15059 1.30058C5.74665 1.0999 6.37165 0.998553 7.00059 1.00058V0.000582048C6.26896 -0.00939926 5.54127 0.109063 4.85059 0.350582ZM1.35059 2.90059C1.77164 2.31297 2.27708 1.79068 2.85059 1.35059L3.45059 2.15059C2.95551 2.53676 2.51781 2.9913 2.15059 3.50059L1.35059 2.90059ZM0.350582 4.85059L1.30058 5.15059C1.0999 5.74665 0.998553 6.37165 1.00058 7.00059H0.000582048C-0.00939926 6.26896 0.109063 5.54127 0.350582 4.85059ZM0.350586 9.20057C0.582467 9.89779 0.919706 10.5554 1.35059 11.1506L2.15059 10.5506C1.78913 10.0445 1.50282 9.4887 1.30059 8.90057L0.350586 9.20057ZM4.85057 13.6506C4.15336 13.4187 3.49574 13.0815 2.90057 12.6506L3.50057 11.8506C4.00668 12.212 4.56244 12.4983 5.15057 12.7006L4.85057 13.6506ZM12.6506 11.1006C12.2116 11.6895 11.6895 12.2116 11.1006 12.6506L10.5006 11.8506C11.0225 11.4787 11.4787 11.0225 11.8506 10.5006L12.6506 11.1006ZM12.7006 8.85058L13.6506 9.15058C13.8681 8.45401 13.9859 7.73017 14.0006 7.00058H13.0006C13.0026 7.62952 12.9013 8.25451 12.7006 8.85058ZM12.6006 2.85059C13.0315 3.44575 13.3687 4.10337 13.6006 4.80059L12.6506 5.10059C12.4483 4.51246 12.162 3.95669 11.8006 3.45059L12.6006 2.85059ZM11.0506 1.30058C10.4554 0.869703 9.7978 0.532464 9.10058 0.300583L8.80058 1.25058C9.38871 1.45282 9.94448 1.73912 10.4506 2.10058L11.0506 1.30058ZM8.85058 12.7006L9.15058 13.6506C8.44767 13.84 7.72728 13.9573 7.00058 14.0006V13.0006C7.62952 13.0026 8.25451 12.9013 8.85058 12.7006Z" fill={color} />
    </Svg>
  );
}

function PendingIcon({ color = '#F4B740' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Circle cx={8} cy={8} r={7} stroke={color} strokeWidth={1.5} fill="none" />
      <Path d="M8 4V8.5L10.5 10" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function FailedIcon({ color = '#BA6B5D' }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path d="M12 4.7L11.3 4L8 7.3L4.7 4L4 4.7L7.3 8L4 11.3L4.7 12L8 8.7L11.3 12L12 11.3L8.7 8L12 4.7Z" fill={color} />
    </Svg>
  );
}

// Asset icons
function DaiIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#F5AC37" />
      <Path d="M6 10H14M6 8H14M10 4L6 10L10 16L14 10L10 4Z" stroke="white" strokeWidth={1} />
    </Svg>
  );
}

function WethIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Circle cx={10} cy={10} r={10} fill="#EC1C79" />
      <Path d="M10 4L10 8.5L13.5 10L10 4Z" fill="#F8A4CC" />
      <Path d="M10 4L6.5 10L10 8.5L10 4Z" fill="white" />
      <Path d="M10 12.5L10 16L13.5 10.75L10 12.5Z" fill="#F8A4CC" />
      <Path d="M10 16L10 12.5L6.5 10.75L10 16Z" fill="white" />
    </Svg>
  );
}

const ASSET_ICONS: Record<string, (props: { size?: number }) => React.JSX.Element> = {
  DAI: DaiIcon,
  WETH: WethIcon,
};

// Theme-keyed like TokenHues in constants/theme.ts: translucent tints over
// the scheme's surfaces, pastel borders/text on dark glass, deep ones on the
// light canvas.
const TYPE_STYLES: Record<'light' | 'dark', Record<string, { bg: string; border: string }>> = {
  dark: {
    Withdrawal: { bg: 'rgba(0,218,248,0.16)', border: '#7BE8FA' },
    Deposit: { bg: 'rgba(112,0,255,0.18)', border: '#d1bcff' },
    Exit: { bg: 'rgba(255,255,255,0.08)', border: '#A6B2B5' },
    Transfer: { bg: 'rgba(98,126,234,0.20)', border: '#9DB1F5' },
    Fee: { bg: 'rgba(255,255,255,0.08)', border: '#A6B2B5' },
    // In/Out share the Transfer hue so the column stays visually
    // consistent — only the label changes. Slightly tinted to make
    // direction scannable without screaming.
    'Transfer In': { bg: 'rgba(38,161,123,0.18)', border: '#4FD1A5' },
    'Transfer In & registration': { bg: 'rgba(38,161,123,0.18)', border: '#4FD1A5' },
    // Account setup paid from the balance (DEV-574): a cost, like a fee.
    'Gas for viewing key': { bg: 'rgba(255,255,255,0.08)', border: '#A6B2B5' },
    'Account setup': { bg: 'rgba(255,255,255,0.08)', border: '#A6B2B5' },
    'Transfer Out': { bg: 'rgba(232,163,61,0.16)', border: '#E8A33D' },
    Swap: { bg: 'rgba(167,139,250,0.18)', border: '#A78BFA' },
  },
  light: {
    Withdrawal: { bg: 'rgba(0,218,248,0.12)', border: '#006877' },
    Deposit: { bg: 'rgba(112,0,255,0.08)', border: '#5700C9' },
    Exit: { bg: 'rgba(16,23,24,0.06)', border: '#526164' },
    Transfer: { bg: 'rgba(39,117,202,0.10)', border: '#2D5DA8' },
    Fee: { bg: 'rgba(16,23,24,0.06)', border: '#526164' },
    'Transfer In': { bg: 'rgba(38,161,123,0.12)', border: '#1B7A5E' },
    'Transfer In & registration': { bg: 'rgba(38,161,123,0.12)', border: '#1B7A5E' },
    'Gas for viewing key': { bg: 'rgba(16,23,24,0.06)', border: '#526164' },
    'Account setup': { bg: 'rgba(16,23,24,0.06)', border: '#526164' },
    'Transfer Out': { bg: 'rgba(245,172,55,0.16)', border: '#9A6A0B' },
    Swap: { bg: 'rgba(124,58,237,0.10)', border: '#7C3AED' },
  },
};

// `fg` is the icon stroke/fill on the tinted badge — pastel on dark, deep on
// light, mirroring the TYPE_STYLES border convention. Completed and claim read
// the theme's success colour, so the checkmark and every success pill match.
const STATUS_CONFIG: Record<'light' | 'dark', Record<string, { icon: (props: { color?: string }) => React.JSX.Element; bg: string; fg: string; border: boolean }>> = {
  dark: {
    completed: { icon: CheckmarkIcon, bg: Colors.dark.successBg, fg: Colors.dark.success, border: false },
    pending: { icon: PendingIcon, bg: 'rgba(232,163,61,0.16)', fg: '#E8A33D', border: false },
    exit: { icon: ExitIcon, bg: 'transparent', fg: '#A6B2B5', border: true },
    failed: { icon: FailedIcon, bg: 'rgba(255,180,171,0.16)', fg: '#FFB4AB', border: false },
    // Fund states (services/funds-state.ts): at risk reads amber with the
    // alert glyph (pending is amber with the clock); claim is the accent, ringed.
    at_risk: { icon: FailedIcon, bg: 'rgba(232,163,61,0.16)', fg: '#E8A33D', border: false },
    claim: { icon: CheckmarkIcon, bg: Colors.dark.successBg, fg: Colors.dark.success, border: true },
  },
  light: {
    completed: { icon: CheckmarkIcon, bg: Colors.light.successBg, fg: Colors.light.success, border: false },
    pending: { icon: PendingIcon, bg: 'rgba(245,172,55,0.16)', fg: '#9A6A0B', border: false },
    exit: { icon: ExitIcon, bg: 'transparent', fg: '#526164', border: true },
    failed: { icon: FailedIcon, bg: 'rgba(186,26,26,0.10)', fg: '#BA1A1A', border: false },
    at_risk: { icon: FailedIcon, bg: 'rgba(245,172,55,0.16)', fg: '#9A6A0B', border: false },
    claim: { icon: CheckmarkIcon, bg: Colors.light.successBg, fg: Colors.light.success, border: true },
  },
};

// Pulse runs for at most `PULSE_DURATION_MS` once `active` becomes true,
// then stops regardless. Keeps the "fresh submission" feel from turning into
// a persistent distraction for any pending deposit in the list.
const PULSE_DURATION_MS = 6000;

function PulseRow({ children, active }: { children: React.ReactNode; active: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) { opacity.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.4, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(opacity, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    loop.start();
    const stopTimer = setTimeout(() => {
      loop.stop();
      opacity.setValue(1);
    }, PULSE_DURATION_MS);
    return () => { loop.stop(); clearTimeout(stopTimer); };
  }, [active, opacity]);
  // Always the same wrapper: swapping between a fragment and an Animated.View
  // when the pulse ended changed the element type above the row, so React
  // unmounted and remounted the whole row, a visible flash. At rest the
  // opacity is 1 and the wrapper is inert.
  // nw-keep(animated): looped Animated.Value opacity pulse (no className path)
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

// Web-only status-icon tooltip. Renders raw <div>/<span> elements so we get
// real DOM hover semantics with CSS-driven fade — react-native-web's hover
// abstractions can't position absolutely above an icon without leaking layout
// to the cell. Native still uses accessibilityLabel for VoiceOver/TalkBack.
/**
 * Token icon with the network it lives on badged onto its bottom-right corner.
 *
 * This is what lets the dedicated Chain column go away: the chain is a property
 * of the asset, so it rides the asset's icon instead of spending a whole column
 * on a word. The badge carries a card-coloured ring so it stays legible against
 * the token art underneath it.
 */
function AssetChainMark({ asset, chain, chainId, size = 22 }: { asset: string; chain: string; chainId?: number; size?: number }) {
  const testnet = chainId !== undefined && isTestnetChain(chainId);
  // The chain badge is driven by chainId through the SHARED mark, not by a
  // display-name lookup: CHAIN_ICONS only knew 'ETH'/'Sui', so every EVM row
  // (Ethereum, Sepolia AND Optimism) fell back to the Ethereum glyph — an OP
  // deposit was indistinguishable from a mainnet one (QA 2026-08-18).
  // TokenNetworkIcon also carries USDT, which ASSET_ICONS never had.
  // A yield share draws its underlying's mark (ppUSDC → USDC): the share IS
  // that asset held in the vault, and every ppUSDC / ppUSDT row read as
  // Ethereum because neither lookup knew the share symbol (Pat, 2026-09-05).
  const mark = displayTokenSymbol(asset).toUpperCase();
  // The shared marks first, then this file's few extra (DAI, WETH). Anything
  // else takes the shared letter mark: the old ETH-glyph fallback drew the
  // Ethereum logo on BNB, FDUSD and cBTC rows.
  const AssetIcon = hasTokenMark(mark) ? undefined : ASSET_ICONS[mark];
  const SharedAsset = !AssetIcon;
  const badge = Math.round(size * 0.46) + 2;
  return (
    <View
      className="relative shrink-0"
      // nw-keep(measured-or-inset): mark size is a prop so the dense list and the table can share one component
      style={{ width: size, height: size }}
      accessibilityLabel={`${displayTokenSymbol(asset)} on ${chain}${testnet ? ' (testnet)' : ''}`}
    >
      {SharedAsset ? (
        <TokenNetworkIcon symbol={mark} size={size} badgeSize={badge} chainId={chainId} />
      ) : (
        <>
          <AssetIcon size={size} />
          <ChainBadge size={badge} chainId={chainId} symbol={mark} />
        </>
      )}
    </View>
  );
}

function StatusBadgeWebTooltip({
  label,
  bg,
  iconColor,
  bordered,
  borderColor,
  Icon,
  width = 52,
}: {
  label: string;
  bg: string;
  iconColor: string;
  bordered: boolean;
  borderColor: string;
  Icon: (props: { color?: string }) => React.JSX.Element;
  /** Column width. Consolidated tables pass the tight icon-sized value. */
  width?: number;
}) {
  // Viewport coordinates of the badge, captured on hover; null = not hovered.
  // The bubble is PORTALED to <body> (see components/ui/tooltip-portal.web.tsx)
  // because it cannot win a z-index fight from inside the row: react-native-web
  // stamps `position: relative; z-index: 0` on every View, so each row and cell
  // is its own stacking context, and the filter header above the table carries
  // `z-[99999]` so its dropdowns can escape the card. The first row's tooltip
  // reached up into that header and the header's background + bottom border
  // painted straight over it — the reported "tooltip shows below the border".
  const [anchor, setAnchor] = useState<{ x: number; top: number; bottom: number } | null>(null);
  const [shown, setShown] = useState(false);
  // The hovered badge element, retained so the bubble can FOLLOW it: ancestor
  // animations (e.g. the home split-panel's translateX) move the badge without
  // any scroll/resize event firing (codex).
  const anchorElRef = useRef<HTMLElement | null>(null);
  const hovering = anchor !== null;

  // A fixed bubble does not follow its anchor on scroll/resize — dismiss there
  // (the pointer has left the badge in every case that matters). For layout
  // animation, remeasure per frame and move with the badge instead. The rAF
  // flip drives the fade — the portal mounts at opacity 0, then transitions in.
  useEffect(() => {
    if (!hovering) return;
    const raf = requestAnimationFrame(() => setShown(true));
    const hide = () => { anchorElRef.current = null; setAnchor(null); setShown(false); };
    window.addEventListener('scroll', hide, true); // capture: inner scrollers too
    window.addEventListener('resize', hide);
    let followRaf = 0;
    const follow = () => {
      const el = anchorElRef.current;
      if (el) {
        if (!el.isConnected) { hide(); return; } // row unmounted/virtualized away
        const r = el.getBoundingClientRect();
        setAnchor((prev) => {
          if (!prev) return prev;
          const next = { x: r.left + r.width / 2, top: r.top, bottom: r.bottom };
          return Math.abs(prev.x - next.x) > 0.5 || Math.abs(prev.top - next.top) > 0.5 ? next : prev;
        });
      }
      followRaf = requestAnimationFrame(follow);
    };
    followRaf = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(followRaf);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [hovering]);

  // Flip below the badge when there is no room above (first row of a table that
  // starts near the top of the viewport), so the bubble never leaves the screen.
  const openAbove = anchor === null || anchor.top > 44;

  // nw-keep(platform-css): web-only raw-DOM (createElement) hover-tooltip island — the whole
  // subtree renders via React.createElement to raw <div>/<span> so it uses real DOM CSS
  // (cursor, transition, calc/transform positioning, pointer-events); no className path here.
  const wrap: React.CSSProperties = {
    position: 'relative',
    width,
    padding: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'default',
  };
  // nw-keep(data-color): badge background + optional border read the runtime status palette props
  const badge: React.CSSProperties = {
    width: 24,
    height: 24,
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: bg,
    border: bordered ? `1px solid ${borderColor}` : 'none',
  };
  // nw-keep(platform-css): web-only tooltip bubble — viewport-fixed anchoring off the badge's
  // measured rect, opacity transition, pointer-events, box-shadow; all runtime values, and the
  // node lives in <body> (portal) where no className path reaches it anyway.
  const tooltip: React.CSSProperties = {
    position: 'fixed',
    left: anchor?.x ?? 0,
    top: openAbove ? (anchor?.top ?? 0) - 4 : (anchor?.bottom ?? 0) + 4,
    transform: openAbove ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
    background: '#1A1B1D',
    color: '#fff',
    padding: '6px 10px',
    borderRadius: 4,
    fontFamily: Fonts.medium,
    fontWeight: FontWeights.medium,
    fontSize: 11,
    lineHeight: '14px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    opacity: shown ? 1 : 0,
    transition: 'opacity 120ms ease',
    zIndex: 100000,
    boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
  };
  // nw-keep(platform-css): web-only CSS-triangle tooltip arrow (border trick) in the DOM island
  const arrow: React.CSSProperties = {
    position: 'absolute',
    ...(openAbove
      ? { top: '100%', borderTop: '5px solid #1A1B1D' }
      : { bottom: '100%', borderBottom: '5px solid #1A1B1D' }),
    left: '50%',
    transform: 'translateX(-50%)',
    width: 0,
    height: 0,
    borderLeft: '5px solid transparent',
    borderRight: '5px solid transparent',
  };
  return React.createElement(
    'div',
    {
      style: wrap,
      // Measure from the event target: no ref, so nothing to read during render.
      onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => {
        anchorElRef.current = e.currentTarget;
        const r = e.currentTarget.getBoundingClientRect();
        setAnchor({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
      },
      onMouseLeave: () => { anchorElRef.current = null; setAnchor(null); setShown(false); },
      'aria-label': label,
      'data-testid': 'tx-status-badge',
    },
    React.createElement('div', { style: badge }, React.createElement(Icon, { color: iconColor })),
    anchor === null
      ? null
      : React.createElement(
          TooltipPortal,
          null,
          React.createElement(
            'span',
            { style: tooltip, role: 'tooltip' },
            label,
            React.createElement('span', { style: arrow }),
          ),
        ),
  );
}

/**
 * A deposit is "fully spent" once its lineage holds no live value —
 * the original was withdrawn, ragequit, or otherwise consumed and
 * the SDK's 0-value change note is the only thing left. Returns the
 * set of root deposit txHashes (lowercase) that are in this state.
 *
 * Decided by the lineages each tx STARTED (services/fully-spent.ts): a
 * reshield tx holds the source side's change next to the new deposit's note,
 * and only the new deposit's lineage speaks for that row (Mike, 2026-09-24).
 */
function computeFullySpentDepositTxs(notesByChain: ReadonlyMap<number, readonly unknown[]>): Map<number, Set<string>> {
  return fullySpentDepositTxHashesByChain(notesByChain as ReadonlyMap<number, readonly SpendableNoteLike[]>, isLiveNoteStatus);
}

/**
 * Decimals for a transfer row's raw amount. A Stellar note's tokenId is a
 * Soroban contract id the EVM token registry does not know, so its 18-decimal
 * fallback printed 2 XLM as "<0.00001". Stellar pools hold the native asset.
 */
function transferRowDecimals(tx: Pick<Transaction, 'tokenAddress' | 'chainId'>): number {
  const chain = getChainConfig(tx.chainId);
  if (chain?.chainType === 'stellar') return chain.nativeCurrency.decimals;
  return getTokenMetadata(tx.tokenAddress, tx.chainId).decimals ?? 18;
}

function isDepositFullySpentByTxHash(tx: Pick<Transaction, 'type' | 'txHash' | 'chainId'>, fullySpentTxs: ReadonlyMap<number, Set<string>>): boolean {
  if (tx.type !== 'Deposit') return false;
  if (!tx.txHash) return false;
  return fullySpentTxs.get(tx.chainId)?.has(tx.txHash.toLowerCase()) ?? false;
}

function getTransactionTypeStyle(tx: Pick<Transaction, 'type' | 'status'>, scheme: 'light' | 'dark') {
  const normalizedType = tx.type.charAt(0).toUpperCase() + tx.type.slice(1);

  // Deposits wear their status hue (completed cyan / pending amber / failed
  // red) so in-flight rows read at a glance — route through STATUS_CONFIG so
  // the pill and status icon always agree.
  if (normalizedType === 'Deposit') {
    const statusCfg = STATUS_CONFIG[scheme][tx.status];
    if (statusCfg && tx.status !== 'exit') {
      return { bg: statusCfg.bg, border: statusCfg.fg, text: statusCfg.fg };
    }
  }

  const typeStyles = TYPE_STYLES[scheme];
  const baseStyle = typeStyles[normalizedType] || typeStyles[tx.type] || typeStyles.Exit;
  return { ...baseStyle, text: baseStyle.border };
}

// Detail rows in the activity-card idiom: muted label left, emphasised
// value right, hairline between rows. A transaction is a link out to its
// explorer (the arrow says it leaves the app); an address is something people
// paste, so it carries the copy control instead of a link.
function DetailRow({ label, value, mono, href, explorerName, copy, singleLine, last }: { label: string; value: string; mono?: boolean; href?: string; explorerName?: string; copy?: boolean; singleLine?: boolean; last?: boolean }) {
  const { colorScheme } = useTheme();
  const display = singleLine && value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
  const valueClass = `min-w-0 shrink text-right text-[12.5px] text-text ${mono ? 'font-pp-mono' : 'font-pp-sans-medium'}`;
  return (
    <View className={`flex-row items-center justify-between gap-[14px] px-[14px] py-[10px]${last ? '' : ' border-b border-b-border-light'}`}>
      <Text className="shrink-0 font-pp-sans text-[12px] text-text-muted">{label}</Text>
      {href ? (
        <View className="min-w-0 shrink flex-row items-center justify-end gap-[6px]">
        {explorerName ? <ExplorerPrivacyHint explorerName={explorerName} size={12} /> : null}
        <Text
          accessibilityRole="link"
          onPress={() => { void Linking.openURL(href); }}
          className={valueClass}
          numberOfLines={1}
        >
          {display}
          {/* The arrow is decoration: hidden, the icon font's private-use
              glyph stays out of the link's accessible name, which is the
              hash and nothing else. */}
          <Text aria-hidden>
            {' '}
            {/* nw-keep(data-color): icon color is a theme token into the vector-icon sink */}
            <Ionicons name="open-outline" size={12} color={Colors[colorScheme].textMuted} />
          </Text>
        </Text>
        </View>
      ) : copy ? (
        <Text className={valueClass} numberOfLines={1}>
          {display}
          <CopyIconButton value={value} label={label} leading=" " />
        </Text>
      ) : (
        <Text
          className={valueClass}
          selectable
          numberOfLines={singleLine ? 1 : 2}
          ellipsizeMode={singleLine ? 'middle' : 'tail'}
        >
          {value}
        </Text>
      )}
    </View>
  );
}

/** One leg of a two-leg hero (a swap): token mark with its chain badge, a
 *  caption, the amount, and the network with the leg's value. On a narrow
 *  card the network and value drop under the amount as one line. */
function DetailLeg({ leg, caption, amount, usd, narrow }: { leg: RowLeg & { chain: string }; caption: string; amount: string; usd: string; narrow: boolean }) {
  const network = getChainConfig(leg.chainId)?.displayName ?? leg.chain;
  const side = [network, usd].filter(Boolean).join(' · ');
  return (
    <View className="flex-row items-center gap-[12px] rounded-inner border border-border-light bg-card-background px-[14px] py-[12px]">
      <AssetChainMark asset={leg.asset} chain={leg.chain} chainId={leg.chainId} size={28} />
      <View className="min-w-0 flex-1 gap-[1px]">
        <Text numberOfLines={1} className="font-pp-sans text-[11.5px] text-text-muted">{caption}</Text>
        <Text numberOfLines={1} className="font-pp-bold text-[17px] text-text">{amount}</Text>
        {narrow && side ? <Text numberOfLines={1} className="font-pp-sans text-[11.5px] text-text-muted">{side}</Text> : null}
      </View>
      {!narrow && side ? (
        <Text numberOfLines={1} className="shrink-0 font-pp-sans text-[12px] text-text-muted">{side}</Text>
      ) : null}
    </View>
  );
}

export function TransactionDetailModal({ tx, onClose, onCloseForAction, actions }: {
  tx: Transaction;
  onClose: () => void;
  /** Close before an action runs: drops the URL entry synchronously (see ui-entry-retire). */
  onCloseForAction?: () => void;
  /**
   * DEV-553: on phone web the row has no menu, so its actions (Withdraw, Exit,
   * Export note, explorer, links) are listed here. Omitted elsewhere.
   */
  actions?: TransactionRowMenuItem[];
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const isDark = colorScheme === 'dark';

  // Web: Escape closes the detail modal. Capture phase + stopPropagation so
  // the hosting activity drawer's own Escape listener (bubble phase) doesn't
  // also fire and close the drawer underneath in the same keypress.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);
  const date = new Date(tx.timestamp);
  const fullDate = date.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'medium' });

  // Decode Transfer direction from owned notes for the detail header.
  // Falls back to plain "Transfer" when the user has no relevant notes.
  // The SESSION chain's notes, deliberately: another chain's notes include the
  // change of an own send there, and without a reconstructed spend that change
  // reads as "Transfer In" for the change amount, which is worse than
  // "Private". Other chains' own spends get their amount from the lineage row
  // (pools-provider reconstructs from every chain's notes).
  const { notes } = useNotes();
  const { data: poolsData } = usePools();
  // The detail header speaks the same units as the row that opened it.
  const { rateFor: rateForDetail } = useShareRates();
  const balanceDisplay = useShareFreeBalanceDisplay(tx.chainId);
  const exactUnitsLabel = (wei: bigint, decimals: number, symbol: string) => isShareSymbol(symbol)
    ? balanceDisplay(formatUnits(wei, decimals), symbol, tx.chainId, tx.tokenAddress).text
    : tokenAmountLabel(detailAmountDigits(formatFeeUnits(wei, decimals), displayTokenSymbol(symbol)), symbol);
  const detailRate = isShareSymbol(tx.asset) ? rateForDetail(tx.chainId, tx.tokenAddress) : undefined;
  const detailPrice = detailRate ? underlyingPriceFor(detailRate, poolsData.priceMap) : 0;
  // Same rule as the feed row (services/share-display.ts): the underlying's
  // name always, exact with the rate, approximate without it.
  const detailAmount = (n: number): string => balanceDisplay(n, tx.asset, tx.chainId, tx.tokenAddress).text;
  const detailUsd = (n: number, fallback: number): string => (detailRate && detailPrice > 0
    ? `≈ ${formatUsd(shareNumberAsUnderlying(n, detailRate) * detailPrice)}`
    : `≈ $${fallback.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  const sentTxHashes = useMemo(() => buildSentTxHashSet(), []);
  const sentRecord = tx.type === 'Transfer' ? findSentTransfer(tx.txHash) : null;
  // Same two stores as the list row: a payment-request payment is stamped in
  // paid-requests, not sent-transfers, and the row builder mirrors both onto
  // fullAddress. Without this the detail panel said "Private" about a payee the
  // user themselves had chosen.
  const detailPayee = tx.type === 'Transfer'
    ? (recordedTransferPayee(tx.txHash) ?? (tx.fullAddress || null))
    : null;
  // Prefer an explicit direction set on lineage-synthesized rows (#215); fall
  // back to the sender-stamp/notes heuristic for real event rows. Audit logic
  // is unchanged — this only resolves in/out.
  // A paid payment request is stamped in paid-requests, NOT sent-transfers, so
  // the note heuristic sees only the payer's own change note and calls it "in".
  // A paid-request record exists only when THIS device paid it, so it is exact
  // evidence of an outgoing spend and outranks the heuristic.
  const direction = tx.type === 'Transfer'
    ? (tx.direction ?? (findPaidRequest(tx.txHash) ? 'out' : classifyTransfer(tx, notes, sentTxHashes, poolsData.anchorTxHashes)))
    : null;
  // Not yet known to be a stranger's while my spends on its chain are still
  // being classified (the list row's rule).
  const transferResolving = tx.type === 'Transfer' && !direction
    && poolsData.ownTransfersPendingChainIds.includes(tx.chainId);
  // Per-note state is read from the row's own chain's notes.
  const { isDepositMine: isDepositMineForDetail, isDepositAuthoredByMe, notesByChain, ownAddress } = useMyTransactionOwnership();
  // Named as its list row is (services/row-type-label.ts).
  const displayType = rowTypeLabel({ ...tx, direction: direction ?? undefined, authored: isDepositAuthoredByMe(tx) });
  const feeAmountRow = isFeeAmountRow(tx);
  // A Swap row's output is a deposit of its own: fully spent once its lineage is.
  const swap = isSwapRow(tx) ? tx : null;
  const { width: windowWidth } = useWindowDimensions();
  const fullySpentTxs = useMemo(() => computeFullySpentDepositTxs(notesByChain), [notesByChain]);
  const isFullySpent = isDepositFullySpentByTxHash(swap ? swapOutputDepositView(swap) : tx, fullySpentTxs);
  const schemeTypeStyles = TYPE_STYLES[colorScheme];
  const typeStyle = direction
    ? { ...(schemeTypeStyles[displayType] || schemeTypeStyles.Transfer), text: (schemeTypeStyles[displayType] || schemeTypeStyles.Transfer).border }
    : isFullySpent
      ? { ...schemeTypeStyles.Exit, text: schemeTypeStyles.Exit.border }
      : getTransactionTypeStyle(tx, colorScheme);
  const typeColor = typeStyle.text || colors.text;
  // For the user's own transfers, decode the actual amount from
  // local notes; for everyone else's the on-chain `tokenAmount`
  // is just the public relayer fee, which would mislead.
  let transferRaw = direction && direction !== 'self'
    ? computeUserTransferAmount(
        tx, notes, direction,
        // A paid request's amount lives in paid-requests, so without this the
        // event row shows a bare fee and no reconciled total.
        sentRecord?.rawAmount ?? findPaidRequest(tx.txHash)?.rawAmount ?? null,
      )
    : null;
  // Lineage-synthesized rows (#215) carry the exact amount on the row (the
  // recipient note value). Use it when the note-scan returns null — e.g. a
  // note pruned from local state that the reconstruction still knows about.
  if (transferRaw === null && direction && direction !== 'self' && tx.isLineageSynthetic) {
    try { transferRaw = BigInt(tx.rawAmount); } catch { transferRaw = null; }
  }
  let transferTokenAmount: number | null = null;
  let transferUsd: number | null = null;
  if (transferRaw !== null) {
    const decimals = transferRowDecimals(tx);
    transferTokenAmount = Number(transferRaw) / Math.pow(10, decimals);
    // The row's own chain's price: the bare keys belong to the active chain.
    const price = priceFromMap(poolsData.priceMap ?? {}, { chainId: tx.chainId, address: tx.tokenAddress, symbol: tx.asset }) ?? 0;
    transferUsd = price > 0 ? transferTokenAmount * price : null;
  }
  // The relayer fee: the one number that makes a user's own arithmetic work,
  // and the one the feed can never carry. A transfer's row amount EXCLUDES it
  // (the relayer charges on top of what the recipient gets); a withdrawal's row
  // amount INCLUDES it (the gross left the pool). Either way, summing rows and
  // comparing to the balance came out wrong, which is what users report as
  // "money missing" (Mike, 2026-08-26). We stamped the fee at send time in
  // services/withdraw-fees-store, so name it here and show the reconciled
  // total next to it.
  // A batch relay emits one Transacted log per item, so the feed holds several
  // Withdrawal rows under ONE tx hash while the stamp keeps a single aggregate
  // fee. Showing that aggregate against a per-item gross would understate every
  // item, so the fee belongs only on a row that represents the whole tx (the
  // collapsed lineage row in My Transactions).
  const isBatchItemRow = tx.type === 'Withdrawal' && !!tx.txHash && !tx.isLineageSynthetic
    && poolsData.transactions.filter((t) => (t.txHash || '').toLowerCase() === tx.txHash.toLowerCase()).length > 1;
  // The fee recorded for this operation (services/relayer-fee-row.ts): the
  // stamp written at submit time, or, without one (another device, cleared
  // storage), the withdrawnValue the chain carries for an outgoing transfer. A
  // claimed payment's fee is the claim tx's. A withdrawal folds its fee into
  // the gross on-chain, so only the stamp can split it out. No record, no row.
  const relayerFee = relayerFeeFor({
    type: tx.type,
    direction: direction ?? null,
    txHash: tx.txHash,
    claimTxHash: tx.claimTxHash,
    claimTxHashes: tx.claimTxHashes,
    relayFeeRaw: tx.relayFeeRaw,
    feeAmountRow,
    rawAmount: tx.rawAmount,
    isBatchItemRow,
    findFee: findWithdrawFee,
  });
  // What a fee was worth, beside it, as the review step prints it. The price
  // stamped when this device paid it (services/withdraw-fees-store, read from
  // the public price feed it already held) is the historical figure. Without
  // one there is no private way to learn a past price, so today's is shown and
  // says so.
  const feeUsdNote = (wei: bigint, decimals: number, stampedPrice: number | undefined): string =>
    relayerFeeUsdNote(Number(wei) / 10 ** decimals, {
      stamped: stampedPrice,
      now: priceFromMap(poolsData.priceMap ?? {}, { chainId: tx.chainId, address: tx.tokenAddress, symbol: tx.asset }),
      stablecoin: isStablecoin(displayTokenSymbol(tx.asset)),
    });
  let feeText: string | null = null;
  let reconciledLabel: string | null = null;
  let reconciledText: string | null = null;
  if (relayerFee) {
    try {
      const feeWei = relayerFee.wei;
      const decimals = getTokenMetadata(tx.tokenAddress, tx.chainId).decimals ?? 18;
      // Exact, not the 4-dp balance formatter: it renders a real 0.000540 fee
      // as "0.0005" and anything under 0.0001 as "<0.0001", which is useless
      // for the arithmetic these two rows exist to support. Kept in bigint all
      // the way so nothing is lost to floating point either.
      const exact = (v: bigint) => exactUnitsLabel(v, decimals, tx.asset);
      feeText = exact(feeWei) + feeUsdNote(feeWei, decimals, relayerFee.priceUsd);
      if (tx.type === 'Transfer' && direction !== 'in' && transferRaw !== null) {
        reconciledLabel = 'Total spent';
        reconciledText = exact(transferRaw + feeWei);
      } else if (tx.type === 'Withdrawal') {
        const gross = BigInt(tx.rawAmount);
        if (gross > feeWei) {
          // Not "You received": on a swap exit ("Receive as") this net is
          // what went INTO the swap, and the user received the output token.
          // "Net after fee" is exact for both shapes.
          reconciledLabel = 'Net after fee';
          reconciledText = exact(gross - feeWei);
        }
      }
    } catch {
      // A malformed stored fee must never break the detail panel.
      feeText = null;
      reconciledText = null;
    }
  }
  // A claimed payment link is a Transfer In row. What the claim cost in all
  // (relayer fee plus any gas top-up, and the registration when it rode
  // along) rides on the row itself and used to have a Fee row of its own
  // (DEV-450). Its relayer fee alone is the Relayer fee row above, when this
  // device recorded it (DEV-517).
  let claimFeeText: string | null = null;
  if (tx.claimCostRaw) {
    try {
      const cost = BigInt(tx.claimCostRaw);
      if (cost > 0n) {
        const decimals = getTokenMetadata(tx.tokenAddress, tx.chainId).decimals ?? 18;
        // The same figure as the Relayer fee row says nothing new.
        if (!(relayerFee && relayerFee.wei === cost)) {
          claimFeeText = exactUnitsLabel(cost, decimals, tx.asset) + feeUsdNote(cost, decimals, undefined);
        }
      }
    } catch {
      claimFeeText = null;
    }
  }

  // Rows whose amount is the relayer fee print it exactly; a consolidation
  // leads with its note counts and keeps the fee underneath.
  const rowDecimals = getTokenMetadata(tx.tokenAddress, tx.chainId).decimals ?? 18;
  const exactFeeText = feeAmountRow ? exactUnitsLabel(feeRowWei(tx), rowDecimals, tx.asset) : '';
  const consolidationText = consolidationHeadline(tx);
  const headerAmount = feeAmountRow
    ? consolidationText ?? exactFeeText
    : tx.type === 'Transfer' && transferTokenAmount !== null
    ? detailAmount(transferTokenAmount)
    : tx.type === 'Transfer'
      ? (transferResolving ? TRANSFER_RESOLVING_COPY : 'Private')
      : detailAmount(tx.tokenAmount);
  const headerUsd = consolidationText
    ? `Fee ${exactFeeText}`
    : feeAmountRow
      ? detailUsd(tx.tokenAmount, tx.usdValue)
    : tx.type === 'Transfer' && transferUsd !== null
    ? (transferTokenAmount !== null ? detailUsd(transferTokenAmount, transferUsd) : `≈ $${transferUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
    : tx.type === 'Transfer'
      ? ''
      : detailUsd(tx.tokenAmount, tx.usdValue);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);


  // Two legs (a swap, a receive-as withdrawal, a Shield swap), each in the
  // units its own row would use: a share prints the underlying it is worth.
  // A leg that is only a quote is marked ≈.
  const legs = rowLegs(tx);
  const legUnits = (leg: SwapLeg) => {
    const rate = isShareSymbol(leg.asset) ? rateForDetail(leg.chainId, leg.tokenAddress) : undefined;
    return { rate, amount: rate ? shareNumberAsUnderlying(leg.tokenAmount, rate) : leg.tokenAmount };
  };
  const legAmount = (leg: SwapLeg, approx = false) => {
    const text = balanceDisplay(leg.tokenAmount, leg.asset, leg.chainId, leg.tokenAddress).text;
    return approx && !text.startsWith('\u2248') ? `\u2248 ${text}` : text;
  };
  const legUsd = (leg: SwapLeg) => {
    const { rate, amount } = legUnits(leg);
    const price = rate ? underlyingPriceFor(rate, poolsData.priceMap) : 0;
    const usd = rate && price > 0 ? amount * price : leg.usdValue;
    return usd > 0 ? `\u2248 ${usd < 0.01 ? '<$0.01' : formatUsdPrecise(usd)}` : '';
  };
  // Effective rate: what one unit of the source bought, both legs in the
  // underlying a share stands for. Only once a swap's output is known.
  let effectiveRate: string | null = null;
  if (swap && !swap.swapOut.delivering && legs) {
    const inUnits = legUnits(legs.from).amount;
    const outUnits = legUnits(legs.to).amount;
    if (inUnits > 0 && outUnits > 0) {
      const outSymbol = displayTokenSymbol(legs.to.asset);
      effectiveRate = `1 ${displayTokenSymbol(legs.from.asset)} = ${tokenAmountLabel(formatTokenBalance(outUnits / inUnits, outSymbol), outSymbol)}`;
    }
  }
  // The route the value took, opened only when tapped (services/lifi-scan.ts).
  const lifiUrl = viaSwapRoute(tx) ? lifiScanUrl(tx.txHash) : null;
  // A receive-as payout is in another token, so a net in the input token says
  // nothing; a bridge that did not deposit is described by its delivery.
  const showReconciled = !tx.receivedAs && !tx.delivery;
  const deliveryText = tx.delivery === 'failed' ? "Didn't arrive" : tx.delivery ? 'Recovered to your wallet' : null;
  // My own deposit the ASP tags as funded out of a pool on another network: a
  // swap made elsewhere arrived here. Strangers' rows stay as published, and a
  // device with the Shield record already shows what paid for it.
  const fundedBySwapRow = fundedBySwap(tx, isDepositMineForDetail(tx));

  type DetailRowProps = Omit<Parameters<typeof DetailRow>[0], 'last'>;
  const detailRows: DetailRowProps[] = [];
  // Facts first, then the transaction links. A swap names no recipient (its
  // row carries no address): the output is a note in a pool, which the card
  // already shows.
  if (deliveryText) detailRows.push({ label: 'Delivery', value: deliveryText });
  if (fundedBySwapRow) detailRows.push({ label: 'Funded by', value: 'A swap from another network' });
  if (direction === 'self') {
    // Every output is my own note: the recipient is this account, named by its
    // address like a Deposit's.
    if (ownAddress) detailRows.push({ label: 'Recipient', value: ownAddress, mono: true, singleLine: true, copy: true });
  } else if (tx.type === 'Transfer') {
    // The chain names no counterparty of a private transfer, not even to its
    // sender; only the sending device's records do (recordedTransferPayee).
    // "Private" is for a stranger's transfer, whose counterparty nobody can
    // know. My own transfer is not private to me, so without a record here it
    // has no counterparty row rather than a placeholder.
    if (detailPayee) detailRows.push({ label: 'Recipient', value: detailPayee, mono: true, singleLine: true, copy: true });
    else if (!direction && !transferResolving) detailRows.push({ label: 'Address', value: 'Private' });
  } else if (tx.fullAddress && !fundedBySwapRow) {
    // A bridged arrival's depositor is the bridge's executor, not a party. My
    // own withdrawal names the recipient this device recorded when it sent
    // it; a receive-as one names the wallet its payout went to.
    const ownRecipient = tx.type === 'Withdrawal' && !tx.receivedAs
      && findWithdrawRecipient(tx.txHash, tx.chainId) === tx.fullAddress.toLowerCase();
    detailRows.push({ label: ownRecipient ? 'Recipient' : 'Address', value: tx.fullAddress, mono: true, singleLine: true, copy: true });
  }
  if (effectiveRate) detailRows.push({ label: 'Effective rate', value: effectiveRate });
  if (consolidationText) detailRows.push({ label: 'Notes', value: consolidationText });
  if (direction === 'self' && tx.movedAmountRaw) {
    detailRows.push({ label: 'Amount moved', value: exactUnitsLabel(rawWei(tx.movedAmountRaw), rowDecimals, tx.asset) });
  }
  if (feeText) detailRows.push({ label: 'Relayer fee', value: feeText });
  if (claimFeeText) detailRows.push({ label: tx.withRegistration ? 'Claim and registration fee' : 'Claim fee', value: claimFeeText });
  if (showReconciled && reconciledLabel && reconciledText) detailRows.push({ label: reconciledLabel, value: reconciledText });
  // Two transactions when a cross-chain swap has delivered, one otherwise.
  const receiveTx = swap?.swapOut.deliveryTxHash;
  if (tx.txHash) {
    detailRows.push({ label: receiveTx ? 'Swap transaction' : 'Transaction', value: tx.txHash, mono: true, singleLine: true, href: getExplorerTxUrl(tx.chainId, tx.txHash), explorerName: getExplorerName(tx.chainId) });
  }
  if (swap && receiveTx) {
    detailRows.push({ label: 'Receive transaction', value: receiveTx, mono: true, singleLine: true, href: getExplorerTxUrl(swap.swapOut.chainId, receiveTx), explorerName: getExplorerName(swap.swapOut.chainId) });
  }
  if (lifiUrl) detailRows.push({ label: 'Swap route', value: 'LI.FI Scan', href: lifiUrl, explorerName: 'LI.FI Scan' });

  // Hero visuals — the same glyph + hue language as the list rows.
  const heroSource = feeAmountRow ? tx.type : displayType;
  const heroBase = isFullySpent ? 'Exit' : transactionBaseType(heroSource);
  const heroGlyph = transactionTypeGlyph(heroSource, heroBase);
  const heroGlyphColor = transactionTypeColor(heroBase, colors, colorScheme);
  const statusPending = tx.status === 'pending';
  const statusFailed = tx.status === 'failed';

  // Use React Native's Modal so the overlay portals to document.body on web
  // and covers the whole viewport regardless of the parent's stacking context
  // or overflow:hidden (the previous absolute backdrop was getting clipped by
  // the <Card> wrapping the transactions list).
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="absolute inset-0 bg-[rgba(0,0,0,0.6)]" onPress={onClose} />
      <View className="absolute inset-0 z-[999999] items-center justify-center p-[20px]" pointerEvents="box-none">
      <View className="max-h-[85%] w-full max-w-[560px] overflow-hidden rounded-card border border-border bg-card-background">
        {/* Top strip: full date left, close right — the type now reads from
            the hero card below instead of a pill. */}
        <View className="flex-row items-center justify-between px-[18px] pb-[4px] pt-[14px]">
          <Text className="font-pp-sans text-[12px] text-text-muted">{fullDate}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close transaction details" onPress={onClose} hitSlop={8} className="h-[28px] w-[28px] items-center justify-center">
            <Text className="font-pp-regular text-[18px] text-text-muted">✕</Text>
          </Pressable>
        </View>

        {/* Hero, the same for every row type: the type on the left and its
            status pills on the right (they wrap under on a phone rather than
            truncate the type), then the asset and the amount, in the same
            figures as the row that opened it. */}
        <View className="mx-[16px] mt-[6px] gap-[12px] rounded-inner bg-background-secondary px-[16px] py-[14px]">
          <View className="flex-row flex-wrap items-center justify-between gap-x-[12px] gap-y-[8px]">
            <View className="shrink flex-row items-center gap-[6px]">
              {/* nw-keep(data-color): per-type glyph hue (theme token / bespoke transfer purple) into the vector-icon sink */}
              <Ionicons name={heroGlyph} size={16} color={heroGlyphColor} />
              <Text numberOfLines={1} className="shrink font-pp-semi-bold text-[15px] text-text">{displayType}</Text>
            </View>
            <View className="flex-row flex-wrap items-center gap-[6px]">
              {/* "Pending" next to "ASP pending" said the same thing twice (Pat,
                  2026-09-02): a deposit is pending BECAUSE the ASP has not ruled
                  yet. When both would read pending, the ASP pill carries the
                  information and the generic status pill yields. Any other
                  combination (completed + ASP approved, failed, declined) stays
                  two facts and keeps two pills. */}
              {/* A cross-chain swap the bridge did not deposit left the pool but
                  did not complete: the pill says how it ended instead. */}
              {deliveryText ? (
                <Pill tone="warning" label={tx.delivery === 'failed' ? "Didn't arrive" : 'Recovered'} />
              ) : statusPending && tx.reviewStatus === 'pending' ? null : (
                <Pill
                  tone={statusPending ? 'warning' : statusFailed ? 'danger' : 'success'}
                  label={tx.status.charAt(0).toUpperCase() + tx.status.slice(1)}
                />
              )}
              {swap?.swapOut.delivering ? (
                <Pill tone="warning" label="Delivering" />
              ) : null}
              {tx.fundsState && tx.fundsReason && tx.fundsState !== 'ready' ? (
                <Pill
                  tone={tx.fundsState === 'at_risk' ? 'danger' : 'warning'}
                  label={fundsChipText({ state: tx.fundsState, reason: tx.fundsReason })}
                />
              ) : null}
              {/* A withdrawal through a swap route is described by its route;
                  an ASP verdict on the spend adds nothing there. */}
              {tx.reviewStatus && !(tx.type === 'Withdrawal' && viaSwapRoute(tx)) ? (
                <Pill
                  tone={tx.reviewStatus === 'approved' ? 'success' : tx.reviewStatus === 'declined' ? 'danger' : 'warning'}
                  label={tx.reviewStatus === 'poi_required' ? 'Proof required' : `0xbow ASP ${tx.reviewStatus}`}
                />
              ) : null}
              {isFullySpent ? (
                <Pill tone="neutral-inset" label="Fully spent" />
              ) : null}
            </View>
          </View>
          {/* The badge on the mark names the network, so no chain line. A
              swap shows both legs joined by the arrow chip, as the action
              widget does. */}
          {legs ? (
            <View>
              <DetailLeg leg={legs.from} caption={legs.fromCaption} amount={legAmount(legs.from, legs.fromApprox)} usd={legUsd(legs.from)} narrow={windowWidth < 440} />
              <View className="z-[1] items-center">
                <PairArrow color={colors.text} marginTop={-10} marginBottom={-10} />
              </View>
              <DetailLeg leg={legs.to} caption={legs.toCaption} amount={legAmount(legs.to, legs.toApprox)} usd={legUsd(legs.to)} narrow={windowWidth < 440} />
            </View>
          ) : (
          <View className="flex-row items-center gap-[12px]">
            <AssetChainMark asset={tx.asset} chain={tx.chain} chainId={tx.chainId} size={40} />
            <View className="min-w-0 flex-1 gap-[2px]">
              <Text numberOfLines={1} className="font-pp-bold text-[20px] text-text">{headerAmount}</Text>
              <ShareCountHint hint={balanceDisplay(transferTokenAmount ?? tx.tokenAmount, tx.asset, tx.chainId, tx.tokenAddress).hint} />
              {headerUsd ? <Text numberOfLines={1} className="font-pp-sans text-[12px] text-text-muted">{headerUsd}</Text> : null}
            </View>
          </View>
          )}
        </View>

        {/* Details — one bordered card, hairline rows. Only rows with a value
            render, so the card never shows an empty Address or a lone border. */}
        {(detailRows.length > 0 || (actions && actions.length > 0)) && (
          <ScrollView className="px-[16px] py-[12px]">
            {detailRows.length > 0 && (
            <View className="overflow-hidden rounded-inner border border-border-light">
              {detailRows.map((row, i) => (
                <DetailRow key={row.label} {...row} last={i === detailRows.length - 1} />
              ))}
            </View>
            )}
            {actions && actions.length > 0 && (
              <View className={`overflow-hidden rounded-inner border border-border-light ${detailRows.length > 0 ? 'mt-[12px]' : ''}`} testID="transaction-detail-actions">
                {actions.map((item, i) => (
                  <Pressable
                    key={item.key}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    testID={`transaction-detail-action-${item.key}`}
                    // Close first, synchronously: the action opens its own modal
                    // (which pushes its own URL entry) or leaves the page.
                    onPress={() => { (onCloseForAction ?? onClose)(); item.onPress(); }}
                    className={`flex-row items-center gap-[10px] px-[14px] py-[12px] active:bg-background-secondary ${i < actions.length - 1 ? 'border-b border-b-border-light' : ''}`}
                  >
                    {item.icon}
                    <View className="min-w-0 flex-1">
                      {/* nw-keep(data-color): per-item override color (Exit red) or the theme text token */}
                      <Text numberOfLines={1} className="font-pp-sans-medium text-[14px]" style={{ color: item.color ?? colors.text }}>{item.label}</Text>
                      {item.warning ? <Text className="font-pp-sans text-[11.5px] text-danger">{item.warning}</Text> : null}
                    </View>
                    {/* nw-keep(data-color): chevron glyph is a theme token into the vector-icon sink */}
                    <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>
        )}

        {/* Footer: Contact, only while something needs attention. The
            explorer link is the Transaction row itself. */}
        {tx.status === 'pending' || tx.status === 'failed' || tx.fundsState === 'at_risk' ? (
        <View className="flex-row items-center justify-center gap-[10px] px-[16px] pb-[16px] pt-[2px]">
            <Pressable
              className="flex-row items-center gap-[6px] rounded-pill border border-border px-[16px] py-[8px] active:bg-background-secondary"
              onPress={() => Linking.openURL('https://docs.google.com/forms/d/e/1FAIpQLSe0UKiTrZ4kD0apx75bEW0PWqJxpd6bCYh_IUKBrCkJOBzkpQ/viewform')}
            >
              {/* nw-keep(data-color): icon color is a theme token into the @expo/vector-icons sink (no className path) */}
              <Ionicons name="mail-outline" size={14} color={colors.text} />
              <Text className="font-pp-sans-medium text-[12.5px] text-text">
                Contact
              </Text>
            </Pressable>
        </View>
        ) : <View className="h-[4px]" />}
      </View>
      </View>
    </Modal>
  );
}

const TRANSACTIONS_PAGE_SIZE = 20;
const TRANSACTIONS_FULL_PAGE_SIZE = 25;
// Compact hosts (initialRows set, e.g. /explore): "Show more" grows the list
// by this step…
const EMBEDDED_LOAD_STEP = 50;
// …until the list holds this many rows, at which point growing further would
// make the section unscrollably tall — the table flips to page-at-a-time
// (EMBEDDED_PAGE_SIZE rows per page, replacing the list in place).
const EMBEDDED_PAGED_THRESHOLD = 100;
const EMBEDDED_PAGE_SIZE = 100;

export type TransactionsMode = 'compact' | 'full';

export function Transactions({
  mode = 'compact',
  assetFilter,
  chainFilter: chainScope,
  defaultScope,
  embedded = false,
  initialRows,
  onMyCountChange,
  collapsed: collapsedProp,
  hideScopeToggle = false,
}: {
  mode?: TransactionsMode;
  /**
   * Drop the "Mine | All" scope toggle and pin the table to the user's own
   * rows. For a host whose own title already fixes the scope: the My balances
   * panel (/?panel=balances) heads this table "My transactions", so an "All"
   * tab under it would let the table contradict its own heading (Pat,
   * 2026-08-29). The other hosts keep the toggle; it is the reason they exist.
   */
  hideScopeToggle?: boolean;
  /**
   * Open with this many rows and grow by the same step on "Show more",
   * instead of the full table's page-at-a-time pager.
   *
   * For hosts where the feed is one section among several (Explore) rather
   * than the page itself: a 25-row table there buries everything below it.
   * The filters and the scope toggle stay — they are controls, not chrome —
   * so a filtered view still starts short. Unset ⇒ unchanged behaviour.
   */
  initialRows?: number;
  /**
   * Which scope the table opens on. Everywhere else a connected wallet lands
   * on 'mine' (people come for their own activity); /explore is protocol-wide by
   * definition, so it pins 'all' even when connected.
   */
  defaultScope?: 'all' | 'mine';
  /**
   * If provided, restrict the feed to rows whose `tx.asset` (case-insensitive)
   * equals this symbol — used by the per-pool view at /chains/[chain]/[asset]
   * to reuse this component without forking the table.
   */
  assetFilter?: string;
  /**
   * If provided, restrict the feed to rows on this chain. The per-pool page is
   * one pool on one chain; the multi-chain feed's same-symbol rows from other
   * chains must not appear in it. Also hides the Chain control (one option).
   */
  chainFilter?: number;
  /**
   * Render inside a host that already provides the card and the title (the
   * "My transactions (N)" section in My balances). Drops this component's own
   * card chrome and its title/count — two nested cards each announcing
   * "Transactions" read as a bug, and the two counts disagreed by design
   * (the host counts the user's rows, this one counted the visible scope).
   * The scope toggle and filters still render: they are controls, not chrome.
   */
  embedded?: boolean;
  /**
   * Host-controlled collapse. When set it overrides this component's own
   * persisted state, so an embedding host's chevron is the single control.
   * Embedded + collapsed renders nothing at all — but the component stays
   * MOUNTED so onMyCountChange keeps reporting; the host's collapsed title is
   * exactly where the count needs to be right.
   */
  collapsed?: boolean;
  /**
   * Reports how many rows the user owns, regardless of which scope tab is
   * showing. Lets an embedding host title itself without re-deriving
   * ownership — that logic (note lineage, internal-spend suppression) lives
   * here and must not be forked.
   */
  onMyCountChange?: (count: number) => void;
} = {}) {
  const isFull = mode === 'full';
  const assetFilterUpper = assetFilter?.toUpperCase();
  const router = useRouter();
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const isDark = colorScheme === 'dark';
  // Column decisions follow the CONTAINER, not the window: in the desktop
  // split screen this component renders into ~55% of the viewport. Falls back
  // to the window width outside a panel shell (Classic pools page).
  const width = useLayoutWidth();
  const { data } = usePools();
  // Live USDC-per-ppUSDC: a share row prints the USDC it is worth, share named in a hint.
  const { rateFor } = useShareRates();
  const balanceDisplay = useShareFreeBalanceDisplay();
  // The feed is a LIST of self-describing rows, not a column grid, so there are
  // no per-column visibility breakpoints left: each row carries its own asset
  // mark, direction glyph and stacked amount, and the meta line ellipsizes.
  // That is what removed the character-by-character wrapping the 8-column
  // table produced once its container got narrow (the split panel, the sheet).
  // `width` still drives the filter row, which genuinely needs the room.
  const showFilters = width >= 550;
  const [openFilter, setOpenFilter] = useState<string | null>(null);

  const [detailTx, setDetailTx] = useState<Transaction | null>(null);
  // DEV-553: which row a phone tap opened, so its own actions ride along.
  const [detailRowKey, setDetailRowKey] = useState<string | null>(null);
  // Row budget + page, keyed by the view they were set on (see the derivation
  // below). Keeping them together is what lets a filter change fall back to
  // the first short page without a reset effect.
  const [pager, setPager] = useState<{ viewKey: string; count: number; page: number }>({
    viewKey: '',
    count: initialRows ?? TRANSACTIONS_PAGE_SIZE,
    page: 1,
  });

  // Tx detail deep linking: the open detail modal lives in the URL as
  // `?tx=<hash>` (a marked history entry), so it's shareable, browser
  // back/forward open and close it, and Escape pops the entry.
  // The link names only a hash, so a swap's legs must already be one row here
  // or the link opens whichever leg comes first.
  const detailTransactions = useMemo(() => {
    const rows = withPublicSwapRows(data.transactions, data.swapRouteKinds);
    return [...mergeMyTransactions(rows, data.lineageRows, data.anchorTxHashes), ...rows];
  }, [data.transactions, data.lineageRows, data.anchorTxHashes, data.swapRouteKinds]);
  const allTxRef = useRef(detailTransactions);
  allTxRef.current = detailTransactions;
  const findTxByHash = (hash: string) =>
    allTxRef.current.find((t) => t.txHash?.toLowerCase() === hash.toLowerCase()) ?? null;

  const openDetail = useCallback((tx: Transaction) => {
    setDetailTx(tx);
    if (tx.txHash) pushUiParamEntry('tx', tx.txHash);
  }, []);
  // `followedByAction`: a detail action is about to open something (the
  // withdraw modal pushes its own URL entry), so drop `?tx=` synchronously
  // rather than with an async back that would close that modal again.
  const closeDetail = useCallback((opts?: { followedByAction?: boolean }) => {
    setDetailTx(null);
    setDetailRowKey(null);
    retireUiParamEntry('tx', opts);
  }, []);

  // URL → state: deep links (re-based so back stays in the app) and
  // back/forward transitions.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    rebaseUiParamEntry('tx');
    const sync = () => {
      const hash = getUiParam('tx');
      if (!hash) {
        setDetailTx(null);
        return;
      }
      const found = findTxByHash(hash);
      if (found) setDetailTx(found);
    };
    sync();
    return subscribeUiUrl(sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve late arrivals and replace raw feed rows when signed history loads.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const hash = getUiParam('tx');
    if (!hash) return;
    const found = findTxByHash(hash);
    if (found) setDetailTx(found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTransactions]);

  const drawerHost = useDrawerHost();
  const { openRagequitModal } = useRagequitModal();
  const { openWithdrawModal } = useWithdrawModal();
  const { openExportNotesModal } = useAccountRecoveryModal();
  const { openAuditExport } = useAuditExport();
  const { openOriginProof } = useOriginProof();
  const { notes } = useNotes();
  const { toast } = useToast();

  // Withdraw, Exit and Export Note act on the note's own chain
  // (services/row-chain-action.ts). A row on another chain switches there
  // first and opens once the selection and the session have both moved. The
  // pending action is a ref and is tried from the switch's own resolution and
  // from the render that carries the new chain, whichever lands last, each
  // reading the latest committed chain and modal callbacks.
  const { activeChainId: selectedChainId, selectChain, isSui: onSui, isStellar: onStellar } = useChainRouter();
  const evmSessionChainId = useSessionChainId();
  const sessionChainId = onSui ? SUI_TESTNET_ID : onStellar ? STELLAR_TESTNET_ID : evmSessionChainId;
  type RowActionKind = 'withdraw' | 'exit' | 'export';
  const openRowAction = useCallback((kind: RowActionKind, tx: Transaction) => {
    launchFromDrawer(drawerHost, () => {
      if (kind === 'withdraw') openWithdrawModal(tx);
      else if (kind === 'exit') openRagequitModal(tx);
      else openExportNotesModal();
    });
  }, [drawerHost, openWithdrawModal, openRagequitModal, openExportNotesModal]);
  // The EVM SDK session this render sees: an EVM row waits until the old
  // chain's session is gone or the new one is built.
  const { sessionTarget, isInitializing: sdkInitializing, sessionResuming: sdkResuming } = useSdkContext();
  const rowSdkState = (chainId: number) => (getChainConfig(chainId)?.chainType === 'evm'
    ? { sdkSessionChainId: sessionTarget?.chainId ?? null, sdkInitializing, sdkResuming }
    : { sdkSessionChainId: null, sdkInitializing: false });
  const pendingRowActionRef = useRef<(PendingRowAction<RowActionKind> & { tx: Transaction }) | null>(null);
  // Every row action takes a generation; a switch that resolves after a newer
  // action started is ignored, so an older action can never open over it.
  const rowActionGenRef = useRef(0);
  const rowActionLatestRef = useRef({ selectedChainId, sessionChainId, openRowAction, sdk: rowSdkState });
  // Declared before the effect below, so it has run when that one reads it.
  useEffect(() => {
    rowActionLatestRef.current = { selectedChainId, sessionChainId, openRowAction, sdk: rowSdkState };
  });
  const tryPendingRowAction = useCallback(() => {
    const latest = rowActionLatestRef.current;
    const pending = pendingRowActionRef.current;
    const step = pendingRowActionStep(
      pending,
      { selectedChainId: latest.selectedChainId, sessionChainId: latest.sessionChainId, ...latest.sdk(pending?.chainId ?? latest.selectedChainId) },
      Date.now(),
    );
    if (step === 'drop') pendingRowActionRef.current = null;
    if (step !== 'open' || !pending) return;
    pendingRowActionRef.current = null;
    latest.openRowAction(pending.kind, pending.tx);
  }, []);
  useEffect(() => { tryPendingRowAction(); }, [selectedChainId, sessionChainId, sessionTarget, sdkInitializing, sdkResuming, openRowAction, tryPendingRowAction]);
  const runOnRowChain = useCallback((kind: RowActionKind, tx: Transaction) => {
    pendingRowActionRef.current = null;
    const gen = ++rowActionGenRef.current;
    const chainId = tx.chainId;
    if (chainId === selectedChainId && chainId === sessionChainId) {
      openRowAction(kind, tx);
      return;
    }
    void selectChain(chainId).then((outcome) => {
      if (gen !== rowActionGenRef.current) return;
      if (outcome === 'committed') {
        pendingRowActionRef.current = { kind, tx, chainId, at: Date.now() };
        tryPendingRowAction();
      } else if (outcome === 'declined') {
        toast({ title: `Switch to ${getChainConfig(chainId)?.displayName ?? 'that network'} to continue.`, variant: 'destructive' });
      }
    });
  }, [selectedChainId, sessionChainId, openRowAction, selectChain, tryPendingRowAction, toast]);

  // Chain-aware connection: wagmi's address is empty when a Sui wallet drives
  // the session, which hid the All | My Transactions tabs on Sui entirely.
  const { address: connectedAddress } = useMultiChainWallet();
  // The identity whose STORED note export this table should read. Balances
  // already use exactly this precedence (pools-provider.tsx:1313), and the
  // mismatch was visible: the same account showed 30 rows through its wallet
  // and ZERO through its account key, while the balance read 0.2131 ETH in
  // both (Pat, 2026-09-01). The live feed alone cannot classify historical
  // deposits/withdrawals; that needs the export, which was being loaded for a
  // wallet address a key session does not have.
  // EVM-only below, so preferring the session address cannot mis-scope Sui.
  // getCommittedManagers: the row menu's "Recover claim link" reads the
  // signed-in viewing key at click time to trial-decrypt the sender's own
  // on-chain backup (services/blind-deposit-recovery.ts). Read on click, never
  // held in render state.
  const { sessionAddress, identityMode, getCommittedManagers } = usePoolSession();
  // The identity a DEPOSIT row is matched against when note-matching does not
  // resolve it. isDepositMine tries the notes first and then falls back to
  // `tx.fullAddress === ownAddress`, and that fallback is what actually claims
  // most historical deposits. With the wallet address alone it was null for a
  // key session, so 30 rows collapsed to 2 even once the notes were loaded
  // (Pat, 2026-09-01, measured: liveNotes 30 + storedNotes 31, still 2 rows).
  // BRANCHED on identityMode, not `wallet ?? session`: a key session can have a
  // funding wallet connected at a DIFFERENT address (depositing needs one), and
  // that payer must not claim the key account's rows, nor lend its own. Same
  // correction as 1310d10 made in pools-provider; this file was missed. The
  // non-key branch keeps the wallet address, so Sui is untouched: there the
  // wallet hook carries the Sui address and a Sui deposit row must compare
  // against that one.
  const ownAddress = identityMode === 'key' ? (sessionAddress ?? connectedAddress) : connectedAddress;
  // Returning tab: the note cache rehydrates (deposit rows and balances
  // render) but the session keystore isn't rebuilt without a fresh
  // signature — nothing re-syncs, and the user's own transfers/withdrawals
  // can't be classified without the private nullifying key (pools-provider
  // keeps userSpends not-ready). That state is permanent until sign-in, so
  // My Transactions surfaces an action instead of silently stale data. The
  // shared gate keeps this to genuinely locked WALLET sessions (settled
  // wagmi connection, wallet identity mode, EVM); a failed account-key init
  // gets a direct retry, never the wallet-signature prompt.
  const { requiresWalletUnlock: evmRequiresUnlock, keyInitFailed, retryKeyInit, stellarLocked, unlockStellar } = useWalletUnlockGate();
  const stellarWallet = useStellarWallet();
  const stellarWalletAddress = stellarWallet.isConnected ? stellarWallet.address ?? null : null;
  const { openSeedDerivationModal: openEvmSignIn } = useSeedDerivationModal();
  // Stellar's locked session: same banner, Freighter unlock as the action.
  const requiresWalletUnlock = evmRequiresUnlock || stellarLocked;
  const openSeedDerivationModal = stellarLocked ? unlockStellar : () => openEvmSignIn();
  const sessionLocked = requiresWalletUnlock || keyInitFailed;
  const [statusFilter, setStatusFilter] = useState('All');
  const [amountFilter, setAmountFilter] = useState('All');
  const [dateFilter, setDateFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  // Chain filter (Mike): empty set = All chains. Only shown with 2+ chains.
  const [chainFilter, setChainFilter] = useState<Set<number>>(new Set());
  const [scopeTab, setScopeTab] = useState<'all' | 'mine'>('all');
  // A row narrower than this cannot fit the type, the amount, the status column
  // and the menu: "Withdrawal" was cut to "With…" on a phone. There the status
  // moves to the start of the date line, shown only when it is not plain
  // Completed, and the menu column narrows. Measured on the row itself, so a
  // narrow embed on a wide screen gets the same treatment.
  // Until the first row reports its width, a phone-width window decides, so the
  // first paint is already right.
  const [rowWidth, setRowWidth] = useState(0);
  const { width: windowWidth } = useWindowDimensions();
  const compactRows = rowWidth > 0 ? rowWidth < 360 : windowWidth < 480;
  // DEV-553: phone web rows are one line, no menu; a tap opens the details,
  // which list every action the menu had. Desktop and native are unchanged.
  const phoneRows = phoneTransactionRows(Platform.OS, windowWidth);
  // Only an embedding host folds the table (My transactions in My balances);
  // a page's own Transactions card is always open, like its other cards.
  const collapsed = collapsedProp ?? false;

  // Default to My Transactions when a wallet is connected — most users come
  // here for their own activity. Reset back to All when they disconnect so
  // stale scope state doesn't hide the feed. A caller can pin the scope
  // instead (/explore is protocol-wide, so it opens on All while connected);
  // the user can still switch tabs, this only sets where it starts.
  useEffect(() => {
    // No toggle on screen means no way back from 'all', so the pin has to be
    // absolute — it outranks defaultScope and the disconnect reset alike.
    if (hideScopeToggle) {
      setScopeTab('mine');
      return;
    }
    if (defaultScope) {
      setScopeTab(defaultScope);
      return;
    }
    setScopeTab(ownAddress ? 'mine' : 'all');
  }, [ownAddress, defaultScope, hideScopeToggle]);
  // A Swap row is listed under either of its legs, so scoping runs on the
  // merged rows, after each swap has folded in the rows it explains.
  const inScope = useCallback(
    (tx: Transaction) => anyLeg(tx, (leg) =>
      (!assetFilterUpper || leg.asset.toUpperCase() === assetFilterUpper)
      && (chainScope === undefined || leg.chainId === chainScope)),
    [assetFilterUpper, chainScope],
  );
  const scoped = useCallback(
    (rows: Transaction[]) => (!assetFilterUpper && chainScope === undefined ? rows : rows.filter(inScope)),
    [assetFilterUpper, chainScope, inScope],
  );
  const allTransactions = useMemo(() => scoped(data.transactions), [data.transactions, scoped]);

  // Ownership of a row (notes on every chain by tx hash or label, deposits by
  // the identity's address, deposits made FOR someone else excluded) comes
  // from the hook every mine-scoped surface shares, so the home preview and
  // the bell agree with this table (hooks/use-my-transaction-ownership.ts).
  const { isDepositMine, isDepositAuthoredByMe, isDepositRecoverable, isMine, sentTxHashes, filterMineEvents, notesByChain } = useMyTransactionOwnership();

  // Deposits whose entire lineage has no ACTIVE value left (fully withdrawn
  // or exited). Partial withdrawals leave a non-zero ACTIVE change note
  // behind, which keeps the deposit actionable. A 0-value change note (the
  // SDK adds one per lineage even on full withdrawals) is treated as spent.
  // PENDING/INACTIVE notes (e.g. fresh deposit awaiting ASP approval) keep
  // the lineage live — they'll flip to ACTIVE once approved. Judged per
  // chain against that chain's notes, whichever chain is selected.
  const fullySpentDepositTxs = useMemo(
    () => computeFullySpentDepositTxs(notesByChain),
    [notesByChain],
  );

  const isDepositFullySpent = useCallback(
    (tx: Transaction) => isDepositFullySpentByTxHash(tx, fullySpentDepositTxs),
    [fullySpentDepositTxs],
  );

  // Computed regardless of the active tab: the host header reports the user's
  // count even while the table is showing "All".
  const myTransactions = useMemo(() => {
    // "mine" merges in the lineage rows. mergeMyTransactions dedupes by
    // txHash, preferring the reconstructed spend row over the mislabeled ASP row
    // for the same tx (#215), and sorts newest-first.
    // No fall-back-to-all: a "My Transactions" tab that quietly shows other
    // people's activity misleads (the count and rows disagree with the label).
    // An empty personal feed renders the honest empty state below instead.
    //
    // Internal spends (self merge/split, from the nullifier reconstruction)
    // get no lineage row, so nothing replaces their ASP row in the merge —
    // and with SPENT notes now valid 'in' signals, that leftover row would
    // render as a received transfer. Suppress those rows outright.
    //
    // While my spends are being re-classified for a new snapshot, a Transact
    // event row I own only through a note has no trustworthy direction yet:
    // my own change note would read as Transfer In until the lineage row
    // replaces it (DEV-394). Hold exactly those rows; a row this device
    // stamped itself (a send, a paid request) keeps its known direction.
    const mineEvents = filterMineEvents(data.transactions, { internalTxHashes: data.internalTxHashes, spendClassificationPending: data.spendClassificationPending });
    return scoped(mergeMyTransactions(mineEvents, data.lineageRows, data.anchorTxHashes));
  }, [data.transactions, filterMineEvents, data.lineageRows, data.anchorTxHashes, data.internalTxHashes, data.spendClassificationPending, scoped]);

  const scopedTransactions = useMemo(
    // The "all" feed is ASP-event-only: lineage rows (#215) add nothing to it,
    // but one of mine stands in for its own feed Transfer or swap rows there
    // too, and anyone else's same-chain swap is one Swap row like mine.
    () => (scopeTab === 'all' ? scoped(withPublicSwapRows(withLineageTransfers(data.transactions, data.lineageRows), data.swapRouteKinds)) : myTransactions),
    [scopeTab, data.transactions, data.lineageRows, data.swapRouteKinds, myTransactions, scoped],
  );

  useEffect(() => {
    onMyCountChange?.(myTransactions.length);
  }, [myTransactions.length, onMyCountChange]);

  // Debug recording snapshot (services/debug-snapshots.ts): every row of this
  // table in both scopes, with how it decodes here (direction, amount, whether
  // it is mine) and its spent / funds status, so a recording shows the table
  // exactly as the user saw it.
  const debugTableRef = useRef({ allTransactions, myTransactions, notes, sentTxHashes, scopeTab });
  useEffect(() => {
    debugTableRef.current = { allTransactions, myTransactions, notes, sentTxHashes, scopeTab };
  });
  // useId: two tables of the same mode on one screen must not overwrite each other.
  const debugTableId = useId();
  useEffect(() => registerDebugSnapshot(`transactionsTable:${mode}${assetFilterUpper ? ':' + assetFilterUpper : ''}:${debugTableId}`, () => {
    const cur = debugTableRef.current;
    const decode = (tx: Transaction) => {
      const direction = tx.type === 'Transfer'
        ? (tx.direction ?? (findPaidRequest(tx.txHash) ? 'out' : classifyTransfer(tx, cur.notes, cur.sentTxHashes)))
        : null;
      const sent = direction === 'out' ? findSentTransfer(tx.txHash) : null;
      const decodedAmount = direction && direction !== 'self' ? computeUserTransferAmount(tx, cur.notes, direction, sent?.rawAmount ?? null) : null;
      return {
        ...debugSafeRow(tx),
        decoded: {
          direction,
          decodedAmountRaw: decodedAmount !== null ? decodedAmount.toString() : null,
          sentRecord: sent ?? null,
          paidRequest: findPaidRequest(tx.txHash) ?? null,
          isMine: isMine(tx),
          depositMine: isDepositMine(tx),
          depositAuthoredByMe: isDepositAuthoredByMe(tx),
          fullySpent: tx.type === 'Deposit' ? isDepositFullySpent(tx) : null,
        },
      };
    };
    return {
      scopeTab: cur.scopeTab,
      mine: cur.myTransactions.map(decode),
      all: cur.allTransactions.map(decode),
    };
  }), [mode, assetFilterUpper, debugTableId, isMine, isDepositMine, isDepositAuthoredByMe, isDepositFullySpent]);

  // Distinct chains present in the feed — drives the Chain filter dropdown.
  // Built from the full (unscoped) feed so the option list is stable as the
  // user toggles scope/other filters.
  const chainFilterOptions = useMemo<ChainFilterOption[]>(() => {
    const seen = new Map<number, ChainFilterOption>();
    for (const tx of allTransactions) {
      if (tx.chainId === undefined || seen.has(tx.chainId)) continue;
      const cfg = getChainConfig(tx.chainId);
      seen.set(tx.chainId, {
        id: tx.chainId,
        label: cfg?.displayName ?? tx.chain ?? String(tx.chainId),
        chainType: cfg?.chainType ?? 'evm',
      });
    }
    return Array.from(seen.values());
  }, [allTransactions]);

  // Prune selections for chains that leave the feed (e.g. a refresh drops a
  // chain, or debug is turned off). Otherwise a stale selected id keeps hiding
  // every remaining row while the Chain control is gated out of view.
  useEffect(() => {
    const available = new Set(chainFilterOptions.map((o) => o.id));
    setChainFilter((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => available.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [chainFilterOptions]);

  const filteredTransactions = scopedTransactions.filter((tx) => {
    // Chain filter (empty = all chains)
    if (chainFilter.size > 0 && !anyLeg(tx, (leg) => chainFilter.has(leg.chainId))) return false;
    // Type filter (Deposit / Withdrawal / Transfer / Exit)
    if (typeFilter !== 'All' && tx.type !== typeFilter) return false;
    // Status filter. "Exit" matches on-chain Exit rows OR deposits whose
    // entire lineage has been fully spent (rendered with the Exit badge).
    // A Swap row's fully-spent state is its output's, as on the row itself.
    if (!matchesStatusFilter(statusFilter, tx, isDepositFullySpent(isSwapRow(tx) ? swapOutputDepositView(tx) : tx))) return false;
    // Amount filter
    if (amountFilter !== 'All') {
      const usd = tx.usdValue;
      if (amountFilter === '< $100' && usd >= 100) return false;
      if (amountFilter === '$100 - $1K' && (usd < 100 || usd >= 1000)) return false;
      if (amountFilter === '$1K - $10K' && (usd < 1000 || usd >= 10000)) return false;
      if (amountFilter === '> $10K' && usd < 10000) return false;
    }
    // Date filter
    if (dateFilter !== 'All') {
      const txDate = new Date(tx.timestamp);
      const now = new Date();
      if (dateFilter === 'Today') {
        if (txDate.toDateString() !== now.toDateString()) return false;
      } else if (dateFilter === 'This Week') {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (txDate < weekAgo) return false;
      } else if (dateFilter === 'This Month') {
        if (txDate.getMonth() !== now.getMonth() || txDate.getFullYear() !== now.getFullYear()) return false;
      } else if (dateFilter === 'This Year') {
        if (txDate.getFullYear() !== now.getFullYear()) return false;
      }
    }
    return true;
  });

  // The row budget and the page are stored WITH the view they belong to, so a
  // new scope tab or filter falls back to the first short page by derivation.
  // A carried-over expansion contradicted the short-by-default contract, and
  // in pager mode could leave the page past the end of a shorter result set.
  const viewKey = `${scopeTab}|${typeFilter}|${statusFilter}|${amountFilter}|${dateFilter}|${[...chainFilter].sort().join(',')}|${assetFilter ?? ''}`;
  const rowBudget = initialRows ?? TRANSACTIONS_PAGE_SIZE;
  const onCurrentView = pager.viewKey === viewKey;
  const visibleCount = onCurrentView ? pager.count : rowBudget;
  // Embedded hosts (initialRows set) flip to page-at-a-time once "Show more"
  // has grown the list to the threshold — pages of EMBEDDED_PAGE_SIZE replace
  // the list in place rather than growing it forever. The full /transactions
  // page is paged from the start at its own smaller size.
  const embeddedPaged = initialRows !== undefined && isFull && visibleCount >= EMBEDDED_PAGED_THRESHOLD;
  const paged = (initialRows === undefined && isFull) || embeddedPaged;
  const pageSize = embeddedPaged ? EMBEDDED_PAGE_SIZE : TRANSACTIONS_FULL_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / pageSize));
  // Clamped on read as well as on the buttons: the page survives a refetch
  // that shrinks the list within the SAME view (a tx dropping out of a live
  // feed), where the view key cannot reset it.
  const currentPage = Math.min(onCurrentView ? pager.page : 1, totalPages);
  const pageStart = (currentPage - 1) * pageSize;

  const transactions = paged
    ? filteredTransactions.slice(pageStart, pageStart + pageSize)
    : filteredTransactions.slice(0, visibleCount);
  // The row id only: the type is a classification that can change for the
  // same row (a Transfer In settling as Transfer Out), and a key that moves
  // with it would remount the row (cubic, #153).
  const rowKeys = stableRowKeys(transactions, (tx) => String(tx.id));
  // DEV-553: each rendered row's actions (minus "View Details"), by row key and
  // by tx hash, for the phone detail view. Built in this render, never stored.
  const rowActions = new Map<string, () => TransactionRowMenuItem[]>();
  const hasMore = !paged && visibleCount < filteredTransactions.length;
  const remainingRows = filteredTransactions.length - transactions.length;
  const headerCount = activityHeaderCount({
    scopeTab,
    scoped: chainScope !== undefined || assetFilterUpper !== undefined,
    rowCount: filteredTransactions.length,
    totals: data.publicEventTotalsByChain,
    chainFilter,
    otherFilters: typeFilter !== 'All' || statusFilter !== 'All' || dateFilter !== 'All' || amountFilter !== 'All',
    // Only the chains in view: a pending chain outside the Chain filter does
    // not make the selected chains' totals incomplete.
    incomplete: chainFilter.size > 0
      ? [...chainFilter].some((cid) => data.historyPendingChainIds.includes(cid))
      : data.historyPendingChainIds.length > 0,
  });

  // No clamp effect needed: `currentPage` resets with the view (derived
  // above) and both pager buttons clamp at the ends, so it can never point
  // past a shrunken result set.
  const closeFilter = () => setOpenFilter(null);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenFilter(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Mounted but silent: every hook above has run (so the host has its count),
  // and there is nothing to draw under a collapsed host header.
  if (embedded && collapsed) return null;

  return (<>
    <Card
      noPadding
      className="z-[80]"
      // nw-keep(forwarded-style-contract): caller-last overflow:visible must beat Card's base
      // overflow-hidden so the dropdown/backdrop layers escape the card (DROPDOWN_ZINDEX_PATTERN.md);
      // className overflow can't reliably win the web cascade against Card's own class.
      // Embedded rides the same contract to erase the card entirely: the host
      // already draws one, and a card inside a card is the nested border the
      // panel is meant to avoid.
      style={{
        overflow: 'visible',
        ...(embedded ? { borderWidth: 0, backgroundColor: 'transparent', borderRadius: 0 } : null),
      }}
    >
      {/* Header. Embedded: no divider and no horizontal padding, so the scope
          toggle and filters line up with the host's own header text. */}
      <View
        className={`z-[99999] gap-[16px] overflow-visible ${
          embedded
            ? 'pb-[12px]'
            : `border-b p-[16px] ${collapsed ? 'border-b-transparent' : 'border-b-border-light'}`
        }`}
      >
        {/* Skipped entirely when it would be empty (embedded host, toggle
            hidden): an empty row still costs the header's 16px gap above the
            filters. */}
        {(!embedded || (ownAddress && !collapsed && !hideScopeToggle)) && (
        <View className="flex-row items-center gap-[8px]">
          {!embedded && (
            <View className="flex-row items-baseline gap-[6px]">
              <Text className="font-pp-bold text-[16px] leading-[16px] text-text">
                Transactions
              </Text>
              <Text className="font-pp-bold text-[12px] leading-[12px] text-text">
                ({headerCount})
              </Text>
            </View>
          )}
          {ownAddress && !collapsed && !hideScopeToggle && (
            // "All | Mine" rather than "All | My Transactions": the word is
            // already in the heading above these tabs, and a tab pair reads as
            // one choice — the shorter label makes the contrast the point.
            // Mine sits first (DEV-350): it is the default and the reason most
            // users open the table, so it takes the reading-order lead.
            <View className={`flex-row items-center gap-[10px] ${embedded ? '' : 'ml-[16px]'}`}>
              <Pressable onPress={() => setScopeTab('mine')}>
                <Text
                  className={`font-pp-bold text-[12px] ${scopeTab === 'mine' ? 'text-text' : 'text-[#B8BBBF]'}`}
                >
                  Mine
                </Text>
              </Pressable>
              <Text className="text-[12px] text-text-muted">|</Text>
              <Pressable onPress={() => setScopeTab('all')}>
                <Text
                  className={`font-pp-bold text-[12px] ${scopeTab === 'all' ? 'text-text' : 'text-[#B8BBBF]'}`}
                >
                  All
                </Text>
              </Pressable>
            </View>
          )}
        </View>
        )}
        {showFilters && !collapsed && (
          /* The filter GROUP owns the row's slack and wraps inside itself, so a
              fifth filter (Chain) or a long selected label ("Chain: Ethereum,
              Optimism") pushes a filter onto a second line instead of pushing
              Reset Filters out of the card. RN flex children are flexShrink:0
              (react-native-web's View base style), so without `flex-1` the group
              keeps its one-line max-content width (472px at "All", 750px with real
              selections) and overflow-visible lets the excess spill: 71px past the
              split panel at the width where showFilters (>=550) first turns the row
              on — showFilters gates on the PANEL width, but the row only gets that
              minus 42-68px of chrome, so there is a band (window ~1058-1128 on the
              split panel) where the row renders at a width it cannot fit.
              Wrapping must live on the GROUP, not the row — moving only Reset to a
              second line still overflows once the five filters alone outgrow the
              744px the split panel can ever give them.
              Reset stays shrink-0 at its natural width; h-[20px] + justify-center
              (20px = the chevron box, i.e. the first filter line's height) holds it
              on line one, so the wrapped case doesn't drag it down and the
              unwrapped case is pixel-identical to before. */
          <View className="flex-row items-start justify-between gap-[12px] overflow-visible">
            <View className="flex-1 flex-row flex-wrap items-center gap-x-[20px] gap-y-[10px] overflow-visible">
              {/* Date Filter */}
              {/* Only the OPEN filter takes the high z-index (DROPDOWN_ZINDEX_PATTERN.md
                  §3/§5, same conditional the pool-page table uses on its rows). With the
                  group wrapping, equal-z siblings resolve by DOM order, so a filter that
                  lands on the second line would paint over — and swallow the taps meant
                  for — an open first-line menu. */}
              <View className={`relative overflow-visible ${openFilter === 'date' ? 'z-[99999]' : 'z-[1]'}`}>
                <Pressable className="-mx-[6px] flex-row items-center gap-[4px] rounded-control px-[6px]" onPress={() => setOpenFilter(openFilter === 'date' ? null : 'date')}>
                  <Text className="font-pp-regular text-[12px] text-text-secondary">Date: {dateFilter}</Text>
                  {/* nw-keep(data-color): chevron glyph color is a theme token into the SVG-icon color prop (no className path) */}
                  <ChevronDownIcon color={colors.textSecondary} />
                </Pressable>
                {openFilter === 'date' && (
                  <>
                    {/* nw-keep(platform-css): web-only position:fixed full-viewport tap-catcher (RN-Web only) */}
                    <Pressable className="bottom-0 left-0 right-0 top-0 z-[9998]" style={WEB_FIXED_POSITION} onPress={closeFilter} />
                    <View
                      className="absolute left-0 top-[28px] z-[99999] min-w-[160px] rounded-card border border-border-light bg-menu-background p-[6px]"
                      // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                      style={DROPDOWN_SHADOW}
                    >
                      {['All', 'Today', 'This Week', 'This Month', 'This Year'].map((opt) => (
                        <Pressable key={opt} className="flex-row items-center rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => { setDateFilter(opt); closeFilter(); }}>
                          <Text className="font-pp-regular text-[14px] text-text">{opt}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                )}
              </View>
              {/* Type Filter */}
              <View className={`relative overflow-visible ${openFilter === 'type' ? 'z-[99999]' : 'z-[1]'}`}>
                <Pressable className="-mx-[6px] flex-row items-center gap-[4px] rounded-control px-[6px]" onPress={() => setOpenFilter(openFilter === 'type' ? null : 'type')}>
                  <Text className="font-pp-regular text-[12px] text-text-secondary">Type: {typeFilter}</Text>
                  {/* nw-keep(data-color): chevron glyph color is a theme token into the SVG-icon color prop (no className path) */}
                  <ChevronDownIcon color={colors.textSecondary} />
                </Pressable>
                {openFilter === 'type' && (
                  <>
                    {/* nw-keep(platform-css): web-only position:fixed full-viewport tap-catcher (RN-Web only) */}
                    <Pressable className="bottom-0 left-0 right-0 top-0 z-[9998]" style={WEB_FIXED_POSITION} onPress={closeFilter} />
                    <View
                      className="absolute left-0 top-[28px] z-[99999] min-w-[160px] rounded-card border border-border-light bg-menu-background p-[6px]"
                      // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                      style={DROPDOWN_SHADOW}
                    >
                      {['All', 'Deposit', 'Withdrawal', 'Transfer', 'Swap', 'Exit'].map((opt) => (
                        <Pressable key={opt} className="flex-row items-center rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => { setTypeFilter(opt); closeFilter(); }}>
                          <Text className="font-pp-regular text-[14px] text-text">{opt}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                )}
              </View>
              {/* Amount Filter */}
              <View className={`relative overflow-visible ${openFilter === 'amount' ? 'z-[99999]' : 'z-[1]'}`}>
                <Pressable className="-mx-[6px] flex-row items-center gap-[4px] rounded-control px-[6px]" onPress={() => setOpenFilter(openFilter === 'amount' ? null : 'amount')}>
                  <Text className="font-pp-regular text-[12px] text-text-secondary">Amount: {amountFilter}</Text>
                  {/* nw-keep(data-color): chevron glyph color is a theme token into the SVG-icon color prop (no className path) */}
                  <ChevronDownIcon color={colors.textSecondary} />
                </Pressable>
                {openFilter === 'amount' && (
                  <>
                    {/* nw-keep(platform-css): web-only position:fixed full-viewport tap-catcher (RN-Web only) */}
                    <Pressable className="bottom-0 left-0 right-0 top-0 z-[9998]" style={WEB_FIXED_POSITION} onPress={closeFilter} />
                    <View
                      className="absolute left-0 top-[28px] z-[99999] min-w-[160px] rounded-card border border-border-light bg-menu-background p-[6px]"
                      // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                      style={DROPDOWN_SHADOW}
                    >
                      {['All', '< $100', '$100 - $1K', '$1K - $10K', '> $10K'].map((opt) => (
                        <Pressable key={opt} className="flex-row items-center rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => { setAmountFilter(opt); closeFilter(); }}>
                          <Text className="font-pp-regular text-[14px] text-text">{opt}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                )}
              </View>
              {/* Status Filter */}
              <View className={`relative overflow-visible ${openFilter === 'status' ? 'z-[99999]' : 'z-[1]'}`}>
                <Pressable className="-mx-[6px] flex-row items-center gap-[4px] rounded-control px-[6px]" onPress={() => setOpenFilter(openFilter === 'status' ? null : 'status')}>
                  <Text className="font-pp-regular text-[12px] text-text-secondary">Status: {statusFilter}</Text>
                  {/* nw-keep(data-color): chevron glyph color is a theme token into the SVG-icon color prop (no className path) */}
                  <ChevronDownIcon color={colors.textSecondary} />
                </Pressable>
                {openFilter === 'status' && (
                  <>
                    {/* nw-keep(platform-css): web-only position:fixed full-viewport tap-catcher (RN-Web only) */}
                    <Pressable className="bottom-0 left-0 right-0 top-0 z-[9998]" style={WEB_FIXED_POSITION} onPress={closeFilter} />
                    <View
                      className="absolute left-0 top-[28px] z-[99999] min-w-[160px] rounded-card border border-border-light bg-menu-background p-[6px]"
                      // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                      style={DROPDOWN_SHADOW}
                    >
                      {/* The (i) is a SIBLING of the option, not a child of
                          it: nested inside, reading the hint on a touch device
                          would also apply the filter and close the menu. */}
                      {STATUS_FILTER_OPTIONS.map((opt) => (
                        <View key={opt} className="flex-row items-center justify-between gap-[8px] rounded-pill px-[12px] hover:bg-background-secondary">
                          <Pressable className="flex-1 flex-row items-center py-[10px]" onPress={() => { setStatusFilter(opt); closeFilter(); }}>
                            <Text className="font-pp-regular text-[14px] text-text">{opt}</Text>
                          </Pressable>
                          {STATUS_FILTER_HINTS[opt] ? (
                            <HoverHint hint={STATUS_FILTER_HINTS[opt]} testID={`status-filter-hint-${opt}`}>
                              {/* nw-keep(data-color): glyph colour is a runtime theme token (vector-icon sink) */}
                              <Ionicons name="information-circle-outline" size={13} color={colors.textMuted} />
                            </HoverHint>
                          ) : null}
                        </View>
                      ))}
                    </View>
                  </>
                )}
              </View>
              {/* Chain Filter — only when the feed actually spans 2+ chains */}
              {chainFilterOptions.length >= 2 && (
                <BlockchainFilter
                  open={openFilter === 'chain'}
                  onToggle={() => setOpenFilter(openFilter === 'chain' ? null : 'chain')}
                  onClose={closeFilter}
                  options={chainFilterOptions}
                  selected={chainFilter}
                  onChange={setChainFilter}
                />
              )}
            </View>
            <Pressable className="h-[20px] shrink-0 justify-center" onPress={() => { setStatusFilter('All'); setAmountFilter('All'); setDateFilter('All'); setTypeFilter('All'); setChainFilter(new Set()); }}>
              <Text className="font-pp-regular text-[14px] text-text-muted underline">
                Reset Filters
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Table */}
      {collapsed ? null : (
      <View className="z-[1] overflow-visible px-[16px] py-[8px]">
        {/* No column headers: the activity feed is a LIST, not a table — each
            row is self-describing (type + direction glyph, asset mark, amount),
            which is what removes the wrapping problem a dense grid created. */}

        {/* Cached-but-locked session (see sessionLocked above): the rows
            below can only show wallet-matched deposits; transfers and
            withdrawals stay unclassified until the keystore is rebuilt. */}
        {scopeTab === 'mine' && sessionLocked && (
          <View className="flex-row items-center gap-[8px] border-b border-b-border-light px-[8px] py-[10px]">
            {/* nw-keep(data-color): lock glyph color is a theme token into the @expo/vector-icons sink (no className path) */}
            <Ionicons name="lock-closed-outline" size={14} color={colors.textSecondary} />
            <Text className="flex-1 font-pp-regular text-[12px] text-text-secondary">
              Sign in to sync your full activity
            </Text>
            <Pressable
              className="rounded-control bg-button-primary px-[14px] py-[6px]"
              accessibilityRole="button"
              accessibilityLabel="Sync full activity"
              onPress={() => (keyInitFailed ? retryKeyInit() : openSeedDerivationModal())}
            >
              <Text className="font-pp-medium text-[12px] text-button-primary-text">
                {keyInitFailed ? 'Retry' : 'Sign in'}
              </Text>
            </Pressable>
          </View>
        )}

        {/* Honest empty state (no fall-back to the global feed in the personal
            scope). Filter-empty is distinguished from scope-empty: filters
            apply AFTER scoping, so "no transactions for this wallet" would be
            wrong when the wallet has history the filters exclude. */}
        {transactions.length === 0 && (
          <View className="items-center gap-[8px] py-[28px]">
            {scopedTransactions.length === 0 ? (
              <Text className="font-pp-regular text-[13px] text-text-muted">
                {scopeTab === 'mine' ? 'No transactions for this account yet.' : 'No transactions found.'}
              </Text>
            ) : (
              <>
                <Text className="font-pp-regular text-[13px] text-text-muted">
                  No transactions match the filters.
                </Text>
                <Pressable onPress={() => { setStatusFilter('All'); setAmountFilter('All'); setDateFilter('All'); setTypeFilter('All'); setChainFilter(new Set()); }}>
                  <Text className="font-pp-medium text-[13px] text-text underline">
                    Reset Filters
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        )}

        {/* Table Rows. Keyed by the row's own identity, not its position: an
            index suffix remounted every row below a newly arrived one, which
            restarted pending rows' pulse and read as the table refreshing. */}
        {transactions.map((tx, index) => {
          const rowKey = rowKeys[index];
          const baseNormalizedType = tx.type.charAt(0).toUpperCase() + tx.type.slice(1);
          const feeAmountRow = isFeeAmountRow(tx);
          // In the personal scope, decode Transfer direction from owned
          // notes: spent input in this lineage → Out (sender), output
          // landed in this tx with no spent input → In (recipient).
          // Same paid-request precedence as the detail modal: paying a
          // request leaves no sent-transfers stamp, so without this the payer's
          // own payment reads as "Transfer In" and carries no fee.
          const direction = baseNormalizedType === 'Transfer'
            ? (tx.direction ?? (findPaidRequest(tx.txHash) ? 'out' : classifyTransfer(tx, notes, sentTxHashes, data.anchorTxHashes)))
            : null;
          // A deposit this wallet made FOR SOMEONE ELSE must not read as an
          // ordinary Deposit. It is in the My list so the payer can find their
          // own payment and re-copy the recipient's claim link, but the money
          // is not theirs any more, and a row saying plain "Deposit" in their
          // own list says the opposite (Pat, 2026-09-16). Same shape as the
          // Transfer In / Transfer Out split directly above.
          const authoredDeposit = isDepositAuthoredByMe(tx);
          const normalizedType = rowTypeLabel({ ...tx, type: baseNormalizedType, direction: direction ?? undefined, authored: authoredDeposit, scope: scopeTab });
          // A Swap row's output is a deposit of this account: ownership, the
          // fund actions and fully-spent read it, on its own chain and lineage.
          const swapRow = isSwapRow(tx) ? tx : null;
          const depositTx = swapRow ? swapOutputDepositView(swapRow) : tx;
          const isFullySpent = isDepositFullySpent(depositTx);
          // Once a deposit lineage is fully spent (withdrawn or
          // ragequit), drop the original status hue on the type pill
          // and use the neutral Exit grey to match the status icon.
          // Without this the pending-orange pill lingers next to the
          // exit icon and reads as "still in flight".
          const schemeTypeStyles = TYPE_STYLES[colorScheme];
          const typeStyle = direction
            ? { ...(schemeTypeStyles[normalizedType] || schemeTypeStyles.Transfer), text: (schemeTypeStyles[normalizedType] || schemeTypeStyles.Transfer).border }
            : isFullySpent
              ? { ...schemeTypeStyles.Exit, text: schemeTypeStyles.Exit.border }
              : getTransactionTypeStyle(tx, colorScheme);
          // For the user's own transfers we can decode the actual
          // amount from local notes (recipient: their note value;
          // sender: spent inputs − their change). A stranger's transfer
          // reads "Private" instead, with the shield on its counterparty
          // line — we have no decryptable data for it, by design.
          const sentRecord = direction === 'out' ? findSentTransfer(tx.txHash) : null;
          let transferRaw = direction && direction !== 'self'
            ? computeUserTransferAmount(tx, notes, direction, sentRecord?.rawAmount ?? null)
            : null;
          // #215: lineage rows carry the exact amount on the row; use it when
          // the note-scan returns null (e.g. a since-SPENT received note).
          if (transferRaw === null && direction && direction !== 'self' && tx.isLineageSynthetic) {
            try { transferRaw = BigInt(tx.rawAmount); } catch { transferRaw = null; }
          }
          let transferTokenAmount: number | null = null;
          let transferUsd: number | null = null;
          if (transferRaw !== null) {
            const decimals = transferRowDecimals(tx);
            // Convert via string to avoid Number-precision loss on
            // big balances; only the post-decimal float arithmetic
            // happens in JS.
            transferTokenAmount = Number(transferRaw) / Math.pow(10, decimals);
            // The row's own chain's price: the bare keys belong to the active chain.
            const price = priceFromMap(data.priceMap ?? {}, { chainId: tx.chainId, address: tx.tokenAddress, symbol: tx.asset }) ?? 0;
            transferUsd = price > 0 ? transferTokenAmount * price : null;
          }
          // Fund state overlays the outcome badge: At risk and Claim get their own
          // glyph; Syncing (approved, not on this device) keeps the pending glyph
          // and explains itself in the tooltip.
          const overlayState = !isFullySpent && (tx.fundsState === 'at_risk' || tx.fundsState === 'claim') ? tx.fundsState : null;
          const statusCfg = isFullySpent
            ? STATUS_CONFIG[colorScheme].exit
            : overlayState
              ? STATUS_CONFIG[colorScheme][overlayState]
              : (STATUS_CONFIG[colorScheme][tx.status] || STATUS_CONFIG[colorScheme].pending);
          const StatusIcon = statusCfg.icon;
          const statusLabel = isFullySpent
            ? 'Fully spent. Deposit has been withdrawn or exited'
            : tx.fundsState && tx.fundsReason && tx.fundsState !== 'ready'
              ? `${FUNDS_STATE_LABEL[tx.fundsState]}. ${FUNDS_REASON_COPY[tx.fundsReason]}`
            : tx.status === 'pending' ? (swapPendingLabel(tx) ?? 'Pending')
            : tx.status === 'completed' ? 'Completed'
            : tx.status === 'failed' ? 'Failed'
            : tx.status === 'exit' ? 'Exit'
            : tx.status.charAt(0).toUpperCase() + tx.status.slice(1);
          // A cross-chain output still delivering is only a prepared note: not
          // in the destination pool yet, so nothing can act on it.
          const ownsOutput = isDepositMine(depositTx);
          // A pool page pins the selection to its pool's chain, so it cannot
          // switch to act on a swap output that lives on another chain.
          const isMine = ownsOutput && !swapRow?.swapOut.delivering
            && (chainScope === undefined || depositTx.chainId === chainScope);
          // At risk disables Withdraw (the ASP set will not prove it) but keeps
          // Exit: ragequit is the escape hatch for exactly these deposits.
          const canWithdraw = depositTx.status === 'completed' && depositTx.fundsState !== 'at_risk' && !isFullySpent && isMine;
          const canExit = (depositTx.status === 'completed' || depositTx.status === 'pending' || depositTx.fundsState === 'at_risk') && !isFullySpent && isMine;
          // The note backup is the EVM account export; a Stellar note is not in it.
          const canExportNote = isMine && depositTx.type === 'Deposit' && depositTx.chainId !== STELLAR_TESTNET_ID;
          // Only pulse for the current user's own pending deposits (a swap's
          // output included). Strangers' pending rows stay static.
          const isPending = depositTx.status === 'pending' && depositTx.type === 'Deposit' && ownsOutput;

          // --- list-row presentation ---------------------------------------
          // Direction and action read from a glyph + hue rather than a Type
          // column. Colours come from OUR theme tokens, so they track whichever
          // design variant and scheme is active.
          const baseType = feeAmountRow ? transactionBaseType(tx.type) : transactionBaseType(normalizedType);
          // The glyph follows the label, as in the detail modal: a deposit to a
          // recipient leaves the payer, so it points out.
          const typeGlyph = transactionTypeGlyph(normalizedType, baseType);
          const typeGlyphColor = transactionTypeColor(baseType, colors, colorScheme);

          // Counterparty · date · time on one subdued line, dot-separated.
          //
          // A transfer WE sent has its payee written down locally, in one of two
          // places: the Send flow stamps sent-transfers, and paying a payment
          // request stamps paid-requests. Reading only the first showed "?" on
          // every payment-request payment, and a tester read his own payment as
          // someone else's transaction and reported the money missing (Mike,
          // 2026-08-26). tx.address is the last resort: the row builder fills it
          // from the same stores, and a stranger's transfer legitimately has no
          // recipient we can know.
          const shortAddr = (a: string) => (a.length >= 10 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);
          // A self-transfer paid this account: its address, as a Deposit shows.
          const transferPayee = tx.type !== 'Transfer'
            ? null
            : direction === 'self'
              ? (ownAddress ?? null)
              : (recordedTransferPayee(tx.txHash) ?? (tx.fullAddress || null));
          // Someone else's transfer has a counterparty nobody can know: it is
          // PRIVATE, not unknown, so it wears the shield the rest of the app
          // uses for privacy rather than a bare "?" that reads like missing
          // data (Pat, 2026-08-26). My own transfer is not private to me; with
          // no record of the other side on this device the line shows only
          // the date.
          // Until my spends on the row's chain are classified, a Transfer with
          // no direction may still be mine: it is not known to be private yet.
          const transferResolving = tx.type === 'Transfer' && !direction
            && data.ownTransfersPendingChainIds.includes(tx.chainId);
          const counterpartyPrivate = tx.type === 'Transfer' && !transferPayee && !direction && !transferResolving;
          const counterparty = tx.type === 'Transfer'
            ? (transferPayee ? shortAddr(transferPayee) : '')
            : tx.address;
          // Formatted from the raw time, like Payment Requests: "Oct 6 · 00:16".
          const rowDate = tx.timestamp > 0 ? formatShortDate(tx.timestamp) : '';
          const rowTime = formatShortTime(tx.timestamp);
          const metaLine = [counterparty, rowDate, rowTime].filter(Boolean).join(' \u00B7 ');

          // Token amount leads, fiat sits underneath it.
          //
          // A stranger's transfer has no decryptable value, and that is the
          // privacy guarantee working — not missing data. It says so once, in
          // words, where the figure would be: the shield already carries the
          // point in the counterparty slot, and an icon where a number belongs
          // reads as a glitch (Pat's call, 2026-08-26). The fiat line stays
          // empty rather than repeating it. Matches the detail panel, which has
          // always said "Address: Private" for this row.
          // A fee-amount row is fee-scale by definition, and formatTokenBalance
          // rounds to 4 decimals for ETH. Pat's anchor fee (0.000539379930021)
          // and the balance it left behind (0.00046) BOTH printed as "0.0005",
          // so one screen showed the same number twice for two different
          // quantities. formatFeeUnits exists for exactly this and says so in
          // its own comment; it is scoped to this row rather than widening the
          // shared balance formatter, which would make ordinary balances long.
          // A share amount prints as the underlying it is worth at the live rate
          // ("30.00 USDC", hint "held as ppUSDC"); the share count is the
          // fallback until the rate has been read. Fee-amount rows keep their asset.
          const shareRate = isShareSymbol(tx.asset) ? rateFor(tx.chainId, tx.tokenAddress) : undefined;
          // Always the UNDERLYING's name, converted when the rate is in and
          // marked approximate while it is not. The old fallback printed the
          // share count under the SHARE's name, so a 49.913840 USDC deposit
          // read "49.87911 ppUSDC" on the public feed and looked like a fee had
          // been taken (Pat, 2026-09-12).
          const amountText = (n: number) => balanceDisplay(n, tx.asset, tx.chainId, tx.tokenAddress).text;
          // A consolidation leads with its note counts, as the consolidation
          // panel does, and keeps the fee on the line underneath.
          const exactFeeText = feeAmountRow
            ? balanceDisplay(formatUnits(feeRowWei(tx), getTokenMetadata(tx.tokenAddress, tx.chainId).decimals ?? 18), tx.asset, tx.chainId, tx.tokenAddress).text
            : '';
          const consolidationText = consolidationHeadline(tx);
          // A two-leg row reads as the action widget does: what left, then what
          // arrived, each in the units its own row would use. A phone row puts
          // the arrival on the second line, so the type keeps its width.
          const legText = (leg: SwapLeg) => {
            return balanceDisplay(leg.tokenAmount, leg.asset, leg.chainId, leg.tokenAddress).text;
          };
          const legs = swapLegTexts(tx, legText);
          const legsText = legs && (compactRows ? `${legs.from} \u2192` : `${legs.from} \u2192 ${legs.to}`);
          const stackedLegs = !!legs && compactRows;
          const rowTokenText = feeAmountRow
            ? consolidationText ?? exactFeeText
            : legsText
              ? legsText
            : tx.type === 'Transfer'
              ? (transferTokenAmount !== null ? amountText(transferTokenAmount) : transferResolving ? TRANSFER_RESOLVING_COPY : 'Private')
              : amountText(tx.tokenAmount);
          // The dollar line follows the same converted quantity as the amount above it.
          const shareUsd = (n: number): string | null => {
            if (!shareRate) return null;
            const price = underlyingPriceFor(shareRate, data.priceMap);
            return price > 0 ? formatUsd(shareNumberAsUnderlying(n, shareRate) * price) : null;
          };
          const rowUsdText = stackedLegs
            ? legs.to
            : consolidationText
            ? `Fee ${exactFeeText}`
            : feeAmountRow
              ? tx.value
            : tx.type === 'Transfer'
            ? (transferTokenAmount !== null && shareRate
                ? (shareUsd(transferTokenAmount) ?? (transferUsd !== null ? `$${transferUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : ''))
                : transferUsd !== null
                  ? `$${transferUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                  : '')
            // A real amount priced at $0 means no price feed (testnet XLM), not a worthless deposit.
            : (shareUsd(tx.tokenAmount) ?? (tx.usdValue === 0 && tx.tokenAmount > 0 ? '' : tx.value));

          const rowMenuItems = () => buildMenuItems(tx, { canWithdraw, canExit, canExportNote }, depositTx);
          if (phoneRows) {
            const detailActions = () => rowMenuItems().filter((item) => item.key !== 'view');
            rowActions.set(`row:${rowKey}`, detailActions);
            if (tx.txHash && !rowActions.has(`tx:${tx.txHash.toLowerCase()}`)) rowActions.set(`tx:${tx.txHash.toLowerCase()}`, detailActions);
          }
          const rowContent = (
            <>
                {/* Left: asset mark, then type over the counterparty/date line.
                    min-w-0 on both this and the inner column is what lets the
                    meta line ellipsize instead of pushing the amount off. */}
                <View className="min-w-0 flex-1 flex-row items-center gap-[10px]">
                  <AssetChainMark asset={tx.asset} chain={tx.chain} chainId={tx.chainId} size={28} />
                  <View className="min-w-0 flex-1 gap-[3px]">
                    <View className="flex-row items-start gap-[5px]">
                      {/* nw-keep(data-color): direction glyph color is per-type (theme token, or the bespoke transfer hue) into the vector-icon sink */}
                      <View className="mt-[2px]"><Ionicons name={typeGlyph} size={15} color={typeGlyphColor} /></View>
                      {/* A phone row wraps a long type rather than cut it. */}
                      <Text numberOfLines={compactRows ? 2 : 1} className="shrink font-pp-semi-bold text-[14px] leading-[19px] text-text">
                        {normalizedType}
                      </Text>
                      {phoneRows && statusCfg !== STATUS_CONFIG[colorScheme].completed ? (
                        <View accessibilityLabel={statusLabel} className="mt-[2px] h-[14px] w-[14px] items-center justify-center">
                          {/* nw-keep(data-color): status glyph color from the STATUS_CONFIG palette into the SVG-icon color prop */}
                          <View className="scale-[0.8]"><StatusIcon color={statusCfg.fg} /></View>
                        </View>
                      ) : null}
                    </View>
                    {phoneRows ? null : (
                    <View className="flex-row items-center gap-[4px]">
                    {compactRows && statusCfg !== STATUS_CONFIG[colorScheme].completed ? (
                      <View accessibilityLabel={statusLabel} className="h-[14px] w-[14px] items-center justify-center">
                        {/* nw-keep(data-color): status glyph color from the STATUS_CONFIG palette into the SVG-icon color prop */}
                        <View className="scale-[0.8]"><StatusIcon color={statusCfg.fg} /></View>
                      </View>
                    ) : null}
                    <Text numberOfLines={1} className="min-w-0 shrink font-pp-regular text-[12px] leading-[17px] text-text-muted">
                      {(() => {
                        // Copy control right after the counterparty address —
                        // the copied value is always the FULL address.
                        // Private counterparty: the shield stands in for the
                        // address, followed by the date/time as usual.
                        if (counterpartyPrivate) {
                          const rest = [rowDate, rowTime].filter(Boolean).join(' · ');
                          return (
                            <>
                              <Ionicons name="shield-checkmark-outline" size={11} color={colors.textMuted} />
                              {rest ? ` · ${rest}` : ''}
                            </>
                          );
                        }
                        const counterpartyFull = tx.type === 'Transfer'
                          ? (transferPayee ?? null)
                          : (tx.fullAddress || null);
                        if (!counterpartyFull || !counterparty) return metaLine;
                        const rest = [rowDate, rowTime].filter(Boolean).join(' · ');
                        return (
                          <>
                            <AddressWithExplorer
                              display={counterparty}
                              full={counterpartyFull}
                              href={getExplorerAddressUrl(tx.chainId, counterpartyFull)}
                            />
                            {rest ? ` · ${rest}` : ''}
                          </>
                        );
                      })()}
                    </Text>
                    </View>
                    )}
                  </View>
                </View>

                {/* Right: token amount over its fiat value, then status + menu. */}
                <View className="shrink-0 flex-row items-center gap-[4px] overflow-visible">
                  <View className="min-w-[76px] items-end gap-[2px]">
                    <Text numberOfLines={1} className="font-pp-semi-bold text-[13.5px] leading-[18px] text-text">
                      {rowTokenText}
                    </Text>
                    <ShareCountHint hint={balanceDisplay(transferTokenAmount ?? tx.tokenAmount, tx.asset, tx.chainId, tx.tokenAddress).hint} />
                    <Text numberOfLines={1} className={stackedLegs ? 'font-pp-semi-bold text-[13.5px] leading-[18px] text-text' : 'font-pp-regular text-[11.5px] leading-[16px] text-text-muted'}>
                      {rowUsdText}
                    </Text>
                  </View>
                  {compactRows ? null : Platform.OS === 'web' ? (
                    <StatusBadgeWebTooltip
                      label={statusLabel}
                      bg={statusCfg.bg}
                      iconColor={statusCfg.fg}
                      bordered={statusCfg.border}
                      borderColor={colors.border}
                      Icon={StatusIcon}
                      width={34}
                    />
                  ) : (
                    <View className="w-[34px] items-center p-[5px]" accessibilityLabel={statusLabel}>
                      <View
                        className={`h-[24px] w-[24px] items-center justify-center rounded-full border-border ${statusCfg.border ? 'border' : 'border-0'}`}
                        // nw-keep(data-color): status-badge tint from the STATUS_CONFIG palette (runtime, not a class token)
                        style={{ backgroundColor: statusCfg.bg }}
                      >
                        {/* nw-keep(data-color): status glyph color from the STATUS_CONFIG palette into the SVG-icon color prop */}
                        <StatusIcon color={statusCfg.fg} />
                      </View>
                    </View>
                  )}
                  {phoneRows ? null : (
                  <View className={`relative z-[99999] ${compactRows ? 'w-[32px]' : 'w-[40px]'} items-center justify-center overflow-visible`}>
                    <TransactionRowMenu items={rowMenuItems()} />
                  </View>
                  )}
                </View>
            </>
          );

          return (
            <View key={rowKey} className="relative z-[1] overflow-visible"
              onLayout={index === 0 ? (e) => { const w = Math.round(e.nativeEvent.layout.width); setRowWidth((prev) => (prev === w ? prev : w)); } : undefined}
            >
              <PulseRow active={isPending}>
              {phoneRows ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${normalizedType} details`}
                  testID="transaction-row"
                  onPress={() => { setDetailRowKey(rowKey); openDetail(tx); }}
                  className="flex-row items-center gap-[8px] overflow-visible py-[12px] active:opacity-70"
                >
                  {rowContent}
                </Pressable>
              ) : (
                <View className="flex-row items-center gap-[8px] overflow-visible py-[12px]">
                  {rowContent}
                </View>
              )}
              </PulseRow>
              {index < transactions.length - 1 && (
                <View className="relative z-[-1] h-[1px] self-stretch bg-border-light" />
              )}
            </View>
          );
        })}
        {hasMore && (
          <Pressable
            className="items-center justify-center border-t border-t-border-light py-[12px]"
            onPress={
              initialRows === undefined
                ? () => router.push('/transactions')
                // Grow by the fixed step, capped at the paged threshold — the
                // cap is what flips the table into page-at-a-time mode.
                : () => setPager({ viewKey, count: Math.min(visibleCount + EMBEDDED_LOAD_STEP, EMBEDDED_PAGED_THRESHOLD), page: 1 })
            }
            accessibilityRole="button"
            testID="transactions-load-more"
          >
            <Text className="font-pp-medium text-[13px] text-text-secondary">
              {initialRows === undefined ? 'View All' : showMoreLabel(Math.min(remainingRows, EMBEDDED_LOAD_STEP), remainingRows)}
            </Text>
          </Pressable>
        )}
        {paged && totalPages > 1 && (
          <View className="flex-row items-center justify-between border-t border-t-border-light px-[16px] py-[12px]">
            <Pressable
              className={`flex-row items-center gap-[4px] ${currentPage <= 1 ? 'opacity-40' : 'opacity-100'}`}
              onPress={() => setPager({ viewKey, count: visibleCount, page: Math.max(1, currentPage - 1) })}
              disabled={currentPage <= 1}
            >
              {/* nw-keep(data-color): chevron glyph color is a theme token into the @expo/vector-icons sink (no className path) */}
              <Ionicons name="chevron-back" size={16} color={colors.text} />
              <Text className="font-pp-medium text-[13px] text-text">Prev</Text>
            </Pressable>
            <Text className="font-pp-regular text-[12px] text-text-secondary">
              Page {currentPage} / {totalPages}
            </Text>
            <Pressable
              className={`flex-row items-center gap-[4px] ${currentPage >= totalPages ? 'opacity-40' : 'opacity-100'}`}
              onPress={() => setPager({ viewKey, count: visibleCount, page: Math.min(totalPages, currentPage + 1) })}
              disabled={currentPage >= totalPages}
            >
              <Text className="font-pp-medium text-[13px] text-text">Next</Text>
              {/* nw-keep(data-color): chevron glyph color is a theme token into the @expo/vector-icons sink (no className path) */}
              <Ionicons name="chevron-forward" size={16} color={colors.text} />
            </Pressable>
          </View>
        )}
      </View>
      )}
    </Card>
    {detailTx && (
      <TransactionDetailModal
        tx={detailTx}
        onClose={() => closeDetail()}
        onCloseForAction={() => closeDetail({ followedByAction: true })}
        actions={phoneRows
          ? ((detailRowKey ? rowActions.get(`row:${detailRowKey}`) : undefined)
            ?? (detailTx.txHash ? rowActions.get(`tx:${detailTx.txHash.toLowerCase()}`) : undefined))?.()
          : undefined}
      />
    )}
  </>
  );

  function buildMenuItems(
    tx: Transaction,
    flags: { canWithdraw: boolean; canExit: boolean; canExportNote: boolean },
    /** The deposit the fund actions act on: the row itself, or a swap's output. */
    depositTx: Transaction = tx,
  ): TransactionRowMenuItem[] {
    // nw-keep(data-color): every menu-item `icon` below feeds a theme token (or the fixed exit-red
    // literal) into an @expo/vector-icons / SVG color prop — non-class sinks, no className path.
    const items: TransactionRowMenuItem[] = [
      {
        key: 'view',
        label: 'View Details',
        icon: <Ionicons name="eye-outline" size={16} color={colors.text} />,
        onPress: () => openDetail(tx),
      },
      {
        key: 'explorer',
        label: `View on ${getExplorerName(tx.chainId)}`,
        // DEV-573: red triangle + what opening the explorer gives away.
        icon: <Ionicons name="warning" size={16} color="#E11D48" />,
        warning: explorerPrivacyText(getExplorerName(tx.chainId)),
        onPress: () => {
          if (tx.txHash) Linking.openURL(getExplorerTxUrl(tx.chainId, tx.txHash));
        },
      },
    ];
    if (flags.canWithdraw) {
      items.push({
        key: 'withdraw',
        label: 'Withdraw',
        icon: <Ionicons name="arrow-up-outline" size={16} color={colors.text} />,
        onPress: () => runOnRowChain('withdraw', depositTx),
      });
    }
    if (flags.canExit) {
      items.push({
        key: 'exit',
        label: 'Exit',
        icon: <RagequitIcon color="#BA6B5D" />,
        onPress: () => runOnRowChain('exit', depositTx),
        color: '#BA6B5D',
      });
    }
    if (flags.canExportNote) {
      items.push({
        key: 'export',
        label: 'Export Note',
        icon: <Ionicons name="download-outline" size={16} color={colors.text} />,
        onPress: () => runOnRowChain('export', depositTx),
      });
    }
    // Audit receipt — a per-transaction partial viewing key. Prefer the
    // sent-payment proof (recipient note captured at send time) over the
    // owned-note proof: for an outgoing transfer the user's NoteManager
    // only holds the change note, which would prove the wrong thing.
    // Falls back to the record a transfer with an unknown relay outcome left
    // before broadcast (DEV-413): under this row's own change note, or, for a
    // send with no change, under its recipient note, which only the public
    // snapshot's outputs for this tx can name.
    // The row's own chain's notes, whichever chain is selected; a swap's
    // output is on the output's chain.
    const rowNotes = notesByChain.get(tx.chainId) ?? [];
    const depositNotes = notesByChain.get(depositTx.chainId) ?? [];
    const rowNoteCommitments = tx.txHash
      ? [
        ...rowNotes
          .filter((n) => String(n.txHash || '').toLowerCase() === tx.txHash.toLowerCase())
          .map((n) => String(n.commitment)),
        ...(data.transactOutputsByTx?.get(tx.txHash.toLowerCase()) ?? []),
      ]
      : [];
    const sentAudits = findSentAuditsForRow(tx.txHash, rowNoteCommitments);
    // A swap's own tx also holds the source side's change: its key is the output's.
    const swapLabels = isSwapRow(tx) ? tx.swapOut.labels : null;
    const ownedNote = tx.txHash
      ? depositNotes.find((n) => String(n.txHash || '').toLowerCase() === tx.txHash.toLowerCase()
        && (!swapLabels || swapLabels.includes(hexKey(String(n.label ?? '')))))
      : undefined;
    // For an OUTGOING transfer the only owned note is the change, which would
    // prove the wrong thing. So offer the owned-note key only for non-outgoing
    // rows; an outgoing row needs the send-time recipient disclosure (sentAudit)
    // and otherwise offers no key (covers reconstructed #215 'Sent' rows, which
    // set tx.direction === 'out').
    const isOutgoingTransfer = tx.direction === 'out' || !!findSentTransfer(tx.txHash);
    // A Stellar send to an unregistered account: its one-time link is
    // rebuilt from this device's saved copy (services/stellar/stellar-sent-claims.ts).
    const stellarClaim = tx.chainId === STELLAR_TESTNET_ID && tx.direction === 'out' && stellarWalletAddress
      ? findStellarSentClaim(stellarWalletAddress, tx.txHash)
      : null;
    if (stellarClaim) {
      items.push({
        key: 'stellar-claim-link',
        label: 'Copy payment link',
        icon: <Ionicons name="link-outline" size={16} color={colors.text} />,
        onPress: () => {
          void (async () => {
            const { buildStellarClaimUrl } = await import('@/services/stellar/stellar-claim-url');
            const url = buildStellarClaimUrl(stellarClaim.notes.map((n) => ({ ...n, txHash: stellarClaim.txHash ?? n.txHash })));
            const { copyText } = await import('@/services/copy-text');
            toast(url && (await copyText(url))
              ? { title: 'Payment link copied to your clipboard.' }
              : { title: 'Clipboard is unavailable. Try again with the page focused.', variant: 'destructive' });
          })();
        },
      });
    }
    // DEV-511: a private swap-send to an unregistered recipient. The claim was
    // sealed to this account's viewing key before the relay and keyed by the
    // relayed hash on broadcast; opening it is local, no request. Without a
    // local record (another browser: the row is "Withdrawal via swap", viaSwap)
    // a same-chain send is read from Note ciphertexts already loaded; nothing
    // is fetched on the click.
    const sealedSwapClaims = tx.txHash ? findSealedClaimsForTx(tx.txHash) : [];
    if (sealedSwapClaims.length > 0 || ((tx.sentToOther || (tx.viaSwap && !tx.receivedAs && !tx.delivery)) && tx.txHash && !isDepositRecoverable(tx))) {
      items.push({
        key: 'recover-swap-claim-link',
        label: 'Recover claim link',
        icon: <Ionicons name="cloud-download-outline" size={16} color={colors.text} />,
        onPress: () => {
          void (async () => {
            const km = getCommittedManagers().keystoreManager;
            if (!km) {
              toast({ title: 'Sign in first: the claim link is recovered with your viewing key.', variant: 'destructive' });
              return;
            }
            try {
              const viewingPrivateKey = String(km.getViewingKeyPair().privateKey);
              let url: string | null = null;
              if (sealedSwapClaims.length > 0) {
                const { createCryptoService } = await import('@/services/sdk-runtime');
                const crypto = createCryptoService() as unknown as BackupCryptoLike;
                const claims = sealedSwapClaims
                  .map((sealed) => openSwapSendClaim({ sealed, viewingPrivateKey, crypto }))
                  .filter((c): c is NonNullable<typeof c> => !!c);
                url = buildSentReceiptUrl(claims.map((c) => ({ ...c, txHash: String(tx.txHash) as `0x${string}` })) as never);
              } else {
                // No request: only Note ciphertexts the app already loaded on
                // its own schedule (services/note-ciphertexts.ts). A click must
                // not cause a fetch, or the fetch's timing names this row.
                const { createCryptoService } = await import('@/services/sdk-runtime');
                const crypto = createCryptoService() as unknown as BackupCryptoLike;
                const loaded = noteCiphertextsFor(tx.chainId, String(tx.txHash));
                const claims = claimsFromLoadedCiphertexts({
                  chainId: tx.chainId,
                  txHash: String(tx.txHash),
                  ciphertexts: loaded,
                  open: (c) => decryptBlindDepositBackup({ ...c, viewingPrivateKey, crypto }),
                });
                const outcome = claimRecoveryOutcome({ loadedCiphertexts: loaded.length, claims: claims.length });
                if (outcome !== 'found') {
                  toast(outcome === 'none-needed'
                    ? { title: SWAP_SEND_NO_CLAIM_IN_TX }
                    : { title: 'Still syncing, try again shortly.', variant: 'destructive' });
                  return;
                }
                url = buildRecoveredClaimUrl(claims);
              }
              if (!url) {
                toast({ title: 'Could not rebuild the claim link on this device.', variant: 'destructive' });
                return;
              }
              const { copyText } = await import('@/services/copy-text');
              toast((await copyText(url))
                ? { title: 'Claim link recovered and copied to your clipboard.' }
                : { title: 'Recovered the link but could not copy. Try again with the page focused.', variant: 'destructive' });
            } catch (e) {
              toast({ title: 'Could not recover the claim link right now. Try again in a moment.', variant: 'destructive' });
              console.warn('[transactions] recover swap claim link failed', e instanceof Error ? e.message : String(e));
            }
          })();
        },
      });
    }
    if (sentAudits.length > 0) {
      // Disclosures exist exactly for out-of-band sends (unregistered
      // recipient), so the one-time receipt link is rebuildable here. Valid
      // even after the recipient claimed: importing is idempotent and the
      // import reconcile re-derives the real note status.
      items.push({
        key: 'receipt-link',
        label: 'Copy payment link',
        icon: <Ionicons name="link-outline" size={16} color={colors.text} />,
        onPress: () => {
          void (async () => {
            // Deliberately keep the rebuilt link's createdAtBlock as the 0x0
            // stub. The import path heals it from the bulk snapshot. A previous
            // version queried getTransactionReceipt/getBlock for sentAudits[0]'s
            // relayed tx hash here, which links this browser to the relayed
            // transfer hash for a convenience optimization only.
            const url = buildSentReceiptUrl(sentAudits);
            if (!url) {
              toast({ title: 'Could not rebuild the payment link on this device.', variant: 'destructive' });
              return;
            }
            // Shared copy helper rather than navigator.clipboard directly:
            // this action is the durable route to an out-of-band payment, and
            // it used to be silently web-only, so a phone could not hand over
            // a link the recipient needed (codex, 2026-09-16).
            const { copyText } = await import('@/services/copy-text');
            if (await copyText(url)) {
              toast({ title: 'Payment link copied to your clipboard.' });
              return;
            }
            toast({ title: 'Clipboard is unavailable. Try again with the page focused.', variant: 'destructive' });
          })();
        },
      });
      items.push({
        key: 'audit-key',
        label: 'Export transaction proof',
        icon: <Ionicons name="shield-checkmark-outline" size={16} color={colors.text} />,
        // One key per recipient note — a multi-lineage send disclosed several.
        onPress: () => launchFromDrawer(drawerHost, () => openAuditExport(sentAudits.map((d) => buildSentPaymentKey(d)))),
      });
    } else if (isDepositRecoverable(tx) && tx.txHash) {
      // A deposit this wallet made for someone else, with NO local disclosure
      // for it - this browser never saw the send, or its storage is gone. The
      // sender's own on-chain backup (services/blind-deposit-backup.ts) is the
      // durable copy: scan for it with the signed-in viewing key and rebuild
      // the recipient's claim link from what comes back. Eligibility is public
      // authorship (isDepositRecoverable), not this device's stamp, so a new
      // browser gets the item too. No secret recovered is written to storage;
      // the chain is the store and this is a read.
      items.push({
        key: 'recover-claim-link',
        label: 'Recover claim link',
        icon: <Ionicons name="cloud-download-outline" size={16} color={colors.text} />,
        onPress: () => {
          void (async () => {
            const km = getCommittedManagers().keystoreManager;
            if (!km) {
              toast({ title: 'Sign in first: the claim link is recovered with your viewing key.', variant: 'destructive' });
              return;
            }
            try {
              const claims = await recoverBlindDepositClaims({
                chainId: tx.chainId,
                viewingPrivateKey: String(km.getViewingKeyPair().privateKey),
                txHash: tx.txHash,
              });
              const url = buildRecoveredClaimUrl(claims);
              if (!url) {
                toast({ title: 'No claim backup found on chain for this deposit.', variant: 'destructive' });
                return;
              }
              // A backup decrypted with my key IS the proof this row paid
              // someone else. Re-stamp it as outgoing (tx hash only, never a
              // secret): that is the record the original browser held, so the
              // row reads Deposit to recipient again and stays out of the payer's
              // balances and counts, instead of an ordinary Deposit whose
              // Withdraw cannot work.
              if (ownAddress) {
                recordOutgoingDeposit({
                  payer: ownAddress.toLowerCase(),
                  chainId: tx.chainId,
                  txHash: String(tx.txHash).toLowerCase(),
                  kind: 'deposit-for',
                  timestamp: Date.now(),
                });
              }
              const { copyText } = await import('@/services/copy-text');
              toast(
                (await copyText(url))
                  ? { title: 'Claim link recovered and copied to your clipboard.' }
                  : { title: 'Recovered the link but could not copy. Try again with the page focused.', variant: 'destructive' },
              );
            } catch (e) {
              toast({ title: 'Could not scan for the claim backup right now. Try again in a moment.', variant: 'destructive' });
              console.warn('[transactions] recover claim link failed', e instanceof Error ? e.message : String(e));
            }
          })();
        },
      });
    } else if (ownedNote && !isOutgoingTransfer && tx.chainId !== STELLAR_TESTNET_ID) {
      // The proof verifier reads EVM pools only, so a Stellar proof would not verify.
      items.push({
        key: 'audit-key',
        label: 'Export transaction proof',
        icon: <Ionicons name="shield-checkmark-outline" size={16} color={colors.text} />,
        // The note's own chain: a swap's output is the deposit row's.
        onPress: () => launchFromDrawer(drawerHost, () => openAuditExport(buildOwnedNoteKey(ownedNote as never, depositTx.chainId))),
      });
    }
    // A paid PAYMENT REQUEST (legacy v1): its one-time receipt is rebuildable
    // from the persisted record, so the payer can re-copy it any time - the
    // in-modal copy used to be the only one and died with the first modal
    // reset (Mike, QA 2026-08-25). SDK-native and v2 payments auto-discover
    // and have no receipt, so their rows deliberately offer nothing here.
    const paidRecord = findPaidRequest(tx.txHash);
    if (paidRecord?.requestKind === 'v1' && paidRecord.commitment && paidRecord.label && paidRecord.noteAddressHash) {
      items.push({
        key: 'paid-receipt-link',
        label: 'Copy receipt link',
        icon: <Ionicons name="link-outline" size={16} color={colors.text} />,
        onPress: () => {
          const receipt: PaymentReceiptPayload = {
            kind: 'ppv2-payment-receipt',
            version: 1,
            requestId: paidRecord.requestId,
            chainId: paidRecord.chainId,
            recipientAddress: paidRecord.recipient as `0x${string}`,
            tokenId: paidRecord.tokenAddress as `0x${string}`,
            amount: paidRecord.rawAmount as `0x${string}`,
            noteAddressHash: paidRecord.noteAddressHash as `0x${string}`,
            commitment: paidRecord.commitment as `0x${string}`,
            label: paidRecord.label as `0x${string}`,
            txHash: paidRecord.txHash as `0x${string}`,
            createdAt: new Date(paidRecord.timestamp).toISOString(),
          };
          const url = `${receiptLinkBase()}/receive/${encodePaymentReceiptPayloadForUrl(receipt)}`;
          if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.clipboard) {
            toast({ title: 'Could not copy the receipt link on this device.', variant: 'destructive' });
            return;
          }
          navigator.clipboard.writeText(url)
            .then(() => toast({ title: 'Receipt link copied to your clipboard.' }))
            .catch(() => toast({ title: 'Clipboard is unavailable. Try again with the page focused.', variant: 'destructive' }));
        },
      });
    }
    // Proof of origin — for public withdrawals/exits, prove they're yours and
    // the funds come from a clean (ASP-approved) lineage you control. Only
    // provable when you hold a note in that lineage on this device — make that
    // state obvious rather than failing silently.
    // EVM pools only, like the proof export above: a Stellar origin proof would not verify.
    if ((tx.type === 'Withdrawal' || tx.type === 'Exit') && tx.chainId !== STELLAR_TESTNET_ID) {
      const oType: 'withdraw' | 'exit' = tx.type === 'Exit' ? 'exit' : 'withdraw';
      const provable = canProveOrigin(rowNotes as never, {
        type: oType, txHash: tx.txHash as `0x${string}`, label: (tx.label ?? null) as `0x${string}` | null,
      });
      items.push({
        key: 'origin',
        label: provable ? 'Prove origin' : 'Prove origin. Unavailable',
        icon: <Ionicons name="ribbon-outline" size={16} color={provable ? colors.text : colors.textMuted} />,
        color: provable ? undefined : colors.textMuted,
        onPress: () => {
          if (!provable) {
            // Type-specific: a withdrawal creates a change note the prover
            // needs; an exit consumes a note and creates none, so the proof
            // needs the exact exited note's preimage (usually from imported
            // historical state).
            Alert.alert(
              'Origin can’t be proven here',
              oType === 'exit'
                ? 'Proving an exit needs the exact note it consumed. Sign in with, or import, the account that held that note.'
                : 'You don’t hold this withdrawal’s change note on this device. Connect or import the wallet that does to prove its origin.',
            );
            return;
          }
          const proof = buildOriginProofForTarget({
            chainId: tx.chainId,
            notes: rowNotes as never,
            target: {
              type: oType,
              txHash: tx.txHash as `0x${string}`,
              label: (tx.label ?? null) as `0x${string}` | null,
              recipient: tx.fullAddress as `0x${string}`,
              value: tx.rawAmount,
              tokenId: tx.tokenAddress as `0x${string}`,
            },
          });
          if (proof) launchFromDrawer(drawerHost, () => openOriginProof(proof));
        },
      });
    }
    return items;
  }
}
