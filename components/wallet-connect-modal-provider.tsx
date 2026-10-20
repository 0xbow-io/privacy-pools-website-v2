import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { dropStaleWcSession } from '@/services/wc-stale-session';
import { isWalletTileDisabled, primaryMobileWalletIds, walletListMaxHeight, WALLET_OPEN_CHECK_MS, isTilePending, mobileOsFromUserAgent, mobileWalletLinksFor, shareablePageUrl, type MobileOs } from '@/services/wc-mobile-links';
import { WEB_FIXED_POSITION, WEB_BLUR_BACKDROP } from '@/components/ui/web-style-shims';
import { View, Text, Image, Pressable, Platform, Linking, ActivityIndicator, ScrollView, useWindowDimensions } from 'react-native';
import type { ViewStyle } from 'react-native';
import { useAccount, useConnect, useConnectionEffect } from 'wagmi';
import type { Connector } from 'wagmi';
import QRCode from 'react-native-qrcode-svg';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { StellarWalletOption } from '@/components/stellar-wallet-option';
import { useConnectFreighter, useStellarWallet } from '@/components/stellar-wallet-provider';
import { useChainRouter } from '@/hooks/use-chain-router';
import { AccountKeySignIn } from '@/components/account-key-sign-in';
import { useMobileAccountKeys } from '@/components/mobile-account-keys-context';
import { PasskeySignInPanel } from '@/components/passkey-sign-in-panel';
import { PASSKEY_EOA_CONNECTOR_ID } from '@/services/passkey-eoa/constants';
import { useBackHandler } from '@/hooks/use-back-handler';
import { armAutoSignAfterConnect } from '@/services/auto-sign-after-connect';

// Quick check for whether the current browser actually has a
// window.ethereum-style provider attached. wagmi's generic `injected()`
// connector is always in the connectors[] (we add it in the config),
// but on a mobile browser without an in-app wallet there's no provider
// and the tile is dead — clicking it opens an empty wallet prompt and
// then errors. Filter the generic tile out when no provider is found.
// EIP-6963 announced wallets aren't affected: wagmi only adds them to
// connectors[] when they actually announce, so they're pre-filtered.
function hasWindowEthereum(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { ethereum?: unknown };
  return typeof w.ethereum !== 'undefined' && w.ethereum !== null;
}

// react-native-web-only style escape hatches: position:fixed lets the
// modal stay anchored over scrolling content, the blur-backdrop matches
// the look used by the other modal providers in ppv2.
interface WebOnlyViewStyle {
  position?: string;
  backdropFilter?: string;
  WebkitBackdropFilter?: string;
}

// QR-frame shadow: a subtle floating card. WEB carries the verbatim baseline
// box-shadow (RN-Web would convert the shadow* anyway); native keeps shadow*/
// elevation. Kept as a style sink because it's a runtime Platform.select.
const QR_FRAME_SHADOW = Platform.select({
  web: { boxShadow: '0 6px 24px rgba(0, 0, 0, 0.15)' } as ViewStyle,
  ios: { shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
  android: { elevation: 4 },
});

// Wallets whose universal links accept a WalletConnect URI. iOS does not
// reliably route a bare `wc:` link to an installed wallet, and in-app browsers
// (Telegram) drop custom schemes, so each row navigates to the wallet's https
// link from the tap itself.
const DEEPLINK_WALLETS = [
  { name: 'MetaMask', base: 'https://metamask.app.link/wc?uri=' },
  { name: 'Trust Wallet', base: 'https://link.trustwallet.com/wc?uri=' },
  { name: 'Rainbow', base: 'https://rnbwapp.com/wc?uri=' },
  { name: 'Coinbase Wallet', base: 'https://go.cb-w.com/wc?uri=' },
] as const;

// No display_uri by then means the provider or relay never came up.
const WC_URI_TIMEOUT_MS = 30_000;

// Must run synchronously inside a press handler. On web, react-native-web's
// Linking.openURL uses window.open(…, 'noopener'), which iOS and in-app
// browsers ignore for app links and which always resolves.
function openWalletLink(href: string): void {
  console.info('[wc] open link', href.split(':')[0]);
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.location.href = href;
    return;
  }
  void Linking.openURL(href).catch(() => {});
}

function isTelegramWebView(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { TelegramWebviewProxy?: unknown; navigator?: Navigator };
  return typeof w.TelegramWebviewProxy !== 'undefined' || /Telegram/i.test(w.navigator?.userAgent ?? '');
}

interface WalletConnectModalContextValue {
  /** Open the wallet picker. Resolves once the user picks (or dismisses). */
  open: () => Promise<void>;
  /** Dismiss the picker (no-op while a connect is in flight). */
  close: () => void;
  /** Whether the picker is currently shown — consumed by the URL bridge. */
  isOpen: boolean;
}

const WalletConnectModalContext = createContext<WalletConnectModalContextValue>({
  open: async () => {},
  close: () => {},
  isOpen: false,
});

interface WalletOption {
  /** Stable key for React lists + pendingId tracking. Distinct from
   * connector.uid because the mobile "Open in installed wallet" tile
   * shares its connector with the WalletConnect tile. */
  uid: string;
  /** Connector to feed into wagmi's connectAsync. */
  connector: Connector;
  /** Human-readable label shown in the picker tile. */
  label: string;
  /** Sub-label rendered under the title (e.g. "MetaMask, Rabby, …"). */
  description: string;
  /** Sibling tile under WalletConnect on mobile that deep-links the
   * generated wc: URI to the OS-registered wallet instead of showing
   * the QR. Same WC session under the hood, different transport. */
  kind?: 'wc-deeplink' | 'wc-link';
  /** kind 'wc-link': builds the wallet link from the pre-created pairing URI. */
  href?: (uri: string, pageUrl: string, os?: MobileOs) => string;
  /** kind 'wc-link': vendored icon data URI (the connector icon is WalletConnect's). */
  icon?: string;
  /** kind 'wc-link': listed under "More wallets". */
  more?: boolean;
  /** kind 'wc-link': false when the link does not carry the pairing URI. */
  needsUri?: boolean;
}

// The hidden attempt that creates the pairing URI when a mobile picker opens.
const PREPARE_UID = 'wc:prepare';

// Prefer individually discovered wallets; window.ethereum is a legacy fallback
// when none are discovered, since it cannot reliably select among extensions.
function pickWalletOptions(connectors: readonly Connector[], isMobile: boolean): WalletOption[] {
  const seen = new Set<string>();
  const out: WalletOption[] = [];
  const ethProviderPresent = hasWindowEthereum();
  const hasDiscoveredWallets = connectors.some(isDetectedWallet);

  for (const c of connectors) {
    // The embedded (passkey) smart wallet has its own create/unlock onboarding —
    // it isn't a "connect existing wallet" option, so keep it out of this picker.
    if (c.id === 'pools-embedded') {
      continue;
    }
    // The passkey EOA (native) has its own sign-in panel above the list.
    if (c.id === PASSKEY_EOA_CONNECTOR_ID) {
      continue;
    }

    // Hide the legacy fallback when unavailable or discovery offers an explicit choice.
    if (c.type === 'injected' && c.id === 'injected' && (!ethProviderPresent || hasDiscoveredWallets)) {
      continue;
    }

    const dedupeKey = `${c.id}:${c.name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let description: string;
    switch (c.type) {
      case 'walletConnect':
        description = 'Scan a QR code with a mobile wallet';
        break;
      case 'injected':
        description = c.id === 'injected'
          ? 'MetaMask, Rabby, Brave, …'
          : 'Detected in this browser';
        break;
      default:
        description = c.name;
    }

    // wagmi's generic `injected()` connector calls itself "Injected",
    // which is jargon to anyone outside wallet-developer land. Show
    // "Browser Wallet" instead. EIP-6963-announced wallets keep their
    // self-reported name (MetaMask, Rabby, …) because that's a real
    // brand the user recognises.
    const label = c.type === 'injected' && c.id === 'injected' ? 'Browser Wallet' : c.name;

    out.push({
      uid: c.uid,
      connector: c,
      label,
      description,
    });
  }

  // Mobile web without an injected wallet (regular Safari/Chrome): scanning a
  // QR on the same phone makes no sense. Replace the WalletConnect tile with
  // one tile per wallet. The pairing URI is created when the picker opens
  // (prepare), so each tap follows its link synchronously.
  if (isMobile && !ethProviderPresent && Platform.OS === 'web') {
    const wcIdx = out.findIndex((o) => o.connector.type === 'walletConnect');
    if (wcIdx >= 0) {
      const wc = out[wcIdx];
      const os = mobileOs();
      const primary = primaryMobileWalletIds(os);
      out.splice(wcIdx, 1, ...mobileWalletLinksFor(os).map((l): WalletOption => ({
        uid: `${wc.connector.uid}:${l.id}`,
        connector: wc.connector,
        label: l.name,
        description: l.id === 'other' ? 'Choose from your installed wallets' : l.needsUri ? 'Open the app to connect' : 'Use this page in the Base app',
        kind: 'wc-link',
        href: l.href,
        needsUri: l.needsUri,
        icon: l.icon,
        // Android: the bare wc: tap raises the native "Open with" sheet of installed
        // wallets, so that is the one tile; the per-wallet list sits behind "Other options".
        more: !primary.has(l.id),
      })));
    }
  }

  return out.sort((a, b) => Number(isDetectedWallet(b.connector)) - Number(isDetectedWallet(a.connector)));
}

function mobileOs(): MobileOs {
  if (typeof navigator === 'undefined') return 'other';
  return mobileOsFromUserAgent(navigator.userAgent, navigator.maxTouchPoints);
}

function isDetectedWallet(connector: Connector): boolean {
  return connector.type === 'injected' && connector.id !== 'injected';
}

/** Shared by the modal and inline picker. Wallet icons stay in image elements
 * (including SVG data URIs), with a local glyph if metadata is absent or broken. */
export function WalletOptionContent({ option, isPending }: { option: WalletOption; isPending: boolean }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  // Some wallets (including Phantom) announce a multiline data URI.
  const icon = (option.kind === 'wc-link' ? option.icon : option.connector.icon)?.trim();
  const showIcon = !!icon && /^data:image\/(png|webp|svg\+xml|jpeg)[;,]/i.test(icon) && failedIcon !== icon;
  const glyph = option.kind === 'wc-deeplink' || option.kind === 'wc-link' ? 'phone-portrait-outline'
    : option.connector.type === 'walletConnect' ? 'qr-code-outline' : 'wallet-outline';
  return (
    <>
      <View className="h-[36px] w-[36px] items-center justify-center overflow-hidden rounded-[10px] bg-card-background">
        {showIcon ? (
          <Image source={{ uri: icon }} className="h-[28px] w-[28px]" resizeMode="contain" onError={() => setFailedIcon(icon)} accessibilityElementsHidden />
        ) : (
          <Ionicons name={glyph} size={20} color={colors.textSecondary} />
        )}
      </View>
      <View className="min-w-0 flex-1 gap-[2px]">
        <Text className="font-pp-medium text-[14px] text-text" numberOfLines={1}>{option.label}</Text>
        <Text className="font-pp-regular text-[12px] text-text-secondary" numberOfLines={1}>
          {isPending ? (option.kind === 'wc-link' ? 'Preparing…' : 'Connecting…') : isDetectedWallet(option.connector) ? 'Browser extension' : option.description}
        </Text>
      </View>
      {isDetectedWallet(option.connector) && !isPending && (
        <View className="rounded-control bg-background-secondary px-[7px] py-[4px]">
          <Text className="font-pp-medium text-[10px] text-text-secondary">Installed</Text>
        </View>
      )}
      {isPending && option.kind === 'wc-link'
        ? <ActivityIndicator size="small" color={colors.textMuted} />
        : <Ionicons name="chevron-forward" size={15} color={colors.textMuted} />}
    </>
  );
}

/** One subtle line while the shared pairing link is created. */
export function WalletLinksPreparing() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  return (
    <View className="flex-row items-center gap-[6px] px-[2px]" accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={colors.textMuted} />
      <Text className="font-pp-regular text-[12px] text-text-secondary">Preparing wallet links</Text>
    </View>
  );
}

export function MoreWalletsButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  return (
    <Pressable onPress={onPress} accessibilityRole="button" className="min-h-[44px] flex-row items-center justify-center gap-[6px] rounded-[8px] active:opacity-[0.7]">
      <Text className="font-pp-medium text-[13px] text-text-secondary">{label}</Text>
      <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
    </Pressable>
  );
}

/**
 * The connector-picking brain, extracted so any surface can host the wallet
 * list — the connect modal below and the ActionHub's inline picker both consume it.
 * Owns the option list, the in-flight connector, the WalletConnect URI (we
 * render our own QR; showQrModal is false in the wagmi config) and error
 * normalization. `onConnected` fires after a successful connectAsync.
 */
export function useWalletPicker(onConnected?: () => void) {
  const { connectors, connectAsync } = useConnect();
  // Live connection mirror for the "incompatible receiver" quirk below: some
  // injected providers (Brave shims, multi-provider proxies) hand wagmi a
  // broken thenable, so connectAsync THROWS while the connection itself
  // completes fine a beat later. The catch must not paint that as a failure.
  const { isConnected: liveConnected, address: liveAddress } = useAccount();
  const liveConnectedRef = useRef(liveConnected);
  liveConnectedRef.current = liveConnected;
  const liveAddressRef = useRef(liveAddress);
  liveAddressRef.current = liveAddress;
  // 540 mirrors the breakpoint other ppv2 modals use (transfer, deposit, …).
  const { width: viewportWidth } = useWindowDimensions();
  const isMobile = viewportWidth <= 540;

  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // WalletConnect URI emitted by the connector once a session is
  // proposed. Set by the 'message' event listener below; rendered as a
  // QR code so users with a mobile wallet can scan to connect — same
  // contract wagmi's bundled QR modal would have honored, just without
  // the @reown/appkit dependency.
  const [wcUri, setWcUri] = useState<string | null>(null);
  // 'wallets' lists universal links for the installed-wallet tile; 'qr' is the scan view.
  const [wcView, setWcView] = useState<'qr' | 'wallets'>('qr');
  // Pairing URI created when a mobile picker opens, for the per-wallet tiles.
  const [preparedUri, setPreparedUri] = useState<string | null>(null);
  // Set when a tapped wallet link left the page visible: offer Open + Copy.
  const [notOpened, setNotOpened] = useState<{ label: string; href: string; uri: string | null } | null>(null);
  // (Declared after notOpened: the lifecycle test reads state by position.)
  // Tile tapped before the pairing URI existed: pending until the prepare ends.
  const [waitingUid, setWaitingUid] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const openCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uriTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageOffRef = useRef<(() => void) | null>(null);
  // Only the current attempt may update the picker or remove its listener.
  const attemptRef = useRef(0);
  // Armed when connectAsync died on the broken-thenable quirk: the connect
  // is usually still IN FLIGHT in the wallet (the user hasn't even approved
  // yet), so no timer can judge it — the isConnected effect below resolves
  // it whenever the approval lands.
  const quirkPendingRef = useRef(false);

  const options = useMemo(() => pickWalletOptions(connectors, isMobile), [connectors, isMobile]);

  const detachMessageListener = useCallback(() => {
    if (uriTimeoutRef.current) {
      clearTimeout(uriTimeoutRef.current);
      uriTimeoutRef.current = null;
    }
    if (messageOffRef.current) {
      messageOffRef.current();
      messageOffRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    attemptRef.current += 1;
    detachMessageListener();
    if (openCheckRef.current) clearTimeout(openCheckRef.current);
  }, [detachMessageListener]);

  const reset = useCallback(() => {
    attemptRef.current += 1;
    setError(null);
    setPendingId(null);
    setWcUri(null);
    setWcView('qr');
    setPreparedUri(null);
    setNotOpened(null);
    setWaitingUid(null);
    setShowMore(false);
    if (openCheckRef.current) {
      clearTimeout(openCheckRef.current);
      openCheckRef.current = null;
    }
    quirkPendingRef.current = false;
    detachMessageListener();
  }, [detachMessageListener]);

  const showQr = useCallback(() => setWcView('qr'), []);

  // Resolve a quirk-interrupted connect the moment the connection actually
  // lands — however long the wallet approval takes.
  useEffect(() => {
    if (liveConnected && quirkPendingRef.current) {
      quirkPendingRef.current = false;
      setError(null);
      armAutoSignAfterConnect(liveAddress ?? null);
      onConnected?.();
    }
  }, [liveConnected, liveAddress, onConnected]);

  const pick = useCallback(async (option: WalletOption) => {
    const attempt = ++attemptRef.current;
    const t0 = Date.now();
    const wcLog = (step: string, extra?: unknown) => console.info(`[wc] ${step} +${Date.now() - t0}ms`, option.kind ?? option.connector.type, extra ?? '');
    wcLog('pick', { id: option.connector.id, ua: typeof navigator !== 'undefined' ? navigator.userAgent : '' });
    const isCurrent = () => attemptRef.current === attempt;
    detachMessageListener();
    quirkPendingRef.current = false;
    setPendingId(option.uid);
    setError(null);
    setWcUri(null);
    setWcView('qr');
    if (option.uid === PREPARE_UID) setPreparedUri(null);

    // For WalletConnect we render our own QR (showQrModal: false in the
    // wagmi config). The connector emits a 'message' event with
    // { type: 'display_uri', data: '<wc:1@2?...>' } when the session
    // proposal is generated. Capture it here:
    //   - kind 'wc-deeplink' → list wallets to open. The link has to be
    //     followed from a tap, and this event arrives seconds after one.
    //   - otherwise → render via react-native-qrcode-svg.
    // Detached after the connect promise settles regardless of outcome.
    if (option.connector.type === 'walletConnect') {
      const handler = (msg: unknown) => {
        wcLog('message', (msg as { type?: unknown } | null)?.type);
        if (!isCurrent()) return;
        if (
          typeof msg === 'object' && msg !== null &&
          'type' in msg && (msg as { type?: unknown }).type === 'display_uri' &&
          'data' in msg && typeof (msg as { data?: unknown }).data === 'string'
        ) {
          const uri = (msg as { data: string }).data;
          wcLog('display_uri', uri.slice(0, 3));
          if (uriTimeoutRef.current) {
            clearTimeout(uriTimeoutRef.current);
            uriTimeoutRef.current = null;
          }
          if (option.uid === PREPARE_UID) {
            // Pre-created pairing: the tiles stay, enabled now that a tap can
            // follow a link synchronously. connectAsync keeps waiting below.
            setPreparedUri(uri);
            setPendingId(null);
            return;
          }
          setWcView(option.kind === 'wc-deeplink' ? 'wallets' : 'qr');
          setWcUri(uri);
        }
      };
      option.connector.emitter.on('message', handler);
      messageOffRef.current = () => option.connector.emitter.off('message', handler);
      // connectAsync never settles when the provider cannot reach the relay.
      uriTimeoutRef.current = setTimeout(() => {
        uriTimeoutRef.current = null;
        wcLog('uri timeout');
        if (!isCurrent()) return;
        attemptRef.current += 1;
        detachMessageListener();
        setPendingId(null);
        setError('Couldn’t reach WalletConnect. Check your connection and try again.');
      }, WC_URI_TIMEOUT_MS);
    }

    try {
      // A WalletConnect session left over from an earlier attempt that never
      // reached wagmi makes the connector skip the pairing: no display_uri,
      // so no link or QR, just a spinner until the timeout. Drop it first.
      if (option.connector.type === 'walletConnect' && !liveConnectedRef.current) {
        wcLog('drop stale start');
        await dropStaleWcSession(option.connector);
        wcLog('drop stale done');
        if (!isCurrent()) return;
      }
      wcLog('connect start');
      const result = await connectAsync({ connector: option.connector });
      wcLog('connect resolved', result?.accounts?.length);
      // DEV-522: a connect the user just approved asks for the sign-in
      // signature straight away (see services/auto-sign-after-connect.ts).
      // Armed even when this attempt is no longer current: the connection's
      // own event closes the picker (close -> reset) before this line runs,
      // and the user did approve this account. The arm is address-scoped, so
      // a newer attempt that connected another account drops it.
      armAutoSignAfterConnect(result?.accounts?.[0] ?? null);
      if (isCurrent()) onConnected?.();
    } catch (err) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : String(err);
      wcLog('connect error', message.slice(0, 200));
      // User-rejected prompts are normal — surface a quieter message.
      if (/user rejected|user denied|user cancel/i.test(message)) {
        setError('Connection cancelled.');
      } else if (/incompatible receiver/i.test(message)) {
        // Broken-thenable quirk (see quirkPendingRef): the throw fires while
        // the wallet approval is still pending, so NEVER show this error and
        // never judge it on a timer — the user may take arbitrarily long to
        // approve. The isConnected effect above completes the flow when the
        // connection lands; until then the picker just stays open.
        if (liveConnectedRef.current) {
          armAutoSignAfterConnect(liveAddressRef.current ?? null);
          onConnected?.();
        } else {
          quirkPendingRef.current = true;
        }
      } else {
        setError(message);
      }
      // An expired or failed pairing cannot be opened any more.
      if (option.uid === PREPARE_UID) setPreparedUri(null);
    } finally {
      if (isCurrent()) {
        attemptRef.current += 1;
        setPendingId(null);
        detachMessageListener();
      }
    }
  }, [connectAsync, detachMessageListener, onConnected]);

  const linkConnector = useMemo(() => options.find((o) => o.kind === 'wc-link')?.connector ?? null, [options]);
  const preparedUriRef = useRef(preparedUri);
  preparedUriRef.current = preparedUri;
  const pendingIdRef = useRef(pendingId);
  pendingIdRef.current = pendingId;

  // Mobile picker opened: create the pairing now so the wc URI exists before
  // the tap. Same WalletConnect relay request the old flow made on tap.
  const prepare = useCallback(() => {
    if (!linkConnector || preparedUriRef.current || pendingIdRef.current) return;
    console.info('[wc] prepare pairing on picker open');
    void pick({ uid: PREPARE_UID, connector: linkConnector, label: '', description: '', kind: 'wc-link' });
  }, [linkConnector, pick]);

  // Tap on a per-wallet tile. Nothing is awaited before the navigation: an
  // app link followed after an await is dropped by mobile browsers.
  const openLink = useCallback((option: WalletOption) => {
    if (option.kind !== 'wc-link' || !option.href) return;
    const uri = preparedUriRef.current;
    if (option.needsUri !== false && !uri) {
      console.info('[wc] tap before uri', option.label);
      setWaitingUid(option.uid);
      prepare();
      return;
    }
    const pageUrl = typeof window !== 'undefined' ? shareablePageUrl(window.location) : '';
    const href = option.href(uri ?? '', pageUrl, mobileOs());
    console.info('[wc] tap', option.label);
    setNotOpened(null);
    openWalletLink(href);
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    if (openCheckRef.current) clearTimeout(openCheckRef.current);
    openCheckRef.current = setTimeout(() => {
      openCheckRef.current = null;
      const visible = document.visibilityState === 'visible';
      console.info('[wc] open check', option.label, visible ? 'still visible' : 'left page');
      if (visible) setNotOpened({ label: option.label, href, uri: option.needsUri === false ? null : uri });
    }, WALLET_OPEN_CHECK_MS);
  }, [prepare]);

  // Only the tapped tile is pending. The shared pairing prepare is shown once
  // (preparingLinks), never as every tile spinning.
  const preparingLinks = pendingId === PREPARE_UID;
  useEffect(() => { if (!preparingLinks) setWaitingUid(null); }, [preparingLinks]);
  const isOptionPending = useCallback((option: WalletOption) =>
    isTilePending(pendingId, option.uid, PREPARE_UID) || (preparingLinks && waitingUid === option.uid), [pendingId, preparingLinks, waitingUid]);
  const isOptionDisabled = useCallback((option: WalletOption) =>
    isWalletTileDisabled({ pendingId, prepareUid: PREPARE_UID, isLink: option.kind === 'wc-link', needsUri: option.needsUri !== false }), [pendingId]);
  const shownOptions = useMemo(() => (showMore ? options : options.filter((o) => !o.more)), [options, showMore]);
  const moreCount = options.length - shownOptions.length;
  const expandMore = useCallback(() => setShowMore(true), []);
  const moreLabel = options.some((o) => o.kind === 'wc-link' && o.href && o.uid.endsWith(':other')) ? 'Other options' : 'More wallets';
  const select = useCallback((option: WalletOption) => {
    if (option.kind === 'wc-link') openLink(option);
    else void pick(option);
  }, [openLink, pick]);

  return { options, shownOptions, moreCount, moreLabel, expandMore, preparingLinks, error, pendingId, wcUri, wcView, showQr, pick, reset, isMobile, prepare, select, isOptionPending, isOptionDisabled, notOpened, openLink: openWalletLink };
}

export function WalletConnectModalProvider({ children }: { children: ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];

  const [isOpen, setIsOpen] = useState(false);
  // Account-key sign-in view inside the picker (wallet-less sessions).
  const [showAccountKey, setShowAccountKey] = useState(false);
  const mobileAccountKeys = useMobileAccountKeys();
  const onConnected = useCallback(() => setIsOpen(false), []);
  const { options, shownOptions, moreCount, moreLabel, expandMore, preparingLinks, error, wcUri, wcView, showQr, reset, isMobile, prepare, select, isOptionPending, isOptionDisabled, notOpened } = useWalletPicker(onConnected);
  const { height: windowHeight } = useWindowDimensions();

  // On the Stellar chain there is nothing for the EVM picker to connect:
  // every "Connect Wallet" goes straight to Freighter (or to get it).
  // Read through refs so `open` keeps one identity: callers open the picker
  // from effects keyed on it (the /modal route), and a Stellar wallet state
  // change must not re-fire them.
  const { isStellar: activeIsStellar } = useChainRouter();
  const connectFreighter = useConnectFreighter();
  const stellarWallet = useStellarWallet();
  const stellarRef = useRef({ activeIsStellar, connectFreighter, stellarWallet });
  stellarRef.current = { activeIsStellar, connectFreighter, stellarWallet };
  const open = useCallback(async () => {
    const { activeIsStellar: onStellar, connectFreighter: connectStellar, stellarWallet: freighter } = stellarRef.current;
    if (onStellar) {
      if (freighter.isConnected) return;
      // A detected Freighter connects in one step. Otherwise show the picker
      // with the Freighter row: going straight to window.open(freighter.app)
      // is blocked as a popup when nothing was clicked (a ?modal=connect
      // link), and the user saw nothing at all.
      if (freighter.availabilityChecked && freighter.isAvailable) {
        await connectStellar();
        return;
      }
      setShowAccountKey(false);
      setIsOpen(true);
      return;
    }
    reset();
    setShowAccountKey(false);
    setIsOpen(true);
  }, [reset]);

  const close = useCallback(() => {
    // Dismissal is always allowed — a rejected WalletConnect deep-link can
    // leave connectAsync hanging until the proposal expires, which would
    // make the modal unclosable. reset() abandons the attempt; a late
    // success still closes through the live connection effect below.
    setIsOpen(false);
    setShowAccountKey(false);
    reset();
  }, [reset]);

  // Mobile: create the WalletConnect pairing as the picker opens.
  useEffect(() => {
    if (isOpen && !activeIsStellar) prepare();
  }, [isOpen, activeIsStellar, prepare]);

  // An abandoned wallet approval can still connect outside the picker. Its
  // stale callback is ignored, but the actual connection closes any open modal.
  useConnectionEffect({ onConnect: close });

  // Web: Escape dismisses the picker (same guard as the × button).
  useEffect(() => {
    if (Platform.OS !== 'web' || !isOpen || typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);
  useBackHandler(isOpen, close);

  const value = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);

  return (
    <WalletConnectModalContext.Provider value={value}>
      {children}
      {isOpen && (
        <View
          className={`absolute inset-0 z-[9999] bg-[rgba(0,0,0,0.5)] ${isMobile ? 'items-stretch justify-end' : 'items-center justify-center'}`}
          // nw-keep(platform-css): web-only position:fixed (anchor over scrolling content) + backdrop blur — no className path; empty on native
          style={[WEB_FIXED_POSITION as ViewStyle, WEB_BLUR_BACKDROP as ViewStyle]}
          pointerEvents="auto"
        >
          <Pressable className="absolute inset-0" onPress={close} />
          <View
            className={`w-full gap-[16px] border-border bg-card-background p-[24px] ${isMobile ? 'max-w-full rounded-t-[18px] rounded-b-none border-t pb-[32px] pt-[14px]' : 'max-w-[420px] rounded-card border'}`}
          >
            {isMobile && <View className="mb-[6px] h-[4px] w-[40px] self-center rounded-control bg-border-light" />}
            <View className="flex-row items-center justify-between">
              <Text className="font-pp-semi-bold text-[18px] text-text">{!wcUri ? 'Connect Wallet' : wcView === 'wallets' ? 'Open your wallet' : 'Scan with your wallet'}</Text>
              <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close">
                <Text className="px-[8px] font-pp-semi-bold text-[28px] leading-[28px] text-text-secondary">×</Text>
              </Pressable>
            </View>

            {/* Native: passkey sign-in + account picker first. Renders nothing on web. */}
            {!showAccountKey && !wcUri && <PasskeySignInPanel colors={colors} onDone={() => setIsOpen(false)} />}

            {showAccountKey ? (
              <>
                <AccountKeySignIn colors={colors} onDone={() => { setShowAccountKey(false); setIsOpen(false); }} />
                <Pressable onPress={() => setShowAccountKey(false)} hitSlop={8}>
                  <Text className="py-[6px] text-center font-pp-medium text-[12px] text-text-secondary underline">← Back to wallets</Text>
                </Pressable>
              </>
            ) : activeIsStellar ? (
              // Stellar connects through Freighter only; the EVM wallets and
              // the account key do not apply here.
              <View className="gap-[8px]">
                <StellarWalletOption className="min-h-[68px] flex-row items-center gap-[12px] rounded-[8px] border border-border-light bg-background px-[16px] py-[14px] active:opacity-[0.85]" onConnected={() => setIsOpen(false)} />
              </View>
            ) : wcUri ? (
              wcView === 'wallets'
                ? <WalletDeepLinkList uri={wcUri} onShowQr={showQr} onBack={reset} />
                : <WalletConnectQr uri={wcUri} onBack={reset} />
            ) : options.length === 0 ? (
              <View className="gap-[24px] pt-[4px]">
                <Text className="font-pp-regular text-[14px] leading-[22px] text-text-secondary">
                  {isMobile
                    ? 'Open this page in your wallet’s browser, or get a wallet to connect.'
                    : 'No wallet detected. Get a wallet below, then return here to connect.'}
                </Text>
                <View className="gap-[10px]">
                  {[
                    { name: 'MetaMask', url: 'https://metamask.io' },
                    { name: 'Ambire', url: 'https://ambire.com' },
                  ].map((wallet) => (
                    <Pressable
                      key={wallet.name}
                      accessibilityRole="link"
                      onPress={() => { void Linking.openURL(wallet.url); }}
                      className="min-h-[56px] flex-row items-center justify-between rounded-control border border-border-light bg-background-secondary px-[18px] py-[16px] hover:opacity-80 active:opacity-70"
                    >
                      <Text className="font-pp-medium text-[15px] text-text">Get {wallet.name}</Text>
                      <Ionicons name="open-outline" size={16} color={colors.textSecondary} />
                    </Pressable>
                  ))}
                </View>
                <StellarWalletOption className="min-h-[68px] flex-row items-center gap-[12px] rounded-[8px] border border-border-light bg-background px-[16px] py-[14px] active:opacity-[0.85]" onConnected={() => setIsOpen(false)} />
                <Pressable
                  onPress={() => setShowAccountKey(true)}
                  accessibilityRole="button"
                  className="min-h-[44px] items-center justify-center rounded-control hover:opacity-80 active:opacity-70"
                >
                  <Text className="font-pp-medium text-[13px] text-text-secondary underline">Sign in with an account key</Text>
                </Pressable>
              </View>
            ) : (
              <View className="gap-[8px]">
                {preparingLinks && <WalletLinksPreparing />}
                {/* Bounded: the expanded list scrolls inside the sheet. */}
                {/* nw-keep(measured-or-inset): maxHeight is measured from the window height; the gap goes to the content-container sink */}
                <ScrollView style={{ maxHeight: walletListMaxHeight(windowHeight), flexGrow: 0 }} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
                {shownOptions.map((option) => {
                  const isPending = isOptionPending(option);
                  const disabled = isOptionDisabled(option);
                  return (
                    <Pressable
                      key={option.uid}
                      onPress={() => select(option)}
                      disabled={disabled}
                      accessibilityRole="button"
                      accessibilityState={{ disabled, busy: isPending }}
                      // Fill/border are class-authored and the pressed dim is active:; a style
                      // FUNCTION on a className'd Pressable is arrayed by css-interop's web runtime
                      // and never invoked, which would drop the fill + pressed state.
                      className={`min-h-[68px] flex-row items-center gap-[12px] rounded-[8px] border border-border-light bg-background px-[16px] py-[14px] active:opacity-[0.85] ${disabled ? 'opacity-50' : 'opacity-100'}`}
                    >
                      <WalletOptionContent option={option} isPending={isPending} />
                    </Pressable>
                  );
                })}
                </ScrollView>
                {moreCount > 0 && <MoreWalletsButton label={moreLabel} onPress={expandMore} />}
                {notOpened && <WalletNotOpened {...notOpened} />}
                <StellarWalletOption className="min-h-[68px] flex-row items-center gap-[12px] rounded-[8px] border border-border-light bg-background px-[16px] py-[14px] active:opacity-[0.85]" onConnected={() => setIsOpen(false)} />
                {/* Wallet-less path: sign in with an exported account key. */}
                <Pressable onPress={() => setShowAccountKey(true)} hitSlop={8}>
                  <Text className="py-[6px] text-center font-pp-medium text-[12px] text-text-secondary underline">
                    Or sign in with an account key (no wallet)
                  </Text>
                </Pressable>
              </View>
            )}

            {/* Native app: bring an account key over from the web by QR. */}
            {mobileAccountKeys.available && !showAccountKey && !wcUri ? (
              <View className="gap-[6px]">
                <Pressable
                  onPress={() => { close(); mobileAccountKeys.open('import'); }}
                  accessibilityRole="button"
                  testID="wallet-modal-import-key-from-web"
                  className="min-h-[52px] flex-row items-center justify-center gap-[8px] rounded-[8px] border border-border-light bg-background px-[16px] active:opacity-[0.85]"
                >
                  <Ionicons name="phone-portrait-outline" size={16} color={colors.text} />
                  <Text className="font-pp-medium text-[14px] text-text">Import account key from web</Text>
                </Pressable>
                {mobileAccountKeys.count > 0 ? (
                  <Pressable onPress={() => { close(); mobileAccountKeys.open('list'); }} hitSlop={8}>
                    <Text className="py-[6px] text-center font-pp-medium text-[12px] text-text-secondary underline">
                      Saved keys on this phone ({mobileAccountKeys.count})
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {error && (
              <Text className="font-pp-regular text-[12px] text-[#E11D48]">{error}</Text>
            )}
          </View>
        </View>
      )}
    </WalletConnectModalContext.Provider>
  );
}

// QR + copy-uri block shown after the WalletConnect tile is picked. We
// keep the QR contained in a square white card regardless of theme so
// camera apps reading it have maximum contrast (react-native-qrcode-svg
// renders dark squares on a light background by default — it doesn't
// invert when the app's in dark mode).
export function WalletConnectQr({
  uri,
  onBack,
}: {
  uri: string;
  onBack: () => void;
}) {
  const { width } = useWindowDimensions();
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(uri);
      } else {
        const Clipboard = await import('expo-clipboard');
        await Clipboard.setStringAsync(uri);
      }
      setCopied(true);
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      copyResetRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // No-op: failure to copy isn't worth surfacing as an error.
    }
  }, [uri]);

  // Hand off to whatever app the OS has registered for the `wc:` scheme.
  // On mobile this triggers the OS wallet picker (MetaMask Mobile,
  // Rainbow, Trust, …). On desktop most browsers prompt with "no app
  // configured" — harmless. AppKit puts this behind its "Open Wallet"
  // button; we mirror the behavior.
  const handleOpenInWallet = useCallback(() => openWalletLink(uri), [uri]);

  return (
    <View className="items-center gap-[14px] py-[4px]">
      <Text className="px-[8px] text-center font-pp-regular text-[12px] leading-[17px] text-text-secondary">
        Scan this code with your mobile wallet.
      </Text>

      <View
        className="rounded-control bg-[#FFFFFF] p-[16px]"
        // nw-keep(platform-css): QR-frame float shadow — WEB carries the verbatim baseline box-shadow, native keeps shadow*/elevation via Platform.select
        style={QR_FRAME_SHADOW}
      >
        {/* nw-keep(svg-or-canvas): fixed QR module/background colors (theme-independent for scannability; QRCode color props) */}
        <QRCode
          value={uri}
          size={208}
          backgroundColor="#FFFFFF"
          color="#000000"
        />
      </View>

      <Pressable
        onPress={handleCopy}
        // Fill is class-authored and the pressed dim is active:; a style FUNCTION on a
        // className'd Pressable is arrayed by css-interop's web runtime and never invoked.
        accessibilityRole="button"
        className="w-full min-h-[44px] items-center justify-center rounded-control py-[12px] active:opacity-70"
      >
        <Text accessibilityLiveRegion="polite" className="font-pp-medium text-[13px] text-text-secondary">
          {copied ? 'Copied!' : 'Copy connection link'}
        </Text>
      </Pressable>

      {width <= 540 && <Pressable
        onPress={handleOpenInWallet}
        accessibilityRole="button"
        // Border is class-authored and the pressed dim is active:; a style FUNCTION on a
        // className'd Pressable is arrayed by css-interop's web runtime and never invoked.
        className="w-full items-center justify-center rounded-[8px] border border-border bg-transparent py-[11px] active:opacity-[0.7]"
      >
        <Text className="font-pp-medium text-[13px] tracking-[0.2px] text-text">
          Open wallet app
        </Text>
      </Pressable>}

      <Pressable onPress={onBack} accessibilityRole="button" className="min-h-[44px] items-center justify-center px-[12px] active:opacity-70">
        <Text className="font-pp-medium text-[12px] text-text-secondary">← Back to wallets</Text>
      </Pressable>
    </View>
  );
}

// Shown for the "Open in installed wallet" tile once the WalletConnect URI
// exists, so the wallet link is followed from a tap on this list.
export function WalletDeepLinkList({
  uri,
  onShowQr,
  onBack,
}: {
  uri: string;
  onShowQr: () => void;
  onBack: () => void;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const [notOpened, setNotOpened] = useState<string | null>(null);
  const checkRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inTelegram = useMemo(() => isTelegramWebView(), []);

  useEffect(() => () => {
    if (checkRef.current) clearTimeout(checkRef.current);
  }, []);

  const handleOpen = useCallback((name: string, href: string) => {
    setNotOpened(null);
    openWalletLink(href);
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    // A wallet that took the link backgrounds this page.
    if (checkRef.current) clearTimeout(checkRef.current);
    checkRef.current = setTimeout(() => {
      if (document.visibilityState === 'visible') setNotOpened(name);
    }, 1500);
  }, []);

  // The bare wc: link comes first: on Android it raises the OS chooser with
  // every installed wallet. Named universal links are the fallback.
  const rows = DEEPLINK_WALLETS.map((w) => ({ name: w.name, href: `${w.base}${encodeURIComponent(uri)}` }));

  return (
    <View className="gap-[8px]">
      <Pressable
        onPress={() => handleOpen('Your wallet', uri)}
        accessibilityRole="link"
        testID="wc-open-wallet"
        className="min-h-[52px] flex-row items-center justify-center gap-[8px] rounded-[8px] bg-text px-[16px] py-[12px] active:opacity-[0.85]"
      >
        <Text className="font-pp-semi-bold text-[14px] text-background">Open wallet</Text>
      </Pressable>
      <Text className="pt-[4px] font-pp-regular text-[12px] text-text-secondary">Or open a specific wallet</Text>
      {rows.map((row) => (
        <Pressable
          key={row.name}
          onPress={() => handleOpen(row.name, row.href)}
          accessibilityRole="link"
          className="min-h-[52px] flex-row items-center justify-between rounded-[8px] border border-border-light bg-background px-[16px] py-[12px] active:opacity-[0.85]"
        >
          <Text className="font-pp-medium text-[14px] text-text">{row.name}</Text>
          <Ionicons name="open-outline" size={16} color={colors.textSecondary} />
        </Pressable>
      ))}

      {notOpened && (
        <Text accessibilityLiveRegion="polite" className="font-pp-regular text-[12px] leading-[17px] text-text-secondary">
          {notOpened} didn’t open. Check it’s installed, or connect with a QR code or link instead.
        </Text>
      )}
      {inTelegram && (
        <Text className="font-pp-regular text-[12px] leading-[17px] text-text-secondary">
          If nothing opens in Telegram, tap ⋯ and choose Open in Safari.
        </Text>
      )}

      <Pressable onPress={onShowQr} accessibilityRole="button" className="min-h-[44px] items-center justify-center active:opacity-70">
        <Text className="font-pp-medium text-[13px] text-text-secondary underline">Show QR code or copy link</Text>
      </Pressable>
      <Pressable onPress={onBack} accessibilityRole="button" className="min-h-[44px] items-center justify-center px-[12px] active:opacity-70">
        <Text className="font-pp-medium text-[12px] text-text-secondary">← Back to wallets</Text>
      </Pressable>
    </View>
  );
}

async function copyText(text: string): Promise<void> {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  } else {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(text);
  }
}

// A tapped wallet link left the page visible: retry from a real tap, or copy
// the pairing link to paste into the wallet.
export function WalletNotOpened({ label, href, uri }: { label: string; href: string; uri: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <View className="gap-[8px] rounded-[8px] border border-border-light px-[14px] py-[12px]">
      <Text accessibilityLiveRegion="polite" className="font-pp-regular text-[12px] leading-[17px] text-text-secondary">
        {label} didn’t open. Check it’s installed.
      </Text>
      <View className="flex-row gap-[8px]">
        <Pressable
          onPress={() => { console.info('[wc] retry open', label); openWalletLink(href); }}
          accessibilityRole="link"
          testID="wc-retry-open"
          className="min-h-[40px] flex-1 items-center justify-center rounded-[8px] bg-text px-[12px] active:opacity-[0.85]"
        >
          <Text className="font-pp-semi-bold text-[13px] text-background">Open</Text>
        </Pressable>
        {uri && <Pressable
          onPress={() => { void copyText(uri).then(() => setCopied(true)).catch(() => {}); }}
          accessibilityRole="button"
          className="min-h-[40px] flex-1 items-center justify-center rounded-[8px] border border-border px-[12px] active:opacity-[0.7]"
        >
          <Text className="font-pp-medium text-[13px] text-text">{copied ? 'Copied' : 'Copy link'}</Text>
        </Pressable>}
      </View>
    </View>
  );
}

export function useWalletConnectModal(): WalletConnectModalContextValue {
  return useContext(WalletConnectModalContext);
}
