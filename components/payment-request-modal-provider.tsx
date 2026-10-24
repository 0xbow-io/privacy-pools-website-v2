import { ShareCountHint } from '@/components/pools/share-count-hint';
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
import { useBalanceDisplay } from '@/hooks/use-balance-display';

import { BalanceAmount } from '@/components/pools/balance-amount';
import { TokenMark } from '@/components/ui/token-network-icon';
import { sdkErrorText } from '@/services/sdk-error-amounts';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { requestWalletRefusalFor } from '@/services/request-wallet-availability';
import { setReceiveSetup } from '@/services/receive-setup';
import { isSupersededLegacyPool, poolDisplayLabel } from '@/config/pool-paths';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ACTIVE_ENVIRONMENT } from '@/config/environments';
import { tokenAmountLabel, isShareSymbol, displayTokenSymbol } from '@/services/share-display';
import { assertPaymentRequestBounds, PaymentRequestBoundsError } from '@/services/payment-request-bounds';
import { assertDepositCap } from '@/services/deposit-cap';
import { getPrice } from '@/services/price-service';
import { ENTRYPOINT_ASSETS_ABI, getVettingFeeBPS, type EntrypointAssetConfig } from '@/services/entrypoint-assets';
import { friendlyDepositError } from '@/services/deposit-limits';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { useOpLock } from '@/hooks/use-op-lock';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateTransactionCaches } from '@/services/cache';
import { fetchTransferFeeQuote } from '@/services/transfer-fee-quote';
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Circle } from 'react-native-svg';
import { CopyIconButton } from '@/components/ui/copy-address';
import { InlineOpPortal } from '@/components/inline-op-portal';
import { useInlineOpsCapable } from '@/hooks/use-inline-ops-capable';
import { useAccount, usePublicClient, useSendTransaction, useSignTypedData, useSwitchChain } from 'wagmi';
import { encodeFunctionData, erc20Abi, formatUnits, parseUnits } from 'viem';
import { NoteStatus } from '@/services/sdk-types';
import { recordPaidRequest } from '@/services/paid-requests-store';
import { recordWithdrawFee } from '@/services/withdraw-fees-store';
import { describePaymentTxOutcome, waitForPaymentTx } from '@/services/tx-finality';
import type { Address as SdkAddress, Hash, Hex, Note } from '@/services/sdk-types';
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
  type RelayTransferParams,
  type TransferRecipientSpec,
} from '@/services/relayed-transfer';
import { expectTransferRelay } from '@/services/transfer-relay-outputs';
import { useNotes } from '@/hooks/use-notes';

import { useTheme } from '@/components/theme-provider';
import { PAY_URL_BASE } from '@/config/env';
import { IsDefaultPoolActive } from '@/config/pool-profile';
import { resolveEnsName } from '@/services/ens';

// Production deployments set EXPO_PUBLIC_PAY_URL_BASE so share links pin
// to the brand domain (https://privacypools.com) regardless of which
// Vercel alias actually rendered the modal. Preview and dev leave it
// unset and fall back to window.location.origin so the in-flight session
// stays on the same host.
function shareLinkBase(): string {
  if (PAY_URL_BASE) return PAY_URL_BASE;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return '';
}
import { loadStoredAccountExport, saveStoredAccountExport } from '@/components/sdk-provider';
import { Colors } from '@/constants/theme';
import { useSuiClient } from '@mysten/dapp-kit';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { STELLAR_XLM } from '@/config/stellar-deployment';
import { encodeStellarBlindRequest, stellarBlindRequestId } from '@/services/stellar/stellar-request';
import { describeStellarStage, stellarErrorMessage } from '@/services/stellar/stellar-copy';
import { withStellarLinkParams } from '@/services/stellar/stellar-link';
import { canProveSave, saveWithProof, type PickerHost } from '@/services/backup-file-proof';
import { ACTIVE_APP_ENVIRONMENT } from '@/config/app-environment';
import { STAGING_MAINNET_EXPLICIT } from '@/config/staging-mainnet';
import { useSuiSession } from '@/hooks/use-sui-session';
import { selectSuiNotes, SUI_SINGLE_NOTE_ERROR } from '@/services/sui-witness/note-selection';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useNoteImport } from '@/hooks/use-note-import';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { useToast } from '@/components/toast-provider';
import { useRequireConnection } from '@/hooks/use-require-connection';
import { useTabCloseGuard } from '@/hooks/use-tab-close-guard';
import { useDebug } from '@/components/debug-provider';
import { useTxActivity } from '@/components/tx-activity-provider';
import { usePathname } from 'expo-router';
import { FlowProgress } from '@/components/ui/flow-progress';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { getChainConfig, getExplorerAddressUrl, getExplorerName, getExplorerTxUrl, isSupportedEvmChainId, defaultChainId, STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { getEntrypointDepositableTokens, getTokenMetadata, isStablecoin } from '@/config/tokens';
import { sanitizeAmountInput } from '@/services/token-amount';
import { discardUnsharedPaymentRequest, getStoredPaymentRequestRecord } from '@/services/payment-request-recovery';
import { bumpPaymentRequestRevision } from '@/services/payment-request-revision';
import {
  type BackupFileTarget,
  canProveBackupSave,
  notePaymentRequestBackupDelivered,
  openBackupFileTargetFromPress,
  saveBackupWithProof,
  writeBackupFileTarget,
} from '@/services/payment-request-signout';
import { addSessionPaymentRequest } from '@/services/session-payment-requests';
import {
  TRANSFER_MAX_INPUTS,
  TRANSFER_MAX_LABELS,
  formatRelayedPaymentShortfall,
  selectGreedyTransferInputs,
  toTransferSpendabilityLog,
  verifyTransferSpendability,
} from '@/services/transfer-spendability';
import { maxCoverableTransfer } from '@/services/transfer-note-selection';
import { translateSdkTransactError } from '@/services/transfer-outcome';
import {
  isPayRelayIndeterminate,
  latchPayRelay,
  leavePaymentLabel,
  leavePaymentWarning,
  onPayRelayLatchChange,
  payRelayLatch,
  payRelayUnknownMessage,
  PayRelayDeadlineError,
  releasePayRelay,
  withRelayDeadline,
  type PayRunPhase,
} from '@/services/pay-relay-guard';
import { onRelayedTxHash } from '@/services/relayed-receipt';
import { receiptChain } from '@/services/receipt-chain-registry';
import { requestChainRefusal } from '@/services/receipt-chain';
import { linkToken } from '@/services/link-token-registry';

import {
  decodePaymentReceiptPayloadFromUrl,
  decodePaymentRequestPayloadFromUrl,
  encodePaymentReceiptPayloadForUrl,
  encodePaymentRequestPayloadForUrl,
  normalizeExpiresAt,
  getPaymentRequestSigningDomain,
  getPaymentRequestSigningMessage,
  sanitizePaymentRequestPayloadForSharing,
  stellarSdkPaymentRequestPayload,
  type PaymentReceiptPayload,
  type PaymentRequestPayload,
  type PaymentRequestPayloadV1,
  type PaymentRequestPayloadV2,
  type PaymentRequestPayloadV3,
  PAYMENT_REQUEST_V2_SIGNING_TYPES,
  type StoredPaymentRequest,
  findStoredPaymentRequest,
  removeStoredPaymentRequest,
  mergeImportedNote,
  parsePaymentReceiptPayload,
  parsePaymentRequestPayload,
  paymentRequestIdToHex,
  verifyPaymentRequestSignature,
  assertPaymentRequestPayable,
  getPaymentRequestV3TypedData,
  isPaymentRequestExpired,
  paymentRequestRefusalMessage,
  PAYMENT_REQUEST_EXPIRED_MESSAGE,
} from '@/services/payment-requests';
import { useNativeMockBlock } from '@/hooks/use-native-mock-block';
import { usePaymentRequestExpired } from '@/hooks/use-payment-request-expired';
import { payStatusBoxHidden, paySuccessDetail } from '@/services/pay-status-display';

type PaymentMode = 'request' | 'pay' | 'receive';
// Deep-link auto-action target, discriminated by chain type: a raw number
// let an EVM chainId that equals the Sui sentinel masquerade as Sui (codex).
type AutoTarget = { kind: 'sui' } | { kind: 'evm'; chainId: number } | null;

/** Optional create-flow prefill. Two shapes, both additive — omit the whole
 *  object for the plain "empty form" open:
 *
 *  1. RE-ISSUE (`chainId` present) — the Payment Requests list widget's
 *     Re-issue action regenerating a request with the original amount/token.
 *     Carries the SOURCE chain: the same text amount means something different
 *     under another chain's token precision, so the modal aligns/validates
 *     against it before applying anything.
 *  2. AMOUNT SEED (`initialAmount`, no `chainId`) — open the form with the
 *     amount field already filled for whatever chain/asset is currently
 *     selected. Runs through the same sanitizer the input uses; the field stays
 *     fully editable and the create flow validates it exactly like a typed
 *     value. Ignored when `chainId` is present (the re-issue path owns the
 *     amount then). */
export type PaymentRequestPrefill = {
  chainId?: number;
  amount?: string;
  tokenAddress?: Hex;
  initialAmount?: string;
  /** Hub opener: draw inside the inline host instead of the overlay. */
  inline?: boolean;
};

/** One hub-card edit, pushed into the request form. Every field optional. */
export type InlineRequestFormPatch = {
  amount?: string;
  /** Catalog address of the requested asset; matched case-insensitively. */
  tokenAddress?: Hex;
  /**
   * The chain `tokenAddress` belongs to. A cross-chain pick switches the app's
   * chain and writes the token in the same tick, and the switch may not have
   * reached this provider's own `chainId` yet — so the address is resolved
   * against THIS chain's catalog rather than whichever one happens to be
   * current. Without it a pick on another chain silently no-ops.
   */
  tokenChainId?: number;
};

type PaymentRequestModalContextType = {
  openRequestPaymentModal: (prefill?: PaymentRequestPrefill) => void;
  openPayRequestModal: (payload?: string, opts?: { inline?: boolean }) => void;
  openPayViaTransferModal: (payload?: string, opts?: { inline?: boolean }) => void;
  openReceivePaymentModal: (payload?: string) => void;
  closePaymentRequestModal: () => void;
  /** Whether the modal is currently shown — consumed by the URL bridge. */
  isOpen: boolean;
  /** True while the flow draws inside the hub's inline host (no overlay). */
  inlineActive: boolean;
  /**
   * The asset a request would be created for. The hub's amount card renders
   * THIS — never its own pool token — so the pill can never name an asset the
   * created payload does not carry. On Sui `symbol`/`decimals` are the forced
   * SUI/9 pair; `address` stays the (unused) EVM selection.
   */
  requestToken: { symbol: string; address: Hex; decimals: number; chainId: number };
  /** The amount a request would be created for; the provider owns it. */
  requestAmount: string;
  /** A request has been created: its amount is frozen into the payload. */
  requestCreated: boolean;
  /** The hub's card pushes each edit here. */
  syncInlineRequestForm: (patch: InlineRequestFormPatch) => void;
  /**
   * A run is EXECUTING in the provider. Exposed because the page-level
   * launchers (app/pay/[encoded].tsx, app/receive/[encoded].tsx) render their
   * OWN buttons, and those buttons call the OPENERS, not the locked handlers:
   * useOpLock only wraps handlePayRequest/handlePayViaTransfer, so it cannot
   * see a press arriving through openPayViaTransferModal. Worse, every opener
   * calls resetState(), whose first act is `opEpochRef.current += 1` -- the
   * exact abort signal both pay handlers' live() gates read. A page press
   * landing mid-run therefore does what closePaymentRequestModal explicitly
   * refuses to do: it staleds a run the user may already have paid gas for.
   * The page buttons must gate on this. (QA 2026-08-27, "ux is still bad".)
   */
  isBusy: boolean;
  /**
   * WHICH run is executing -- for the button LABEL only ("Processing..." on
   * the pressed control). Never for opacity: dim mirrors `disabled`, nothing
   * else. Same rule as this file's own pay buttons.
   */
  busyAction: 'wallet' | 'transfer' | null;
  /** Which flow the modal is showing — the URL bridge must only treat the
   *  REQUEST mode as the `?modal=request` deep-link modal; a /pay-page open
   *  (pay mode) is not a deep-link modal and must never be judged/closed as
   *  one (it was: disconnected payers saw the pay modal flash-close). */
  mode: PaymentMode;
  /**
   * The last request PAID this session, so the /pay page can render a
   * terminal "paid" card even after the inline flow unmounts. Without it the
   * page fell back to the pristine request card - Status "Ready", live Pay
   * button - after a confirmed payment (Mike, QA 2026-08-25): success read
   * as a reset, and one more press paid the same request twice.
   */
  lastPaid: { requestKey: string; txHash: string; hadReceipt: boolean; chainId: number } | null;
  /**
   * A relay of this request may still land (DEV-486), so it must not be paid
   * again. The /pay page gates its own Pay buttons on it.
   */
  payRelayLatchFor: (requestKey: string | null | undefined) => { heard: boolean; until: number } | null;
};

const missingProvider = () => {
  throw new Error('usePaymentRequestModal must be used within a PaymentRequestModalProvider');
};

/** Presentation switch: the classic <Modal> overlay, or re-parented into the
 *  desktop hub's inline host (modal-less). Content and state are identical. */
function RequestShell({
  inline,
  isOpen,
  isMobileSheet,
  onClose,
  children,
}: {
  inline: boolean;
  isOpen: boolean;
  isMobileSheet: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (inline) {
    if (!isOpen) return null;
    return (
      <InlineOpPortal>
        <View className="relative w-full grow gap-[16px]">{children}</View>
      </InlineOpPortal>
    );
  }
  return (
    <Modal animationType={isMobileSheet ? 'slide' : 'fade'} transparent visible={isOpen} onRequestClose={onClose}>
      <View className={`flex-1 items-center bg-[rgba(0,0,0,0.35)] ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[16px]'}`}>
        <View className={`w-full gap-[16px] border border-border bg-card-background p-[20px] ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[26px]' : 'max-w-[720px] max-h-[92%] rounded-card'}`}>
          {children}
        </View>
      </View>
    </Modal>
  );
}

const PaymentRequestModalContext = createContext<PaymentRequestModalContextType>({
  openRequestPaymentModal: missingProvider,
  openPayRequestModal: missingProvider,
  openPayViaTransferModal: missingProvider,
  openReceivePaymentModal: missingProvider,
  closePaymentRequestModal: missingProvider,
  isOpen: false,
  inlineActive: false,
  // The literal, not NATIVE_ASSET_ADDRESS: that const is declared further down
  // this module, so referencing it from a module-scope default would be a TDZ
  // ReferenceError at import time.
  requestToken: { symbol: 'ETH', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Hex, decimals: 18, chainId: 0 },
  requestAmount: '',
  requestCreated: false,
  syncInlineRequestForm: () => {},
  isBusy: false,
  busyAction: null,
  mode: 'request',
  lastPaid: null,
  payRelayLatchFor: () => null,
});

export function usePaymentRequestModal() {
  return useContext(PaymentRequestModalContext);
}

function canUseBrowserApis(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Try to parse a pasted payload as one of the Sui payment kinds (raw JSON or
 * base64/base64url JSON). Returns null for anything else — EVM payloads,
 * packed-binary links, garbage — so the pay/receive handlers can branch by
 * payload KIND instead of the active chain selection (an EVM /pay or /receive
 * link must keep working while Sui is the selected chain, and vice versa).
 */
function parseSuiPaymentPayload(raw: string): ({ kind: string } & Record<string, unknown>) | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const tryJson = (s: string): unknown => {
    try { return JSON.parse(s); } catch { return null; }
  };
  let parsed: unknown = trimmed.startsWith('{') ? tryJson(trimmed) : null;
  if (!parsed && typeof atob === 'function' && /^[A-Za-z0-9+/\-_=%]+$/.test(trimmed)) {
    try {
      const b64 = decodeURIComponent(trimmed).replace(/-/g, '+').replace(/_/g, '/');
      parsed = tryJson(atob(b64));
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const kind = (parsed as { kind?: unknown }).kind;
  if (kind !== 'ppv2-sui-payment-request' && kind !== 'ppv2-sui-payment-receipt') return null;
  return parsed as { kind: string } & Record<string, unknown>;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function makeRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback: emit a UUID-shaped string (8-4-4-4-12 hex chars) so
  // `paymentRequestIdToHex` accepts it. Uses Math.random — fine for
  // the legacy non-secure-context path; not load-bearing for privacy.
  const hex = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function formatRequestCode(requestId: string | null | undefined): string {
  if (!requestId) return 'Pending';
  const clean = requestId.replace(/[^a-zA-Z0-9]/g, '');
  if (clean.length <= 8) return clean;
  return `${clean.slice(0, 5)}...${clean.slice(-4)}`;
}

function isSignablePaymentRequest(
  request: PaymentRequestPayload | null | undefined,
): request is PaymentRequestPayloadV2 | PaymentRequestPayloadV3 {
  return !!request && (request.kind === 'ppv2-sdk-payment-request' || request.version === 2);
}

/**
 * The payment card, essentials only: total, the request code, status — plus the
 * verified-wallet line and the single explainer notice.
 *
 * The invoice-style chrome it used to be plumbed with (a card `title`/`subtitle`
 * duplicating the modal header two rows above, a fake `1x <token> payment` line
 * item, a `senderLabel` field) was decorative and already unrendered, so the
 * props are gone with it. `requestCode` is the opposite case: real data that was
 * computed and then dropped — it now has a row, and only when a code actually
 * exists (no "Awaiting request" filler).
 */
function PaymentPreviewCard({
  amountLabel,
  amountHint,
  requestCode,
  status,
  verifiedWalletLabel,
  verifiedWalletUrl,
  verifiedWalletAddress,
  noticeTitle,
  noticeBody,
}: {
  amountLabel: string;
  amountHint?: string | null;
  /** Omitted until a real request/receipt code exists. */
  requestCode?: string;
  /** Omitted in the draft state (nothing to report yet). */
  status?: { label: string; color: string };
  verifiedWalletLabel?: string;
  verifiedWalletUrl?: string;
  /** Full signer address behind the label — enables the copy control. */
  verifiedWalletAddress?: string;
  noticeTitle: string;
  noticeBody: string;
}) {
  return (
    <View className="gap-[16px] rounded-inner border border-border-light bg-card-background px-[18px] py-[18px]">
      <View className="flex-row items-center justify-between">
        <Text className="font-pp-bold text-[16px] text-text">Total</Text>
        <View className="flex-row items-center gap-[4px]">
          <Text className="font-pp-bold text-[16px] text-text">{amountLabel}</Text>
          <ShareCountHint hint={amountHint ?? null} />
        </View>
      </View>

      <View className="gap-[8px]">
        {requestCode ? (
          <View className="flex-row items-center justify-between gap-[12px]">
            <Text className="font-pp-medium text-[12px] text-text-muted">Request code</Text>
            <Text className="text-right font-pp-medium text-[12px] text-text">{requestCode}</Text>
          </View>
        ) : null}
        {status ? (
          <View className="flex-row items-center justify-between gap-[12px]">
            <Text className="font-pp-medium text-[12px] text-text-muted">Status</Text>
            {/* nw-keep(data-color): status text color is a runtime-computed prop (arbitrary, no class value) */}
            <Text className="text-right font-pp-medium text-[12px]" style={{ color: status.color }}>{status.label}</Text>
          </View>
        ) : null}
        {verifiedWalletLabel ? (
          <View className="flex-row items-center justify-between gap-[12px]">
            <Text className="font-pp-medium text-[12px] text-text-muted">Verified wallet</Text>
            <Pressable
              disabled={!verifiedWalletUrl}
              onPress={() => verifiedWalletUrl && Linking.openURL(verifiedWalletUrl)}
            >
              <Text className="text-right font-pp-medium text-[12px] text-primary underline">{verifiedWalletLabel}</Text>
            </Pressable>
            {verifiedWalletAddress ? <CopyIconButton value={verifiedWalletAddress} /> : null}
          </View>
        ) : null}
      </View>

      {noticeBody ? (
        <View className="gap-[6px] rounded-inner border border-border bg-success-bg px-[14px] py-[12px]">
          <Text className="font-pp-semi-bold text-[13px] text-success">{noticeTitle}</Text>
          <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">{noticeBody}</Text>
        </View>
      ) : null}
    </View>
  );
}




const NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';




export function PaymentRequestModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;
  // Modal-less presentation for hub-opened flows (see withdraw provider).
  const inlineCapable = useInlineOpsCapable();
  const [inlinePreferred, setInlinePreferred] = useState(false);
  const inlineHubActive = inlinePreferred && inlineCapable;
  // Surface of the CURRENT run, readable from an async continuation (codex):
  // the registration hand-off below resumes long after the press, and an
  // inline (hub) payment must come back inline while a modal payment reopens
  // the overlay. A ref, not a dependency -- mirroring keysReadyRef -- so the
  // resume reads the live surface without rebuilding the pay handler on every
  // hub toggle.
  const inlineHubActiveRef = useRef(inlineHubActive);
  inlineHubActiveRef.current = inlineHubActive;
  const { address: walletAddress, chainId: walletChainId } = useAccount();
  // Relayed flow: an account-key session is enough — no wallet tx is posted.
  const ensureConnected = useRequireConnection({ allowAccountKey: true });
  // Key gate: actions that need the derived keys prompt for the one-time
  // signature on demand (the modal no longer auto-opens on connect). Read
  // through a ref so the onSigned continuation re-enters with fresh state.
  const { keysReady, sessionAddress, identityMode, sessionTarget } = usePoolSession();
  // Owner identity for the flow: the SESSION identity (key wins over a
  // connected payer wallet; wallet when no key). Relayed flows never post
  // a wallet tx.
  const address = (sessionAddress ?? walletAddress ?? undefined) as `0x${string}` | undefined;
  const keysReadyRef = useRef(keysReady);
  keysReadyRef.current = keysReady;
  const { openSeedDerivationModal } = useSeedDerivationModal();
  const { toast } = useToast();
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
  const balanceDisplay = useBalanceDisplay(chainId);
  const withOpLock = useOpLock();
  const queryClient = useQueryClient();
  // The COMMITTED chain of the live session (null while none) — used ONLY to
  // gate merges into the live session (the receipt-import path). The derived
  // useSessionChainId moves with the connector BEFORE the session object
  // follows, so gating on it could import a receipt into the outgoing
  // session; the committed target cannot desync from poolSession.
  const sessionChainId = sessionTarget?.chainId ?? null;
  // Sui/EVM branch follows the app-wide chain SELECTION (the single routing
  // truth; ChainProvider auto-selects Sui when a Sui wallet connects). On Sui
  // a request degrades to transfer+receipt (the GVK transact circuit needs the
  // payer to know each output's note secret, so the blind noteAddressHash
  // model is not usable — the payer generates the recipient's secret and
  // returns it in the receipt).
  const { isSui, isStellar, selectChain } = useChainRouter();
  // Stellar requests are created here (isStellar branch of the create handler)
  // and paid from the /pay page through the Send flow; the EVM/Sui PAY paths
  // below cannot handle one. Read through a ref so those entry points can
  // refuse without widening their dependency lists.
  const stellarActiveRef = useRef(isStellar);
  stellarActiveRef.current = isStellar;
  const refuseOnStellar = useCallback(() => {
    if (!stellarActiveRef.current) return false;
    toast({ title: 'Open the Stellar payment link to pay it.', variant: 'destructive' });
    return true;
  }, [toast]);
  const suiSession = useSuiSession();
  const stellarSession = useStellarSession();
  const suiClient = useSuiClient();
  const publicClient = usePublicClient({ chainId });
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const {
    poolSession,
    keystoreManager,
    noteManager,
    ensureInitialized,
    getCommittedManagers,
    exportAccount,
    importAccount,
    refreshNotes,
  } = usePoolSession();
  const { notes, refetch: refetchNotes } = useNotes();
  const { log, isDebugEnabled } = useDebug();
  const { beginTx, endTx } = useTxActivity();
  // Only `markRegistered` is consumed here — the pay-via-transfer
  // path auto-registers and needs to push that status back into the
  // context so the header menu hides the manual registration entry.
  // The payment-request *creation* path intentionally does NOT gate
  // on registration: keystore is required to spend received funds, but
  // making a request itself is free, and the receiver can register
  // later from the header menu (or implicitly on their first deposit/
  // payment) when they're ready to spend.
  const { openKeystoreRegistrationModal } = useKeystoreRegistrationModal();

  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<PaymentMode>('request');
  // Chain-scoped request catalog: a request created on mainnet must carry the
  // canonical token contract. Superseded native pools are excluded; the
  // current share row is the request option for that coin.
  const requestableTokens = useMemo(
    () => getEntrypointDepositableTokens(chainId).filter((t) => !isSupersededLegacyPool(t.symbol, chainId)).map((t) => ({ ...t, address: t.address as Hex })),
    [chainId],
  );
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<Hex>(() => requestableTokens[0].address);
  const [amountInput, setAmountInput] = useState('');
  const [sellerName, setSellerName] = useState('');
  const [shouldSignRequest, setShouldSignRequest] = useState(false);
  const [inputPayload, setInputPayload] = useState('');
  const [outputPayload, setOutputPayload] = useState('');
  // Amount/token FROZEN at create time — the Ready card must describe the
  // payload it created, not the live (still-editable) draft (codex r3, P2).
  const [createdDraft, setCreatedDraft] = useState<{ amountLabel: string; amountHint: string | null } | null>(null);
  const [payLink, setPayLink] = useState<string | null>(null);
  const [receiveLink, setReceiveLink] = useState<string | null>(null);
  // Whether the CURRENT links have been secured (copied). Reset whenever a
  // link changes; the close guard warns only about unsecured links.
  const [linksSecured, setLinksSecured] = useState(false);
  useEffect(() => {
    setLinksSecured(false);
  }, [payLink, receiveLink]);
  // Sui payment receipt lifecycle: paying a Sui request generates the
  // requester's note SECRET in this tab. 'at-risk' from just before the
  // transaction is submitted until the receipt payload is copied/shared/
  // downloaded — closing the tab in that window permanently locks the funds.
  const [suiReceiptLifecycle, setSuiReceiptLifecycle] = useState<'none' | 'at-risk' | 'secured'>('none');
  const [lastPaid, setLastPaid] = useState<{ requestKey: string; txHash: string; hadReceipt: boolean; chainId: number } | null>(null);
  const suiReceiptLifecycleRef = useRef(suiReceiptLifecycle);
  suiReceiptLifecycleRef.current = suiReceiptLifecycle;

  // A freshly created request link may be the only recoverable copy of its
  // payment key, and an unsecured Sui receipt is the only copy of the
  // requester's note secret — warn before closing until they're saved.
  // Claim flow: a receipt import is DEVICE-LOCAL until the note is anchored
  // on-chain (viewing-key registration + self-transfer). The claim reuses the
  // same machinery as the import-note page. The receipt's chain and owner
  // ride along: claiming binds to the LIVE wagmi chain/address, so both must
  // match before the button is armed (codex/kimi R1: wrong-chain merge).
  const [receivedNote, setReceivedNote] = useState<{ note: Note; chainId: number; owner: string } | null>(null);
  const {
    status: claimStatus,
    statusMessage: claimStatusMessage,
    errMessage: claimError,
    busy: claimBusy,
    hasUnanchoredLocalNote,
    importOnChain: claimOnChain,
    reset: resetClaim,
  } = useNoteImport();

  const [backupFileText, setBackupFileText] = useState<string | null>(null);
  // The account backupFileText was exported FOR: the session can switch while
  // the modal stays open, and a backup must never be ledgered to another owner.
  const backupOwnerRef = useRef<string | null>(null);
  const [backupSaved, setBackupSaved] = useState(false);
  // A Stellar request backup names its file after the Stellar account (there
  // is no EVM address) and, once written, lets those requests leave this
  // browser at sign-out. Null for an EVM backup.
  const stellarBackupRef = useRef<{ fileName: string; owner: string; paymentIds: string[] } | null>(null);
  // `linksSecured` (set by copying the link) used to be the whole test, which
  // encoded an assumption we have since disproved: that holding the LINK means
  // the request is safe. It does not. An unregistered request lives in this
  // browser, and only the backup file restores it, so copying the link and
  // closing the tab could still lose the payment (Pat, 2026-08-31).
  // A browser-only request warns on close EITHER way, because the risk does not
  // end when the file is written: it ends when the file is somewhere the user
  // will still have it. Saved, the warning is a reminder to keep it and does
  // NOT ask for another download (Pat, 2026-08-31); unsaved, it asks for the
  // download that has not happened.
  const hasBrowserOnlyRequest = !!backupFileText;
  const backupAtRisk = hasBrowserOnlyRequest && !backupSaved;
  useTabCloseGuard(
    ((!!payLink || !!receiveLink) && !linksSecured)
      || hasBrowserOnlyRequest
      || suiReceiptLifecycle === 'at-risk'
      || hasUnanchoredLocalNote,
    backupAtRisk
      ? 'Save your backup first. This request lives only in this browser and the link alone cannot restore it.'
      : hasBrowserOnlyRequest
        ? 'Keep the backup file you downloaded. This request lives only in this browser and the link alone cannot restore it.'
        : 'Save your payment link or receipt first. Without it, this payment may be unrecoverable.',
  );

  const [txHash, setTxHash] = useState<string | null>(null);
  const [txChainId, setTxChainId] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<'wallet' | 'transfer' | null>(null);
  // Where the running payment is, for the Leave copy (DEV-486). A ref as well
  // as state: the close press must see the phase set in the same tick as the
  // relay call, not the one from the last render.
  const payPhaseRef = useRef<PayRunPhase>('idle');
  const [payPhase, setPayPhaseState] = useState<PayRunPhase>('idle');
  const setPayPhase = useCallback((phase: PayRunPhase) => {
    payPhaseRef.current = phase;
    setPayPhaseState(phase);
  }, []);
  // Re-render when a request is latched or released, so every Pay button
  // reads the latch (services/pay-relay-guard.ts).
  const [payRelayLatchTick, setPayRelayLatchTick] = useState(0);
  useEffect(() => onPayRelayLatchChange(() => setPayRelayLatchTick((n) => n + 1)), []);
  // Escape hatch for the close guard below. An unanswered wallet prompt never
  // settles (viem's injected transport has no timeout), so a hard block left
  // the modal permanently unclosable -- the exact strand the pre-guard comment
  // warned about. First press warns, second press closes anyway.
  const closeOverrideRef = useRef(false);
  // Route ownership for the registration hand-off (code review 2026-08-27).
  // This provider is mounted in app/_layout.tsx and survives navigation, so
  // opEpochRef -- which only moves on resetState() -- stays put when the user
  // simply leaves the page. A hand-off resuming on live() alone could
  // therefore relay the old payment on an unrelated route, or reopen a modal
  // the user had walked away from. The pathname at hand-off time is the
  // ownership token: resume only if we are still on the surface that asked.
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const [copiedPayLink, setCopiedPayLink] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState(false);
  // When the modal is opened via the /pay/[encoded] page after the user
  // already picked their intent (Pay via Wallet vs Pay via Private
  // Transfer), we record which handler to fire on mount so the user
  // doesn't have to click the same button twice. Cleared after firing.
  const [pendingAutoAction, setPendingAutoAction] = useState<'wallet' | 'transfer' | null>(null);
  /**
   * Choice gate shown BEFORE creating a request from an unregistered wallet.
   *
   * Such a request works, but it is only recoverable from this browser: the
   * per-request key lives in local storage, so clearing it strands any payment
   * that arrives (DEV-301). Registering first makes payments discoverable from
   * the seed on any device; not registering is fine as long as the user keeps
   * the backup. The old flow just created it and said nothing.
   *
   * Promise-based so the create handler can await the answer inline.
   */
  // Set when the seller chose "Download recovery file" over registering. The
  // request's key does not exist until the request does, so the choice is
  // recorded here and honoured the moment creation succeeds.
  const pendingKeyDownloadRef = useRef(false);
  // The backup file's save target, opened AT the "Download backup" press (the
  // picker needs that gesture) and written once the request exists. A write
  // through it is proof the file is on disk, which is what lets sign-out purge
  // this request (DEV-497: the plain download this flow used to do proves
  // nothing, so the request was never purged). null = no picker here.
  const pendingBackupTargetRef = useRef<Promise<BackupFileTarget | 'cancelled' | null> | null>(null);
  const [unregisteredPrompt, setUnregisteredPrompt] = useState<
    { resolve: (choice: 'register' | 'download' | 'cancel') => void } | null
  >(null);
  /** Set when a request was created without registering, so the UI can lead with the backup. */
  const [backupUrgent, setBackupUrgent] = useState(false);
  /** Payload copy/download live behind More; the share link is the primary act. */
  const [moreOpen, setMoreOpen] = useState(false);
  /**
   * The seller's recovery file, prepared in advance.
   *
   * Split in two on purpose. Chrome drops a programmatic download that no
   * longer carries a user gesture, and the request has to be CREATED before
   * there is anything to back up, so an anchor click after that await was
   * silently ignored in a real browser while headless (acceptDownloads)
   * happily saved it. So the payload is built as soon as the request exists,
   * and the write below is synchronous: nothing is awaited between the press
   * and the click.
   */

  const buildBackupText = useCallback(async (): Promise<string | null> => {
    if (!address) return null;
    try {
      const { exportAllPaymentRequests, serializePaymentRequestBackup } =
        await import('@/services/payment-request-recovery');
      return serializePaymentRequestBackup(await exportAllPaymentRequests(address));
    } catch (err) {
      log('warn', 'PaymentRequest', 'Could not build the recovery file', err);
      return null;
    }
  }, [address, log]);

  /** What a saved backup is worth, and what losing it costs. Stated once. */
  const BACKUP_SAVED_TOAST = 'Backup saved. Without the file, clearing this browser loses the payment.';

  /**
   * SYNCHRONOUS: safe to call straight from onPress, keeps the gesture. A
   * plain download proves nothing (it can be dropped without an error), so it
   * never lets sign-out remove a Stellar request; saveStellarBackupWithProof
   * below does.
   */
  const saveBackupFile = useCallback((text: string | null): boolean => {
    const stellarBackup = stellarBackupRef.current;
    const fileName = stellarBackup?.fileName ?? (address ? `privacy-pools-request-backup-${address.toLowerCase()}.json` : null);
    if (!canUseBrowserApis() || !text || !fileName) return false;
    try {
      const url = window.URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      return true;
    } catch (err) {
      log('warn', 'PaymentRequest', 'Recovery-file write failed', err);
      return false;
    }
  }, [address, log]);

  /**
   * The Stellar panel's press: the save-file picker where the browser has
   * one, and its confirmed write is the proof that lets sign-out remove these
   * requests (services/backup-file-proof.ts, PR #209's model). Without the
   * picker it is the plain download, which proves nothing.
   */
  const saveStellarBackupWithProof = useCallback(async (text: string): Promise<'saved' | 'cancelled' | 'downloaded' | 'failed'> => {
    const stellarBackup = stellarBackupRef.current;
    const host = canUseBrowserApis() ? (window as PickerHost) : undefined;
    if (!stellarBackup || !canProveSave(host)) return saveBackupFile(text) ? 'downloaded' : 'failed';
    const result = await saveWithProof(host, text, stellarBackup.fileName);
    if (result === 'saved') {
      stellarSession.markRequestBackupSaved(stellarBackup.owner, stellarBackup.paymentIds);
      return 'saved';
    }
    if (result === 'cancelled') return 'cancelled';
    // The picker or its write failed: the plain download, which proves nothing.
    return saveBackupFile(text) ? 'downloaded' : 'failed';
  }, [saveBackupFile, stellarSession.markRequestBackupSaved]);

  const askUnregistered = useCallback(
    () => new Promise<'register' | 'download' | 'cancel'>((resolve) => {
      setUnregisteredPrompt({ resolve });
    }),
    [],
  );
  const answerUnregistered = useCallback((choice: 'register' | 'download' | 'cancel') => {
    setUnregisteredPrompt((prev) => {
      prev?.resolve(choice);
      return null;
    });
  }, []);
  // The payload's exact target, resolved at open. The auto-action fires
  // only once the app selection actually matches it — firing earlier just made
  // the handler's switch-and-stop consume the one-shot to say "press Pay
  // again" (codex P1-7). null = no target could be resolved (fire ungated so
  // the handler surfaces its honest unsupported-chain error).
  const [pendingAutoTarget, setPendingAutoTarget] = useState<AutoTarget>(null);
  // Operation epoch (codex P1-5): bumped by every full reset (all openers call
  // resetState). A handler continuing across a close/reopen aborts before any
  // wallet prompt or broadcast instead of writing into the new mode's UI.
  const opEpochRef = useRef(0);
  const [requestSignatureStatus, setRequestSignatureStatus] = useState<'unsigned' | 'checking' | 'valid' | 'invalid'>('unsigned');
  const [verifiedSignerEnsName, setVerifiedSignerEnsName] = useState<string | null>(null);
  const canSignPaymentRequest = !!walletAddress;

  useEffect(() => {
    if (!canSignPaymentRequest && shouldSignRequest) {
      setShouldSignRequest(false);
    }
  }, [canSignPaymentRequest, shouldSignRequest]);

  const selectedToken = useMemo(
    () => requestableTokens.find((token) => token.address === selectedTokenAddress) ?? requestableTokens[0],
    [requestableTokens, selectedTokenAddress],
  );
  // Request-mode token identity: on Sui the only requestable asset is native
  // SUI (9 decimals) — the EVM token list must not be offered while the create
  // path emits coinType 0x2::sui::SUI.
  const requestTokenSymbol = isStellar ? 'XLM' : isSui ? 'SUI' : selectedToken.symbol;
  const requestTokenDecimals = isStellar ? STELLAR_XLM.decimals : isSui ? 9 : selectedToken.decimals;

  // What the hub's amount card renders. Derived from the SAME selectedToken the
  // create path uses, so the pill can never name an asset the payload does not
  // carry.
  const requestToken = useMemo(
    () => ({ symbol: requestTokenSymbol, address: selectedToken.address, decimals: requestTokenDecimals, chainId: isStellar ? STELLAR_TESTNET_ID : chainId }),
    [requestTokenSymbol, selectedToken.address, requestTokenDecimals, chainId, isStellar],
  );
  // Refs, so the sync callback identity is stable: the hub calls it from
  // render-time handlers and a changing identity would churn its publisher.
  const isOpenRef = useRef(isOpen); isOpenRef.current = isOpen;
  const modeRef = useRef(mode); modeRef.current = mode;
  const outputPayloadRef = useRef(outputPayload); outputPayloadRef.current = outputPayload;
  const requestableTokensRef = useRef(requestableTokens); requestableTokensRef.current = requestableTokens;
  const requestTokenDecimalsRef = useRef(requestTokenDecimals); requestTokenDecimalsRef.current = requestTokenDecimals;
  // Sui and Stellar each request one native asset: a token pick from the hub
  // card must never change what their request encodes.
  const isSuiRef = useRef(isSui || isStellar); isSuiRef.current = isSui || isStellar;

  /**
   * Inline (hub) request form: the amount card owns the token + amount and
   * pushes each edit here, so the created request is exactly what the card
   * showed. Mirrors the swap flow's syncInlineForm and withdraw's
   * syncInlineAmount.
   */
  const syncInlineRequestForm = useCallback((patch: InlineRequestFormPatch) => {
    // The OVERLAY owns the form while it is up: a re-issue opens as a modal
    // with a prefilled token/amount and must not be overwritten by the card
    // behind it. Closed, the write is what carries the card's figure into the
    // next open (resetState keeps both).
    if (isOpenRef.current && (!inlineHubActiveRef.current || modeRef.current !== 'request')) return;
    // A CREATED request is frozen: changing the draft key would wipe the
    // payload and the pay link. Only a deliberate token pick may do that.
    if (outputPayloadRef.current && patch.tokenAddress === undefined) return;
    let decimals = requestTokenDecimalsRef.current;
    if (patch.tokenAddress !== undefined && !isSuiRef.current) {
      // Resolve against the PICK's chain when it names one (a cross-chain pick
      // races the chain switch); otherwise this chain's live catalog.
      const catalog: { address: Hex; decimals: number }[] = patch.tokenChainId !== undefined
        ? getEntrypointDepositableTokens(patch.tokenChainId).filter((t) => !isSupersededLegacyPool(t.symbol, patch.tokenChainId!)).map((t) => ({ ...t, address: t.address as Hex }))
        : requestableTokensRef.current;
      // Case-INSENSITIVE match, then store the catalog's OWN string:
      // selectedToken compares with === against checksummed registry
      // addresses, so a lowercased address would resolve to the native asset.
      const match = catalog.find(
        (t) => t.address.toLowerCase() === patch.tokenAddress!.toLowerCase(),
      );
      // An asset no catalog can request is a NO-OP, never an index-0 fallback.
      if (!match) return;
      setSelectedTokenAddress(match.address);
      decimals = match.decimals;
    }
    if (patch.amount !== undefined) setAmountInput(sanitizeAmountInput(patch.amount, decimals));
  }, []);

  // Everything that changes WHAT a created request would be. Raw
  // selectedTokenAddress is not enough (codex): native assets share one
  // sentinel across chains, and routing to Sui swaps the asset to
  // 0x2::sui::SUI without touching the EVM selection — the chain must be part
  // of the key. Signature intent too: toggling verification or editing the
  // seller name changes the emitted payload/signature.
  const requestDraftKey = [
    isStellar ? `${STELLAR_TESTNET_ID}:XLM` : isSui ? `${SUI_TESTNET_ID}:0x2::sui::SUI` : `${chainId}:${selectedTokenAddress.toLowerCase()}`,
    amountInput,
    shouldSignRequest ? `signed:${sellerName.trim()}` : 'unsigned',
  ].join('|');

  useEffect(() => {
    if (mode !== 'request') return;
    // Never wipe an unsecured Sui payment receipt — it is the only copy of
    // the requester's note secret.
    if (suiReceiptLifecycleRef.current === 'at-risk') return;
    setOutputPayload('');
    setPayLink(null);
    setCreatedDraft(null);
  }, [requestDraftKey, mode]);

  // Whether the CREATED request is recoverable from wallet keys alone:
  // registered v2 payments are rediscovered via scanCatchAll with the
  // registered viewing key, and SDK-native ones re-derive their per-request
  // key from the seed — losing the pay link strands NEITHER. Only legacy v1
  // (unregistered) requests need the URL kept, so only they get the warning.
  const createdRequestKeyRecoverable = useMemo(() => {
    if (!outputPayload) return false;
    try {
      const parsed = JSON.parse(outputPayload) as { kind?: string; version?: number };
      return parsed.kind === 'ppv2-sdk-payment-request'
        || (parsed.kind === 'ppv2-payment-request' && parsed.version === 2);
    } catch {
      return false;
    }
  }, [outputPayload]);

  // A cancelled or failed create must not leave the download armed for the
  // next request, which would silently write a file the user did not ask for.
  const resetState = useCallback(() => {
    // Claim state must never leak across modal sessions — cleared even when
    // the at-risk early return below preserves the Sui receipt payload.
    setReceivedNote(null);
    resetClaim();
    if (suiReceiptLifecycleRef.current === 'at-risk') {
      // An unsecured Sui payment receipt is pending — preserve it (and the
      // armed close guard) so reopening the modal shows it again; clear only
      // the transient status lines. The epoch still bumps (codex): a PRE-
      // broadcast run that outlived this reset must abort instead of sending
      // after close — post-broadcast receipt writes are unguarded and land.
      opEpochRef.current += 1;
      setPendingAutoAction(null);
      setPendingAutoTarget(null);
      setStatusMessage(null);
      setWarningMessage(null);
      setErrorMessage(null);
      return;
    }
    opEpochRef.current += 1;
    pendingKeyDownloadRef.current = false;
    stellarBackupRef.current = null;
    pendingBackupTargetRef.current = null;
    setBackupFileText(null);
    backupOwnerRef.current = null;
    setBackupSaved(false);
    // A warning armed in one session must not carry into the next: an unused
    // "press again to leave anyway" would let the FIRST close press of a brand
    // new payment abandon it after approval gas was spent (code review
    // 2026-08-27).
    closeOverrideRef.current = false;
    setSuiReceiptLifecycle('none');
    setInputPayload('');
    setOutputPayload('');
    setCreatedDraft(null);
    setSellerName('');
    setShouldSignRequest(false);
    setPayLink(null);
    setReceiveLink(null);
    setTxHash(null);
    setTxChainId(null);
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);
    setIsBusy(false);
    setBusyAction(null);
    setCopiedPayLink(false);
    setPendingAutoAction(null);
    setPendingAutoTarget(null);
    setRequestSignatureStatus('unsigned');
    setVerifiedSignerEnsName(null);
  }, [resetClaim]);

  const closePaymentRequestModal = useCallback(() => {
    // Closing mid-PAYMENT is NOT allowed (QA 2026-08-26). resetState() below
    // bumps opEpochRef, which is how every liveness gate in the pay handlers
    // decides a run is stale -- so a close landing while the wallet prompt is
    // up made the run abort at the `!live()` gate before the deposit
    // broadcast, AFTER the user had already signed and paid gas for the ERC-20
    // approval. Symptom: approve goes through, nothing is sent, no error, the
    // flow back at its start state. This is the same invariant
    // withdraw-modal-provider.tsx enforces ("Block close while the withdrawal
    // is executing") and the one action-hub.tsx already assumes every flow
    // provider keeps.
    //
    // Deliberately NOT extended to the claim path: `claimBusy` still closes,
    // because useNoteImport's run-generation guard suppresses the stale
    // completion and hasUnanchoredLocalNote keeps the tab-close guard armed.
    // Blocking there stranded users whose wallet prompt never resolved.
    // `busyAction`, not `isBusy`: isBusy is shared by all four flows here,
    // including create-request (local key derivation) and receive (a
    // device-local import), neither of which has anything in a wallet -- so
    // blocking their close with wallet copy was simply wrong (code review
    // 2026-08-27). Only the two pay handlers set busyAction, so it is exactly
    // "a payment is executing". Read directly rather than through a ref: a ref
    // assigned in the render body is no more current than the state it copies,
    // so it bought nothing but an extra lint suppression.
    // The warning names what is running (DEV-486): a private transfer never
    // asks the wallet for anything, and before its relay starts nothing can
    // have been sent, so leaving then simply cancels it (the epoch bump below
    // stops the run at its pre-broadcast live() gate).
    const leaveWarning = busyAction ? leavePaymentWarning(busyAction === 'wallet' ? 'wallet' : payPhaseRef.current) : null;
    if (leaveWarning && !closeOverrideRef.current) {
      closeOverrideRef.current = true;
      setWarningMessage(leaveWarning);
      return;
    }
    closeOverrideRef.current = false;
    if (claimBusy) resetClaim();
    setIsOpen(false);
    setInlinePreferred(false);
    resetState();
  }, [busyAction, claimBusy, resetClaim, resetState]);

  // Self-reference so the chain-alignment re-entry below always calls the
  // CURRENT callback (with fresh isSui/chainId), not a stale closure.
  const openRequestRef = useRef<(prefill?: PaymentRequestPrefill) => void>(() => {});
  const openRequestPaymentModal = useCallback((prefill?: PaymentRequestPrefill) => {
    // Chain alignment first: re-issuing an EVM row while Sui is selected must
    // not become a native-SUI request with SUI precision. Align the app-level
    // selection, then re-enter with the same prefill once the EVM state is in
    // place (same pattern as alignChainForPayload for /pay deep links).
    if (prefill?.chainId !== undefined && isSui && isSupportedEvmChainId(prefill.chainId)) {
      selectChain(defaultChainId);
      setTimeout(() => openRequestRef.current(prefill), 0);
      return;
    }
    // The wallet-picker and seed-derivation gates are EVM session concerns;
    // the Sui and Stellar sessions derive their keys from a wallet signature
    // on demand (Stellar: inside the create handler).
    if (!isSui && !isStellar) {
      // Disconnected → open the wallet picker instead of a dead modal (QA-4).
      // (The pay/receive-from-link opens below intentionally stay ungated: the
      // recipient lands on a share link first and connects from there.)
      if (!ensureConnected()) return;
      // Keys not derived yet → one-time signature first, then continue here
      // (the continuation carries its captured prefill). Inline (hub) opens
      // show the form ungated; actions walk the gates when needed.
      if (!keysReadyRef.current && identityMode !== 'key' && !prefill?.inline) {
        openSeedDerivationModal({ onSigned: () => openRequestPaymentModal(prefill) });
        return;
      }
    }
    resetState();
    setMode('request');
    // Re-issue prefill (list widget): seed the form with the original
    // request's amount/token — the user still reviews before creating.
    // Validated against the chain the create flow will actually use: the
    // token must be requestable here AND the amount must parse under ITS
    // precision. Anything invalid rejects the whole prefill (clean form +
    // notice) instead of silently keeping a previous/mismatched selection.
    if (prefill?.chainId !== undefined) {
      const match = prefill.tokenAddress
        ? requestableTokens.find((token) => token.address.toLowerCase() === prefill.tokenAddress!.toLowerCase())
        : undefined;
      const chainMatches = !isSui && prefill.chainId === chainId;
      const amountOk = (() => {
        if (!prefill.amount || !match) return false;
        try {
          return parseUnits(sanitizeAmountInput(prefill.amount), match.decimals) > 0n;
        } catch {
          return false;
        }
      })();
      if (chainMatches && match && amountOk) {
        setSelectedTokenAddress(match.address);
        // Clamp to the MATCHED token's precision: unclamped, an over-precise
        // string is rounded half-up by parseUnits at create time, so the payload
        // would encode a different number than the form states.
        setAmountInput(sanitizeAmountInput(prefill.amount!, match.decimals));
      } else {
        setSelectedTokenAddress(requestableTokens[0].address);
        setAmountInput('');
        setWarningMessage('The original asset or chain is not available here. Set amount and asset manually.');
      }
    } else if (prefill?.initialAmount !== undefined) {
      // Amount seed, current chain/asset: no cross-chain precision question, so
      // it just goes through the SAME sanitizer as typing (clamped to this
      // asset's decimals). The asset selection is left alone, the field stays
      // editable, and Create Request validates it like any typed amount.
      setAmountInput(sanitizeAmountInput(prefill.initialAmount, requestTokenDecimals));
    }
    setInlinePreferred(!!prefill?.inline);
    setIsOpen(true);
  }, [resetState, ensureConnected, identityMode, openSeedDerivationModal, isSui, isStellar, chainId, selectChain, requestTokenDecimals]);
  useEffect(() => { openRequestRef.current = openRequestPaymentModal; }, [openRequestPaymentModal]);

  // A pay/receive payload carries its chain implicitly in its KIND. Align the
  // app-level selection at open time so the selection-scoped state the
  // handlers read (EVM notes/session vs Sui session config) matches the
  // payload — an existing EVM /pay or /receive link must keep working while
  // Sui is the selected chain, and vice versa.
  // Resolve the payload's EXACT target: DISCRIMINATED by chain type (codex:
  // an EVM payload whose unsupported chainId happens to equal the Sui
  // sentinel must not be mistaken for a Sui target). null when the payload
  // can't be decoded at all.
  const resolvePayloadTarget = useCallback((payload?: string): AutoTarget => {
    if (!payload) return null;
    if (parseSuiPaymentPayload(payload)) return { kind: 'sui' as const };
    try {
      const decoded = decodePaymentRequestPayloadFromUrl(payload.trim()) as { chainId?: number };
      if (typeof decoded.chainId === 'number') return { kind: 'evm' as const, chainId: decoded.chainId };
    } catch { /* not a URL-encoded payload */ }
    try {
      const parsed = parsePaymentRequestPayload(payload) as { chainId?: number };
      if (typeof parsed.chainId === 'number') return { kind: 'evm' as const, chainId: parsed.chainId };
    } catch { /* not raw JSON either */ }
    return null;
  }, []);

  const alignChainForPayload = useCallback((payload?: string) => {
    if (!payload) return;
    const target = resolvePayloadTarget(payload);
    // A DECLINED wallet switch must not leave the auto-action armed forever
    // (codex: selectChain swallows rejection and the gate then waits for a
    // commit that never comes — and could fire after a later unrelated
    // switch). selectChain reports commitment; on refusal, disarm and tell
    // the user the manual button still works.
    const disarmOnRefusal = (outcome: 'committed' | 'declined' | 'superseded') => {
      // Only a REAL refusal disarms: a superseded request lost to a NEWER
      // selection whose own auto-action may be armed (codex verification).
      if (outcome !== 'declined') return;
      setPendingAutoAction(null);
      setPendingAutoTarget(null);
      setWarningMessage('The network switch was declined. Switch manually, then press Pay.');
    };
    if (target?.kind === 'sui') {
      if (!isSui) void selectChain(SUI_TESTNET_ID).then(disarmOnRefusal);
      return;
    }
    // EVM payloads align to the payload's OWN chain when this build supports
    // it (a Citrea request opens on Citrea, not the default), else to the
    // default EVM chain so selection-scoped state at least leaves Sui.
    const evmTarget = target !== null && isSupportedEvmChainId(target.chainId) ? target.chainId : defaultChainId;
    if (isSui || chainId !== evmTarget) void selectChain(evmTarget).then(disarmOnRefusal);
  }, [isSui, chainId, selectChain, resolvePayloadTarget]);

  // The three link-landing opens stay connection-ungated (the visitor lands
  // on a share link first and connects from inside the flow), but when a
  // wallet IS connected and the account is still locked, unlock comes first
  // and the flow resumes with the same payload.
  /**
   * The payload the pay surface was OPENED with, kept outside modal state.
   *
   * `inputPayload` does not survive a deferral: a locked session sends the
   * press through the seed-derivation modal, and the retry re-enters the
   * handler after something has called `resetState()` (which clears
   * inputPayload). The handler then decoded '' and threw "Empty payment
   * request payload" at a user who had just signed - which is exactly what an
   * unregistered payer hit on the first wallet-pay of a v3 request
   * (Pat, 2026-08-28). The transfer path had a bespoke guard for this; a ref
   * fixes it for every entry point, because the payload of the link you opened
   * is not modal state and should never have been stored as if it were.
   */
  const openedPayloadRef = useRef<string>('');

  // Native mock mode: no real flow starts from the pretend account.
  const blockMockFlow = useNativeMockBlock();
  const openPayRequestModal = useCallback((payload?: string, opts?: { inline?: boolean }) => {
    if (refuseOnStellar()) return;
    if (blockMockFlow()) return;
    // DEV-239: "Pay via Wallet" pays the request straight from the connected
    // wallet (depositFor), so it must NOT force account-key / passkey sign-in.
    // The seed/passkey unlock is only needed for "Pay via Private Transfer"
    // (openPayViaTransferModal), which keeps the prompt below.
    alignChainForPayload(payload);
    resetState();
    setMode('pay');
    if (payload) {
      openedPayloadRef.current = payload;
      setInputPayload(payload);
      setPendingAutoAction('wallet');
      setPendingAutoTarget(resolvePayloadTarget(payload));
    }
    setInlinePreferred(!!opts?.inline);
    setIsOpen(true);
  }, [blockMockFlow, resetState, alignChainForPayload, resolvePayloadTarget, refuseOnStellar]);

  const openPayViaTransferModal = useCallback((payload?: string, opts?: { inline?: boolean }) => {
    if (refuseOnStellar()) return;
    if (blockMockFlow()) return;
    // Why a press did or did not start the payment. Pressing "Pay via Private
    // Transfer" and getting NOTHING is the hardest failure to read from outside,
    // since every branch here is silent.
    log('info', 'PayRequest', 'pay via transfer requested', {
      hasWallet: !!address,
      keysReady: keysReadyRef.current,
      identityMode,
      inline: opts?.inline,
      hasPayload: !!payload,
    });
    if (address && !keysReadyRef.current && identityMode !== 'key') {
      openSeedDerivationModal({ onSigned: () => openPayViaTransferModal(payload, opts) });
      return;
    }
    alignChainForPayload(payload);
    resetState();
    setMode('pay');
    if (payload) {
      openedPayloadRef.current = payload;
      setInputPayload(payload);
      setPendingAutoAction('transfer');
      setPendingAutoTarget(resolvePayloadTarget(payload));
    }
    setInlinePreferred(!!opts?.inline);
    setIsOpen(true);
  }, [blockMockFlow, resetState, address, identityMode, openSeedDerivationModal, alignChainForPayload, resolvePayloadTarget, refuseOnStellar]);

  const openReceivePaymentModal = useCallback((payload?: string) => {
    if (address && !keysReadyRef.current && identityMode !== 'key') {
      openSeedDerivationModal({ onSigned: () => openReceivePaymentModal(payload) });
      return;
    }
    alignChainForPayload(payload);
    resetState();
    setMode('receive');
    if (payload) setInputPayload(payload);
    setIsOpen(true);
  }, [resetState, address, identityMode, openSeedDerivationModal, alignChainForPayload, resolvePayloadTarget]);

  // Test affordance: expose the payment-request modal controls + payload I/O so
  // the Sui playwright harness can drive request/pay/receive without clicking
  // through the header dropdown. Only under EXPO_PUBLIC_TEST_MODE.
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_TEST_MODE !== 'true' || typeof window === 'undefined') return;
    (window as unknown as Record<string, unknown>).__paymentReq = {
      openRequest: () => openRequestPaymentModal(),
      openPay: (p?: string) => openPayViaTransferModal(p),
      openReceive: (p?: string) => openReceivePaymentModal(p),
      setAmount: (a: string) => setAmountInput(a),
      setInput: (p: string) => setInputPayload(p),
      getOutput: () => outputPayload,
      getStatus: () => ({ status: statusMessage, error: errorMessage, warning: warningMessage }),
    };
  }, [openRequestPaymentModal, openPayViaTransferModal, openReceivePaymentModal, outputPayload, statusMessage, errorMessage, warningMessage]);

  // "Copy backup" copies the BACKUP when the seller has one (the unregistered
  // path builds a real account backup); otherwise the payload is the only
  // restorable artefact and it is what gets copied. "Copy payload" below is
  // always the raw payload.
  const handleCopyOutput = useCallback(async () => {
    if (!canUseBrowserApis() || !outputPayload) return;
    await navigator.clipboard.writeText(backupFileText ?? outputPayload);
    // Receipt secured — the close warning can stand down.
    setSuiReceiptLifecycle((prev) => (prev === 'at-risk' ? 'secured' : prev));
    toast({ title: 'Copied to clipboard.' });
    setErrorMessage(null);
    setCopiedOutput(true);
    setTimeout(() => setCopiedOutput(false), 2000);
  }, [backupFileText, outputPayload, toast]);

  const handleCopyPayload = useCallback(async () => {
    if (!canUseBrowserApis() || !outputPayload) return;
    await navigator.clipboard.writeText(outputPayload);
    setSuiReceiptLifecycle((prev) => (prev === 'at-risk' ? 'secured' : prev));
    toast({ title: 'Payload copied to clipboard.' });
    setErrorMessage(null);
    setCopiedPayload(true);
    setTimeout(() => setCopiedPayload(false), 2000);
  }, [outputPayload, toast]);

  // Keep the copy-button "Copied!" affordance in sync with the rest of the
  // modal reset so a stale flag can't linger if state changes before the timer.
  useEffect(() => {
    if (!isOpen) setCopiedOutput(false);
    if (!isOpen) setCopiedPayload(false);
  }, [isOpen]);

  const handleCopyPayLink = useCallback(async () => {
    if (!canUseBrowserApis() || !payLink) return;
    await navigator.clipboard.writeText(payLink);
    setLinksSecured(true);
    setCopiedPayLink(true);
    toast({ title: 'Pay link copied to clipboard.' });
    setErrorMessage(null);
    setTimeout(() => setCopiedPayLink(false), 2000);
  }, [payLink, toast]);

  const handleCopyReceiveLink = useCallback(async () => {
    if (!canUseBrowserApis() || !receiveLink) return;
    await navigator.clipboard.writeText(receiveLink);
    setLinksSecured(true);
    toast({ title: 'Receive link copied to clipboard.' });
    setErrorMessage(null);
  }, [receiveLink, toast]);

  const handleShareOutput = useCallback(async () => {
    if (!outputPayload) return;
    await Share.share({ message: outputPayload, title: 'Privacy Pools Payment Payload' });
    setSuiReceiptLifecycle((prev) => (prev === 'at-risk' ? 'secured' : prev));
    toast({ title: 'Shared successfully.' });
    setErrorMessage(null);
  }, [outputPayload, toast]);

  const handleDownloadOutput = useCallback(() => {
    if (!canUseBrowserApis() || !outputPayload || !address) return;
    const blob = new Blob([backupFileText ?? outputPayload], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `privacy-pools-${mode}-${address.toLowerCase()}-${chainId}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    setSuiReceiptLifecycle((prev) => (prev === 'at-risk' ? 'secured' : prev));
    toast({ title: 'Downloaded payload.' });
    setErrorMessage(null);
  }, [address, chainId, mode, backupFileText, outputPayload, toast]);

  // DEV-383: on a virgin wallet session the key derivation waits for the
  // SeedDerivationModal's explicit Sign, and these inline handlers used to
  // call ensureInitialized() bare - awaiting a derivation that waits for a
  // modal nothing would ever open. The button sat at "Creating..."/"Paying..."
  // forever with no signature prompt and no error. Gate exactly like the
  // transfer flow's non-inline open: raise the modal, continue after Sign.
  const retryAfterSignRef = useRef<(() => void) | null>(null);
  const gateOnLockedSession = useCallback((retry: () => void): boolean => {
    // EVM session lock only: Sui and Stellar unlock inside their own flows.
    if (isSui || isStellar || identityMode === 'key' || keysReadyRef.current) return false;
    retryAfterSignRef.current = retry;
    openSeedDerivationModal({ onSigned: () => { const r = retryAfterSignRef.current; retryAfterSignRef.current = null; r?.(); } });
    return true;
  }, [isSui, isStellar, identityMode, openSeedDerivationModal]);

  const handleCreateRequestUnlocked = useCallback(async () => {
    if (gateOnLockedSession(() => { void handleCreateRequestRef.current?.(); })) return;
    // Freeze the draft NOW: the fields stay editable during the awaits below,
    // and the Ready card must render the request that was CREATED, not the
    // live inputs (codex r3: a 1 ETH request could display as Ready for a
    // later 2 USDC edit).
    const frozenView = balanceDisplay(amountInput.trim(), isSui ? 'SUI' : requestTokenSymbol, chainId);
    const frozenAmountLabel = `${isShareSymbol(requestTokenSymbol) && frozenView.converted ? '≈ ' : ''}${frozenView.text}`;
    // === Stellar path === the SDK's blind request (stellar-request.ts): the
    // link carries note slots, a payment key and a tag, never this account's
    // address. The SDK keeps the request in this account, and its sync finds
    // the payment through it. No viewing key has to be published.
    if (isStellar) {
      const stellarAddress = stellarSession.wallet.isConnected ? stellarSession.wallet.address : null;
      if (!stellarAddress) { setErrorMessage('Connect Freighter first.'); return; }
      if (!amountInput.trim()) { setErrorMessage('Enter an amount first.'); return; }
      setIsBusy(true); setStatusMessage(null); setWarningMessage(null); setErrorMessage(null);
      try {
        const amountStroops = parseUnits(amountInput.trim(), STELLAR_XLM.decimals);
        if (amountStroops <= 0n) { setErrorMessage('Enter an amount first.'); return; }
        const sdkRequest = await stellarSession.createPaymentRequest({
          amount: amountStroops,
          onStage: (stage) => setStatusMessage(describeStellarStage(stage)),
        });
        const request = stellarSdkPaymentRequestPayload(sdkRequest, STELLAR_TESTNET_ID);
        setStatusMessage(null);
        setOutputPayload(JSON.stringify(request, null, 2));
        setCreatedDraft({ amountLabel: frozenAmountLabel, amountHint: frozenView.hint });
        const stellarPayLink = canUseBrowserApis()
          ? withStellarLinkParams(`${shareLinkBase()}/pay#${encodeStellarBlindRequest(request)}`, ACTIVE_APP_ENVIRONMENT, { stagingMainnet: STAGING_MAINNET_EXPLICIT })
          : null;
        if (stellarPayLink) setPayLink(stellarPayLink);
        // Listed under Payment Requests (this tab, and kept in this browser
        // with the request). Paid once the SDK marks the request FULFILLED
        // (payment-requests-card).
        stellarSession.recordRequestRow({
          requestId: stellarBlindRequestId(request.paymentId),
          chainId: STELLAR_TESTNET_ID,
          owner: stellarAddress.toLowerCase(),
          tokenAddress: request.tokenId,
          amount: `0x${amountStroops.toString(16)}`,
          createdAtMs: Date.now(),
          payLink: stellarPayLink,
          signed: false,
        });
        bumpPaymentRequestRevision();
        // Like an EVM request made without registering: the record is the only
        // way a payment to it is found, so its backup downloads right away,
        // and the panel under the link keeps the button if the browser
        // refuses the download.
        const backup = stellarSession.exportRequestBackup();
        stellarBackupRef.current = backup
          ? { fileName: `privacy-pools-request-backup-${stellarAddress}.json`, owner: stellarAddress, paymentIds: backup.paymentIds }
          : null;
        setBackupFileText(backup?.payload ?? null);
        const wrote = saveBackupFile(backup?.payload ?? null);
        setBackupSaved(wrote);
        setBackupUrgent(!wrote);
        if (wrote) toast({ title: BACKUP_SAVED_TOAST });
        toast({ title: `Payment request created for ${tokenAmountLabel(amountInput.trim(), 'XLM')}.` });
        // The backup story is told once, by the panel under the pay link (as on EVM).
        setWarningMessage(null);
      } catch (error) {
        setStatusMessage(null);
        const raw = error instanceof Error ? error.message : String(error);
        setErrorMessage(/reject|denied|cancel|declined/i.test(raw) ? 'Request cancelled in Freighter.' : stellarErrorMessage(raw));
      } finally {
        setIsBusy(false);
      }
      return;
    }
    // === Sui path === recipient publishes a request payload carrying only their
    // Sui address + amount (no secret — the payer generates it at pay time).
    if (isSui) {
      const suiAddr = suiSession.account?.address;
      if (!suiAddr) { setErrorMessage('Connect your Sui wallet first.'); return; }
      if (!amountInput.trim()) { setErrorMessage('Enter an amount first.'); return; }
      setIsBusy(true); setStatusMessage(null); setWarningMessage(null); setErrorMessage(null);
      try {
        const amountMist = parseUnits(amountInput, 9); // SUI = 9 decimals
        const request = {
          kind: 'ppv2-sui-payment-request' as const,
          version: 1,
          requestId: makeRequestId(),
          chainId: 102,
          recipientAddress: suiAddr,
          amountMist: amountMist.toString(),
          coinType: '0x2::sui::SUI',
          createdAt: new Date().toISOString(),
        };
        setOutputPayload(JSON.stringify(request, null, 2));
        setCreatedDraft({ amountLabel: frozenAmountLabel, amountHint: frozenView.hint });
        // No pay link on Sui: the /pay codec (#212 strict validation) only
        // understands the EVM payload kinds — the payer pastes this payload
        // into "Pay via Private Transfer" instead.
        toast({ title: `Payment request created for ${amountInput} SUI.` });
        setWarningMessage('Share this request. The payer fulfills it with a private transfer and returns a receipt for you to import.');
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to create payment request.');
      } finally {
        setIsBusy(false);
      }
      return;
    }

    if (!address) {
      setErrorMessage('Connect your wallet first.');
      return;
    }
    if (!amountInput.trim()) {
      setErrorMessage('Enter an amount first.');
      return;
    }

    // Both ends of what may be asked for, checked HERE rather than at pay time
    // (Nathaniel, QA 2026-09-21). A refusal, not a dead button: the user is
    // told which end they are on and nothing is created. The cap is the same
    // one the payer's deposit meets, so a link that passes here is a link that
    // can actually be settled.
    try {
      await assertPaymentRequestBounds({
        amount: parseFloat(amountInput),
        symbol: requestTokenSymbol,
        capUsd: ACTIVE_ENVIRONMENT.maxDepositUsd,
        fetchPrice: getPrice,
      });
    } catch (error) {
      if (error instanceof PaymentRequestBoundsError) {
        toast({ title: error.message, variant: 'destructive' });
        return;
      }
      throw error;
    }

    setIsBusy(true);
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);

    try {
      const amount = parseUnits(amountInput, selectedToken.decimals);
      const amountHex = `0x${amount.toString(16)}` as Hex;
      let signatureWarning: string | null = null;
      if (shouldSignRequest && !walletAddress) {
        throw new Error('Connect a wallet to sign the payment request. Account-key sessions can create unsigned requests.');
      }

      // SDK-native flow: let the SDK's PaymentRequestService generate a
      // fresh paymentId, per-request X25519 keypair, deterministic
      // `tag = Poseidon([paymentId])`, and N (noteAddressHash, noteSecret)
      // slots — and persist the private half (paymentPrivKey + lifecycle
      // metadata) via its storage adapter so it survives refresh. The
      // sender pays via `prepareFulfillPaymentRequest`; the receiver
      // discovers via the normal `discoverNotes()` scan (tag-filtered, so
      // it's O(1) instead of trial-decrypting every catch-all event).
      // No keystore registration required on the receiver side.
      //
      // We call ensureInitialized() FIRST — it derives keystore keys
      // from the wallet signature as part of bootstrap. Gating on the
      // React `keystoreManager` ref would refuse perfectly valid
      // sessions whose context hadn't hydrated yet. ensureInitialized()
      // either returns a usable session or throws — the outer
      // try/catch surfaces an actionable error to the user.
      const session = await ensureInitialized();
      let registeredViewingKey: Hex | null = null;
      try {
        const cfg = getChainConfig(chainId);
        if (!cfg?.contracts) throw new Error(`Unsupported chain: ${chainId}`);
        const [{ lookupViewingKey }, sdkSetup] = await Promise.all([
          import('@/services/viewing-key-cache'),
          import('@/services/sdk-runtime'),
        ]);
        const rpc = sdkSetup.createRPCInteractor(chainId, Number(cfg.contracts.fromBlock));
        const ks = sdkSetup.createKeystoreInteractor(
          rpc,
          cfg.contracts.keystoreAddress as SdkAddress,
          cfg.contracts.keystoreFromBlock,
        );
        const lookup = await lookupViewingKey(
          chainId,
          address.toLowerCase() as SdkAddress,
          { getViewingKey: (account) => ks.getViewingKey(account) },
          {
            keystoreAddress: cfg.contracts.keystoreAddress,
            useAspCache: IsDefaultPoolActive,
          },
        );
        registeredViewingKey = lookup.viewingKey as Hex | null;
        log('info', 'PaymentRequest', 'Seller viewing-key registration check', {
          registered: !!registeredViewingKey,
          source: lookup.source,
          aspAvailable: lookup.aspAvailable,
        });
      } catch (registrationErr) {
        log('warn', 'PaymentRequest', 'Could not check seller viewing-key registration; falling back to per-request discovery', registrationErr);
      }

      // Unregistered: the request will work, but only from THIS browser until
      // it is claimed, so offer the safer route before creating it rather than
      // explaining the loss afterwards.
      if (!registeredViewingKey) {
        const choice = await askUnregistered();
        if (choice === 'cancel') { setIsBusy(false); return; }
        if (choice === 'register') {
          const registered = await new Promise<boolean>((resolve) => {
            openKeystoreRegistrationModal({
              title: 'Register to receive anywhere',
              body: 'A one-time on-chain setup lets payments reach you on any device, with nothing to keep safe.',
              primaryLabel: 'Register',
              onSuccess: () => resolve(true),
              onCancel: () => resolve(false),
            });
          });
          if (!registered) { setIsBusy(false); return; }
          // Re-read the published key so this request takes the registered
          // (seed-recoverable) path rather than the per-request one.
          try {
            const [{ lookupViewingKey }, sdkSetup] = await Promise.all([
              import('@/services/viewing-key-cache'),
              import('@/services/sdk-runtime'),
            ]);
            const cfg = getChainConfig(chainId);
            if (cfg?.contracts) {
              const rpc = sdkSetup.createRPCInteractor(chainId, Number(cfg.contracts.fromBlock));
              const ks = sdkSetup.createKeystoreInteractor(
                rpc,
                cfg.contracts.keystoreAddress as SdkAddress,
                cfg.contracts.keystoreFromBlock,
              );
              const after = await lookupViewingKey(
                chainId,
                address.toLowerCase() as SdkAddress,
                { getViewingKey: (account) => ks.getViewingKey(account) },
                { keystoreAddress: cfg.contracts.keystoreAddress, useAspCache: false },
              );
              registeredViewingKey = after.viewingKey as Hex | null;
            }
          } catch (reReadErr) {
            // Registration landed but the read failed: fall through to the
            // per-request path rather than blocking the request.
            log('warn', 'PaymentRequest', 'Post-registration viewing-key re-read failed', reReadErr);
          }
        } else {
          // Unregistered by choice: the request's key does not exist until the
          // request does, so record the intent and download the moment it is
          // created. backupUrgent keeps the UI leading with it until then.
          pendingKeyDownloadRef.current = true;
          setBackupUrgent(true);
        }
      }

      if (registeredViewingKey) {
        let request: PaymentRequestPayloadV2 = {
          kind: 'ppv2-payment-request',
          version: 2,
          requestId: makeRequestId(),
          chainId,
          recipientAddress: address as Hex,
          recipientViewingPubKey: registeredViewingKey,
          tokenId: selectedToken.address,
          amount: amountHex,
          createdAt: new Date().toISOString(),
        };

        if (shouldSignRequest) {
          try {
            const name = sellerName.trim();
            const signature = await signTypedDataAsync({
              domain: getPaymentRequestSigningDomain(chainId),
              types: PAYMENT_REQUEST_V2_SIGNING_TYPES,
              primaryType: 'DiscoverablePaymentRequest',
              message: getPaymentRequestSigningMessage(request, name),
            });
            request = {
              ...request,
              signature: {
                signer: address as Hex,
                signature: signature as Hex,
                signedAt: new Date().toISOString(),
                sellerName: name || undefined,
              },
            };
          } catch {
            signatureWarning = 'Request created unsigned. The payer can still pay, but they cannot verify who created it.';
          }
        }

        setOutputPayload(JSON.stringify(request, null, 2));
        setCreatedDraft({ amountLabel: frozenAmountLabel, amountHint: frozenView.hint });
        const createdPayLink = canUseBrowserApis()
          ? `${shareLinkBase()}/pay#${encodePaymentRequestPayloadForUrl(request)}`
          : null;
        if (createdPayLink) setPayLink(createdPayLink);
        // Session-scoped listing (product call): the request must show in the
        // Payment Requests menu NOW, but registered requests are stateless by
        // design — nothing durable to differ across devices.
        addSessionPaymentRequest({
          requestId: request.requestId,
          chainId,
          owner: address.toLowerCase(),
          tokenAddress: selectedToken.address,
          amount: amountHex,
          createdAtMs: Date.now(),
          payLink: createdPayLink,
          signed: !!request.signature,
        });
        bumpPaymentRequestRevision();
        toast({
          title: request.signature
            ? `Signed payment request created for ${balanceDisplay(amountInput, selectedToken.symbol, chainId).text}.`
            : `Payment request created for ${balanceDisplay(amountInput, selectedToken.symbol, chainId).text}.`,
        });
        // DEV-217: drop the "wallet is registered / no backup needed" yellow
        // info box; only surface a signature warning if one actually occurred.
        setWarningMessage(signatureWarning);
        log('info', 'PaymentRequest', 'Created registered-viewing-key payment request', {
          chainId,
          tokenId: selectedToken.address,
          recipientAddress: address,
          requestId: request.requestId,
          signed: !!request.signature,
        });
        return;
      }

      const sdkRequest = await session.generatePaymentRequest({
        amount: amountHex,
        tokenId: selectedToken.address,
        slots: 5,
      });
      // The SDK has already stored this request as OPEN, so anything below that
      // cannot produce a shareable link must remove it again (DEV-515).
      const discardAndThrow = async (err: unknown): Promise<never> => {
        await discardUnsharedPaymentRequest(chainId, sdkRequest.paymentId as Hex, address, session).catch(() => false);
        throw err;
      };
      // v2.0 migration: the public PaymentRequest returned by
      // generatePaymentRequest no longer carries noteSecretsMap (only
      // noteAddressHashes). The V3 payload still transports the secrets,
      // so read them from the record the SDK just persisted.
      let storedRecord: Awaited<ReturnType<typeof getStoredPaymentRequestRecord>> = null;
      try {
        storedRecord = await getStoredPaymentRequestRecord(chainId, sdkRequest.paymentId as Hex, address);
      } catch (readErr) {
        await discardAndThrow(readErr);
      }
      if (!storedRecord?.noteSecretsMap?.size) {
        await discardAndThrow(new Error('Payment request was created but its local record could not be read back.'));
      }
      const noteSecretsMap = Array.from((storedRecord!.noteSecretsMap as Map<Hex, Hex>).entries()) as [Hex, Hex][];
      // The SDK just persisted a new OPEN record — refresh the list widget.
      bumpPaymentRequestRevision();
      let compactExpiresAt: Hex | undefined;
      try {
        compactExpiresAt = sdkRequest.expiresAt !== undefined ? normalizeExpiresAt(sdkRequest.expiresAt) : undefined;
      } catch (expiryErr) {
        await discardAndThrow(expiryErr);
      }
      const request: PaymentRequestPayloadV3 = {
        kind: 'ppv2-sdk-payment-request',
        version: 1,
        chainId,
        recipientAddress: address as Hex,
        paymentId: sdkRequest.paymentId as Hex,
        tag: sdkRequest.tag as Hex,
        paymentPubKey: sdkRequest.paymentPubKey as Hex,
        tokenId: sdkRequest.tokenId as Hex,
        amount: sdkRequest.amount as Hex,
        noteSecretsMap,
        // The SDK's deadline rides in the link so the payer can refuse a
        // request this browser no longer scans for. The SDK pads it to a
        // 32-byte word; the link carries the compact value (DEV-515).
        ...(compactExpiresAt !== undefined ? { expiresAt: compactExpiresAt } : {}),
        createdAt: new Date().toISOString(),
      };
      // Prove the link can be built before anything else, a signature prompt
      // included, rather than leave a row that looks payable but was never
      // shareable, one per attempt (DEV-515).
      try {
        encodePaymentRequestPayloadForUrl(sanitizePaymentRequestPayloadForSharing(request));
      } catch (packErr) {
        await discardAndThrow(packErr);
      }

      // Everything that leaves this device goes through the public-request
      // sanitizer: the payer fulfills from the tuple KEYS alone, so the
      // shared tuples carry the fixed placeholder in the secret slot (the
      // real noteSecrets stay only in the SDK's local record). The tuple
      // shape is kept so old builds' decoders and the paste-parser stay
      // symmetric. Sanitize BEFORE signing so the signature verifies
      // against the payload the payer actually receives.
      let shareableRequest = sanitizePaymentRequestPayloadForSharing(request) as PaymentRequestPayloadV3;

      if (shouldSignRequest) {
        // TODO(native): this same-wallet signature is available everywhere,
        // but native still needs a separate identity-wallet handoff later.
        try {
          const name = sellerName.trim();
          // Expiring type when the request has a deadline, so the seal covers
          // it (see PAYMENT_REQUEST_EXPIRING_SIGNING_TYPES). Narrowed per
          // branch: wagmi's types cannot take the union in one call.
          const domain = getPaymentRequestSigningDomain(chainId);
          const typed = getPaymentRequestV3TypedData(shareableRequest, name);
          const signature = typed.primaryType === 'ExpiringPaymentRequest'
            ? await signTypedDataAsync({ domain, ...typed })
            : await signTypedDataAsync({ domain, ...typed });
          shareableRequest = {
            ...shareableRequest,
            signature: {
              signer: address as Hex,
              signature: signature as Hex,
              signedAt: new Date().toISOString(),
              sellerName: name || undefined,
            },
          };
        } catch {
          signatureWarning = 'Request created unsigned. The payer can still pay, but they cannot verify who created it.';
        }
      }

      setOutputPayload(JSON.stringify(shareableRequest, null, 2));
      if (pendingKeyDownloadRef.current) {
        pendingKeyDownloadRef.current = false;
        stellarBackupRef.current = null;
        const text = await buildBackupText();
        backupOwnerRef.current = text ? address : null;
        setBackupFileText(text);
        const target = pendingBackupTargetRef.current ? await pendingBackupTargetRef.current : null;
        pendingBackupTargetRef.current = null;
        // Normally this lands and the seller already has the file, so the panel
        // below settles to a confirmation. It can still be refused (a browser
        // that blocks a download not tied to a gesture, or a dismissed save
        // dialog), and then the panel keeps the button.
        let wrote: boolean;
        if (target && target !== 'cancelled' && text) {
          wrote = await writeBackupFileTarget(target, text);
          if (wrote) void notePaymentRequestBackupDelivered(address, text);
          else wrote = saveBackupFile(text);
        } else if (target === 'cancelled') {
          wrote = false;
        } else {
          wrote = saveBackupFile(text);
        }
        setBackupSaved(wrote);
        setBackupUrgent(!wrote);
        if (wrote) toast({ title: BACKUP_SAVED_TOAST });
      }

        setCreatedDraft({ amountLabel: frozenAmountLabel, amountHint: frozenView.hint });
      if (canUseBrowserApis()) {
        setPayLink(`${shareLinkBase()}/pay#${encodePaymentRequestPayloadForUrl(shareableRequest)}`);
      }
      toast({
        title: shareableRequest.signature
          ? `Signed payment request created for ${balanceDisplay(amountInput, selectedToken.symbol, chainId).text}.`
          : `Payment request created for ${balanceDisplay(amountInput, selectedToken.symbol, chainId).text}.`,
      });
      // Only a real signature problem is a warning here. The backup story is
      // told once, by the panel under the pay link: a V3 request is only
      // reachable by choosing "Download backup", so a second line telling the
      // seller to export one restates the choice they just made.
      setWarningMessage(signatureWarning ?? null);
      log('info', 'PaymentRequest', 'Created SDK-native payment request', {
        chainId,
        tokenId: selectedToken.address,
        recipientAddress: address,
        paymentId: sdkRequest.paymentId,
        tag: sdkRequest.tag,
        slots: noteSecretsMap.length,
        signed: !!shareableRequest.signature,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create payment request.');
    } finally {
      setIsBusy(false);
    }
  }, [address, walletAddress, amountInput, chainId, ensureInitialized, log, selectedToken, sellerName, shouldSignRequest, signTypedDataAsync, isSui, suiSession, isStellar, stellarSession, toast, saveBackupFile]);

  // Same-tick double-press guard (shared lock) — see hooks/use-op-lock.ts.
  const handleCreateRequest = useMemo(() => withOpLock(handleCreateRequestUnlocked), [withOpLock, handleCreateRequestUnlocked]);
  const handleCreateRequestRef = useRef<typeof handleCreateRequest | null>(null);
  handleCreateRequestRef.current = handleCreateRequest;

  const handlePayRequestUnlocked = useCallback(async () => {
    if (gateOnLockedSession(() => { void handlePayRequestRef.current?.(); })) return;
    // Operation binding (codex P1-5): abort before any wallet prompt/broadcast
    // if the modal was reset (closed/reopened/mode-switched) since this run began.
    const runEpoch = opEpochRef.current;
    const live = () => opEpochRef.current === runEpoch;
    // Has THIS run already cost the user money? Set the instant a wallet
    // broadcast of this run lands. Before it, a stale abort is free and
    // silence is correct — nothing was spent, and repainting a reset or
    // reopened modal is exactly the bug the epoch guard exists to prevent.
    // AFTER it, silence is itself the bug: the user signed an approval, paid
    // gas, granted an allowance, and got no payment, no error and no
    // instruction (QA 2026-08-26). Money already spent outranks "don't
    // repaint", so from that point every abort speaks — through the toast
    // (global; survives the reset that killed the run) and, only while this
    // run still owns the UI, through the banner.
    let walletSpend: 'registration' | 'approval' | null = null;
    let payUnits: { symbol: string; decimals: number } | null = null;
    const abortStale = (stage: string): void => {
      log('warn', 'Payment', `Stale run aborted ${stage}`, { walletSpend });
      if (!walletSpend) return; // pre-spend: silent by design (codex P1-5)
      const detail = walletSpend === 'approval'
        ? 'Your token approval went through but the payment was not sent, because this flow was closed or restarted. Nothing left your balance. Press Pay again — the approval is already on-chain, so your wallet will not ask for it twice.'
        : 'Your keystore registration went through but the payment was not sent, because this flow was closed or restarted. Nothing left your balance. Press Pay again to finish paying.';
      // The detail rides the TOAST, not the banner. Every call site invokes
      // this only when !live(), so an `if (live())` banner write here was dead
      // code and the actionable sentence never reached anyone (code review
      // 2026-08-27). The toast is global and survives the reset that killed
      // the run, which is exactly what this case needs.
      toast({
        title: 'Payment not sent — but your wallet already paid gas.',
        description: detail,
        variant: 'destructive',
      });
    };
    // A press (manual or auto) consumes any armed deep-link intent — a stale
    // armed action must never fire later off an unrelated chain switch (codex).
    setPendingAutoAction(null);
    setPendingAutoTarget(null);
    // Sui has no wallet-pay (depositFor) path; fulfill via private transfer.
    // Branch by payload KIND, not the active selection — an EVM request link
    // must stay wallet-payable even while Sui is the selected chain.
    if (parseSuiPaymentPayload(inputPayload)?.kind === 'ppv2-sui-payment-request') {
      setErrorMessage('On Sui, fulfill a request with "Pay via Private Transfer" below.');
      return;
    }
    if (!walletAddress) {
      setErrorMessage('Connect a wallet to pay via wallet. Account-key sessions can use Pay via Private Transfer.');
      return;
    }
    if (!address) {
      setErrorMessage('Connect your wallet first.');
      return;
    }
    if (!publicClient) {
      // BEFORE setIsBusy: an early return after it would leave both pay
      // buttons disabled-forever (they gate on isBusy) with no busyAction to
      // even show a spinner — a wedged modal until reopened.
      setErrorMessage('Wallet client unavailable. Reconnect and try again.');
      return;
    }
    setIsBusy(true);
    setBusyAction('wallet');
    setPayPhase('wallet');
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);
    // Pause background polling (balances, ASP queries) while the tx
    // is in flight so we don't blast the RPC during the wait.
    beginTx();

    try {
      // Fall back to the payload this surface was OPENED with. A locked
      // session defers the press through the seed-derivation modal, and the
      // retry can land after inputPayload has been reset to '' — see
      // openedPayloadRef. Reading state alone made the payer sign, and then get
      // "Empty payment request payload" instead of a payment.
      const payloadSource = inputPayload.trim() || openedPayloadRef.current.trim();
      const request = (() => {
        try {
          return parsePaymentRequestPayload(payloadSource);
        } catch {
          return decodePaymentRequestPayloadFromUrl(payloadSource);
        }
      })();
      {
        // Only a token this build KNOWS. getTokenMetadata never returns null:
        // for an address missing from the registry it guesses 18 decimals, and
        // a pasted link naming an unknown 6-decimal token would then print its
        // figures a trillion times too small. Unknown means raw, not guessed.
        const known = ACTIVE_ENVIRONMENT.tokensByChain[request.chainId]?.[String(request.tokenId).toLowerCase()];
        payUnits = known ? { symbol: known.symbol, decimals: known.decimals } : null;
      }
      // SECURITY GATE, before any wallet interaction. The signature seals the
      // recipient address + key — the fields that decide where funds land — and
      // this handler used to pay a decoded link without ever checking it, so a
      // link tampered with in transit (swapped address/key) would mint a note
      // for the attacker or a permanently unspendable one. The button is gated
      // too, but a stale/deep link can reach this handler directly, so the
      // authority lives HERE and the UI gate is only a courtesy. Unsigned
      // requests stay payable by design (nothing was sealed to break); a
      // present-but-invalid signature is refused outright.
      // Also refuses a request past its deadline: the requester has stopped
      // scanning for it, so the deposit could land and never be found.
      const payable = await assertPaymentRequestPayable(request);
      if (!payable.payable) {
        throw new Error(paymentRequestRefusalMessage(payable.reason));
      }
      // The deposit path has no SDK deadline check (prepareDepositFor takes
      // none), and registration plus approval can take minutes in the wallet.
      // So the deadline is checked again right before each broadcast.
      const refuseIfExpired = () => {
        if (isPaymentRequestExpired(request)) throw new Error(PAYMENT_REQUEST_EXPIRED_MESSAGE);
      };
      // SDK-native requests USED to be refused here: depositFor emitted a fresh
      // random hint, so the event could not land in the receiver's tag map and
      // the payment would be undiscoverable. The SDK has since gained
      // DepositForParams path A (caller-built `noteData` + `depositSecret`,
      // added for stealth delivery), so the deposit can carry
      // `hint = tag = Poseidon([paymentId])` after all. services/payment-request-deposit.ts
      // builds that payload, and refuses before broadcast if the hint is not
      // the tag — the one failure mode that is unrecoverable on-chain rather
      // than merely wrong. Re-enabled deliberately: wallet-pay is the only path
      // for a payer with NO shielded balance, and since every request this app
      // creates is SDK-native, gating it off made the feature dead code.
      // chainId is untrusted input from the decoded link. Reject before
      // any wallet / RPC interaction so the user gets an actionable
      // error instead of a cryptic wagmi or RPC failure deep in the
      // flow.
      if (!isSupportedEvmChainId(request.chainId)) {
        throw new Error(requestChainRefusal(receiptChain(request.chainId)));
      }
      // A private-transfer relay of this request may still land (DEV-486).
      const relayLatch = payRelayLatch(request.kind === 'ppv2-sdk-payment-request' ? request.paymentId : request.requestId);
      if (relayLatch) {
        setWarningMessage(payRelayUnknownMessage(relayLatch.heard));
        return;
      }
      // Launch deposit cap (prod $100). This payment IS a deposit of
      // request.amount in request.tokenId, and the link carries the amount,
      // so the deposit modal's typed-amount check never sees it (codex review
      // of d60b2c4). Refuse here, before chain switching, registration or
      // approval could cost the payer gas for a deposit the ASP will reject.
      {
        const capToken = getTokenMetadata(request.tokenId, request.chainId);
        // A request for a withdraw-only (legacy) asset: the Entrypoint reverts
        // the deposit, so refuse here too, before chain switch, registration or
        // an approval could cost the payer gas (codex, 2026-09-04). It can
        // still be paid privately from a shielded balance in that asset.
        const walletRefusal = requestWalletRefusalFor(request);
        if (walletRefusal) throw new Error(walletRefusal);
        await assertDepositCap({
          amountWei: BigInt(request.amount),
          decimals: capToken?.decimals ?? 18,
          symbol: capToken ? displayTokenSymbol(capToken.symbol) : 'this token',
          capUsd: ACTIVE_ENVIRONMENT.maxDepositUsd,
          fetchPrice: getPrice,
        });
      }
      // Compare against the WALLET's actual chain, not just the app
      // selection: the wallet signs every tx here, and a wallet parked on
      // chain 1 with the app aligned to the request's Sepolia passed the old
      // selection-only check — the send then died on viem's chain-mismatch
      // with a raw error dump (QA screenshot, 2026-08-16).
      if (request.chainId !== chainId || (walletChainId !== undefined && walletChainId !== request.chainId)) {
        if (!live()) { log('warn', 'Payment', 'Stale run aborted before chain switch'); return; }
        await switchChainAsync({ chainId: request.chainId });
        // STOP after a successful switch — do NOT continue this closure. The
        // whole handler (ensureInitialized, session, clients) was captured on
        // the previous chain's render, so continuing would prepare deposit
        // calldata against the OLD chain and submit it on the new one. On a
        // two-EVM-chain build the worst case is a native transfer to an
        // address with no contract on the target chain — funds gone with no
        // note created. Same switch-then-retry contract as app/pay.
        throw new Error(
          `Wallet switched to ${getChainConfig(request.chainId)?.displayName ?? `chain ${request.chainId}`}. Press Pay again to complete the payment.`,
        );
      }
      const { createRPCInteractor } = await import('@/services/sdk-runtime');
      const rpcInteractor = createRPCInteractor(request.chainId, Number(getChainConfig(request.chainId)?.contracts?.fromBlock));

      const session = await ensureInitialized();
      // isKeystoreRegistered() checks ONLY the auth key (codex round 3): after
      // a failed viewing-key leg it reports registered and the repair below
      // became unreachable. prepareRegisterKeystore() checks BOTH legs and
      // returns alreadyRegistered/null calldata accordingly — always ask it
      // for wallet sessions.
      const isRegistered = await session.isKeystoreRegistered();
      if (!isRegistered && identityMode === 'key') {
        log('info', 'PaymentRequest', 'Skipping keystore auto-registration for wallet-funded key session payment', {
          sessionAddress: address,
          payerAddress: walletAddress,
        });
      } else if (identityMode !== 'key') {
        const registration = await session.prepareRegisterKeystore();
        // Malformed adapter output must not authorize continuation (codex
        // round 3): not-registered with NEITHER leg present is an invariant
        // violation, not a green light.
        if (!registration.alreadyRegistered && !registration.keystoreCalldata && !registration.viewingKeyCalldata) {
          throw new Error('Keystore registration is unavailable for this session.');
        }
        // Each leg submits independently (viewing-only resume is a real SDK
        // state), and the SDK receipt's mined status is READ (codex round 2:
        // both statuses were ignored, so a reverted registration proceeded
        // into the payment). status is `true`/boolean on the SDK receipt.
        const requireOk = (receipt: unknown, label: string) => {
          const status = (receipt as { status?: unknown } | undefined)?.status;
          if (status === false || status === 'reverted') {
            throw new Error(`${label} reverted on-chain.`);
          }
        };
        if (!registration.alreadyRegistered && registration.keystoreCalldata) {
          if (!live()) { abortStale('before the keystore registration broadcast'); return; }
          refuseIfExpired();
          const regHash = await sendTransactionAsync({
            chainId: request.chainId,
            to: registration.keystoreCalldata.to,
            data: registration.keystoreCalldata.data,
            value: BigInt(registration.keystoreCalldata.value),
          });
          // BEFORE the receipt await, not after (code review 2026-08-27): the
          // gas is committed the moment the broadcast lands, so a revert or a
          // receipt-read timeout must still count as spent. Setting it after
          // requireOk lost the flag on exactly the failures that cost money.
          walletSpend = 'registration';
          requireOk(await rpcInteractor.waitForTransactionReceipt(regHash), 'Keystore registration');
        }
        if (!registration.alreadyRegistered && registration.viewingKeyCalldata) {
          if (!live()) { abortStale('before the viewing-key broadcast'); return; }
          const vkHash = await sendTransactionAsync({
            chainId: request.chainId,
            to: registration.viewingKeyCalldata.to,
            data: registration.viewingKeyCalldata.data,
            value: BigInt(registration.viewingKeyCalldata.value),
          });
          walletSpend = 'registration';
          requireOk(await rpcInteractor.waitForTransactionReceipt(vkHash), 'Viewing-key registration');
        }
        setReceiveSetup(address, request.chainId, 'complete', 'onchain');
      }

      // prepareDepositFor's schema is XOR — either a bare `noteAddressHash`
      // (v1 / blind path, where the receiver already committed to one and
      // shared it in the request) or a `discoveryData` object (v2 / public-
      // key-publish, where the sender generates noteSecret+noteAddressHash
      // and the SDK encrypts noteData to the receiver's published viewing
      // pubkey so they auto-discover via scanCatchAll). Passing flat
      // `recipientAddress`/`recipientViewingPubKey` fields fails Zod with
      // "Invalid input" because neither schema branch accepts them.
      let depositForParams: {
        tokenId: Hex;
        value: Hex;
        noteAddressHash?: Hex;
        noteData?: { hint: Hex; data: Hex };
        depositSecret?: Hex;
        discoveryData?: {
          publicViewingKey: Hex;
          noteAddressHash: Hex;
          noteSecret: Hex;
        };
      };
      if (request.kind === 'ppv2-sdk-payment-request') {
        // Path A: bind to a slot the RECIPIENT pre-allocated and hand the SDK a
        // verbatim noteData tagged with the request tag. Deliberately NOT the
        // `discoveryData` shape the v2 branch below uses: that emits a random
        // hint encrypted to a key the receiver does not scan with, and the
        // payer-generated noteSecret is never handed over, so the funds would be
        // permanently unrecoverable. See services/payment-request-deposit.ts.
        const { createCryptoService, createNoteComputationService } = await import('@/services/sdk-runtime');
        const { buildPaymentRequestDepositNoteData } = await import('@/services/payment-request-deposit');
        const cryptoService = createCryptoService();
        const noteComputation = await createNoteComputationService();
        const built = buildPaymentRequestDepositNoteData({
          request: {
            tokenId: request.tokenId,
            amount: request.amount,
            paymentPubKey: request.paymentPubKey,
            tag: request.tag,
            noteSecretsMap: request.noteSecretsMap,
          },
          noteComputation: noteComputation as never,
          depositSecret: cryptoService.generateSecret() as Hex,
        });
        depositForParams = {
          tokenId: request.tokenId,
          value: request.amount,
          noteAddressHash: built.noteAddressHash,
          noteData: built.noteData,
          depositSecret: built.depositSecret,
        };
      } else if (request.version === 2) {
        const { createCryptoService, createHashService } = await import('@/services/sdk-runtime');
        const cryptoService = createCryptoService();
        const hashService = await createHashService();
        const noteSecret = cryptoService.generateSecret() as Hex;
        const noteAddressHash = hashService.hash([request.recipientAddress, noteSecret]) as Hex;
        depositForParams = {
          tokenId: request.tokenId,
          value: request.amount,
          discoveryData: {
            publicViewingKey: request.recipientViewingPubKey,
            noteAddressHash,
            noteSecret,
          },
        };
      } else {
        depositForParams = {
          tokenId: request.tokenId,
          value: request.amount,
          noteAddressHash: request.noteAddressHash,
        };
      }
      // The SDK validates the Entrypoint minimum INSIDE prepareDepositFor and
      // throws BelowMinimumAmount ("value 0x… is below minimum 0x…", raw units)
      // before returning anything - so this is where the payer's copy is
      // decided (codex P2 on 1a65ddb: a check placed after the call was dead).
      // The request's asset is the deposit asset, so the parsed minimum is
      // already in its units.
      let result: Awaited<ReturnType<typeof session.prepareDepositFor>>;
      try {
        result = await session.prepareDepositFor(depositForParams);
      } catch (prepErr) {
        const meta = getTokenMetadata(request.tokenId, request.chainId);
        const friendly = friendlyDepositError(
          prepErr instanceof Error ? prepErr.message : String(prepErr),
          { payDecimals: meta.decimals, paySymbol: meta.symbol, poolDecimals: meta.decimals },
          prepErr instanceof Error ? prepErr.name : undefined,
        );
        if (friendly) throw new Error(`${friendly}, and this request asks for less, so it cannot be paid. Nothing was paid.`);
        throw prepErr;
      }

      // The Entrypoint's per-asset config, read once for EVERY asset (native
      // included): the vetting fee below needs it for ERC-20 allowances.
      const entrypointAddress = result.depositTx.to as Hex;
      const assetConfig = await rpcInteractor.readContract({
        address: entrypointAddress,
        abi: ENTRYPOINT_ASSETS_ABI,
        functionName: 'assets',
        args: [request.tokenId],
      }) as EntrypointAssetConfig;
      const paymentAmount = BigInt(request.amount);

      if (request.tokenId.toLowerCase() !== NATIVE_ASSET_ADDRESS) {
        const feeBPS = getVettingFeeBPS(assetConfig);
        const requiredAllowance = paymentAmount + ((paymentAmount * feeBPS) / 10_000n);

        // BALANCE before allowance. Approving a token you do not hold succeeds,
        // so without this the payer signed an approval, paid its gas, and then
        // watched the deposit revert in transferFrom with nothing to explain it.
        // The case that made this routine: a request denominated in a POOL SHARE
        // (ppUSDC / ppUSDT). Shares live in the pool as notes, never in a wallet,
        // so the wallet route can never pay one — the shielded-balance route can
        // (codex, 2026-09-04).
        const payerBalance = await rpcInteractor.readContract({
          address: request.tokenId,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [walletAddress],
        }) as bigint;
        if (payerBalance < requiredAllowance) {
          const meta = getTokenMetadata(request.tokenId, request.chainId);
          const need = balanceDisplay(formatUnits(requiredAllowance, meta.decimals), meta.symbol, request.chainId, request.tokenId).text;
          const have = balanceDisplay(formatUnits(payerBalance, meta.decimals), meta.symbol, request.chainId, request.tokenId).text;
          throw new Error(
            isShareSymbol(meta.symbol)
              ? `This request asks for ${need}, a pool share your wallet cannot hold. Nothing was paid. Pay it from your shielded ${displayTokenSymbol(meta.symbol)} balance instead.`
              : `You need ${need} in your wallet to pay this request, and you have ${have}. Nothing was paid.`,
          );
        }

        const payerAllowance = await rpcInteractor.readContract({
          address: request.tokenId,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [walletAddress, entrypointAddress],
        }) as bigint;

        log('debug', 'PaymentRequest', 'Checked wallet-payment ERC-20 payer allowance', {
          tokenId: request.tokenId,
          payer: walletAddress,
          entrypoint: entrypointAddress,
          payerAllowance: payerAllowance.toString(),
          requiredAllowance: requiredAllowance.toString(),
          sdkHadApprovalTx: !!result.approvalTx,
        });

        if (payerAllowance < requiredAllowance) {
          if (!live()) { abortStale('before the approval broadcast'); return; }
          refuseIfExpired();
          const approvalHash = await sendTransactionAsync({
            chainId: request.chainId,
            to: request.tokenId,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [entrypointAddress, requiredAllowance],
            }) as Hex,
            value: 0n,
          });
          // Submitted: the fee is already committed whatever happens next.
          walletSpend = 'approval';
          const approvalOutcome = await waitForPaymentTx(publicClient, approvalHash);
          if (approvalOutcome.kind !== 'success') {
            // The outcome label is about the TX; the allowance is the ground
            // truth about the GOAL. A wallet can replace our approve() with a
            // re-signed variant (different amount, different casing) that viem
            // labels 'replaced' — if the resulting allowance covers the
            // payment, aborting would be wrong. Only when it still falls short
            // do we stop, with approval-specific copy (the generic one said
            // "payment", misnaming what the user cancelled).
            const allowanceNow = await rpcInteractor.readContract({
              address: request.tokenId,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [walletAddress, entrypointAddress],
            }) as bigint;
            if (allowanceNow < requiredAllowance) {
              throw new Error(
                approvalOutcome.kind === 'not-sent'
                  ? 'You cancelled the token approval in your wallet. Nothing was paid.'
                  : 'The token approval did not complete. Nothing was paid. Check your wallet and try again.',
              );
            }
            log('info', 'PaymentRequest', 'Approval tx was replaced but the allowance is sufficient. Continuing', {
              outcome: approvalOutcome.kind,
            });
          }
        }
      }

      // THE regression's exit path (QA 2026-08-26): reached with a mined
      // approval behind it, it used to return without a word.
      if (!live()) { abortStale('before the payment broadcast'); return; }
      refuseIfExpired();
      const hash = await sendTransactionAsync({
        chainId: request.chainId,
        to: result.depositTx.to,
        data: result.depositTx.data,
        value: BigInt(result.depositTx.value),
      });
      // Replacement-aware wait (services/tx-finality). Two lies live here
      // otherwise, both verified against the installed viem source:
      //   - a SPEED-UP lands the same payment under a NEW hash, and viem
      //     resolves with the REPLACEMENT's receipt — recording `hash` would
      //     stamp/display a ghost tx and the paid-request exclusion would
      //     silently miss (the over-count bug returns for this payment);
      //   - a CANCEL is a 0-value self-send that SUCCEEDS, so a bare status
      //     check reports "Payment sent" for a payment the user cancelled.
      // `finalHash` is the hash that is real; everything downstream uses it.
      let payOutcome: Awaited<ReturnType<typeof waitForPaymentTx>>;
      try {
        payOutcome = await waitForPaymentTx(publicClient, hash);
      } catch (waitErr) {
        // The SUBMISSION went out; only the wait failed (timeout, or viem's
        // known race where a replacement is found in a block before its
        // receipt endpoint catches up — that path throws). "Failed" would be
        // a guess that invites paying twice.
        log('warn', 'PaymentRequest', 'Payment wait failed after submission', { error: String(waitErr) });
        throw new Error(
          `The payment was submitted but could not be confirmed. Check ${hash} on the explorer before paying again.`,
        );
      }
      if (payOutcome.kind !== 'success') {
        throw new Error(
          describePaymentTxOutcome(payOutcome)
            ?? 'The payment could not be confirmed. Check the explorer before retrying.',
        );
      }
      const finalHash = payOutcome.finalHash;
      if (payOutcome.replacedFrom) {
        log('info', 'PaymentRequest', 'Payment was repriced in the wallet; using the replacement hash', {
          submitted: payOutcome.replacedFrom,
          final: finalHash,
        });
      }
      setTxHash(finalHash);
      setTxChainId(request.chainId);

      // Stamp this as a payment made TO SOMEONE ELSE. On-chain it is an
      // ordinary deposit by this wallet — the recipient is hidden inside
      // noteAddressHash — so without this record the balance fallback in
      // pools-provider counts the payment back into the payer's own balance,
      // telling them they still hold money they just paid away.
      // Same key convention as the transfer path: SDK-native requests are
      // identified by paymentId, legacy ones by requestId.
      const isSdkNative = request.kind === 'ppv2-sdk-payment-request';
      const paidRequestKey = isSdkNative ? request.paymentId : request.requestId;
      setLastPaid({
        requestKey: paidRequestKey,
        txHash: finalHash,
        // The chain the payment EXECUTED on, not the one selected later.
        chainId: request.chainId,
        // Only v1 hands the recipient an out-of-band receipt; v2 and SDK-native
        // are both discovered on-chain.
        hadReceipt: !isSdkNative && request.version !== 2,
      });
      const paidBase = {
        txHash: finalHash,
        recipient: request.recipientAddress ?? '',
        rawAmount: request.amount,
        tokenAddress: request.tokenId,
        chainId: request.chainId,
        requestId: paidRequestKey,
        timestamp: Date.now(),
        requestKind: (isSdkNative ? 'sdk' : request.version === 2 ? 'v2' : 'v1') as 'v1' | 'v2' | 'sdk',
      };
      recordPaidRequest(paidBase);
      // Confirmed write → refresh shared tx/stats caches (codex round 1, P1).
      void invalidateTransactionCaches(queryClient);

      if (isSdkNative) {
        // Discoverable by TAG: the deposit's Note event carries hint = the
        // request tag, so the recipient's scanPaymentRequests matches it in
        // O(1) and flips the request to fulfilled. No receipt payload needed.
        // The one honest caveat: a deposit note lands PENDING and only becomes
        // spendable once the ASP approves its label, so say so rather than
        // implying instant funds.
        setOutputPayload('');
        setReceiveLink(null);
        setStatusMessage('Payment sent. The recipient will see it on their next sync, once the deposit clears its compliance review.');
        setWarningMessage(null);
      } else if (request.version === 2) {
        // Discoverable: the recipient-targeted Note event is already on-chain
        // with a ciphertext decryptable by `request.recipientViewingPubKey`.
        // The recipient's next `discoverNotes()` call will find it on any
        // device with the seed — no receipt payload needed.
        setOutputPayload('');
        setReceiveLink(null);
        setStatusMessage('Payment sent. The recipient will discover the note automatically on their next sync. No receipt link is needed for this payment.');
        setWarningMessage(null);
      } else {
        const receiptPayload: PaymentReceiptPayload = {
          kind: 'ppv2-payment-receipt',
          version: 1,
          requestId: request.requestId,
          chainId: request.chainId,
          recipientAddress: request.recipientAddress,
          tokenId: request.tokenId,
          amount: request.amount,
          noteAddressHash: request.noteAddressHash,
          commitment: result.pendingNote.commitment,
          label: result.pendingNote.label,
          txHash: finalHash,
          createdAt: new Date().toISOString(),
        };
        setOutputPayload(JSON.stringify(receiptPayload, null, 2));
        if (canUseBrowserApis()) {
          setReceiveLink(`${shareLinkBase()}/receive#${encodePaymentReceiptPayloadForUrl(receiptPayload)}`);
        }
        // Persist everything the receipt link needs (upsert REPLACES by
        // txHash, so the base fields ride along). Until 2026-08-25 this
        // receipt lived only in component state: any modal reset destroyed
        // the payer's only copy, with nothing to re-copy from the row menu
        // (Mike, QA). The link is rebuildable from this record forever.
        recordPaidRequest({
          ...paidBase,
          noteAddressHash: request.noteAddressHash,
          commitment: receiptPayload.commitment,
          label: receiptPayload.label,
        });
        setStatusMessage('Payment sent. Share this receipt payload with the recipient so they can import the note.');
        setWarningMessage('The recipient still needs their local request payload on their device to reconstruct the note secret and receive this payment.');
      }
      log('info', 'PaymentRequest', 'Paid payment request', {
        requestId: paidRequestKey,
        version: request.version,
        txHash: finalHash,
        commitment: result.pendingNote.commitment,
      });
    } catch (error) {
      // Stale runs must not repaint a reset/reopened modal; 'Superseded' from
      // a pre-broadcast gate is silent by design (codex).
      // A wallet payment deposits into the request's pool, so a deposit minimum
      // or a vault quote is in that asset. Set once the request decodes; before
      // that there is nothing to place the figures in and they stay as written.
      const emsg = error instanceof Error
        ? sdkErrorText(error, payUnits ? { input: payUnits, output: payUnits, funding: payUnits } : null, error.message)
        : 'Failed to pay request.';
      // Toast for the notification, banner for the record. Only the first line
      // goes to either (QA): viem failures dump multi-line internals and the
      // first line is the human sentence. The toast alone used to be the only
      // trace, so a payment that failed while nobody was watching left the card
      // looking untouched and gave no reason to read. Switch-and-retry guidance
      // is not an error, so it keeps the default variant.
      // A spent run reports its failure even when the epoch moved: !live()
      // silence is only honest while the run was still free (QA 2026-08-26).
      // But only the TOAST may fire on a dead run -- writing the banner would
      // paint a payment error into a modal that has since been reset to
      // another flow, where nothing would ever clear it (code review
      // 2026-08-27).
      if ((live() || walletSpend) && !/Superseded/.test(emsg)) {
        const title = emsg.split('\n')[0];
        toast(/Press Pay again/.test(emsg) ? { title } : { title, variant: 'destructive' });
        if (live()) setErrorMessage(title);
      }
    } finally {
      endTx();
      setIsBusy(false);
      setBusyAction(null);
      setPayPhase('idle');
    }
    // walletChainId is load-bearing for the wallet-vs-request chain compare
    // above; omitting it let that guard run against a stale wallet chain.
  }, [address, walletAddress, walletChainId, chainId, ensureInitialized, identityMode, inputPayload, log, sendTransactionAsync, switchChainAsync, beginTx, endTx, publicClient, toast, queryClient, gateOnLockedSession]);

  // Same-tick double-press guard (shared lock) — see hooks/use-op-lock.ts.
  const handlePayRequest = useMemo(() => withOpLock(handlePayRequestUnlocked), [withOpLock, handlePayRequestUnlocked]);
  const handlePayRequestRef = useRef<typeof handlePayRequest | null>(null);
  handlePayRequestRef.current = handlePayRequest;

  const handlePayViaTransferUnlocked = useCallback(async () => {
    if (gateOnLockedSession(() => { void handlePayViaTransferRef.current?.(); })) return;
    // Operation binding (codex P1-5) — see handlePayRequestUnlocked.
    const runEpoch = opEpochRef.current;
    const live = () => opEpochRef.current === runEpoch;
    // A press consumes any armed deep-link intent (codex).
    setPendingAutoAction(null);
    setPendingAutoTarget(null);
    let suiPayBroadcastAttempted = false;
    // === Sui path === fulfill the request with a private transfer to the
    // requester, generating their note secret and returning it in a receipt.
    // Branched by payload KIND, not the active selection — an EVM request must
    // stay payable while Sui is active and vice versa.
    const suiPayRequest = parseSuiPaymentPayload(inputPayload);
    if (suiPayRequest?.kind === 'ppv2-sui-payment-request') {
      if (!isSui) {
        // The Sui session config is selection-scoped; align, then re-run.
        selectChain(SUI_TESTNET_ID);
        setErrorMessage(null);
        setStatusMessage('Switched to Sui Testnet. Press Pay again.');
        return;
      }
      const suiAddr = suiSession.account?.address;
      if (!suiAddr) { setErrorMessage('Connect your Sui wallet first.'); return; }
      setIsBusy(true); setBusyAction('transfer'); setPayPhase('wallet'); setStatusMessage(null); setWarningMessage(null); setErrorMessage(null);
      try {
        const req = suiPayRequest as unknown as { requestId: string; recipientAddress: string; amountMist: string };
        const want = BigInt(req.amountMist);
        // Lineage-first selection (value conservation is per-label).
        const selection = selectSuiNotes(suiSession.loadNotes(), want);
        if (!selection) throw new Error(SUI_SINGLE_NOTE_ERROR);
        const { notes: chosen, sum, label } = selection;
        const { randomFieldElement, addressToU256 } = await import('@/services/sui-witness');
        const tokenId = BigInt(chosen[0].tokenId);
        const change = sum - want;
        const recipientSecret = randomFieldElement();
        const recipientOwner = addressToU256(req.recipientAddress);
        // The requester's note secret now exists only in this tab; arm the
        // close guard before the transaction can land on-chain, and show a
        // COMPLETE importable base receipt BEFORE the combined
        // sign-and-execute call (codex round 3: a post-submit failure used to
        // drop the closure holding the only copy of the secret while the
        // recipient could already own the on-chain commitment). The
        // commitment is deterministic from the note fields.
        // Stale check BEFORE arming (codex): a run aborted after arming left a
        // phantom "at-risk" receipt for a transfer that never broadcast,
        // trapping every reopen on the receipt screen.
        if (!live()) { log('warn', 'Payment', 'Stale run aborted before Sui receipt arm'); return; }
        setSuiReceiptLifecycle('at-risk');
        {
          const { calculateNoteAddressHash, calculateNoteCommitment } = await import('@/services/sui-witness/crypto');
          const preHash = await calculateNoteAddressHash(recipientOwner, recipientSecret);
          const preCommitment = await calculateNoteCommitment(preHash, tokenId, want, 0n, label);
          setOutputPayload(JSON.stringify({
            kind: 'ppv2-sui-payment-receipt' as const,
            version: 1,
            requestId: req.requestId,
            recipientAddress: req.recipientAddress,
            note: {
              commitment: preCommitment.toString(),
              value: want.toString(), tokenId: tokenId.toString(), label: label.toString(),
              noteSecret: recipientSecret.toString(), ownerAddress: recipientOwner.toString(),
              coinType: '0x2::sui::SUI', status: 'active',
            },
          }, null, 2));
        }
        if (!live()) {
          // This run armed the lifecycle above but never broadcast — disarm
          // its own phantom receipt or every reopen is trapped on it (codex).
          setSuiReceiptLifecycle('none');
          setOutputPayload('');
          log('warn', 'Payment', 'Stale run aborted before broadcast (own receipt disarmed)');
          return;
        }
        suiPayBroadcastAttempted = true;
        setStatusMessage('Reconstructing Merkle proofs + proving...');
        const result = await suiSession.transferOrWithdraw({
          shouldContinue: live,
          inputNotes: chosen,
          outputNotes: change > 0n
            ? [
                { value: want, tokenId, label, noteSecret: recipientSecret, ownerAddress: recipientOwner },
                { value: change, tokenId, label, noteSecret: randomFieldElement(), ownerAddress: addressToU256(suiAddr) },
              ]
            : [{ value: want, tokenId, label, noteSecret: recipientSecret, ownerAddress: recipientOwner }],
          amountOut: 0n,
          tokenIdOut: 0n,
        });
        const receipt = {
          kind: 'ppv2-sui-payment-receipt' as const,
          version: 1,
          requestId: req.requestId,
          recipientAddress: req.recipientAddress,
          note: {
            commitment: result.outputCommitments[0].toString(),
            value: want.toString(), tokenId: tokenId.toString(), label: label.toString(),
            noteSecret: recipientSecret.toString(), ownerAddress: recipientOwner.toString(),
            coinType: '0x2::sui::SUI', status: 'active', txDigest: result.txDigest,
          },
        };
        setOutputPayload(JSON.stringify(receipt, null, 2));
        setStatusMessage(`Paid ${(Number(want) / 1e9).toFixed(4)} SUI. Send this receipt back to the requester to import.`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to fulfill the Sui payment request.';
        // Disarm only for failures that provably never submitted (codex
        // round 3): transferOrWithdraw signs AND executes — after it starts,
        // the tx may have landed and the base receipt above is the
        // requester's only recovery path.
        const knownRejection = /Superseded|User rejected|User denied|User cancelled|rejected from user/i.test(msg);
        if (!suiPayBroadcastAttempted || knownRejection) {
          setSuiReceiptLifecycle('none');
          setOutputPayload('');
        } else {
          setWarningMessage('The payment outcome is unknown. Keep the receipt above and verify the transaction before retrying.');
        }
        // A superseded run is silent by design, and a stale run must not
        // paint its error into the NEXT modal session (codex verification).
        if (live() && !/Superseded/.test(msg)) setErrorMessage(msg);
      } finally {
        setIsBusy(false); setBusyAction(null); setPayPhase('idle');
      }
      return;
    }

    // EVM payload while Sui is selected: the private-transfer path spends
    // EVM notes, which are selection-scoped — align, then re-run. (Deep links
    // are already aligned at open time; this covers a manual cross-mode paste.)
    if (isSui) {
      selectChain(defaultChainId);
      setErrorMessage(null);
      setStatusMessage(`Switched to ${getChainConfig(defaultChainId)?.displayName ?? 'the EVM chain'}. Press Pay again.`);
      return;
    }

    if (!address) {
      setErrorMessage('Connect your wallet first.');
      return;
    }
    setIsBusy(true);
    setBusyAction('transfer');
    setPayPhase('preparing');
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);
    beginTx();

    // Hoisted so the catch can render SDK operands in token units. The catch
    // cannot re-parse the payload (it may be the thing that threw).
    let payToken: { symbol: string; decimals: number } | null = null;
    // Units for sdkErrorText, only for a token this build KNOWS. payToken above
    // comes from getTokenMetadata, which guesses 18 decimals for an unknown
    // token; that guess stays confined to the request-specific wording.
    let knownPayUnits: { symbol: string; decimals: number } | null = null;
    // For the relay latch in the catch: which request, whether the relay was
    // handed over, and whether the relayer answered with a hash.
    let payRequestKey: string | null = null;
    let relayAttempted = false;
    let relayHeardHash: string | null = null;
    let stopHearingRelay: (() => void) | null = null;
    let paymentRecorded = false;
    try {
      // Fall back to the payload this surface was OPENED with. A locked
      // session defers the press through the seed-derivation modal, and the
      // retry can land after inputPayload has been reset to '' — see
      // openedPayloadRef. Reading state alone made the payer sign, and then get
      // "Empty payment request payload" instead of a payment.
      const payloadSource = inputPayload.trim() || openedPayloadRef.current.trim();
      const request = (() => {
        try {
          return parsePaymentRequestPayload(payloadSource);
        } catch {
          return decodePaymentRequestPayloadFromUrl(payloadSource);
        }
      })();
      if (!isSupportedEvmChainId(request.chainId)) {
        throw new Error(requestChainRefusal(receiptChain(request.chainId)));
      }
      payRequestKey = request.kind === 'ppv2-sdk-payment-request' ? request.paymentId : request.requestId;
      // An earlier relay of THIS request may still land (DEV-486): a second
      // press used to start a second payment beside it.
      const latch = payRelayLatch(payRequestKey);
      if (latch) {
        setWarningMessage(payRelayUnknownMessage(latch.heard));
        return;
      }
      payToken = getTokenMetadata(request.tokenId, request.chainId);
      {
        const known = ACTIVE_ENVIRONMENT.tokensByChain[request.chainId]?.[String(request.tokenId).toLowerCase()];
        knownPayUnits = known ? { symbol: known.symbol, decimals: known.decimals } : null;
      }
      // Same authority the wallet-pay handler uses, for the same reason — a
      // tampered signed request must be refused whichever button paid it. The
      // old check here fired ONLY for v3-with-a-signature, silently skipping a
      // tampered v2 (whose signature seals recipientAddress + viewing key just
      // the same). assertPaymentRequestPayable covers every version and treats
      // a present-but-invalid signature as tampering, an absent one as
      // unsigned-by-design.
      const payable = await assertPaymentRequestPayable(request);
      if (!payable.payable) {
        throw new Error(paymentRequestRefusalMessage(payable.reason));
      }
      // WALLET chain included in the check — see the wallet-pay handler: a
      // wallet on another chain than the app selection sailed past the
      // selection-only compare and the registration send died on viem's
      // chain-mismatch.
      if (request.chainId !== chainId || (walletAddress && walletChainId !== undefined && walletChainId !== request.chainId)) {
        if (!walletAddress) {
          throw new Error(`This payment request is for chain ${request.chainId}. Account-key sessions cannot switch chains; connect the owning wallet or open the app on the request's chain.`);
        }
        if (!live()) { log('warn', 'Payment', 'Stale run aborted before chain switch'); return; }
        await switchChainAsync({ chainId: request.chainId });
        // STOP after a successful switch (see the deposit-pay handler above):
        // this closure's session/processor belong to the previous chain, and a
        // transfer prepared there but relayed on the request's chain would at
        // best die with PoolVault_ProofContextMismatch after full proving.
        throw new Error(
          `Wallet switched to ${getChainConfig(request.chainId)?.displayName ?? `chain ${request.chainId}`}. Press Pay again to complete the payment.`,
        );
      }

      const session = await ensureInitialized();


      // Paying can begin before the payer's own note stream has landed: a press
      // moments after sign-in saw zero notes and reported "No active notes
      // available", while the notes arrived seconds later (QA 2026-08-19). An
      // empty set is therefore treated as "not synced yet" and re-read a few
      // times before it is treated as "nothing to pay with".
      const selectFrom = (source: typeof notes) => {
        const matching = source.filter((n) => n.tokenId.toLowerCase() === request.tokenId.toLowerCase());
        const owned = matching.filter((n) => n.isOwned && n.ownerAddress?.toLowerCase() === address.toLowerCase());
        return { matching, owned, active: owned.filter((n) => n.status === NoteStatus.ACTIVE) };
      };
      let { matching: allMatchingNotes, owned: ownedNotes, active: activeNotes } = selectFrom(notes);
      // `notes` is a render-captured snapshot, so re-reading the manager the
      // hook itself reads is what picks up a sync that landed since the press.
      // Sui keeps its notes elsewhere and has no equivalent live read, so it
      // keeps the snapshot rather than looping to no effect.
      for (let attempt = 1; attempt <= 3 && activeNotes.length === 0 && !isSui; attempt += 1) {
        if (!live()) return;
        setStatusMessage('Syncing your private balance...');
        refreshNotes();
        refetchNotes();
        await new Promise((resolve) => setTimeout(resolve, 4000));
        if (!live()) return;
        const liveNotes = getCommittedManagers().noteManager?.getNotes() ?? notes;
        ({ matching: allMatchingNotes, owned: ownedNotes, active: activeNotes } = selectFrom(liveNotes));
      }

      setStatusMessage(`Found ${allMatchingNotes.length} total, ${ownedNotes.length} owned, ${activeNotes.length} active; checking spendability...`);
      if (isDebugEnabled) {
        console.log(`[PaymentTransfer] All notes: ${allMatchingNotes.length}, owned by ${truncateAddress(address)}: ${ownedNotes.length}, active: ${activeNotes.length}`);
        allMatchingNotes.forEach((n, i) => {
          console.log(`  [${i}] commitment=${truncateAddress(n.commitment)} status=${n.status} isOwned=${n.isOwned} owner=${n.ownerAddress ? truncateAddress(n.ownerAddress) : 'none'} txHash=${n.txHash ? truncateAddress(n.txHash) : 'none'} createdAtBlock=${n.createdAtBlock} spentAtBlock=${n.spentAtBlock}`);
        });
      }
      log('info', 'PaymentRequest', 'Matching notes summary', {
        total: allMatchingNotes.length,
        ownedCount: ownedNotes.length,
        activeCount: activeNotes.length,
      });

      if (activeNotes.length === 0) {
        const statusCounts = allMatchingNotes.reduce<Record<string, number>>((acc, note) => {
          acc[note.status] = (acc[note.status] ?? 0) + 1;
          return acc;
        }, {});
        const statusSummary = Object.entries(statusCounts)
          .map(([status, count]) => `${status}=${count}`)
          .join(', ');
        throw new Error(
          allMatchingNotes.length === 0
            ? 'No private balance found for this asset yet. If you just shielded or received funds, wait for the sync to finish and press Pay again.'
            : `No active notes available. Found ${allMatchingNotes.length} matching notes${statusSummary ? ` (${statusSummary})` : ''}.`,
        );
      }
      // Read the freshly committed managers, not the render-captured ones —
      // on the first attempt those are still stale right after ensureInitialized().
      const { noteManager: liveNoteManager, keystoreManager: liveKeystoreManager } = getCommittedManagers();
      if (!liveNoteManager) {
        throw new Error('Private note state is not available yet. Sync the pool and try again.');
      }
      if (!liveKeystoreManager) {
        throw new Error('Private spending keys are not available yet. Reconnect your wallet and try again.');
      }
      // The relayed path spends amount + fee from the selected inputs, so the
      // selection must target BOTH. Targeting the bare amount picks a note that
      // exactly covers the payment and leaves nothing for the fee, and the
      // transact then fails with "Insufficient value for transact:
      // available=0.001, requested=0.001493" while the account still holds a
      // larger note that would have covered it (QA 2026-08-19). The send flow
      // hit the same thing on 2026-08-17 and this mirrors its fix: a fresh
      // non-committal quote with 25% headroom for drift, falling back to the
      // bare amount so the relay-time guard states the real constraint rather
      // than the padded one failing opaquely here.
      //
      // What the 2026-08-19 fix got WRONG, and this replaces (QA 2026-08-27):
      // when amount + the PADDED fee was not covered it re-selected against the
      // BARE amount, on the stated theory that "the relay-time guard states the
      // real constraint". The SEND flow has such a guard
      // (transfer-modal-provider.tsx checks the binding quote against the
      // selected inputs before relaying). THIS FLOW HAD NONE. So the fallback
      // "covered" a 5.000000 note against a 5.000000 request, walked into
      // session.relayTransfer, and the SDK re-proved with the fee on top and
      // threw raw hex at the user:
      //   Insufficient value for transact: available=0x4c4b40,
      //   requested=0x00...004ca226        (5.000000 vs 5.022246 USDC)
      // A selection that provably cannot fund the transact never proceeds now.
      //
      // The ONLY remaining fallback is padded target -> UNPADDED amount + fee.
      // The pad is drift headroom and headroom must never be the thing that
      // refuses a payment the real fee would allow (that band is ~fee/4 wide).
      const requestAmountWei = BigInt(request.amount);
      let feeQuoteWei: bigint | null = null;
      try {
        feeQuoteWei = await fetchTransferFeeQuote(request.chainId, request.tokenId);
      } catch (feeErr) {
        log('warn', 'PaymentRequest', 'Could not price the relayer fee for input selection', {
          error: feeErr instanceof Error ? feeErr.message : String(feeErr),
        });
      }
      const feeBudget = feeQuoteWei != null ? feeQuoteWei + feeQuoteWei / 4n : 0n;
      const paddedTarget = requestAmountWei + feeBudget;
      const trueTarget = requestAmountWei + (feeQuoteWei ?? 0n);
      const spendabilityReport = await verifyTransferSpendability({
        notes: activeNotes,
        chainId: request.chainId,
        noteManager: liveNoteManager,
        keystoreManager: liveKeystoreManager,
        ownerAddress: address as Hex,
      });
      // Lineage cap: the transact emits one change note per input lineage plus
      // one recipient note per lineage (5-output circuit cap → ≤2 lineages),
      // AND the SDK requires one recipient slot per distinct input label
      // (resolveHashByLabel throws "Too few noteAddressHashes" otherwise).
      // SDK-native requests carry noteSecretsMap.length slots; the legacy v1/v2
      // paths build a single-slot map at pay time, so they must stay
      // single-lineage.
      const recipientSlotCount = request.kind === 'ppv2-sdk-payment-request'
        ? Math.max(1, request.noteSecretsMap.length)
        : 1;
      const maxLabels = Math.min(TRANSFER_MAX_LABELS, recipientSlotCount);
      // These inputs are spent now, so the selection also merges the spare
      // notes of the deposits it already uses.
      let selection = selectGreedyTransferInputs(
        spendabilityReport.spendableNotes,
        paddedTarget,
        TRANSFER_MAX_INPUTS,
        maxLabels,
        { sweepSelectedLabels: true },
      );
      if (!selection.covered && feeBudget > (feeQuoteWei ?? 0n)) {
        // Drop the 25% drift pad, NEVER the fee itself.
        selection = selectGreedyTransferInputs(
          spendabilityReport.spendableNotes,
          trueTarget,
          TRANSFER_MAX_INPUTS,
          maxLabels,
          { sweepSelectedLabels: true },
        );
      }
      log('info', 'PaymentRequest', 'Preflighted payment-request input spendability', {
        ...toTransferSpendabilityLog(spendabilityReport),
        selectedCount: selection.selectedNotes.length,
        covered: selection.covered,
        feeQuote: (feeQuoteWei ?? 0n).toString(),
        feeBudget: feeBudget.toString(),
        maxLabels,
      });
      if (!selection.covered) {
        const requestToken = getTokenMetadata(request.tokenId, request.chainId);
        // WHICH constraint bound? On a failed selection `selection.accumulated`
        // is the EXACT maximum coverable within both caps, so comparing it
        // against the lineage-blind maximum and the raw total separates "not
        // enough money" from "enough money, wrong lineage". They emit the same
        // SDK error and need OPPOSITE user actions (QA 2026-08-27): for the
        // lineage case "deposit a little more" is actively wrong advice.
        const reachable = selection.accumulated;
        const lineageBlind = maxCoverableTransfer(
          spendabilityReport.spendableNotes, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS,
        );
        const totalSpendable = spendabilityReport.spendableNotes
          .reduce((sum, n) => sum + BigInt(n.value), 0n);
        // What a SINGLE new deposit would have to hold to make this payable. A
        // new deposit is its own lineage, so it can pair with at most
        // maxLabels-1 of the existing ones -- compute that headroom and ask for
        // the rest. At maxLabels 1 there is no headroom and the answer is the
        // whole total (code review 2026-08-27).
        const pairableWithNewDeposit = maxLabels > 1
          ? maxCoverableTransfer(spendabilityReport.spendableNotes, TRANSFER_MAX_INPUTS, maxLabels - 1)
          : 0n;
        const singleDepositTopUp = trueTarget > pairableWithNewDeposit
          ? trueTarget - pairableWithNewDeposit
          : trueTarget;
        // Categories and ratios only, never absolute amounts (code review
        // 2026-08-27). The debug provider keeps its buffer even when debugging
        // is switched off and exports it verbatim, so anything logged here ends
        // up in a file users hand to support: the first version of this line
        // disclosed the payer's exact shielded holdings AND what they were
        // trying to pay. `boundBy` is the whole diagnostic value -- it says
        // which constraint refused the payment -- and it leaks nothing.
        log('warn', 'PaymentRequest', 'Payment cannot be funded within the caps', {
          boundBy: lineageBlind >= trueTarget
            ? 'single-lineage-cap'
            : totalSpendable >= trueTarget ? 'lineage-or-input-cap' : 'insufficient-value',
          feeQuoted: feeQuoteWei != null,
          spendableNoteCount: spendabilityReport.spendableNotes.length,
          maxLabels,
        });
        throw new Error(formatRelayedPaymentShortfall({
          requestedAmount: requestAmountWei,
          relayerFee: feeQuoteWei,
          reachableAmount: reachable,
          lineageBlindAmount: lineageBlind,
          totalSpendable,
          tokenSymbol: requestToken.symbol,
          decimals: requestToken.decimals,
          maxLabels,
          singleDepositTopUp,
        }));
      }
      // Account-level capacity, captured once so the pre-relay and retry
      // guards below can report the truth instead of re-describing this
      // selection as if it were the whole account (code review 2026-08-27).
      const capacityLineageBlind = maxCoverableTransfer(
        spendabilityReport.spendableNotes, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS,
      );
      const capacityTotalSpendable = spendabilityReport.spendableNotes
        .reduce((sum, n) => sum + BigInt(n.value), 0n);
      const capacityPairable = maxLabels > 1
        ? maxCoverableTransfer(spendabilityReport.spendableNotes, TRANSFER_MAX_INPUTS, maxLabels - 1)
        : 0n;
      // === Registration hand-off, AFTER the affordability preflight ===
      //
      // Ordering is deliberate (code review 2026-08-27). This used to run
      // BEFORE the note sync and spendability check above, so a payer who
      // could afford the registration but not registration + payment + relayer
      // fee paid the registration fee out of their shielded value and then
      // watched the automatically resumed payment fail for insufficient funds.
      // The fee is permanent; the payment never happens. Everything above this
      // point is read-only, so refusing up there costs the user nothing, and by
      // here we know the payment is actually fundable.
      // Private transfer is a transact — it requires the sender's keystore
      // AUTH POLICY to be on-chain so the auth-policy leaf exists for the
      // proof. That is the ONLY on-chain precondition for spending, and it is
      // exactly what isKeystoreRegistered() answers (SDK PoolSessionKeystore:
      // Keystore.nullifyingKeys[account] != 0).
      //
      // What this block must NOT do is gate on prepareRegisterKeystore()
      // (codex): that helper ALSO reads Keystore.viewingKeys[account] and
      // reports alreadyRegistered:false whenever the VIEWING key is unset, even
      // for an account whose auth policy is already registered. The viewing key
      // is a RECEIVING facility — the SDK reads the on-chain copy only to
      // resolve a recipient given by `evmAddress` (resolveDepositForParams /
      // resolveRecipientDiscovery), and the sender's own change notes are
      // encrypted with the LOCAL keystoreManager.getViewingKeyPair(), never the
      // on-chain one. None of this flow's three branches below take the
      // evmAddress branch (SDK-native forwards paymentPubKey, v2 carries
      // recipientViewingPubKey, v1 is a pre-blinded noteAddressHash), so the
      // payer's on-chain viewing key is irrelevant to this payment.
      //
      // Gating on it is what raised a wallet transaction on a RELAYED payment
      // (QA): every account registered through the gasless / cold-start path
      // (Keystore.setAuthPolicyWithSig via PrivacyPoolRelay.registerAndRelay —
      // hooks/use-gasless-registration.ts, hooks/use-note-import.ts, the
      // withdraw cold start) has an auth policy and NO viewing key, by
      // construction. Those are precisely the accounts with no native gas, so
      // the setViewingKey prompt could never succeed and came back on EVERY
      // press. A viewing key is registered where it is actually needed — the
      // registration modal's self-funded path still submits both legs.
      const isRegistered = await session.isKeystoreRegistered();
      if (!isRegistered) {
        if (identityMode === 'key') {
          throw new Error('This account key is not registered on-chain yet. Sign out of the account key and connect the owner wallet once to register, then retry from the account key.');
        }
        if (!walletAddress) {
          throw new Error('This account is not registered on-chain yet. Account-key sessions cannot register because registration is a wallet transaction. Connect the owning wallet once to register, then retry from the account key.');
        }
        // Hand off to the ONE registration surface rather than sending raw
        // calldata from here (codex): it is the only place that probes gasless
        // eligibility, prices the relayer fee, and TELLS the user what the
        // one-time on-chain step costs before any prompt. Inlining
        // sendTransactionAsync meant a "Pay via Private Transfer" press produced
        // an unexplained wallet transaction that is not the payment — and no
        // gasless option at all. Every other flow already hands off this way
        // (deposit, swap, ragequit, withdraw, header, my-privacy-pools).
        //
        // allowGasless stays TRUE — unlike deposit/ragequit, which turn it off
        // because their own operation still needs wallet gas. This payment is
        // relayed end to end via session.relayTransfer below, so a wallet with
        // no native currency can complete it: spending a slice of the shielded
        // balance on the relayer's registration fee unblocks a flow that then
        // actually works. Same reasoning the swap hand-off carries.
        if (!live()) { log('warn', 'Payment', 'Stale run aborted before registration handoff'); return; }
        log('info', 'PaymentRequest', 'Keystore not registered, prompting via modal');
        // Park this run BEFORE handing off: nothing is in flight while the
        // registration modal owns the screen, so the `finally` below must be
        // allowed to run endTx() and clear the busy state — hence `return`,
        // not `throw`.
        const resumeInline = inlineHubActiveRef.current;
        const handoffPath = pathnameRef.current;
        // Both callbacks must re-check this. live() alone is not enough: see
        // the pathnameRef note at its declaration.
        const stillOurs = () => live() && pathnameRef.current === handoffPath;
        if (!resumeInline) setIsOpen(false);
        openKeystoreRegistrationModal({
          title: 'Register before you pay privately',
          body:
            "Paying from your private balance needs a one-time on-chain record for your wallet. This is the registration, not the payment. The payment itself is relayed and costs you no gas. Once this confirms we'll continue with your payment automatically.",
          primaryLabel: 'Register and continue',
          onSuccess: () => {
            // The hand-off can outlive this run: the user may navigate away
            // from /pay, or another opener may resetState() (bumping the epoch
            // AND clearing inputPayload) while the registration modal owns the
            // screen. Resuming unconditionally then resurrected a modal the
            // user had left and re-entered the pay handler against whatever
            // inputPayload now held -- an empty string throws a parse error
            // into a modal nobody opened (code review 2026-08-27).
            if (!stillOurs()) {
              log('warn', 'Payment', 'Registration completed but the payment surface changed; not resuming', {
                navigatedAway: pathnameRef.current !== handoffPath,
              });
              return;
            }
            if (!resumeInline) setIsOpen(true);
            void handlePayViaTransferRef.current?.();
          },
          // "Not now" must bring the payment back instead of stranding it
          // hidden mid-flow (the same fix the deposit and withdraw hand-offs
          // carry — codex round 2 there).
          onCancel: () => {
            // Had NO check at all (code review 2026-08-27): cancelling after
            // navigating away resurrected the abandoned payment modal on an
            // unrelated page.
            if (!stillOurs()) {
              log('warn', 'Payment', 'Registration cancelled after the payment surface changed; not reopening');
              return;
            }
            if (!resumeInline) setIsOpen(true);
          },
        });
        return;
      }

      const selectedNotes = selection.selectedNotes;
      const accumulated = selection.accumulated;
      if (isDebugEnabled) {
        console.log('[PaymentTransfer] Selected notes:', selectedNotes.map((n) => truncateAddress(n.commitment)).join(', '));
      }
      {
        // In the request token's units, not raw base units: this line is user-
        // visible while notes are selected (audit, 2026-08-29).
        const meta = getTokenMetadata(request.tokenId, request.chainId);
        const fmt = (wei: bigint) => balanceDisplay(formatUnits(wei, meta.decimals), meta.symbol, request.chainId, request.tokenId).text;
        setStatusMessage(`Using ${selectedNotes.length} note(s) totalling ${fmt(accumulated)} (need ${fmt(trueTarget)})`);
      }
      // Debug-only, and still redacted because the debug provider keeps an
      // exportable in-memory log buffer.
      if (isDebugEnabled) {
        log('info', 'PaymentRequest', 'Selected input notes', {
          count: selectedNotes.length,
        });
      }
      const inputCommitments = selectedNotes.map((n) => n.commitment);
      const inputNote = selectedNotes[0];

      setStatusMessage('Generating ZK proof...');
      if (isDebugEnabled) {
        log('info', 'PaymentRequest', 'Planning private payment', {
          version: request.version,
          inputCount: inputCommitments.length,
          tokenId: request.tokenId,
        });
      }

      // A payment proves once, inside relayTransfer, against a quote requested
      // right before it. The recipient is resolved here the way prepareTransfer
      // and prepareFulfillPaymentRequest did. Three branches:
      //   - SDK-native (kind ppv2-sdk-payment-request): the request's own
      //     pre-committed noteAddressHashes, encrypted to its paymentPubKey and
      //     tagged with its tag, so the receiver's discoverNotes() picks the
      //     note up via scanPaymentRequests in O(1). Works whether or not the
      //     receiver is keystore-registered. A lapsed request is refused, as the
      //     SDK did on every prepare.
      //   - legacy v2: payload carries the recipient's `recipientViewingPubKey`,
      //     so a fresh noteSecret made here is encrypted to it directly. Going
      //     through `evmAddress` would force a keystore lookup and silently
      //     downgrade to out-of-band when the receiver isn't registered.
      //   - legacy v1: pre-blinded noteAddressHash + out-of-band receipt.
      //
      // SDK's `getNotesTokenId` does a strict string compare against the input
      // note's stored tokenId. Notes come out of scanCatchAll with whatever case
      // the on-chain Note payload carried (checksummed in the ASP event stream),
      // while `request.tokenId` is normalized to lowercase by
      // parsePaymentRequestPayload. Use the note's tokenId directly to avoid
      // `Input notes have tokenId 0xEeeee… but transact tokenId is 0xeeee…`.
      const payTokenId = (request.kind !== 'ppv2-sdk-payment-request'
        || inputNote.tokenId.toLowerCase() === request.tokenId.toLowerCase()
        ? inputNote.tokenId
        : request.tokenId) as SdkAddress;
      const recipientSpec: TransferRecipientSpec = request.kind === 'ppv2-sdk-payment-request'
        ? {
          kind: 'payment-request',
          // v2.0 migration: the public PaymentRequest carries only the
          // pre-committed noteAddressHashes (the sender never needs the
          // recipient's noteSecrets). The V3 payload's noteSecretsMap entries
          // are keyed by noteAddressHash, so the keys ARE the slot list.
          noteAddressHashes: request.noteSecretsMap.map(([noteAddressHash]) => noteAddressHash),
          paymentPubKey: request.paymentPubKey,
          tag: request.tag,
          ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
        }
        : request.version === 2
          ? { kind: 'viewing-key', evmAddress: request.recipientAddress as SdkAddress, publicViewingKey: request.recipientViewingPubKey }
          : { kind: 'blind', noteAddressHash: request.noteAddressHash };
      const recipientDeps = await loadTransferRecipientDeps(request.chainId);
      const builtRecipient = await buildTransferRecipient(recipientSpec, inputCommitments.length, recipientDeps);
      const outputsFor = (fee: bigint) => planTransferOutputs({
        inputNotes: selectedNotes,
        amount: requestAmountWei,
        fee,
        tokenId: payTokenId,
        recipient: builtRecipient.recipient,
        commitment: recipientDeps.commitment,
      });
      // Recipient outputs do not depend on the fee; the relay check holds each
      // proof (a stale-root retry included) to these.
      const plannedRecipient = outputsFor(0n).recipient;
      const recipientCommitment = plannedRecipient[0]?.commitment;
      const recipientLabel = plannedRecipient[0]?.label;
      // The relayed proof's first change output, read by the relay check
      // before the POST; change secrets are random, so no plan knows it.
      let changeCommitment: Hash | undefined;

      if (!publicClient) {
        throw new Error('Public client unavailable for transaction tracking.');
      }

      // Submit via the SDK's HTTPS relayer (same flow as withdrawals). The
      // relayer re-proves with the agreed-upon fee and submits on-chain
      // from its own wallet, so `caller` on the Transacted event is the
      // relayer — the sender's address stays off-chain.
      // Each relay gets a committed quote requested right before it, so its one
      // proof has the commitment's whole lifetime.
      const transferQuotes = relayerTransferQuotes(request.chainId);
      const freshRelayOption = async (): Promise<RelayTransferParams> => {
        const selectedQuote = await requestTransferQuote(transferQuotes, payTokenId);
        if (!selectedQuote) {
          throw new Error('No relayer quote available for this transfer.');
        }
        // PRE-RELAY FEE GUARD (QA 2026-08-27). session.relayTransfer proves
        // with totalSpent = amount + feeCommitment.feeAmount, so the fee only
        // becomes BINDING here, before the proof. Without this, the SDK throws InsufficientTransactValue with 32-byte hex
        // operands and the catch below toasted it verbatim. The send flow has
        // carried this exact guard since 2026-08-17
        // (transfer-modal-provider.tsx); this flow never did, which is what let
        // the 2026-08-19 bare-amount fallback reach a transact that provably
        // could not succeed. It also covers what the preflight cannot: the
        // non-committal quote timed out (feeQuoteWei null) or the fee drifted up
        // between the two quotes.
        const quotedRelayFee = transferRelayFee({ selectedQuote });
        if (requestAmountWei + quotedRelayFee > accumulated) {
          const requestToken = getTokenMetadata(request.tokenId, request.chainId);
          // Report the ACCOUNT's real capacity, not the selection (code review
          // 2026-08-27). Passing `accumulated` for all three made the message
          // claim the account holds only what this selection happened to gather,
          // so a payer with a larger eligible lineage elsewhere was told to add
          // funds they already had.
          throw new Error(formatRelayedPaymentShortfall({
            requestedAmount: requestAmountWei,
            relayerFee: quotedRelayFee,
            reachableAmount: accumulated,
            lineageBlindAmount: capacityLineageBlind,
            totalSpendable: capacityTotalSpendable,
            tokenSymbol: requestToken.symbol,
            decimals: requestToken.decimals,
            maxLabels,
            singleDepositTopUp: requestAmountWei + quotedRelayFee > capacityPairable
              ? requestAmountWei + quotedRelayFee - capacityPairable
              : requestAmountWei + quotedRelayFee,
          }));
        }
        return relayTransferParams({
          inputCommitments: inputCommitments as Hash[],
          amount: requestAmountWei,
          tokenId: payTokenId,
          built: builtRecipient,
          selectedQuote,
        });
      };
      // A run the user has left asks the relayer for nothing more.
      if (!live()) { log('warn', 'Payment', 'Stale run aborted before the relayer quote'); return; }
      setStatusMessage('Getting a fresh relayer quote...');
      // Whichever option is actually submitted (the first, or the retry below)
      // is the one whose fee was charged.
      let submittedOption = await freshRelayOption();
      log('info', 'PaymentRequest', 'Submitting transfer via SDK relayer', {
        relayer: submittedOption.selectedQuote.relayerInfo.name,
        processor: submittedOption.selectedQuote.relayerInfo.processorAddress,
      });
      // The status line comes AFTER the live() gate: set before it, a stale run
      // painted "Submitting via relayer..." into the next session and left it
      // there over live Pay buttons (DEV-486).
      if (!live()) { log('warn', 'Payment', 'Stale run aborted before broadcast'); return; }
      setStatusMessage('Submitting via relayer...');
      const paidRecordFor = (paidHash: Hash) => ({
        txHash: paidHash,
        recipient: request.recipientAddress ?? '',
        rawAmount: request.amount,
        tokenAddress: request.tokenId,
        chainId: request.chainId,
        // SDK-native payloads carry a paymentId, not a requestId - same role.
        requestId: request.kind === 'ppv2-sdk-payment-request' ? request.paymentId : request.requestId,
        timestamp: Date.now(),
        requestKind: (request.kind === 'ppv2-sdk-payment-request' ? 'sdk' : request.version === 2 ? 'v2' : 'v1') as 'v1' | 'v2' | 'sdk',
      });
      // DEV-486: the relayer's hash is heard as soon as it answers, before the
      // SDK's receipt wait, which is what tells a handed-over payment from one
      // the relayer never picked up.
      stopHearingRelay = onRelayedTxHash((heard, method) => {
        if (method !== 'relayTransfer') return;
        relayHeardHash = heard;
        if (payRequestKey) latchPayRelay(payRequestKey, true);
        if (live()) setPayPhase('handed-over');
      });
      // Bounded (DEV-486): an unanswered relay sat on "Submitting via
      // relayer..." for 10+ minutes. The deadline only stops the WAIT; the
      // relay keeps running, so a late answer is still recorded as paid.
      const relay = (option: RelayTransferParams) => {
        relayAttempted = true;
        // Latched from the moment the relay leaves, not only on failure: a press
        // while it is in flight must already see it.
        if (payRequestKey) latchPayRelay(payRequestKey, !!relayHeardHash);
        if (live()) setPayPhase('relaying');
        const outputPlan = outputsFor(transferRelayFee(option));
        const relayCheck = expectTransferRelay(transferRelayExpectation(option.selectedQuote, inputCommitments.length, outputPlan));
        const pending = session.relayTransfer(option).then((result) => {
          // The relay hook reads the proof before the POST, so a relay that
          // answered without its outputs means the hook did not run.
          if (!relayCheck.outputs()) log('warn', 'PaymentRequest', 'Relay check read no outputs; the change note is not matched');
          return result;
        }, (err: unknown) => {
          throw plainTransferRelayError(err);
        }).finally(() => {
          changeCommitment = relayCheck.outputs()?.[0] ?? changeCommitment;
          relayCheck.release();
        });
        return withRelayDeadline(pending).catch((err) => {
          if (err instanceof PayRelayDeadlineError) {
            void pending.then((late) => {
              const lateHash = (late as { txReceipt?: { txHash?: string; status?: unknown } } | undefined)?.txReceipt;
              if (!lateHash?.txHash || lateHash.status === false) return;
              log('warn', 'PaymentRequest', 'Relay answered after the deadline; recording the payment', { txHash: lateHash.txHash });
              const lateRecord = paidRecordFor(lateHash.txHash as Hash);
              // A legacy v1 payment also needs what rebuilds its receipt, the
              // same fields the normal success path records below.
              recordPaidRequest(request.kind !== 'ppv2-sdk-payment-request' && request.version !== 2
                ? {
                  ...lateRecord,
                  noteAddressHash: request.noteAddressHash,
                  commitment: (recipientCommitment ?? '0x0') as string,
                  label: (recipientLabel ?? '0x0') as string,
                }
                : lateRecord);
              if (payRequestKey) releasePayRelay(payRequestKey);
              setLastPaid({
                requestKey: request.kind === 'ppv2-sdk-payment-request' ? request.paymentId : request.requestId,
                txHash: lateHash.txHash,
                hadReceipt: request.kind !== 'ppv2-sdk-payment-request' && request.version !== 2,
                chainId: request.chainId,
              });
            }, () => { /* a late failure leaves the latch to expire */ });
          }
          throw err;
        });
      };
      /*
       * PoolVault requires the proof's associationSetRoot to EQUAL the
       * registry's latest root, and that root keeps no history, so any deposit
       * approved between building the proof and the relayer's simulation makes
       * it revert with PoolVault_InvalidASPRoot. A CI run hit exactly that
       * (2026-08-19). The withdrawal path has re-proved once since 844f0a8;
       * paying a request had no such recovery and simply failed.
       *
       * Retrying is safe: the rejection comes from the relayer's eth_call, so
       * nothing was broadcast and no note is marked spent.
       */
      let transferResult;
      try {
        transferResult = await relay(submittedOption);
      } catch (relayErr) {
        const relayMessage = relayErr instanceof Error ? relayErr.message : String(relayErr);
        if (!/InvalidASPRoot/i.test(relayMessage)) throw relayErr;
        // The relayer refused this one in its own simulation, so nothing was
        // sent: until the retry relays, a failure is a plain one, not unknown.
        relayAttempted = false;
        if (payRequestKey) releasePayRelay(payRequestKey);
        if (!live()) { log('warn', 'Payment', 'Stale run aborted before the retry quote'); return; }
        log('warn', 'PaymentRequest', 'Association-set root rotated mid-flight; re-proving once', { relayMessage });
        setStatusMessage('The approval set just updated. Re-proving your payment...');
        // relayTransfer re-reads and verifies the association-set leaves on
        // every proof, so the same recipient with a fresh quote is the retry. The
        // fee guard runs again inside freshRelayOption: this is the path where
        // the fee is most likely to have drifted up.
        submittedOption = await freshRelayOption();
        if (!live()) { log('warn', 'Payment', 'Stale run aborted before the retry relay'); return; }
        setStatusMessage('Submitting via relayer...');
        transferResult = await relay(submittedOption);
      }
      const hash = transferResult.txReceipt.txHash as Hash;
      setTxHash(hash);
      setTxChainId(request.chainId);
      // The two steps either side of this line are the only ones that can hang
      // for minutes (the relay call and then the chain), and the flow used to
      // report neither: a stall here was indistinguishable from a stall there.
      log('info', 'PaymentRequest', 'Relay tx submitted', { txHash: hash });
      setStatusMessage('Waiting for the transaction to confirm...');

      // PRIVACY: RELAYED transfer. Confirm from bulk chain data rather than
      // polling this client's RPC for the relayer's tx hash, which would
      // identify this IP as the payer. Exact match on our input nullifiers.
      // No observation means submitted-unconfirmed, never success. See
      // services/onchain-note-index.ts and docs/privacy-request-discipline.md.
      // A receipt the SDK itself saw as REVERTED is the only outcome that means
      // the notes were not spent, so it is the only one that may end the flow
      // before the payment is recorded.
      const sdkStatus = (transferResult as { txReceipt?: { status?: unknown } } | undefined)?.txReceipt?.status;
      if (sdkStatus === false) {
        throw new Error('Transaction reverted on-chain. Your notes were NOT spent.');
      }
      // ORDER IS LOAD-BEARING: record the payment BEFORE confirming it.
      //
      // The relayer accepted the transaction and returned a hash, so the money
      // is already moving. Confirmation only decides what we TELL the user. An
      // earlier revision confirmed first and threw on "not observed yet", which
      // skipped the stamping below: the payment landed on-chain, the balance
      // dropped, and no paid-request record and no sent row existed — an
      // invisible payment, exactly the report we are chasing (Mike, 2026-08-26).
      // Never move a throw above this stamp.
      const paidViaTransfer = paidRecordFor(hash);
      recordPaidRequest(paidViaTransfer);
      // Recorded: from here a throw is bookkeeping, not an unknown outcome, and
      // the request no longer needs the latch (the paid card takes over).
      paymentRecorded = true;
      if (payRequestKey) releasePayRelay(payRequestKey);
      // The relayer fee was debited ON TOP of the request amount, so without
      // this the payer's history row understates what left their balance. Own
      // try/catch, and strictly AFTER recordPaidRequest, so it can never cost
      // us the payment record itself.
      try {
        const quotedFee = transferRelayFee(submittedOption);
        if (quotedFee > 0n) {
          recordWithdrawFee({
            txHash: hash,
            feeAmount: `0x${quotedFee.toString(16)}`,
            tokenAddress: request.tokenId,
            chainId: request.chainId,
            timestamp: Date.now(),
            kind: 'transfer',
          });
        }
      } catch (e) {
        log('warn', 'PaymentRequest', 'Failed to stamp relayer-fee record', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
      setLastPaid({
        requestKey: request.kind === 'ppv2-sdk-payment-request' ? request.paymentId : request.requestId,
        txHash: hash,
        hadReceipt: request.kind !== 'ppv2-sdk-payment-request' && request.version !== 2,
        // The chain the payment EXECUTED on, not the one selected later.
        chainId: request.chainId,
      });
      if (request.kind === 'ppv2-sdk-payment-request') {
        // SDK-native: the on-chain Note event is tagged with
        // `request.tag` and the ciphertext is encrypted to the per-
        // request paymentPubKey. The recipient's PaymentRequestService
        // already holds the matching paymentPrivKey, so the next
        // discoverNotes() call runs scanPaymentRequests, decrypts, and
        // marks the request fulfilled — no receipt hand-off, no main
        // viewing key required, no keystore registration required.
        setOutputPayload('');
        setReceiveLink(null);
        setStatusMessage('Private transfer sent via relay. The recipient will discover the note automatically on their next sync. No receipt link is needed for this payment.');
        setWarningMessage(null);
      } else if (request.version === 2) {
        // Discoverable: recipient finds the note via `scanCatchAll`, no
        // receipt hand-off needed.
        setOutputPayload('');
        setReceiveLink(null);
        setStatusMessage('Private transfer sent via relay. The recipient will discover the note automatically on their next sync.');
        setWarningMessage(null);
      } else {
        const receiptPayload: PaymentReceiptPayload = {
          kind: 'ppv2-payment-receipt',
          version: 1,
          requestId: request.requestId,
          chainId: request.chainId,
          recipientAddress: request.recipientAddress,
          tokenId: request.tokenId,
          amount: request.amount,
          noteAddressHash: request.noteAddressHash,
          commitment: (recipientCommitment ?? '0x0') as Hex,
          label: (recipientLabel ?? '0x0') as Hex,
          txHash: hash,
          createdAt: new Date().toISOString(),
        };
        setOutputPayload(JSON.stringify(receiptPayload, null, 2));
        if (canUseBrowserApis()) {
          setReceiveLink(`${shareLinkBase()}/receive#${encodePaymentReceiptPayloadForUrl(receiptPayload)}`);
        }
        recordPaidRequest({
          ...paidViaTransfer,
          noteAddressHash: request.noteAddressHash,
          commitment: (recipientCommitment ?? '0x0') as string,
          label: (recipientLabel ?? '0x0') as string,
        });
        setStatusMessage('Private transfer payment sent via relay. Share the receipt with the recipient.');
        setWarningMessage('The recipient still needs their local request payload to reconstruct the note secret.');
      }

      // Bulk confirmation runs HERE, after the payment is recorded, and only
      // decides what the user is told. Privacy: matched against our own input
      // nullifiers in bulk chain data, never by polling the relayer's tx hash
      // (that poll would identify this IP as the payer). See
      // services/onchain-note-index.ts and docs/privacy-request-discipline.md.
      try {
        const { confirmRelayedSpend } = await import('@/services/onchain-note-index');
        const reqChainConfig = getChainConfig(request.chainId);
        if (reqChainConfig?.contracts?.poolAddress) {
          const { observed } = await confirmRelayedSpend({
            chainId: request.chainId,
            poolAddress: String(reqChainConfig.contracts.poolAddress),
            fromBlock: reqChainConfig.contracts.fromBlock,
            inputCommitments: inputCommitments as Hash[],
            outputCommitments: [recipientCommitment, changeCommitment].filter((c): c is Hash => !!c),
            privateNullifyingKey: liveKeystoreManager.getPrivateNullifyingKey(),
          });
          const observedTx = observed?.txHash?.toLowerCase() ?? null;
          if (observed && observedTx && observedTx !== hash.toLowerCase()) {
            // Our inputs were consumed by a different transaction (another
            // device or a replacement). The payment is recorded against the
            // hash the relayer gave us; say so rather than claiming success.
            log('warn', 'PaymentRequest', 'Inputs spent by a different transaction than this payment submitted', {
              submittedTxHash: hash, observedTxHash: observed.txHash,
            });
            setWarningMessage(`Your notes were spent by transaction ${observed.txHash}, not by the one this payment submitted. Check your activity before paying again.`);
          } else if (!observed && sdkStatus !== true) {
            setWarningMessage('The payment is submitted but not visible on-chain yet. It will settle in your activity shortly; do not pay again.');
          }
          log('info', 'PaymentRequest', 'Payment confirmation outcome', {
            txHash: hash,
            via: observed ? 'bulk-observation' : (sdkStatus === true ? 'sdk-receipt' : 'unconfirmed'),
            observedTxHash: observed?.txHash ?? null,
            outputsMatch: observed?.outputsMatch ?? null,
          });
        }
      } catch (confirmErr) {
        // A confirmation failure must never undo a recorded payment.
        log('warn', 'PaymentRequest', 'Could not confirm the payment from bulk data; the payment stays recorded', confirmErr);
      }

      // The SDK's finalizeTransfer already added the change note to the internal
      // NoteManager (with ACTIVE status, correct noteSecret, and
      // parent-commitment link), and marked the input note SPENT. Persist
      // the updated SDK state to local storage so the note survives reload.
      // Not re-imported: importAccount runs a full-range discovery pass, and
      // one timed to this relayed payment would tie this client to it. The
      // grid's discovery confirms the rest.
      await exportAccount();
      refreshNotes();
      refetchNotes();
      // Confirmed write → refresh shared tx/stats caches (codex round 1, P1).
      void invalidateTransactionCaches(queryClient);
    } catch (error) {
      // Stale runs must not repaint a reset/reopened modal (codex).
      const rawMsg = error instanceof Error ? error.message : 'Failed to pay via private transfer.';
      // Raw SDK throws must never reach the toast (QA 2026-08-27): this flow
      // printed `Insufficient value for transact: available=0x4c4b40,
      // requested=0x...4ca226` straight at the user. The guards above should
      // make it unreachable; this is what makes "never" true.
      // The request-specific wording first; every other SDK figure through the
      // structured amounts, in the paid asset, rather than as base units.
      // The SDK's own refusal (prepareFulfillPaymentRequest) gets the same copy
      // as the gate above, not its long internal sentence.
      const isExpired = error instanceof Error
        && (error.name === 'PaymentRequestExpired' || /^Payment request expired at /.test(error.message));
      const emsg = (isExpired ? PAYMENT_REQUEST_EXPIRED_MESSAGE : null)
        ?? (payToken ? translateSdkTransactError(rawMsg, payToken) : null)
        ?? (knownPayUnits
          ? sdkErrorText(error, { input: knownPayUnits, swapInput: knownPayUnits }, rawMsg)
          : rawMsg);
      // Toast, not banner (QA): viem failures dump multi-line internals — the
      // first line is the human sentence. Switch-and-retry guidance is not an
      // error, so it keeps the default variant.
      // A relay that was handed over and did not provably fail may still land.
      // Latch the request whatever the screen shows now, so neither this
      // modal nor the /pay page can start a second payment beside it (DEV-486).
      const unknownOutcome = !paymentRecorded && isPayRelayIndeterminate(rawMsg, relayAttempted);
      if (payRequestKey) {
        if (unknownOutcome) latchPayRelay(payRequestKey, !!relayHeardHash);
        else if (relayAttempted) releasePayRelay(payRequestKey);
      }
      if (live()) {
        // The rail and its status line end with the run; a stale "Submitting
        // via relayer..." over live Pay buttons read as a payment in flight.
        // A recorded payment keeps its success line.
        if (!paymentRecorded) setStatusMessage(null);
        if (unknownOutcome) {
          setWarningMessage(payRelayUnknownMessage(!!relayHeardHash));
        } else if (!/Superseded/.test(emsg)) {
          const title = emsg.split('\n')[0];
          toast(/Press Pay again/.test(emsg) ? { title } : { title, variant: 'destructive' });
          if (/Press Pay again/.test(emsg)) setStatusMessage(title);
          else setErrorMessage(title);
        }
      }
    } finally {
      stopHearingRelay?.();
      endTx();
      setIsBusy(false);
      setBusyAction(null);
      setPayPhase('idle');
    }
    // toast / queryClient / gateOnLockedSession are all called inside this
    // callback and were missing; the sibling wallet-pay handler's list was
    // corrected for the same three (code review 2026-08-27).
  }, [address, walletAddress, walletChainId, chainId, ensureInitialized, exportAccount, gateOnLockedSession, identityMode, inputPayload, isDebugEnabled, keystoreManager, log, noteManager, notes, openKeystoreRegistrationModal, publicClient, queryClient, refetchNotes, refreshNotes, switchChainAsync, toast, beginTx, endTx, isSui, suiSession, selectChain]);

  // Same-tick double-press guard (shared lock) — see hooks/use-op-lock.ts.
  const handlePayViaTransfer = useMemo(() => withOpLock(handlePayViaTransferUnlocked), [withOpLock, handlePayViaTransferUnlocked]);
  const handlePayViaTransferRef = useRef<typeof handlePayViaTransfer | null>(null);
  handlePayViaTransferRef.current = handlePayViaTransfer;

  // Auto-fire the picked action when the modal was opened from
  // /pay/[encoded] (user already clicked "Pay via Wallet" or "Pay via
  // Private Transfer" on the page — re-prompting them with the same
  // buttons inside the modal is just an extra click). Clear the flag
  // up-front so the effect can't re-fire on its own dependency
  // changes; the user can still hit the buttons manually if the
  // first run errored (e.g. wallet not connected).
  useEffect(() => {
    if (!isOpen || mode !== 'pay' || !pendingAutoAction || !inputPayload || isBusy) return;
    // Alignment gate (codex P1-7): the open requested a chain switch; firing
    // before it commits made the handler's switch-and-stop consume this
    // one-shot just to say "press Pay again". Wait for the selection to land —
    // the deps re-run this effect when it does. Targets this build can't
    // align to (unsupported chainId) fire ungated so the handler surfaces its
    // honest unsupported-chain error instead of hanging silently.
    if (pendingAutoTarget !== null) {
      const alignable = pendingAutoTarget.kind === 'sui' || isSupportedEvmChainId(pendingAutoTarget.chainId);
      const aligned = pendingAutoTarget.kind === 'sui'
        ? isSui
        : !isSui && chainId === pendingAutoTarget.chainId;
      if (alignable && !aligned) return;
    }
    const action = pendingAutoAction;
    setPendingAutoAction(null);
    setPendingAutoTarget(null);
    // The pressed action is the action that runs. This used to reroute a
    // 'wallet' intent to handlePayViaTransfer for SDK-native requests, because
    // depositFor emitted a hint the recipient could not discover. The deposit
    // now carries the request tag (services/payment-request-deposit.ts), so the
    // premise is gone.
    //
    // Silently substituting handlers was the worse half of that bug: pressing
    // "Pay via Wallet" started the private-transfer flow, so a payer with no
    // shielded balance watched the OTHER button say "Processing..." and then
    // got "No private balance found for this asset yet" — an error about funds
    // they were deliberately not spending (Pat, on Sepolia, 2026-08-28). If an
    // action is ever unavailable again, refuse it by name; do not run a
    // different one.
    if (action === 'wallet') {
      void handlePayRequest();
    } else {
      void handlePayViaTransfer();
    }
  }, [isOpen, mode, pendingAutoAction, pendingAutoTarget, isSui, chainId, inputPayload, isBusy, handlePayRequest, handlePayViaTransfer]);

  const handleReceivePaymentUnlocked = useCallback(async () => {
    // === Sui path === import a Sui receipt: reconstruct the note, verify its
    // commitment reconstructs from the receipt fields, and persist it to the
    // Sui note store as spendable. Branched by payload KIND, not the active
    // selection — an EVM /receive link keeps working while Sui is active, and
    // a Sui receipt needs only a connected Sui wallet (pure crypto + local
    // store), not the Sui selection.
    const suiReceiptPayload = parseSuiPaymentPayload(inputPayload);
    if (suiReceiptPayload?.kind === 'ppv2-sui-payment-receipt') {
      const suiAddr = suiSession.account?.address;
      if (!suiAddr) { setErrorMessage('Connect your Sui wallet first.'); return; }
      setIsBusy(true); setStatusMessage(null); setWarningMessage(null); setErrorMessage(null);
      try {
        const rc = suiReceiptPayload as unknown as { note: Record<string, string> };
        const n = rc.note;
        if (!n || typeof n !== 'object') throw new Error('Malformed Sui payment receipt: missing note.');
        const { addressToU256, calculateNoteAddressHash, calculateNoteCommitment } = await import('@/services/sui-witness');
        if (BigInt(n.ownerAddress) !== addressToU256(suiAddr)) {
          throw new Error('This receipt is addressed to a different Sui account.');
        }
        const nAH = await calculateNoteAddressHash(BigInt(n.ownerAddress), BigInt(n.noteSecret));
        const rebuilt = await calculateNoteCommitment(nAH, BigInt(n.tokenId), BigInt(n.value), 0n, BigInt(n.label));
        if (rebuilt !== BigInt(n.commitment)) throw new Error('Receipt commitment does not reconstruct. Refusing to import.');
        // Existence check — a self-consistent receipt can still be a forgery
        // that no pool transaction ever inserted; refuse (or, on a transient
        // RPC failure, ask to retry) rather than store a phantom balance.
        const contracts = getChainConfig(SUI_TESTNET_ID)?.suiContracts;
        if (!contracts) throw new Error('Sui deployment not configured.');
        const [{ SuiChainReader }, { verifySuiNoteOnChain }] = await Promise.all([
          import('@/services/sui-witness/chain-reader'),
          import('@/services/sui-witness/note-receipt'),
        ]);
        const reader = new SuiChainReader({
          client: suiClient,
          packageId: contracts.packageId,
          poolId: contracts.poolObjectId,
        });
        await verifySuiNoteOnChain(reader, { commitment: n.commitment });
        const { upsertSuiNote } = await import('@/services/sui-witness/note-store');
        upsertSuiNote(suiAddr, {
          commitment: n.commitment, value: n.value, tokenId: n.tokenId, label: n.label,
          noteSecret: n.noteSecret, ownerAddress: n.ownerAddress, coinType: n.coinType ?? '0x2::sui::SUI',
          status: 'active', txDigest: n.txDigest,
        });
        suiSession.notes?.refetch?.();
        setStatusMessage(`Imported ${(Number(BigInt(n.value)) / 1e9).toFixed(4)} SUI. It now shows in your balance.`);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to import the Sui receipt.');
      } finally {
        setIsBusy(false);
      }
      return;
    }

    if (!address) {
      setErrorMessage('Connect your wallet first.');
      return;
    }

    setIsBusy(true);
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);

    try {
      const receipt = (() => {
        try {
          return parsePaymentReceiptPayload(inputPayload);
        } catch {
          return decodePaymentReceiptPayloadFromUrl(inputPayload.trim());
        }
      })();
      const storedRequest = findStoredPaymentRequest({
        requestId: receipt.requestId,
        noteAddressHash: receipt.noteAddressHash,
      });

      if (!storedRequest) {
        throw new Error('No matching local payment request found for this receipt.');
      }

      if (storedRequest.recipientAddress.toLowerCase() !== address.toLowerCase()) {
        throw new Error(`This payment belongs to ${storedRequest.recipientAddress}, not the connected wallet.`);
      }
      if (receipt.recipientAddress.toLowerCase() !== storedRequest.recipientAddress.toLowerCase()) {
        throw new Error('Receipt recipient does not match the stored payment request.');
      }
      if (receipt.noteAddressHash.toLowerCase() !== storedRequest.noteAddressHash.toLowerCase()) {
        throw new Error('Receipt note address hash does not match the stored payment request.');
      }

      const chainConfig = getChainConfig(receipt.chainId);
      if (!chainConfig?.contracts?.poolAddress) {
        throw new Error(`Missing pool configuration for chain ${receipt.chainId}.`);
      }

      const {
        createASPClient,
        createHashService,
        createMerkleService,
        createPoolVaultInteractor,
        createRPCInteractor,
      } = await import('@/services/sdk-runtime');
      const hashService = await createHashService();
      const merkleService = createMerkleService(hashService);
      const aspClient = await createASPClient(receipt.chainId, merkleService);
      const rpcInteractor = createRPCInteractor(receipt.chainId, Number(chainConfig.contracts.fromBlock));
      const poolVaultInteractor = createPoolVaultInteractor(
        rpcInteractor,
        chainConfig.contracts.poolAddress as Hex,
        hashService,
        chainConfig.contracts.fromBlock,
      );

      // PRIVACY: bulk index rather than a targeted commitments() read. The
      // receipt's commitment was created by the payer; querying it directly
      // links this (payee) client to the payer's transaction.
      // A note the index has not seen yet is NOT imported as a normal note: a
      // `createdAtBlock 0x0` row is unspendable until healed and is the exact
      // shape the phantom purge deletes. The payee retries once indexed.
      const { createOnChainNoteIndex } = await import('@/services/onchain-note-index');
      const noteIndex = createOnChainNoteIndex({
        chainId: receipt.chainId,
        poolVaultInteractor: poolVaultInteractor as never,
        hashService: hashService as never,
        poolAddress: chainConfig.contracts.poolAddress,
      });
      await noteIndex.refresh();
      if (!noteIndex.hasCommitment(receipt.commitment)) {
        throw new Error('This payment is not visible on-chain yet. Wait a minute and open the receipt again.');
      }
      // Present but its timestamp did not verify against a state leaf yet: a
      // normal note needs the exact timestamp to spend, and a 0x0 row is the
      // purge shape. Retry rather than import something unspendable.
      const createdAtBlock = noteIndex.commitmentTimestamp(receipt.commitment);
      if (!createdAtBlock) {
        throw new Error('This payment is on-chain but not fully indexed yet. Wait a minute and open the receipt again.');
      }
      const labelHash = hashService.hash([receipt.label]);
      let noteStatus: NoteStatus = 'PENDING' as NoteStatus;
      try {
        await aspClient.getMerkleProof(labelHash);
        noteStatus = 'ACTIVE' as NoteStatus;
      } catch {
        noteStatus = 'PENDING' as NoteStatus;
      }

      const note: Note = {
        commitment: receipt.commitment,
        value: receipt.amount,
        tokenId: receipt.tokenId,
        label: receipt.label,
        status: noteStatus,
        ownerAddress: address as Hex,
        noteSecret: storedRequest.noteSecret,
        isOwned: true,
        createdAtBlock,
        spentAtBlock: null,
        txHash: receipt.txHash,
        parentCommitmentHash: null,
      };

      const tokenMetadata = getTokenMetadata(receipt.tokenId, receipt.chainId);
      // Gate the LIVE-session merge on the SESSION's chain, not the app
      // selection (`chainId` above): the live session binds connector-first
      // (useSessionChainId), so with a wallet on supported chain A and the
      // selection on B, a chain-B receipt gated on the selection would be
      // importAccount()ed into the chain-A session and re-persisted under A —
      // the exact wrong-bucket confusion the session hook exists to prevent.
      // The storage writes below are keyed on receipt.chainId either way.
      const currentExport = sessionChainId === receipt.chainId
        ? ((await exportAccount()) ?? loadStoredAccountExport(address, receipt.chainId))
        : loadStoredAccountExport(address, receipt.chainId);
      const merged = mergeImportedNote(currentExport, note);
      saveStoredAccountExport(merged, address, receipt.chainId);
      if (poolSession && sessionChainId === receipt.chainId) {
        await importAccount(merged);
      } else {
        refreshNotes();
      }

      // The claim consumed the legacy record — purge it so its plaintext
      // noteSecret stops living in localStorage (the imported NOTE now carries
      // the secret through the normal note lifecycle instead).
      removeStoredPaymentRequest(storedRequest.requestId);
      bumpPaymentRequestRevision();

      setStatusMessage(`Received payment imported as ${balanceDisplay(formatUnits(BigInt(receipt.amount), tokenMetadata.decimals), tokenMetadata.symbol, receipt.chainId, receipt.tokenId).text}.`);
      setOutputPayload(JSON.stringify(note, null, 2));
      // Offer the on-chain claim: until anchored, this note exists only in
      // this browser's storage. Bind it to the receipt's chain + recipient.
      setReceivedNote({ note, chainId: receipt.chainId, owner: receipt.recipientAddress });
      log('info', 'PaymentRequest', 'Imported received payment note', {
        requestId: receipt.requestId,
        commitment: receipt.commitment,
        createdAtBlock,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to receive payment.');
    } finally {
      setIsBusy(false);
    }
  }, [address, chainId, exportAccount, importAccount, inputPayload, log, poolSession, refreshNotes, suiSession, suiClient]);

  // Same-tick double-press guard (shared lock) — see hooks/use-op-lock.ts.
  const handleReceivePayment = useMemo(() => withOpLock(handleReceivePaymentUnlocked), [withOpLock, handleReceivePaymentUnlocked]);

  const previewRequest = useMemo(() => {
    if (mode !== 'pay' || !inputPayload.trim()) return null;
    try {
      return parsePaymentRequestPayload(inputPayload);
    } catch {
      return null;
    }
  }, [inputPayload, mode]);

  const previewEncodedRequest = useMemo(() => {
    if (mode !== 'pay' || !inputPayload.trim()) return null;
    try {
      return decodePaymentRequestPayloadFromUrl(inputPayload.trim());
    } catch {
      return null;
    }
  }, [inputPayload, mode]);

  const previewPayRequest = previewRequest ?? previewEncodedRequest;
  const previewPayKey = previewPayRequest
    ? (previewPayRequest.kind === 'ppv2-sdk-payment-request' ? previewPayRequest.paymentId : previewPayRequest.requestId)
    : null;
  // The tick is the latch store's change signal; read so the memo follows it.
  const previewRelayLatch = useMemo(
    () => (payRelayLatchTick >= 0 ? payRelayLatch(previewPayKey) : null),
    [previewPayKey, payRelayLatchTick],
  );
  // A latch lapses by time, which no store event announces: re-read it then,
  // or the Pay buttons stay disabled past the window.
  const relayLatchUntil = previewRelayLatch?.until ?? null;
  useEffect(() => {
    if (relayLatchUntil === null) return;
    const timer = setTimeout(() => setPayRelayLatchTick((n) => n + 1), Math.max(0, relayLatchUntil - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [relayLatchUntil]);
  // DEV-486: while a payment runs, the rail IS the screen. The request card,
  // status box and buttons stacked above it read as a form you could press.
  const payRunning = mode === 'pay' && busyAction !== null;
  // Past the SDK deadline the link carries: both Pay buttons go off. The
  // handlers refuse it regardless (assertPaymentRequestPayable).
  const previewPayExpired = usePaymentRequestExpired(mode === 'pay' ? previewPayRequest : null);
  // Same decision the wallet handler enforces (DEV-422).
  const previewWalletRefusal = useMemo(
    () => (previewPayRequest ? requestWalletRefusalFor(previewPayRequest) : null),
    [previewPayRequest],
  );

  useEffect(() => {
    let cancelled = false;
    if (mode !== 'pay' || !isSignablePaymentRequest(previewPayRequest) || !previewPayRequest.signature) {
      setRequestSignatureStatus('unsigned');
      return;
    }
    setRequestSignatureStatus('checking');
    verifyPaymentRequestSignature(previewPayRequest)
      .then((valid) => {
        if (!cancelled) setRequestSignatureStatus(valid ? 'valid' : 'invalid');
      })
      .catch(() => {
        if (!cancelled) setRequestSignatureStatus('invalid');
      });
    return () => {
      cancelled = true;
    };
  }, [mode, previewPayRequest]);

  useEffect(() => {
    let cancelled = false;
    const signer = isSignablePaymentRequest(previewPayRequest)
      ? previewPayRequest.signature?.signer
      : null;
    setVerifiedSignerEnsName(null);
    if (!signer) return;
    resolveEnsName(signer).then((name) => {
      if (!cancelled) setVerifiedSignerEnsName(name);
    });
    return () => {
      cancelled = true;
    };
  }, [previewPayRequest]);

  const previewRequestToken = useMemo(
    // Any environment's registry, never a guessed 18 decimals (DEV-484).
    () => (previewPayRequest ? linkToken(previewPayRequest.tokenId, previewPayRequest.chainId) : null),
    [previewPayRequest],
  );

  const previewReceipt = useMemo(() => {
    if (mode !== 'receive' || !inputPayload.trim()) return null;
    try {
      return parsePaymentReceiptPayload(inputPayload);
    } catch {
      try {
        return decodePaymentReceiptPayloadFromUrl(inputPayload.trim());
      } catch {
        return null;
      }
    }
  }, [inputPayload, mode]);

  const previewReceiptToken = useMemo(
    () => (previewReceipt ? linkToken(previewReceipt.tokenId, previewReceipt.chainId) : null),
    [previewReceipt],
  );

  const modalChainName = useMemo(() => {
    if (mode === 'pay' && previewPayRequest) return getChainConfig(previewPayRequest.chainId)?.displayName ?? `Chain ${previewPayRequest.chainId}`;
    if (mode === 'receive' && previewReceipt) return getChainConfig(previewReceipt.chainId)?.displayName ?? `Chain ${previewReceipt.chainId}`;
    // Request creation is selection-driven: a Sui request is made on Sui, not
    // on the wagmi (EVM) chain. ("Sui" — the preview subtitle appends "testnet".)
    if (mode === 'request' && isSui) return 'Sui';
    if (mode === 'request' && isStellar) return 'Stellar';
    return getChainConfig(chainId)?.displayName ?? `Chain ${chainId}`;
  }, [chainId, mode, previewPayRequest, previewReceipt, isSui, isStellar]);

  // (The old `previewSender` memo fed the card's sender field — decorative
  // invoice chrome the card never rendered. Every signature state it described
  // is still reported: the verified wallet gets its own row, and unsigned /
  // failed / checking are spelled out in the card notice.)

  const verifiedWalletLabel = useMemo(() => {
    if (mode !== 'pay' || !isSignablePaymentRequest(previewPayRequest)) return undefined;
    const signer = previewPayRequest.signature?.signer;
    if (!signer || requestSignatureStatus !== 'valid') return undefined;
    return verifiedSignerEnsName
      ? `${verifiedSignerEnsName} (${truncateAddress(signer)})`
      : truncateAddress(signer);
  }, [mode, previewPayRequest, requestSignatureStatus, verifiedSignerEnsName]);

  const verifiedWalletUrl = useMemo(() => {
    if (mode !== 'pay' || !isSignablePaymentRequest(previewPayRequest)) return undefined;
    const signer = previewPayRequest.signature?.signer;
    if (!signer || requestSignatureStatus !== 'valid') return undefined;
    return getExplorerAddressUrl(previewPayRequest.chainId, signer);
  }, [mode, previewPayRequest, requestSignatureStatus]);

  // Full signer address for the copy control next to the verified label.
  const verifiedWalletSigner = useMemo(() => {
    if (mode !== 'pay' || !isSignablePaymentRequest(previewPayRequest)) return undefined;
    const signer = previewPayRequest.signature?.signer;
    return signer && requestSignatureStatus === 'valid' ? signer : undefined;
  }, [mode, previewPayRequest, requestSignatureStatus]);

  const previewCardProps = useMemo(() => {
    if (mode === 'request') {
      // No typed amount yet → no total. The input's own placeholder already
      // suggests a figure; printing one as the "Total" invented an invoice.
      // FROZEN label once created; live draft label before that.
      const amountLabel = outputPayload && createdDraft
        ? createdDraft.amountLabel
        : amountInput.trim() ? balanceDisplay(amountInput.trim(), requestTokenSymbol, chainId).text : '—';
      // Parsed once (it drives the code row).
      const createdRequest = outputPayload
        ? (() => {
            try {
              return JSON.parse(outputPayload) as {
                kind?: string;
                version?: number;
                paymentId?: string;
                requestId?: string;
              };
            } catch {
              return null;
            }
          })()
        : null;
      const createdRequestId = createdRequest?.paymentId ?? createdRequest?.requestId;
      return {
        amountLabel,
        amountHint: outputPayload && createdDraft ? createdDraft.amountHint : balanceDisplay(amountInput || '0', requestTokenSymbol, chainId).hint,
        // Real code or nothing — no "Awaiting request" filler row.
        requestCode: createdRequestId ? formatRequestCode(createdRequestId) : undefined,
        status: outputPayload ? { label: 'Ready', color: colors.success } : undefined,
        // No explainer on the card at all: a key-recoverable request has no
        // risk worth a notice, and an at-risk (legacy v1) one gets exactly ONE
        // warning — the "Keep this link" box beside the pay link below.
        noticeTitle: '',
        noticeBody: '',
      };
    }

    if (mode === 'pay') {
      // Nothing pasted yet → no total (a sample figure would read as the
      // amount this request is actually asking for).
      const amountLabel = previewPayRequest && previewRequestToken
        ? (previewRequestToken.known ? balanceDisplay(formatUnits(BigInt(previewPayRequest.amount), previewRequestToken.decimals), previewRequestToken.symbol, previewPayRequest.chainId, previewPayRequest.tokenId).text : previewRequestToken.label)
        : '—';
      const payRequestId = previewPayRequest?.kind === 'ppv2-sdk-payment-request'
        ? previewPayRequest.paymentId
        : previewPayRequest?.requestId;
      return {
        amountLabel,
        amountHint: previewPayRequest && previewRequestToken?.known ? balanceDisplay(formatUnits(BigInt(previewPayRequest.amount), previewRequestToken.decimals), previewRequestToken.symbol, previewPayRequest.chainId, previewPayRequest.tokenId).hint : null,
        requestCode: payRequestId ? formatRequestCode(payRequestId) : undefined,
        status: {
          label: txHash ? 'Paid' : previewPayExpired ? 'Expired' : previewPayRequest ? 'Awaiting payment' : 'Paste request',
          color: txHash ? colors.success : colors.textMuted,
        },
        verifiedWalletLabel,
        verifiedWalletUrl,
        noticeTitle: txHash
          ? 'Payment sent'
          : previewPayExpired && requestSignatureStatus !== 'invalid' ? 'Request expired' : 'Double-blind payment',
        // The receipt-sharing instruction is ONLY true for legacy v1 payments
        // (receiveLink present). SDK-native and v2 payments auto-discover and
        // produce NO receipt - telling every payer to "share the receipt" sent
        // Mike hunting for a link that never existed (QA 2026-08-25).
        noticeBody: txHash
          ? (receiveLink
            ? 'The payment was sent on-chain. Share the receipt payload with the recipient so they can reconstruct and import the note.'
            : 'The payment was sent on-chain. The recipient discovers it automatically on their next sync. No receipt link is needed.')
          : previewPayExpired && requestSignatureStatus !== 'invalid'
            ? PAYMENT_REQUEST_EXPIRED_MESSAGE
          : isSignablePaymentRequest(previewPayRequest) && previewPayRequest.signature
            ? requestSignatureStatus === 'valid'
              ? 'Verified wallet signature: these payment details were signed by the sender wallet shown above.'
              : requestSignatureStatus === 'invalid'
                ? 'Signature failed: these payment details may have been changed. Ask the sender for a fresh link.'
                : 'Checking the sender wallet signature...'
            : 'Unsigned request. You can still pay it, but the app cannot prove who created the link.',
      };
    }

    const amountLabel = previewReceipt && previewReceiptToken
      ? (previewReceiptToken.known ? balanceDisplay(formatUnits(BigInt(previewReceipt.amount), previewReceiptToken.decimals), previewReceiptToken.symbol, previewReceipt.chainId, previewReceipt.tokenId).text : previewReceiptToken.label)
      : '—';
    return {
      amountLabel,
      amountHint: previewReceipt && previewReceiptToken?.known ? balanceDisplay(formatUnits(BigInt(previewReceipt.amount), previewReceiptToken.decimals), previewReceiptToken.symbol, previewReceipt.chainId, previewReceipt.tokenId).hint : null,
      requestCode: previewReceipt?.requestId ? formatRequestCode(previewReceipt.requestId) : undefined,
      status: {
        label: outputPayload ? 'Imported' : previewReceipt ? 'Ready to import' : 'Paste receipt',
        color: outputPayload ? colors.success : colors.textMuted,
      },
      noticeTitle: outputPayload ? 'Payment imported' : 'Receive on this device',
      noticeBody: outputPayload
        ? 'The note has been merged into local account storage and will appear in your pool balances on this device.'
        : 'Paste the receipt payload that matches a local request from this device. The stored note secret is required to reconstruct the note.',
    };
    // `requestSignatureStatus` is read directly by the pay-mode notice now that
    // the (unrendered) sender field it used to arrive through is gone.
  }, [amountInput, colors.success, createdDraft, colors.textMuted, mode, outputPayload, previewPayExpired, previewPayRequest, previewReceipt, previewReceiptToken, previewRequestToken, requestSignatureStatus, requestTokenSymbol, txHash, verifiedWalletLabel, verifiedWalletUrl, balanceDisplay, chainId, receiveLink]);

  // One status surface at a time (DEV-496): the rail while a payment runs,
  // the success card after it, the box only otherwise.
  const statusBoxHidden = payStatusBoxHidden({ mode, isBusy, pendingAutoAction, txHash });

  return (
    <PaymentRequestModalContext.Provider
      value={{ openRequestPaymentModal, openPayRequestModal, openPayViaTransferModal, openReceivePaymentModal, closePaymentRequestModal, isOpen, inlineActive: isOpen && inlineHubActive, requestToken, requestAmount: amountInput, requestCreated: !!outputPayload, syncInlineRequestForm, isBusy, busyAction, mode, lastPaid, payRelayLatchFor: payRelayLatch }}
    >
      {children}
      <RequestShell inline={inlineHubActive} isOpen={isOpen} isMobileSheet={isMobileSheet} onClose={closePaymentRequestModal}>
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && !inlineHubActive && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
            {!inlineHubActive && (
            <View className="flex-row items-start justify-between gap-[12px]">
              <View className="flex-1 items-center gap-[4px]">
                <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PRIVACY POOLS V2</Text>
                <Text className="text-center font-pp-sans-bold text-[20px] text-text">
                  {mode === 'request' ? 'Payment Request' : mode === 'pay' ? 'Pay Request' : 'Receive Payment'}
                </Text>
                <Text className="text-center font-pp-regular text-[12px] text-text-secondary">
                  {mode === 'request'
                    ? 'Generate a link to request money privately'
                    : address
                      ? (
                        <>
                          Wallet {truncateAddress(address)}
                          <CopyIconButton value={address} />
                          {` on ${modalChainName}`}
                        </>
                      )
                      : 'Connect your wallet to use this flow.'}
                </Text>
              </View>
              {/* Dim + disable mirrors the close guard in
                  closePaymentRequestModal, which warns on the first press and
                  closes on the second.
                  NOT `disabled` (code review 2026-08-27): disabling it made the
                  handler's escape hatch unreachable through the only two
                  controls a web user has, so an unanswered wallet prompt --
                  which never settles, because viem's injected transport has no
                  timeout -- trapped them in the modal with no way out but a
                  reload. The handler is the guard; this control must stay
                  pressable so the second press can reach it. */}
              <Pressable
                className="h-[32px] w-[32px] items-center justify-center rounded-control border border-border-light"
                onPress={closePaymentRequestModal}
              >
                {/* nw-keep(data-color): close glyph color is the text theme token into the vector-icon sink */}
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>
            )}

            {/* The rail below carries the status while a payment runs (DEV-486),
                and the success card after it (DEV-496). */}
            {statusMessage && !payRunning && !statusBoxHidden ? (
              <View className="rounded-control border border-[#98B975] bg-[#F5FAEE] px-[12px] py-[10px]">
                <Text className="font-pp-regular text-[13px] text-[#6E8A42]">{statusMessage}</Text>
              </View>
            ) : null}
            {warningMessage ? (
              <View className="rounded-control border border-[#E1C26B] bg-[#FFF9E8] px-[12px] py-[10px]">
                <Text className="font-pp-regular text-[13px] text-[#8A6B1F]">{warningMessage}</Text>
              </View>
            ) : null}
            {errorMessage ? (
              <View className="rounded-control border border-[#F2B8B5] bg-[#FFF4F4] px-[12px] py-[10px]">
                <Text className="font-pp-regular text-[13px] text-danger">{errorMessage}</Text>
              </View>
            ) : null}

            <ScrollView className="flex-1" contentContainerClassName="gap-[16px] justify-start pb-[4px]">
              {(!inlineHubActive || !!previewCardProps.requestCode) && !payRunning && (
              <PaymentPreviewCard
                amountLabel={previewCardProps.amountLabel}
                amountHint={previewCardProps.amountHint}
                requestCode={previewCardProps.requestCode}
                status={previewCardProps.status}
                verifiedWalletLabel={previewCardProps.verifiedWalletLabel}
                verifiedWalletUrl={previewCardProps.verifiedWalletUrl}
                verifiedWalletAddress={verifiedWalletSigner}
                noticeTitle={previewCardProps.noticeTitle}
                noticeBody={previewCardProps.noticeBody}
              />
              )}

              {mode === 'request' ? (
                <>
                  {/* Inline pre-creation: the explainer the hub tab used to
                      carry fills the zone with real content instead of the
                      dead preview card. */}
                  {inlineHubActive && !outputPayload ? (
                    <View className="gap-[8px] rounded-control bg-background-secondary px-[16px] py-[22px]">
                      <Text className="font-pp-sans-semi-bold text-[17px] text-text">Get paid without an address</Text>
                      <Text className="font-pp-sans text-[13px] leading-[19px] text-text-secondary">
                        Create a payment request and share the link. The payer never learns your balance; you never expose your history.
                      </Text>
                    </View>
                  ) : null}
                  {/* Inline (hub) the asset is picked by the amount card's token
                      pill, which writes straight into this provider — one
                      control, and it cannot name an asset the payload will not
                      carry. Every NON-inline surface (pool pages, the re-issue
                      button, ?modal=request, native) has no hub to borrow that
                      pill from, so it keeps these chips. */}
                  {!inlineHubActive ? (<>
                  <Text className="font-pp-semi-bold text-[12px] text-text-secondary">Token</Text>
                  <View className="flex-row flex-wrap gap-[8px]">
                    {isSui || isStellar ? (
                      // Sui / Stellar requests are always for the native asset
                      // (SUI / XLM): offering the EVM token list would
                      // mislabel what the request emits.
                      <View className="flex-row items-center gap-[6px] rounded-control border border-text bg-card-background px-[12px] py-[8px]">
                        <Text className="font-pp-medium text-[13px] text-text">{requestTokenSymbol}</Text>
                      </View>
                    ) : (
                      requestableTokens.map((token) => {
                        return (
                          <Pressable
                            key={token.address}
                            className={`flex-row items-center gap-[6px] rounded-control border bg-card-background px-[12px] py-[8px] ${selectedTokenAddress === token.address ? 'border-text' : 'border-border-light'}`}
                            onPress={() => {
                              setSelectedTokenAddress(token.address);
                              // Re-clamp the typed amount to the new token's precision (QA-3 follow-up).
                              const nextDecimals = getTokenMetadata(token.address, chainId).decimals;
                              setAmountInput((a) => sanitizeAmountInput(a, nextDecimals));
                            }}
                          >
                            <TokenMark symbol={token.symbol} size={16} />
                            <Text className="font-pp-medium text-[13px] text-text">{poolDisplayLabel(token.symbol, chainId)}</Text>
                          </Pressable>
                        );
                      })
                    )}
                  </View>
                  </>) : null}
                  {/* The editable half of the form hides once a request is
                      created. The card above already states token/amount, and
                      Done (or switching the token) brings the form back. */}
                  {!outputPayload && (<>
                  {/* Same split as the token: inline, the hub's amount card owns
                      the figure and pushes it here. */}
                  {!inlineHubActive ? (<>
                  <Text className="font-pp-semi-bold text-[12px] text-text-secondary">Amount ({requestTokenSymbol})</Text>
                  <TextInput
                    value={amountInput}
                    onChangeText={(text) => setAmountInput(sanitizeAmountInput(text, requestTokenDecimals))}
                    placeholder={`${!isSui && isStablecoin(selectedToken.symbol) ? '5' : '0.01'} ${requestTokenSymbol}`}
                    // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                    placeholderTextColor={colors.textMuted}
                    keyboardType="numeric"
                    className="rounded-control border border-border-light px-[12px] py-[10px] font-pp-regular text-[14px] text-text"
                  />
                  {isShareSymbol(requestTokenSymbol) ? <Text className="text-[12px] text-text-secondary">Estimated value</Text> : null}
                  <BalanceAmount view={balanceDisplay(amountInput || '0', requestTokenSymbol, chainId)} className="text-[12px] text-text-secondary" />
                  </>) : null}
                  {!isSui && !isStellar && canSignPaymentRequest ? (
                    /* One compact line: toggle + (when on) the display-name
                       input. Checking it makes the connected wallet sign the
                       request so the payer can verify who created it. */
                    <View className="flex-row flex-wrap items-center gap-[10px] rounded-control border border-border-light px-[12px] py-[8px]">
                      <Pressable className="flex-row items-center gap-[8px]" onPress={() => setShouldSignRequest((value) => !value)}>
                        {/* `borderLight` is ~invisible against the card in dark
                            mode (#2A2D33 on #24272C). Use the higher-contrast
                            `border` for the unchecked box. */}
                        <View className={`h-[18px] w-[18px] items-center justify-center rounded-control border ${shouldSignRequest ? 'border-text bg-text' : 'border-border bg-transparent'}`}>
                          {/* nw-keep(data-color): checkmark glyph color is the card-background theme token into the vector-icon sink */}
                          {shouldSignRequest ? <Ionicons name="checkmark" size={12} color={colors.cardBackground} /> : null}
                        </View>
                        <Text className="font-pp-semi-bold text-[13px] text-text">Display your name</Text>
                      </Pressable>
                      {/* Always mounted so the row (and the modal) never changes
                          height when toggled. Just hidden and inert while off. */}
                      <TextInput
                        value={sellerName}
                        onChangeText={setSellerName}
                        placeholder="Display name (optional)"
                        // Unbounded free text here becomes an unbounded string on
                        // the payer's screen. Capped to match the pay page's
                        // SELLER_NAME_MAX so what is typed is what is shown.
                        maxLength={32}
                        // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                        placeholderTextColor={colors.textMuted}
                        editable={shouldSignRequest}
                        pointerEvents={shouldSignRequest ? 'auto' : 'none'}
                        className={`min-w-[140px] flex-1 rounded-control border border-border-light px-[10px] py-[7px] font-pp-regular text-[13px] text-text ${shouldSignRequest ? 'opacity-100' : 'opacity-0'}`}
                      />
                      {/* TODO native/later: separate identity-wallet signing
                          without changing the PPV2 account. */}
                    </View>
                  ) : null}
                  <Pressable
                    className={inlineHubActive
                      ? 'w-full items-center justify-center rounded-inner py-[16px] bg-button-primary active:bg-button-primary-pressed'
                      : 'items-center justify-center rounded-control bg-button-primary px-[16px] py-[14px]'}
                    // nw-keep(platform-css): inline mode pins the CTA to the zone bottom (runtime auto margin)
                    style={inlineHubActive ? { marginTop: 'auto', marginBottom: 27 } : undefined}
                    onPress={handleCreateRequest}
                    disabled={isBusy}
                  >
                    <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">
                      {isBusy ? 'Creating...' : 'Create Request'}
                    </Text>
                  </Pressable>
                  </>)}
                </>
              ) : (
                <>
                  {(mode === 'pay' && previewPayRequest) || (mode === 'receive' && previewReceipt) ? null : (
                    <TextInput
                      multiline
                      autoCapitalize="none"
                      autoCorrect={false}
                      value={inputPayload}
                      onChangeText={setInputPayload}
                      placeholder={mode === 'pay' ? 'Paste the payment request or pay link here' : 'Paste the payment receipt here'}
                      // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                      placeholderTextColor={colors.textMuted}
                      className="min-h-[160px] rounded-control border border-border-light px-[12px] py-[10px] font-pp-regular text-[13px] text-text"
                      // nw-keep(platform-css): textAlignVertical is not css-interop-compatible — the [textAlignVertical:top] arbitrary class compiles to nothing on native, dropping the multiline top-align
                      style={{ textAlignVertical: 'top' }}
                    />
                  )}
                  {mode === 'pay' && previewPayRequest && !payRunning ? (
                    <View className="gap-[6px] rounded-control border border-border-light p-[12px]">
                      {/* Request code lives in the card above — not repeated here. */}
                      {/* Accurate again: the share link no longer carries
                          recipientAddress at all (2026-08-31). */}
                      <Text className="font-pp-regular text-[12px] text-text">Recipient: hidden (double-blind)</Text>
                      <Text className="font-pp-regular text-[12px] text-text">Token: {previewRequestToken ? (previewRequestToken.known ? poolDisplayLabel(previewRequestToken.symbol, previewPayRequest.chainId) : previewRequestToken.label) : previewPayRequest.tokenId}</Text>
                      <Text className="font-pp-regular text-[12px] text-text">
                        Amount: {previewRequestToken ? (previewRequestToken.known ? balanceDisplay(formatUnits(BigInt(previewPayRequest.amount), previewRequestToken.decimals), previewRequestToken.symbol, previewPayRequest.chainId, previewPayRequest.tokenId).text : previewRequestToken.label) : previewPayRequest.amount}
                      </Text>
                    </View>
                  ) : null}
                  {mode === 'receive' && previewReceipt ? (
                    <View className="gap-[6px] rounded-control border border-border-light p-[12px]">
                      <Text className="font-pp-regular text-[12px] text-text">Request: {previewReceipt.requestId}</Text>
                      <Text className="font-pp-regular text-[12px] text-text">
                        Amount: {previewReceiptToken ? (previewReceiptToken.known ? balanceDisplay(formatUnits(BigInt(previewReceipt.amount), previewReceiptToken.decimals), previewReceiptToken.symbol, previewReceipt.chainId, previewReceipt.tokenId).text : previewReceiptToken.label) : previewReceipt.amount}
                      </Text>
                      <Text className="font-pp-regular text-[12px] text-text">
                        Commitment: {truncateAddress(previewReceipt.commitment)}
                        <CopyIconButton value={previewReceipt.commitment} />
                      </Text>
                      <Text className="font-pp-regular text-[12px] text-text">
                        Tx: {truncateAddress(previewReceipt.txHash)}
                        <CopyIconButton value={previewReceipt.txHash} />
                      </Text>
                    </View>
                  ) : null}
                  {mode === 'pay' && txHash ? (
                    // TERMINAL paid state. The form used to come back fully
                    // interactive after the confirmation (isBusy cleared in
                    // finally), which read as "the form reset" and left a live
                    // Pay button one press away from paying the same request
                    // twice (Mike, QA 2026-08-25; codex confirmed the same).
                    <View className="w-full items-center gap-[6px] rounded-control border border-border bg-background-secondary px-[16px] py-[14px]">
                      <Text className="font-pp-semi-bold text-[13px] text-success">Payment sent ✓</Text>
                      <Text className="text-center font-pp-regular text-[12px] text-text-secondary">
                        {/* The handler's own line (the box above it is hidden
                            now, DEV-496), minus the "Payment sent" this card
                            already says. */}
                        {receiveLink
                          ? 'Copy the receipt link above and send it to the recipient.'
                          : paySuccessDetail(statusMessage, 'The recipient discovers this payment automatically. No receipt link is needed.')}
                      </Text>
                    </View>
                  ) : mode === 'pay' ? (
                    <View className="w-full gap-[10px]">
                      {previewRelayLatch && !payRunning ? (
                        <Text className="font-pp-regular text-[12px] leading-[17px] text-warning">{payRelayUnknownMessage(previewRelayLatch.heard)}</Text>
                      ) : null}
                      {payRunning ? null : (<>
                      <Pressable
                        // requestSignatureStatus === 'invalid' means the seal
                        // over recipient+key failed — a tampered link. The
                        // handler refuses it regardless, but a live button
                        // invites the click; disable it. 'unsigned'/'valid' stay
                        // payable.
                        // The dim MIRRORS `disabled`, nothing else (QA
                        // 2026-08-26). It used to key off `busyAction ===
                        // 'wallet'` -- the OTHER button's run -- so pressing Pay
                        // via Wallet dimmed THIS button and left the pressed
                        // one at full opacity: the disabled control looked live
                        // and the live-looking one was disabled. Same rule as
                        // the Claim button below, as app/pay/[encoded].tsx:369
                        // and as withdraw-modal-provider.tsx: opacity-50 means
                        // "you cannot press this", never "this one is running".
                        // WHICH one is running is the label's job.
                        className={`w-full items-center justify-center rounded-control bg-button-primary px-[16px] py-[14px] ${isBusy || requestSignatureStatus === 'invalid' || !!previewRelayLatch || previewPayExpired ? 'opacity-50' : 'opacity-100'}`}
                        onPress={handlePayViaTransfer}
                        disabled={isBusy || requestSignatureStatus === 'invalid' || !!previewRelayLatch || previewPayExpired}
                      >
                        <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">
                          {busyAction === 'transfer' ? 'Processing...' : 'Pay via Private Transfer'}
                        </Text>
                      </Pressable>
                      {/* SDK-native is no longer excluded here: the handler now
                          builds a tag-carrying deposit (services/payment-request-deposit.ts),
                          so wallet-pay works for every request kind. Still gated
                          on a connected wallet, which is what signs the deposit. */}
                      {!walletAddress ? null : previewWalletRefusal ? (
                        <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">{previewWalletRefusal}</Text>
                      ) : (
                        <Pressable
                          // Same tampered-signature gate — this is the button
                          // the bug left live. Handler is the real guard.
                          // Dim mirrors `disabled`; see the sibling above.
                          className={`w-full items-center justify-center rounded-control bg-button-primary px-[16px] py-[14px] ${isBusy || requestSignatureStatus === 'invalid' || !!previewRelayLatch || previewPayExpired ? 'opacity-50' : 'opacity-100'}`}
                          onPress={handlePayRequest}
                          disabled={isBusy || requestSignatureStatus === 'invalid' || !!previewRelayLatch || previewPayExpired}
                        >
                          <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">
                            {busyAction === 'wallet' ? 'Processing...' : 'Pay via Wallet'}
                          </Text>
                        </Pressable>
                      )}
                      </>)}
                      {/* Staged progress, the same rail every other flow uses
                          (deposit, withdraw, transfer, keystore-registration,
                          import-note). Paying via private transfer spends tens
                          of seconds inside prepareTransfer with nothing on
                          screen but a one-line banner above the fold, so users
                          pressed again out of uncertainty (QA 2026-08-26). It
                          reads the SAME statusMessage the handlers already set
                          ('Generating ZK proof...', 'Submitting via
                          relayer...', 'Waiting for the transaction to
                          confirm...') — one source of truth, and no invented
                          percentage: the SDK exposes no proving progress
                          callback, so honest stages are the best signal. */}
                      {/* Also while the action is ARMED but not yet started
                          (QA 2026-08-27). A /pay open sets pendingAutoAction
                          and the auto-fire effect holds it behind the
                          chain-alignment gate until the wallet's network
                          switch commits -- seconds, or forever if the prompt
                          is ignored -- and even after it fires, the handler
                          doesn't reach setIsBusy(true) for a while. Keyed on
                          isBusy alone the card sat blank through all of it.
                          Deliberately NOT added to the buttons' `disabled`:
                          pendingAutoAction has no guaranteed clear when a
                          switch prompt is simply ignored, and pressing Pay is
                          the escape hatch -- the handler clears the armed
                          intent and runs its switch-and-stop. Never gate
                          `disabled` on a flag that can fail to clear. */}
                      {isBusy || pendingAutoAction ? <FlowProgress message={statusMessage ?? undefined} /> : null}
                    </View>
                  ) : receivedNote ? (
                    /* Claim flow: the import above was DEVICE-LOCAL. Anchoring
                       (viewing-key registration + self-transfer) makes the
                       payment recoverable from any browser or wallet. The
                       claim binds to the LIVE wagmi session, so it stays
                       disabled until chain + owner match the receipt (and is
                       hidden for key sessions, which cannot sign the
                       registration. Same rule as the import-note page). */
                    (() => {
                      const pendingApproval = receivedNote.note.status === ('PENDING' as NoteStatus);
                      const wrongChain = chainId !== receivedNote.chainId;
                      const wrongOwner = !walletAddress || walletAddress.toLowerCase() !== receivedNote.owner.toLowerCase();
                      const keyMode = identityMode === 'key';
                      // Order matters: disconnected users must get the
                      // connect-the-recipient copy, not key-session copy.
                      const blocked = (!walletAddress || identityMode === null)
                        ? `Connect ${receivedNote.owner.slice(0, 6)}…${receivedNote.owner.slice(-4)} (the receipt's recipient) to claim.`
                        : keyMode
                          ? 'Claiming needs the owner wallet. Sign out of the account-key session and connect it.'
                          : wrongChain
                            ? `Switch your wallet to chain ${receivedNote.chainId} to claim this payment.`
                            : wrongOwner
                              ? `Connect ${receivedNote.owner.slice(0, 6)}…${receivedNote.owner.slice(-4)} (the receipt's recipient) to claim.`
                              : pendingApproval
                                ? 'This payment is still pending approval. Re-import the receipt once approved to claim it on-chain.'
                                : null;
                      return (
                    <View className="w-full gap-[10px]">
                      <View className="gap-[4px] rounded-control bg-warning-bg px-[12px] py-[10px]">
                        <Text className="font-pp-semi-bold text-[12px] text-warning">Saved to this browser only</Text>
                        <Text className="font-pp-regular text-[12px] leading-[17px] text-warning">
                          Imported payments are transient. They won't survive a different browser or wallet unless claimed on-chain.
                        </Text>
                      </View>
                      {keyMode ? null : (
                        <Pressable
                          className={`w-full items-center justify-center rounded-control bg-button-primary px-[16px] py-[14px] ${(claimBusy || blocked) ? 'opacity-50' : ''}`}
                          onPress={() => { if (!blocked) claimOnChain(receivedNote.note); }}
                          disabled={claimBusy || claimStatus === 'anchored' || !!blocked}
                        >
                          <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">
                            {claimStatus === 'anchoring'
                              ? (claimStatusMessage || 'Claiming…')
                              : claimStatus === 'anchored' ? 'Claimed on-chain ✓' : 'Claim on-chain'}
                          </Text>
                        </Pressable>
                      )}
                      {/* Anchoring proves and submits — same rail, same reason
                          as the pay buttons above, and the same shape the other
                          two claim surfaces use. The button label alone carried
                          the whole story and vanished the moment anything else
                          touched `status`. */}
                      {claimStatus === 'anchoring' ? (
                        <FlowProgress message={claimStatusMessage} />
                      ) : null}
                      {claimStatus === 'anchored' ? (
                        <Text className="font-pp-regular text-[12px] text-success">
                          Claimed. This payment is anchored on-chain and recoverable from any device.
                        </Text>
                      ) : blocked ? (
                        <Text className="font-pp-regular text-[12px] text-text-secondary">{blocked}</Text>
                      ) : claimError ? (
                        <Text className="font-pp-regular text-[12px] text-danger">{claimError}</Text>
                      ) : null}
                    </View>
                      );
                    })()
                  ) : (
                    <View className="w-full gap-[10px]">
                      <View className="gap-[4px] rounded-control bg-warning-bg px-[12px] py-[10px]">
                        <Text className="font-pp-regular text-[12px] leading-[17px] text-warning">
                          Importing saves the payment to this browser only. Claim it on-chain after the import to make it recoverable anywhere.
                        </Text>
                      </View>
                      <Pressable
                        // Dim mirrors `disabled` -- this button was disabled
                        // while busy but never dimmed, so it read as live.
                        className={`w-full items-center justify-center rounded-control bg-button-primary px-[16px] py-[14px] ${isBusy ? 'opacity-50' : 'opacity-100'}`}
                        onPress={handleReceivePayment}
                        disabled={isBusy}
                      >
                        <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">
                          {isBusy ? 'Processing...' : 'Receive Payment'}
                        </Text>
                      </Pressable>
                      {isBusy ? <FlowProgress message={statusMessage ?? undefined} /> : null}
                    </View>
                  )}
                </>
              )}

              {mode === 'request' && payLink ? (
                <>
                  {/* The request is created but nothing has happened yet: it
                      only becomes a payment once this link reaches someone.
                      Say the next step outright rather than leaving a link box
                      to be inferred (Pat, 2026-08-28). */}
                  <Text className="font-pp-semi-bold text-[13px] text-text">
                    Send this link to get paid
                  </Text>
                  {backupFileText ? (
                    /* The seller chose not to register, so this file is the
                       only way the request survives this browser. It used to
                       be a sentence pointing at a button under More; now the
                       button is here, and its handler is synchronous so the
                       press still counts as a gesture. */
                    <View className="w-full gap-[8px] rounded-control border border-accent p-[12px]">
                      <Text className="font-pp-regular text-[12px] leading-[17px] text-text-secondary">
                        {backupSaved
                          ? 'Backup downloaded. Keep it: it restores this request in any browser you sign into with this wallet.'
                          : 'This request lives in this browser only. Save the backup or a cleared browser loses the payment.'}
                      </Text>
                      {/* Once the file is on disk the same button again is just
                          noise (Pat, 2026-08-31), so the saved state keeps only
                          a quiet way to fetch another copy. The full-width
                          button belongs to the case that still needs doing. */}
                      <Pressable
                        onPress={() => {
                          if (stellarBackupRef.current) {
                            void saveStellarBackupWithProof(backupFileText).then((result) => {
                              if (result === 'cancelled') return;
                              const ok = result !== 'failed';
                              setBackupSaved(ok);
                              if (ok) { setBackupUrgent(false); toast({ title: BACKUP_SAVED_TOAST }); }
                              else toast({ title: 'Your browser refused the download. Check its download settings.', variant: 'destructive' });
                            });
                            return;
                          }
                          const text = backupFileText;
                          const owner = backupOwnerRef.current;
                          const settle = (ok: boolean) => {
                            setBackupSaved(ok);
                            if (ok) { setBackupUrgent(false); toast({ title: BACKUP_SAVED_TOAST }); }
                            else toast({ title: 'Your browser refused the download. Check its download settings.', variant: 'destructive' });
                          };
                          // No way to confirm a save here: the plain download,
                          // synchronously, while the press still counts.
                          if (!canProveBackupSave()) { settle(saveBackupFile(text)); return; }
                          // A confirmed save is the only proof that lets
                          // sign-out purge this request.
                          void (async () => {
                            const saved = await saveBackupWithProof(text, `privacy-pools-request-backup-${(owner ?? '').toLowerCase()}.json`);
                            if (saved === 'cancelled') return;
                            if (saved === 'saved') void notePaymentRequestBackupDelivered(owner, text);
                            settle(saved === 'saved' || saveBackupFile(text));
                          })();
                        }}
                        accessibilityRole="button"
                        testID="request-backup-download"
                        className={backupSaved
                          ? 'self-start py-[2px]'
                          : 'items-center justify-center rounded-control border border-border px-[16px] py-[10px]'}
                      >
                        <Text className={backupSaved
                          ? 'font-pp-regular text-[12px] text-text-secondary underline'
                          : 'font-pp-semi-bold text-[13px] text-text'}>
                          {backupSaved ? 'Download again' : 'Download backup'}
                        </Text>
                      </Pressable>
                    </View>
                  ) : backupUrgent ? (
                    <Text className="font-pp-regular text-[12px] leading-[17px] text-text-secondary">
                      This request lives in this browser only. Save the backup under More so a cleared browser cannot lose the payment.
                    </Text>
                  ) : null}
                  <Text className="font-pp-semi-bold text-[12px] text-text-secondary">
                    Shareable pay link
                  </Text>
                  {/* Focusing the field copies it: reaching for a link input is
                      already the "I want this link" gesture (Pat, 2026-08-28).
                      The copy icon sits INSIDE the field at the end (Pat,
                      2026-08-31) — the affordance a link box is expected to
                      carry, and the only visible one on a device with no
                      pointer to focus with. Both call the same handler, so
                      either one marks the links secured. */}
                  <View
                    className={`w-full flex-row items-center gap-[8px] rounded-control border px-[12px] ${copiedPayLink ? 'border-accent' : 'border-border-light'}`}
                  >
                    <TextInput
                      editable={false}
                      selectTextOnFocus
                      value={payLink}
                      onFocus={() => { void handleCopyPayLink(); }}
                      className="min-w-0 flex-1 py-[10px] font-pp-regular text-[14px] text-text"
                    />
                    <Pressable
                      onPress={() => { void handleCopyPayLink(); }}
                      accessibilityRole="button"
                      accessibilityLabel={copiedPayLink ? 'Pay link copied' : 'Copy the pay link'}
                      testID="request-pay-link-copy"
                      hitSlop={10}
                      className="py-[10px]"
                    >
                      {/* nw-keep(data-color): glyph color is a runtime theme token (vector-icon sink) */}
                      <Ionicons
                        name={copiedPayLink ? 'checkmark' : 'copy-outline'}
                        size={16}
                        color={copiedPayLink ? colors.success : colors.textSecondary}
                      />
                    </Pressable>
                  </View>
                  {/* Only legacy v1 (unregistered) requests are stranded by a
                      lost link. Registered/SDK-native payments rediscover
                      from wallet keys, and warning there contradicted the
                      Ready notice saying exactly that. */}
                  {!createdRequestKeyRecoverable && (
                    <View className="gap-[4px] rounded-control border border-[#E1C26B] bg-[#FFF9E8] px-[12px] py-[10px]">
                      <Text className="font-pp-semi-bold text-[12px] text-[#8A6B1F]">Keep this link</Text>
                      <Text className="font-pp-regular text-[12px] leading-[17px] text-[#8A6B1F]">
                        If both you and the payer lose this URL, a payment sent to this request may not be recoverable from another browser.
                      </Text>
                    </View>
                  )}
                </>
              ) : null}
              {mode === 'pay' && receiveLink ? (
                <>
                  <Text className="font-pp-semi-bold text-[12px] text-text-secondary">Shareable receive link</Text>
                  <TextInput
                    editable={false}
                    selectTextOnFocus
                    value={receiveLink}
                    className="rounded-control border border-border-light px-[12px] py-[10px] font-pp-regular text-[14px] text-text"
                  />
                </>
              ) : null}
            </ScrollView>

            {/* Unregistered-seller choice, before the request exists.
                NOT framed as "where should payments arrive": there is no choice
                of destination, the payment always lands in the same account.
                The only question is whether the seller can still reach it once
                this browser is gone, so the title names both exits and the body
                is one cause and one consequence (Pat, 2026-08-31). */}
            {unregisteredPrompt ? (
              <View className="gap-[12px] rounded-control border border-border bg-card-background p-[16px]">
                <Text className="font-pp-semi-bold text-[15px] text-text">
                  Register, or keep a backup
                </Text>
                <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
                  Unregistered, this request lives only in this browser. Lose the browser, lose the payment.
                </Text>
                <View className="gap-[8px]">
                  <Pressable
                    className="items-center justify-center rounded-control bg-button-primary px-[16px] py-[12px]"
                    onPress={() => answerUnregistered('register')}
                    accessibilityRole="button"
                    testID="unregistered-register"
                  >
                    <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">
                      Register my wallet
                    </Text>
                  </Pressable>
                  <Pressable
                    className="items-center justify-center rounded-control border border-border px-[16px] py-[12px]"
                    onPress={() => {
                      // Opened here, inside the press: the picker needs the gesture,
                      // and the request (the file's content) does not exist yet.
                      pendingBackupTargetRef.current = canProveBackupSave() && address
                        ? openBackupFileTargetFromPress(`privacy-pools-request-backup-${address.toLowerCase()}.json`)
                        : null;
                      answerUnregistered('download');
                    }}
                    accessibilityRole="button"
                    testID="unregistered-download"
                  >
                    <Text className="font-pp-regular text-[13px] text-text">
                      Download backup
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {/* The raw payload lives behind More (Pat, 2026-09-03): the pay
                link is the task, this is the thing you paste into Import
                Payment Requests on another browser. */}
            {outputPayload && moreOpen ? (
              <View className="gap-[6px]">
                <Text className="font-pp-semi-bold text-[12px] text-text-secondary">
                  {mode === 'request' ? 'Request payload' : mode === 'pay' ? 'Receipt payload' : 'Imported note'}
                </Text>
                <TextInput
                  multiline
                  editable={false}
                  selectTextOnFocus
                  value={outputPayload}
                  testID="request-payload"
                  className="min-h-[120px] rounded-control border border-border-light px-[12px] py-[10px] font-pp-regular text-[12px] text-text"
                  // nw-keep(platform-css): textAlignVertical is not css-interop-compatible; the [textAlignVertical:top] arbitrary class compiles to nothing on native
                  style={{ textAlignVertical: 'top' }}
                />
              </View>
            ) : null}
            {(!inlineHubActive || !!outputPayload || mode === 'pay') && (
            <View className="flex-row flex-wrap justify-end gap-[8px]">
              {Platform.OS === 'web' ? (
                <>
                  {/* Sharing the link IS the task — a request nobody receives
                      is not a request — so it leads, and the payload
                      copy/download move behind More (Pat, 2026-08-28). */}
                  {/* No Share Pay Link button: the link field itself copies on
                      focus (Pat, 2026-08-28), which is the gesture people
                      already make when they mean to grab a link. Same handler,
                      same toast. */}
                  {moreOpen ? (
                    <>
                      {/* "Backup" rather than "JSON": it is the thing that gets
                          the payment back, which is what the user needs to
                          know. The file is still JSON. */}
                      <Pressable
                        className={`items-center justify-center rounded-control border px-[12px] py-[10px] ${copiedOutput ? 'border-accent' : 'border-border'} ${outputPayload ? 'opacity-100' : 'opacity-40'}`}
                        onPress={handleCopyOutput}
                        disabled={!outputPayload}
                      >
                        <Text className={`font-pp-regular text-[13px] ${copiedOutput ? 'text-accent' : 'text-text'}`}>
                          {copiedOutput ? 'Copied!' : 'Copy backup'}
                        </Text>
                      </Pressable>
                      <Pressable
                        className={`items-center justify-center rounded-control border px-[12px] py-[10px] ${backupUrgent ? 'border-accent' : 'border-border'} ${outputPayload ? 'opacity-100' : 'opacity-40'}`}
                        onPress={handleDownloadOutput}
                        disabled={!outputPayload}
                      >
                        <Text className={`font-pp-regular text-[13px] ${backupUrgent ? 'text-accent' : 'text-text'}`}>
                          Save backup
                        </Text>
                      </Pressable>
                      {/* The payload itself, separate from the backup (Pat, 2026-09-03). */}
                      <Pressable
                        className={`items-center justify-center rounded-control border px-[12px] py-[10px] ${copiedPayload ? 'border-accent' : 'border-border'} ${outputPayload ? 'opacity-100' : 'opacity-40'}`}
                        onPress={handleCopyPayload}
                        disabled={!outputPayload}
                        testID="request-copy-payload"
                      >
                        <Text className={`font-pp-regular text-[13px] ${copiedPayload ? 'text-accent' : 'text-text'}`}>
                          {copiedPayload ? 'Copied!' : 'Copy payload'}
                        </Text>
                      </Pressable>
                      {receiveLink ? (
                        <Pressable
                          className="items-center justify-center rounded-control border border-border px-[16px] py-[10px]"
                          onPress={handleCopyReceiveLink}
                        >
                          <Text className="font-pp-regular text-[13px] text-text">Copy Receive Link</Text>
                        </Pressable>
                      ) : null}
                    </>
                  ) : null}
                  {outputPayload || receiveLink ? (
                    <Pressable
                      className={`items-center justify-center rounded-control border px-[12px] py-[10px] ${backupUrgent && !moreOpen ? 'border-accent' : 'border-border'}`}
                      onPress={() => setMoreOpen((v) => !v)}
                    >
                      <Text className={`font-pp-regular text-[13px] ${backupUrgent && !moreOpen ? 'text-accent' : 'text-text'}`}>
                        {moreOpen ? 'Less' : 'More'}
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              ) : (
                <Pressable
                  className="items-center justify-center rounded-control border border-border px-[16px] py-[10px]"
                  onPress={handleShareOutput}
                  disabled={!outputPayload}
                >
                  <Text className="font-pp-regular text-[13px] text-text">Share</Text>
                </Pressable>
              )}
              {txHash ? (
                <View className="flex-row items-center gap-[6px]">
<Pressable
                  className="items-center justify-center rounded-control border border-border px-[16px] py-[10px]"
                  onPress={() => Linking.openURL(getExplorerTxUrl(txChainId ?? chainId, txHash))}
                >
                  <Text className="font-pp-regular text-[13px] text-text">Explorer</Text>
                </Pressable>
                  <ExplorerPrivacyHint explorerName={getExplorerName(txChainId ?? chainId)} />
                </View>
              ) : null}
              {/* This button is styled identically to the Pay buttons and sits
                  directly beneath them in the inline /pay flow. Left live
                  during a run it was the one press that could kill a payment
                  the user had already paid gas for (QA 2026-08-26) -- the
                  close guard warns on the first press now.
                  Enabled, not disabled (code review 2026-08-27): see the X
                  control above. Disabling both left no reachable route to the
                  handler's second-press escape. The label says what the press
                  will do so the warning is not a surprise. */}
              <Pressable
                className="items-center justify-center rounded-control bg-button-primary px-[14px] py-[14px]"
                onPress={closePaymentRequestModal}
              >
                <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">
                  {busyAction ? leavePaymentLabel(payPhase) : 'Done'}
                </Text>
              </Pressable>
            </View>
            )}
      </RequestShell>
    </PaymentRequestModalContext.Provider>
  );
}
