import { useEffect, useMemo, useState } from 'react';
import { SUPPORT_TELEGRAM_URL } from '@/config/support';
import { View, Text, Pressable, useWindowDimensions, Platform, Image, Linking } from 'react-native';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import type { ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, usePathname } from 'expo-router';
import { mustLeavePoolPageToSwitch } from '@/services/pool-page-chain-switch';
import { useAccount, useDisconnect } from 'wagmi';
import { useConnectWallet, useCurrentAccount, useDisconnectWallet, useWallets } from '@mysten/dapp-kit';
import { ActiveDesignVariant, applyDesignVariant, Colors, DesignVariantNames, type DesignVariant } from '@/constants/theme';
import { ActivePoolSelection, applyPoolSelection } from '@/config/pool-profile';
import { buildStagingPoolMenuOptions } from '@/services/staging-pool-menu';
import { SEPOLIA_DEFAULT_POOL_ADDRESS, INTERNAL_TOOLS_ENABLED } from '@/config/env';
import { ACTIVE_DEPLOYMENTS, ACTIVE_DEPLOYMENTS_BY_CHAIN } from '@/config/environments';
import {
  ACTIVE_APP_ENVIRONMENT,
  APP_ENVIRONMENTS,
  appEnvironmentLabel,
  applyAppEnvironment,
} from '@/config/app-environment';
import apiClient from '@/services/api-client';
import { useTheme } from '@/components/theme-provider';
import { Logo } from './logo';
import { VersionSwitch } from './version-switch';
import { ChainLogo, chainLogoChainFor, type ChainLogoChain } from './chain-logo';
import { useConnectFreighter, useStellarWallet } from '@/components/stellar-wallet-provider';
import { useSupportedWalletConnection } from '@/hooks/use-supported-wallet-connection';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useSyncEverything } from '@/hooks/use-sync-everything';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { defaultChainId, getChainConfig, isChainSelectable } from '@/config/chains';
import type { ChainConfig } from '@/config/chains';
import { navCenteringLeftWidth, splitNavItems } from '@/services/header-nav';
import { useKeystoreRegistrationModal } from '@/components/keystore-registration-modal-provider';
import { useReceiveSetup } from '@/hooks/use-receive-setup';
import { RECEIVE_WARNING } from '@/services/receive-setup';
import { DebugRecordButton, useDebug } from '@/components/debug-provider';
import { useAccounting } from '@/components/accounting-modal-provider';
import { useViewingKeyModal } from '@/components/viewing-key-modal-provider';
import { useAppNavigation } from '@/hooks/use-app-navigation';
import { useWalletScreeningCheck } from '@/hooks/use-wallet-screening-check';
import { NavbarTabs } from '@/components/ui/navbar-tabs';
import { usePaymentRequestBackupModal } from '@/components/payment-request-backup-modal-provider';
import { usePaymentRequestsModal } from '@/components/payment-requests-modal-provider';
import { useImportNoteModal } from '@/components/import-note-modal-provider';
import { useAccountRecoveryModal } from '@/components/account-recovery-modal-provider';
import { useCustomRpcModal } from '@/components/custom-rpc-modal-provider';
import { activeCustomRpcUrl } from '@/config/custom-rpc';
import { TOR_IN_FORCE, TOR_ON_DEVICE } from '@/config/tor';
import { NotificationCenter } from '@/components/ui/notification-center';
import { AccountKeyExportModal } from '@/components/account-key-export-modal';
import { ErrorReportsModal, useErrorReportsEnabled } from '@/components/error-reports-modal';
import { errorReportsMenuLabel } from '@/services/error-reports-setting';
import { AccountKeyToMobileModal } from '@/components/account-key-to-mobile-modal';
import { useMobileAccountKeys } from '@/components/mobile-account-keys-context';
import { useTransferModal } from '@/components/transfer-modal-provider';
import { resolveEnsAvatar, resolveEnsName } from '@/services/ens';
import { useBackHandler } from '@/hooks/use-back-handler';

// Click-away overlay position: fixed on web (cover the viewport from inside the
// header); native keeps the legacy no-position behavior.
const HEADER_OVERLAY: ViewStyle = Platform.OS === 'web' ? ({ position: 'fixed' } as unknown as ViewStyle) : {};

// Keep the glass inside the header so its hairline edge stays crisp.
// Dropdowns sit outside the backdrop's stacking context.
const HEADER_GLASS = {
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
} as unknown as ViewStyle;

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Map a configured chain to its ChainLogo mark (shared mapping — one
 *  definition, so the header, the chain filter and the row badges agree). */
function chainLogoFor(config: ChainConfig): ChainLogoChain {
  if (config.chainType === 'sui') return 'sui-testnet';
  if (config.chainType === 'stellar') return 'stellar-testnet';
  return chainLogoChainFor(config.id);
}

type NavItem = {
  label: string;
  href: string;
  /**
   * Which collapse BAND this item follows. services/header-nav.ts keys its
   * width thresholds on the label string, so an item whose display label the
   * product renamed (or a newly added item) borrows the band of the label
   * whose rules it should share — instead of falling through to the
   * "always visible" default and stranding a 5th entry in the top bar at
   * phone widths. The collapse rules and their unit tests stay untouched.
   */
  collapseAs?: string;
  /**
   * Never shown in the top bar; available in the account menu
   * and the mobile "More" drawer. For destinations that should be reachable
   * without being advertised as a headline feature.
   */
  menuOnly?: boolean;
};


export const navItems: NavItem[] = [
  // Renamed label only (DEV: "My Pools" reads as the personal surface it is);
  // the route and the 'Privacy Pools' collapse band are unchanged.
  { label: 'My Pools', href: '/', collapseAs: 'Privacy Pools' },
  { label: 'Portfolio', href: '/portfolio' },
  // Protocol-wide statistics share the secondary navigation collapse band.
  // "Explore" rather than "Stats": the page carries the pool directory as well
  // as the protocol figures, and it replaced the Explore-pools panel.
  { label: 'Explore', href: '/explore', collapseAs: 'Ecosystem' },
  { label: 'Ecosystem', href: '/ecosystem' },
  // Menu-only: reachable, but not advertised in the top bar as a headline
  // feature alongside the core surfaces.
  { label: 'Payroll', href: '/payroll', menuOnly: true },
];

// Shared destination glyphs for the mobile bottom-bar More drawer.
export const NAV_MENU_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  'My Pools': 'home-outline',
  Portfolio: 'pie-chart-outline',
  Explore: 'compass-outline',
  Ecosystem: 'planet-outline',
  Payroll: 'cash-outline',
};

export function Header({ overlay = false }: { overlay?: boolean }) {
  const { colorScheme, toggleColorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  const router = useRouter();
  const pathname = usePathname();
  const [actionsDropdownOpen, setActionsDropdownOpen] = useState(false);
  const [chainSelectorOpen, setChainSelectorOpen] = useState(false);
  // Android back closes an open header menu before anything else.
  useBackHandler(actionsDropdownOpen, () => setActionsDropdownOpen(false));
  useBackHandler(chainSelectorOpen, () => setChainSelectorOpen(false));

  const isCompact = width < 835;

  // Unified display state (EVM or Sui) + Sui Wallet-Standard connect. When no
  // Sui wallet is connected this reports exactly wagmi's account state.
  const { address, isConnected, isSui: connectedIsSuiWallet, isStellar: connectedIsStellar } = useMultiChainWallet();
  // Non-EVM (Sui or Stellar) wallet is the active connection: every EVM-only
  // affordance below (ENS, finish-setup, account-key rows) keys off this.
  const connectedIsNonEvm = connectedIsSuiWallet || connectedIsStellar;
  const stellarWallet = useStellarWallet();
  const connectFreighter = useConnectFreighter();
  const { isConnected: evmConnected } = useAccount();
  const suiAccount = useCurrentAccount();
  const { disconnect } = useDisconnect();
  const suiWallets = useWallets();
  const { mutate: suiConnect } = useConnectWallet();
  const { mutate: suiDisconnect } = useDisconnectWallet();
  const { activeChain, activeChainId, selectChain, supportedChains, isSui: activeIsSui, isStellar: activeIsStellar } = useChainRouter();
  // Same idea for the selection: custom RPC, Tor and Portfolio are EVM-only.
  const activeIsNonEvm = activeIsSui || activeIsStellar;
  const navigateTo = useAppNavigation();
  const walletScreening = useWalletScreeningCheck();

  // Shared with the mobile balances sheet via useSyncEverything, so a second
  // refresh control cannot drift from this one.
  const { sync: syncEverything, syncing: syncEverythingBusy } = useSyncEverything();
  const handleSync = async () => {
    setActionsDropdownOpen(false);
    await syncEverything();
  };
  const { isDebugEnabled } = useDebug();
  // Sui testnet stays debug-gated on production builds (main behavior): the
  // option only shows with debug mode on, or when Sui is already active.
  const selectableChains = supportedChains.filter(
    (c) => isChainSelectable(c.id, isDebugEnabled) || activeChainId === c.id,
  );
  const { openAccounting } = useAccounting();
  const { openViewingKey } = useViewingKeyModal();
  const { connectWallet } = useSupportedWalletConnection();
  const {
    keysReady, identityMode, sessionAddress, signOutAccountKey,
    passkeyActive,
  } = usePoolSession();
  // Wallet-less session via imported account key: drives the same actions
  // button/dropdown as a wallet connection (with a reduced item set).
  const keySession = identityMode === 'key';
  const menuActive = isConnected || keySession;
  // Keep a way back to an existing session when the selected chain has no wallet.
  const showSessionControls = evmConnected || !!suiAccount || stellarWallet.isConnected || keySession;

  // Shared breakpoints decide which destinations fit in the top bar.
  //
  // splitNavItems keys on `label`; feed it each item's collapse BAND (its
  // `collapseAs`, defaulting to its own label) and carry the real item along,
  // so a renamed/added display label can't silently lose its thresholds.
  //
  // Menu-only destinations stay out of the top bar in every connection state.
  const navSplit = splitNavItems(
    navItems
      // The page redirects on Sui (its note tokenIds would mislabel), so the
      // entry follows the same condition (codex on 49f41bf).
      .filter((item) => !item.menuOnly && !(activeIsNonEvm && item.label === 'Portfolio'))
      .map((item) => ({ item, label: item.collapseAs ?? item.label })),
    width,
    menuActive,
  );
  const visibleNavItems = navSplit.visible.map((entry) => entry.item);
  // Native centering (services/header-nav.ts navCenteringLeftWidth): measured
  // widths of the actions cluster and the nav items; the logo side is padded
  // to the cluster's width whenever the row can afford it, so the nav shares
  // the Shield card's axis instead of the centre of a lopsided gap.
  const [clusterWidth, setClusterWidth] = useState(0);
  const [navContentWidth, setNavContentWidth] = useState(0);
  const navLeftWidth = navCenteringLeftWidth({
    containerWidth: Math.min(width, 1280) - 40,
    clusterWidth,
    navWidth: navContentWidth,
    logoWidth: 41,
  });
  // Secondary destinations, including Payroll, live in the account menu.
  const accountMenuNavItems = menuActive ? navItems.filter((item) => item.menuOnly) : [];
  // When a Sui wallet is the connected+active account, show its address — an
  // EVM session address (a lingering EVM wallet connection or an imported
  // account key) must not win over it in the header button or "Copy Current
  // Address". Only when the Sui wallet is genuinely connected (isConnected &&
  // connectedIsNonEvm, so `address` is defined); otherwise keep the prior
  // sessionAddress-first behavior so a wallet-less account-key session on the
  // Sui tab still shows its key address instead of nothing.
  const displayAddress = connectedIsNonEvm && isConnected ? address : (sessionAddress ?? address);
  const [ensName, setEnsName] = useState<string | null>(null);
  const [ensAvatar, setEnsAvatar] = useState<string | null>(null);
  const [exportKeyOpen, setExportKeyOpen] = useState(false);
  const [errorReportsOpen, setErrorReportsOpen] = useState(false);
  const errorReportsEnabled = useErrorReportsEnabled();
  const [exportToMobileOpen, setExportToMobileOpen] = useState(false);
  const mobileAccountKeys = useMobileAccountKeys();
  const {
    status: keystoreStatus,
    openKeystoreRegistrationModal,
    openFinishSetup,
    refreshStatus: refreshKeystoreStatus,
  } = useKeystoreRegistrationModal();
  const { partial: receivePartial, canFinish: canFinishSetup } = useReceiveSetup();
  // The partial state is read against the fallback EVM chain, so it doesn't
  // apply while a Sui wallet is the active connection — same gating as the
  // rest of this header's EVM-only affordances.
  const showFinishSetup = canFinishSetup && isConnected && !connectedIsNonEvm && keysReady && receivePartial;
  const {
    openExportPaymentRequestsModal,
    openImportPaymentRequestsModal,
  } = usePaymentRequestBackupModal();
  const { openPaymentRequestsModal } = usePaymentRequestsModal();
  const { openImportNoteModal } = useImportNoteModal();
  const { openExportNotesModal, openImportNotesModal } = useAccountRecoveryModal();
  const { openCustomRpcModal } = useCustomRpcModal();
  const { openConsolidation } = useTransferModal();
  // Whether THIS page load is on the user's own endpoint for the selected
  // chain. Read from the baked config (config/custom-rpc.ts), so the label
  // always describes what is actually in force, never an unsaved draft.
  const customRpcInForce = !activeIsNonEvm && Platform.OS === 'web'
    && !!activeCustomRpcUrl(activeChainId);
  // The actions dropdown groups its items behind submenus to keep the top list
  // short: Payments (request/note management), Privacy & keys (keystore, account
  // key, passkey), Theme (design variants) and Pool (every pool the ASP serves).
  // Each submenu has a back row; the menu always reopens on main.
  // 'environment' (Prod / Staging) is always offered; see the row below.
  const [actionsMenuView, setActionsMenuView] = useState<'main' | 'theme' | 'pool' | 'payments' | 'privacy' | 'environment'>('main');

  useEffect(() => {
    let cancelled = false;
    setEnsName(null);
    setEnsAvatar(null);
    // Sui addresses have no ENS; skip resolution entirely.
    if (!displayAddress || connectedIsNonEvm) return () => { cancelled = true; };

    resolveEnsName(displayAddress)
      .then(async (name) => {
        if (cancelled) return;
        setEnsName(name);
        if (!name) return;
        const avatar = await resolveEnsAvatar(name);
        if (!cancelled) setEnsAvatar(avatar);
      })
      .catch(() => {
        if (!cancelled) {
          setEnsName(null);
          setEnsAvatar(null);
        }
      });

    return () => { cancelled = true; };
  }, [displayAddress, connectedIsNonEvm]);

  // Pool options come straight from /global/public/entrypoints, so the menu
  // tracks whatever the ASP serves — no hardcoded pool list. The default
  // (current) pool is the one this build points at when nothing is stored.
  type PoolOption = { poolVault: string; entrypoint: string; fromBlock: number; label: string; isDefault: boolean; isActive: boolean };
  const [poolOptions, setPoolOptions] = useState<PoolOption[]>([]);
  // Which EVM chain the pool menu describes: with environment deployments the
  // selector can move between chains, so the menu follows the ACTIVE chain; a
  // Sepolia-only build keeps its build default (the selection there is Sui vs
  // Sepolia, and the pool menu is a Sepolia concept).
  const evmMenuChainId = ACTIVE_DEPLOYMENTS.length > 0 ? activeChainId : defaultChainId;
  useEffect(() => {
    let mounted = true;
    // Staging chains: the menu is built from the PIN, never the feed. Their
    // single pool is fixed in config, and the feed has served a wrong row
    // (chain 10's misregistration) — rendered as a pickable non-default
    // option, it would applyPoolSelection() a foreign vault straight into
    // the SEPOLIA config (env.ts bakes selectedVault into
    // SEPOLIA_POOL_ADDRESS regardless of the row's chain).
    const stagingPin = ACTIVE_DEPLOYMENTS_BY_CHAIN[evmMenuChainId];
    if (stagingPin) {
      setPoolOptions(buildStagingPoolMenuOptions(stagingPin));
      return () => { mounted = false; };
    }
    apiClient.getEntrypoints()
      .then((res) => {
        if (!mounted) return;
        // Staging chains have exactly one pool each (the preset's); the
        // stored Sepolia pool selection does not apply there.
        const stagingPool = ACTIVE_DEPLOYMENTS_BY_CHAIN[evmMenuChainId]?.pool;
        const defaultVault = (stagingPool ?? SEPOLIA_DEFAULT_POOL_ADDRESS).toLowerCase();
        const activeVault = stagingPool
          ? stagingPool.toLowerCase()
          : (ActivePoolSelection?.poolVault ?? SEPOLIA_DEFAULT_POOL_ADDRESS).toLowerCase();
        const seen = new Set<string>();
        const options: PoolOption[] = [];
        for (const pool of res.pools ?? []) {
          // The feed is cross-chain (Sepolia, Sui, and the staging mainnet /
          // Citrea pools all appear); the switcher must only offer pools on
          // THIS build's chain, or picking one would splice another chain's
          // vault into the Sepolia config.
          if (Number(pool.chainId) !== evmMenuChainId) continue;
          const vault = pool.poolVault?.toLowerCase();
          const entrypoint = pool.entrypoint?.trim();
          if (!vault || !entrypoint || seen.has(vault)) continue;
          seen.add(vault);
          const isDefault = vault === defaultVault;
          options.push({
            poolVault: vault,
            entrypoint,
            fromBlock: pool.fromBlock,
            label: `Entrypoint ${entrypoint.slice(0, 6)}…${entrypoint.slice(-4)}${isDefault ? ' (current)' : ''}`,
            isDefault,
            isActive: vault === activeVault,
          });
        }
        // Default pool first, then by poolId order as served.
        options.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
        setPoolOptions(options);
      })
      .catch(() => {
        // Menu shows the loading row; the rest of the dropdown still works.
      });
    return () => { mounted = false; };
    // Re-filter when the staging selector moves between the EVM chains.
  }, [evmMenuChainId]);

  const handleSelectChain = (chainId: number) => {
    // Leave a pool page first: it pins its own chain (see the helper).
    if (mustLeavePoolPageToSwitch({
      targetChainId: chainId,
      targetChainType: getChainConfig(chainId)?.chainType,
      currentChainId: activeChainId,
      pathname,
    })) {
      router.replace('/');
    }
    selectChain(chainId);
    setChainSelectorOpen(false);
  };

  const handleActionsPress = () => {
    const next = !actionsDropdownOpen;
    setActionsDropdownOpen(next);
    setActionsMenuView('main');
    setChainSelectorOpen(false);
    if (next) {
      // Re-check on every open so the "Register Keystore" item
      // appears/disappears with current chain state, not whatever was
      // cached the last time the session was built.
      void refreshKeystoreStatus();
    }
  };

  const handleOpenRegisterKeystore = () => {
    setActionsDropdownOpen(false);
    openKeystoreRegistrationModal();
  };

  const handleOpenFinishSetup = () => {
    setActionsDropdownOpen(false);
    openFinishSetup();
  };

  // Visible only for wallet-owned sessions. In account-key mode, a connected
  // wallet is just the payer; registering with key-derived calldata from A
  // while wallet B signs would write B's keystore with A's keys.
  const showRegisterKeystore = identityMode === 'wallet' && isConnected && keysReady && keystoreStatus === 'unregistered';

  const handleThemeToggle = () => {
    toggleColorScheme();
    setActionsDropdownOpen(false);
  };

  const handleConnectWallet = () => {
    if (activeIsStellar) {
      // Stellar: Freighter. Not installed -> send the user to get it.
      void connectFreighter();
    } else if (activeIsSui) {
      // Sui: connect via the Wallet Standard (Slush et al). Prefer Slush when
      // several wallets are installed; if none, send the user to get Slush.
      const wallet =
        suiWallets.find((w) => /slush/i.test(w.name)) ??
        suiWallets.find((w) => /sui/i.test(w.name)) ??
        suiWallets[0];
      if (wallet) {
        suiConnect({ wallet });
      } else if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.open('https://slush.app', '_blank', 'noopener');
      }
    } else {
      connectWallet();
    }
    setActionsDropdownOpen(false);
  };

  const handleDisconnect = () => {
    setActionsDropdownOpen(false);
    // Disconnect whichever wallet is actually connected.
    if (connectedIsStellar) {
      stellarWallet.disconnect();
    } else if (connectedIsSuiWallet) {
      suiDisconnect();
    } else {
      disconnect();
    }
  };

  const handleAccounting = () => {
    setActionsDropdownOpen(false);
    openAccounting();
  };

  const handleViewPaymentRequests = () => {
    setActionsDropdownOpen(false);
    openPaymentRequestsModal();
  };

  const handleImportNote = () => {
    setActionsDropdownOpen(false);
    openImportNoteModal();
  };


  const handleCopyAddress = async () => {
    const copyTarget = displayAddress;
    if (!copyTarget || Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.clipboard) {
      setActionsDropdownOpen(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(copyTarget);
    } finally {
      setActionsDropdownOpen(false);
    }
  };

  const handleExportPaymentRequests = () => {
    setActionsDropdownOpen(false);
    openExportPaymentRequestsModal();
  };

  const handleImportPaymentRequests = () => {
    setActionsDropdownOpen(false);
    openImportPaymentRequestsModal();
  };

  const shadowStyle = colorScheme === 'dark'
    ? { shadowColor: '#000000', shadowOpacity: 0.3 }
    : { shadowColor: '#E6E6E6', shadowOpacity: 1 };
  const accountLabel = displayAddress
    ? `${ensName ?? truncateAddress(displayAddress)}${keySession ? ' · key' : ''}`
    : '';

  return (
    // nw-keep(data-color): every Ionicons `color` below is a theme token fed to the
    // @expo/vector-icons sink (no className path) — the header's runtime icon palette.
    <View
      className={`relative z-[99999] h-[67px] w-full overflow-visible ${Platform.OS === 'web' ? (overlay ? 'mb-[-67px]' : '') : 'bg-card-background'}`} testID="site-header"
      // nw-keep(platform-css): NATIVE-only header shadow. RN-Web dropped the deprecated shadow*
      // longhands; the web surface uses the glass layer below, but
      // css-interop normalizes them into a box-shadow once the element carries a className, so the
      // shadow must be gated off web to preserve web parity. Native keeps the scheme-dependent shadow.
      style={Platform.OS === 'web' ? undefined : { shadowOffset: { width: 0, height: 8 }, shadowRadius: 20, elevation: 8, ...shadowStyle }}
    >
      {Platform.OS === 'web' && (
        <View pointerEvents="none" className="absolute inset-0 border-b border-border-light"
          // nw-keep(platform-css): backdrop blur is confined to the header surface.
          // nw-keep(data-color): the current theme background at 82 percent opacity tints the glass.
          style={[HEADER_GLASS, { backgroundColor: `${colors.background}D1` }]} />
      )}
      <View className={`relative mx-auto h-full w-full max-w-[1280px] flex-row items-center justify-between overflow-visible ${width < 400 ? 'px-[16px]' : 'px-[20px]'} py-[16px]`}
        // nw-keep(platform-css): grid centers the nav on first paint, while allowing
        // asymmetric sides when the action cluster needs more room. No measurement pass.
        style={Platform.OS === 'web' ? ({ display: 'grid', gridTemplateColumns: 'minmax(max-content, 1fr) auto minmax(max-content, 1fr)', columnGap: width < 400 ? 4 : 12 } as unknown as ViewStyle) : undefined}
      >
        <View
          className="shrink-0 flex-row items-center"
          // nw-keep(measured-or-inset): the logo side mirrors the MEASURED actions-cluster width so the nav is on the page axis (see navCenteringLeftWidth)
          style={Platform.OS !== 'web' && navLeftWidth !== undefined ? { width: navLeftWidth } : undefined}
        >
          <Pressable className="h-[41px] w-[41px] shrink-0 flex-row items-center justify-center rounded-[8px]" onPress={() => navigateTo('/')}>
            <Logo width={35} height={35} variant={colorScheme === 'dark' ? 'white' : 'black'} />
            {/* Which world you are in, on the mark itself: a staging session looks
                identical to prod otherwise, and a tester parked on staging has no
                other cue in the bar (Pat, 2026-09-08). Prod stays unmarked. The
                warning color pair holds its contrast in both themes; pointer
                events off so the whole 41px
                square still navigates home. */}
            {ACTIVE_APP_ENVIRONMENT === 'staging' ? (
              <View
                pointerEvents="none"
                className="absolute bottom-[-4px] left-[-7px] right-[-7px] items-center rounded-[4px] border border-warning bg-warning-bg py-[1px]"
              >
                <Text className="font-pp-bold text-[9px] uppercase leading-[11px] tracking-[0.3px] text-warning">
                  staging
                </Text>
              </View>
            ) : null}
          </Pressable>
          {Platform.OS === 'web' && <VersionSwitch />}
        </View>

        {/* Web grid balances both sides before first paint and gives the action
            cluster extra space when needed. Native retains measured flex centering. */}
        <View className="min-w-0 flex-1 flex-row items-center justify-center">
        <NavbarTabs items={visibleNavItems} pathname={pathname} viewportWidth={width}
          dark={colorScheme === 'dark'} onNavigate={navigateTo}
          onLayout={Platform.OS !== 'web' ? (e) => setNavContentWidth(Math.round(e.nativeEvent.layout.width)) : undefined} />
        </View>

        {/* Right Actions */}
        {/* shrink-0: the flex nav must never squeeze the cluster — the actions
            are fixed affordances, the nav is the elastic one. */}
        <View
          className={`z-[99999] shrink-0 flex-row items-center ${width < 400 ? 'gap-[4px]' : 'gap-[8px]'}`}
          onLayout={Platform.OS !== 'web' ? (e) => setClusterWidth(Math.round(e.nativeEvent.layout.width)) : undefined}
          // nw-keep(platform-css): align the actions to the outer edge of the grid.
          style={Platform.OS === 'web' ? ({ justifySelf: 'end' } as unknown as ViewStyle) : undefined}
        >
          {/* Signed out there is nothing to notify about — the feed is
              "my activity" plus the pool's pulse, and the "mine" tab keys off a
              connected address. Gated on the same signal as the account chip so
              the two appear and disappear together. */}
          {menuActive && <NotificationCenter />}
          {/* Signed out, the custom RPC form gets its own button.
              It normally lives in the actions dropdown, and that dropdown is
              gated on `menuActive`, so the one setting that decides whether
              connecting works at all could only be changed after connecting.
              On a slow endpoint that means waiting out the load before being
              allowed to touch the thing causing it (Mike, 2026-09-22: "we must
              enable users to select custom rpc before logging in").

              Gated exactly like the menu row it stands in for: EVM only, since
              the Sui client is built by dapp-kit from its own config, and web
              only, since the setting lives in localStorage and takes effect on
              a reload. Hidden once `menuActive`, so the dropdown row and this
              are never both on screen. */}
          {!menuActive && !activeIsNonEvm && Platform.OS === 'web' && (
            <Pressable
              className="h-[28px] w-[28px] items-center justify-center rounded-pill bg-background-secondary"
              // Wrapped, not passed by reference: the press event would arrive
              // as the options argument and its properties would be read as
              // flags.
              onPress={() => openCustomRpcModal()}
              testID="header-custom-rpc"
              accessibilityRole="button"
              accessibilityLabel={customRpcInForce ? 'Custom RPC: on' : 'Use custom RPC'}
            >
              {/* nw-keep(data-color): glyph color is a theme token into the vector-icon sink */}
              <Ionicons
                name="globe-outline"
                size={16}
                color={customRpcInForce ? colors.primary : colors.text}
              />
            </Pressable>
          )}
          {/* Tor, before connecting, for the same reason and one of its own.
              The reason it shares: the actions dropdown is gated on
              `menuActive`, so this was reachable only after connecting. The one
              of its own: Tor decides how the FIRST request travels, and by the
              time a wallet is connected that request has already gone. Offering
              it only afterwards offers it too late. */}
          {!menuActive && !activeIsNonEvm && (Platform.OS === 'web' || TOR_ON_DEVICE) && (
            <Pressable
              className="h-[28px] w-[28px] items-center justify-center rounded-pill bg-background-secondary"
              onPress={() => openCustomRpcModal({ torOnly: true })}
              testID="header-tor"
              accessibilityRole="button"
              accessibilityLabel={TOR_IN_FORCE ? 'anon-rpc: on' : 'Connect with anon-rpc'}
            >
              {/* nw-keep(data-color): glyph color is a theme token into the vector-icon sink */}
              <Ionicons
                name="shield-checkmark-outline"
                size={16}
                color={TOR_IN_FORCE ? colors.primary : colors.text}
              />
            </Pressable>
          )}
          {/* Debug mode only: record everything the debug console logs. Next
              to the Actions menu, never inside it (Pat, 2026-09-24). */}
          <DebugRecordButton />
          <View className="relative z-[99999]">
            <Pressable
              className="h-[32px] flex-row items-center justify-center gap-[10px] rounded-pill bg-button-primary px-[14px] py-[4px]"
              // Disconnected: skip the dropdown — it only ever held a
              // single "Connect Wallet" item, so go straight to the
              // picker. Connected: keep the dropdown (Copy / Sign Out).
              onPress={menuActive ? handleActionsPress : handleConnectWallet}
            >
              {menuActive && displayAddress ? (
                <>
                  {ensAvatar && !isCompact ? (
                    <Image source={{ uri: ensAvatar }} className="h-[18px] w-[18px] rounded-control" />
                  ) : null}
                  <Text
                    className="max-w-[180px] font-pp-sans-medium text-[14px] text-button-primary-text"
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {isCompact ? 'Actions' : accountLabel}
                  </Text>
                </>
              ) : (
                <Text className="max-w-[180px] font-pp-sans-medium text-[14px] text-button-primary-text">
                  {width < 400 ? 'Connect' : 'Connect Wallet'}
                </Text>
              )}
              {menuActive && (
                <Ionicons
                  name="caret-down"
                  size={12}
                  color={colors.buttonPrimaryText}
                />
              )}
              {menuActive && showFinishSetup ? (
                <View
                  testID="header-finish-setup-dot"
                  accessibilityLabel="Setup incomplete"
                  className="absolute right-[-2px] top-[-2px] h-[9px] w-[9px] rounded-[5px] border-[1.5px] border-background bg-warning"
                />
              ) : null}
            </Pressable>

            {/* Actions Dropdown */}
            {menuActive && actionsDropdownOpen && (
              <>
                <Pressable
                  className="inset-0 z-[9998]"
                    // nw-keep(platform-css): fixed on web to cover the viewport; native keeps legacy positioning
                    style={HEADER_OVERLAY}
                  onPress={() => setActionsDropdownOpen(false)}
                />
                <View
                  className="absolute right-0 top-[32px] z-[99999] min-w-[230px] rounded-card border border-border-light bg-menu-background p-[6px]"
                  // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                  style={DROPDOWN_SHADOW}
                >
                  {actionsMenuView !== 'main' && (
                    <Pressable
                      className="flex-row items-center gap-[10px] border-b border-b-border-light px-[12px] py-[10px]"
                      onPress={() => setActionsMenuView('main')}
                    >
                      <Ionicons name="arrow-back" size={16} color={colors.textSecondary} />
                      <Text className="font-pp-sans-medium text-[14px] text-text-secondary">
                        Back
                      </Text>
                    </Pressable>
                  )}
                  {actionsMenuView === 'pool' ? (
                    <>
                      {/* Pool deployments. */}
                      {poolOptions.length === 0 && (
                        <View className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary">
                          <Text className="font-pp-sans text-[14px] text-text-muted">
                            Loading pools…
                          </Text>
                        </View>
                      )}
                      {poolOptions.map((option) => (
                        <Pressable
                          key={option.poolVault}
                          className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                          onPress={() => {
                            setActionsDropdownOpen(false);
                            applyPoolSelection(option.isDefault
                              ? null
                              : { poolVault: option.poolVault, entrypoint: option.entrypoint, fromBlock: option.fromBlock });
                          }}
                        >
                          <Ionicons
                            name={option.isActive ? 'radio-button-on' : 'radio-button-off'}
                            size={16}
                            color={option.isActive ? colors.primary : colors.textMuted}
                          />
                          <Text className={`text-[14px] ${option.isActive ? 'font-pp-sans-semi-bold text-primary' : 'font-pp-sans text-text'}`}>
                            {option.label}
                          </Text>
                        </Pressable>
                      ))}
                    </>
                  ) : actionsMenuView === 'environment' ? (
                    <>
                      {/* Environment submenu (debug only on prod, always on staging): Prod / Staging. Picking
                          the other one persists it and reloads the page, which
                          is how the SDK session, caches and providers are rebuilt
                          for the other world (config/app-environment.ts). */}
                      {APP_ENVIRONMENTS.map((env) => {
                        const isActive = env === ACTIVE_APP_ENVIRONMENT;
                        return (
                          <Pressable
                            key={env}
                            className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                            testID={`menu-environment-${env}`}
                            onPress={() => {
                              setActionsDropdownOpen(false);
                              if (!isActive) applyAppEnvironment(env);
                            }}
                          >
                            <Ionicons
                              name={isActive ? 'radio-button-on' : 'radio-button-off'}
                              size={16}
                              color={isActive ? colors.primary : colors.textMuted}
                            />
                            <Text className={`text-[14px] ${isActive ? 'font-pp-sans-semi-bold text-primary' : 'font-pp-sans text-text'}`}>
                              {appEnvironmentLabel(env)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </>
                  ) : actionsMenuView === 'theme' ? (
                    <>
                      {/* One row per design variant. */}
                      {(Object.entries(DesignVariantNames) as [string, string][]).map(([variant, name]) => {
                        const variantNumber = Number(variant) as DesignVariant;
                        const isActive = variantNumber === ActiveDesignVariant;
                        return (
                          <Pressable
                            key={variant}
                            className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                            onPress={() => {
                              setActionsDropdownOpen(false);
                              applyDesignVariant(variantNumber);
                            }}
                          >
                            <Ionicons
                              name={isActive ? 'radio-button-on' : 'radio-button-off'}
                              size={16}
                              color={isActive ? colors.primary : colors.textMuted}
                            />
                            <Text className={`text-[14px] ${isActive ? 'font-pp-sans-semi-bold text-primary' : 'font-pp-sans text-text'}`}>
                              {name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </>
                  ) : actionsMenuView === 'payments' ? (
                    <>
                      {/* Payments submenu: request management + note import. */}
                      <Pressable className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={handleViewPaymentRequests}>
                        <Ionicons name="list-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          Payment Requests
                        </Text>
                      </Pressable>
                      <Pressable className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={handleImportNote}>
                        <Ionicons name="enter-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          Import Note
                        </Text>
                      </Pressable>
                      {/* EVM request records only; Stellar requests travel in its account backup. */}
                      {!connectedIsStellar && (<>
                      <Pressable className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={handleExportPaymentRequests}>
                        <Ionicons name="download-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          Export Payment Requests
                        </Text>
                      </Pressable>
                      <Pressable className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={handleImportPaymentRequests}>
                        <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          Import Payment Requests
                        </Text>
                      </Pressable>
                      </>)}
                    </>
                  ) : actionsMenuView === 'privacy' ? (
                    <>
                      {/* Privacy & keys submenu: keystore, account key, passkey. */}
                      {showRegisterKeystore && (
                        <Pressable className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={handleOpenRegisterKeystore}>
                          <Ionicons name="key-outline" size={16} color={colors.text} />
                          <Text className="font-pp-sans text-[14px] text-text">
                            Register Keystore
                          </Text>
                        </Pressable>
                      )}
                      {/* EVM X25519 key only; Sui sessions derive a different one. */}
                      {!connectedIsNonEvm && (
                        <Pressable
                          className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                          onPress={() => { setActionsDropdownOpen(false); openViewingKey(); }}
                          testID="menu-viewing-key"
                        >
                          <Ionicons name="eye-outline" size={16} color={colors.text} />
                          <Text className="font-pp-sans text-[14px] text-text">
                            Viewing Key
                          </Text>
                        </Pressable>
                      )}
                      {/* A passkey session has no wallet signature to export as an account key,
                          and neither has a Freighter session (the EVM account key
                          it would export does not exist). */}
                      {!passkeyActive && !(connectedIsStellar && !keySession) && (
                      <Pressable
                        className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                        onPress={() => { setActionsDropdownOpen(false); setExportKeyOpen(true); }}
                      >
                        <Ionicons name="key-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          Export Account Key
                        </Text>
                      </Pressable>
                      )}
                      {/* Only a connected EVM wallet can sign the ASP's SIWE message: a key,
                          passkey, Sui or Freighter session has no such wallet to check. */}
                      {evmConnected && !keySession && !passkeyActive && !connectedIsNonEvm && (
                      <Pressable
                        className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                        onPress={() => { setActionsDropdownOpen(false); walletScreening.run(); }}
                        disabled={walletScreening.running}
                        testID="menu-wallet-screening"
                      >
                        <Ionicons name="shield-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          {walletScreening.running ? 'Checking wallet...' : 'Check wallet status'}
                        </Text>
                      </Pressable>
                      )}
                      {/* Web only: the phone makes the code, this shows the QR.
                          exportAccountKey needs an EVM wallet or an imported key,
                          so a Sui or Freighter wallet session gets no row. */}
                      {Platform.OS === 'web' && !passkeyActive && !(connectedIsNonEvm && !keySession) && (
                      <Pressable
                        className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                        onPress={() => { setActionsDropdownOpen(false); setExportToMobileOpen(true); }}
                        testID="menu-export-key-to-mobile"
                      >
                        <Ionicons name="phone-portrait-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          Export account key to mobile
                        </Text>
                      </Pressable>
                      )}
                      {/* Native only: keys imported from the web, saved on this phone. */}
                      {mobileAccountKeys.available && (
                      <Pressable
                        className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                        onPress={() => { setActionsDropdownOpen(false); mobileAccountKeys.open('list'); }}
                        testID="menu-mobile-account-keys"
                      >
                        <Ionicons name="phone-portrait-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          Account keys
                        </Text>
                      </Pressable>
                      )}
                      <Pressable
                        accessibilityRole="button" testID="wallet-consolidate-notes"
                        className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                        onPress={() => { setActionsDropdownOpen(false); openConsolidation(); }}
                      >
                        <Ionicons name="layers-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">Consolidate notes</Text>
                      </Pressable>
                      {/* Notes backup: export/import the local note store —
                          the recovery path for a browser or device change.
                          EVM wallet sessions bind to the wagmi address, so a
                          key-only or Sui session would export/import against
                          the wrong identity. Stellar has its own sealed backup
                          for the Freighter account. */}
                      {((connectedIsStellar && stellarWallet.isConnected) || (isConnected && !connectedIsNonEvm && !keySession)) && (<>
                      <Pressable
                        className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                        onPress={() => { setActionsDropdownOpen(false); openExportNotesModal(); }}
                      >
                        <Ionicons name="download-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          Export Notes
                        </Text>
                      </Pressable>
                      <Pressable
                        className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                        onPress={() => { setActionsDropdownOpen(false); openImportNotesModal(); }}
                      >
                        <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          Import Notes
                        </Text>
                      </Pressable>
                      </>)}
                      {/* No passkey backup download here: the backup has no restore
                          path in the app yet, so offering it would promise a lifeboat
                          that cannot be used (codex on PR #36). */}
                      <Pressable
                        className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                        onPress={() => { setActionsDropdownOpen(false); setErrorReportsOpen(true); }}
                        testID="menu-error-reports"
                      >
                        <Ionicons name="bug-outline" size={16} color={colors.text} />
                        <Text className="font-pp-sans text-[14px] text-text">
                          {errorReportsMenuLabel(errorReportsEnabled)}
                        </Text>
                      </Pressable>
                    </>
                  ) : (
                  <>
                  {accountMenuNavItems.map((item) => (
                    <Pressable
                      key={item.label}
                      className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                      onPress={() => {
                        setActionsDropdownOpen(false);
                        router.push(item.href as never);
                      }}
                    >
                      <Ionicons
                        name={NAV_MENU_ICONS[item.label] ?? 'ellipse-outline'}
                        size={16}
                        color={colors.text}
                      />
                      <Text className="font-pp-sans text-[14px] text-text">
                        {item.label}
                      </Text>
                    </Pressable>
                  ))}
                  {showFinishSetup && (
                    <Pressable
                      className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                      onPress={handleOpenFinishSetup}
                      testID="menu-finish-setup"
                    >
                      <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
                      <Text className="font-pp-sans-medium text-[14px] text-warning">
                        Finish setup
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                    onPress={handleCopyAddress}
                  >
                    <Ionicons
                      name="copy-outline"
                      size={16}
                      color={colors.text}
                    />
                    <Text className="font-pp-sans text-[14px] text-text">
                      Copy Current Address
                    </Text>
                  </Pressable>
                  {showFinishSetup && (
                    <Text className="max-w-[260px] px-[12px] pb-[6px] font-pp-sans text-[12px] leading-[16px] text-warning">
                      {RECEIVE_WARNING}
                    </Text>
                  )}
                  {isConnected && (
                    <Pressable
                      className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                      onPress={handleAccounting}
                    >
                      <Ionicons
                        name="receipt-outline"
                        size={16}
                        color={colors.text}
                      />
                      <Text className="font-pp-sans text-[14px] text-text">
                        Accounting
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                    onPress={() => setActionsMenuView('payments')}
                  >
                    <Ionicons
                      name="list-outline"
                      size={16}
                      color={colors.text}
                    />
                    <Text className="flex-1 font-pp-sans text-[14px] text-text">
                      Payments
                    </Text>
                    <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
                  </Pressable>
                  <Pressable
                    className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                    onPress={() => setActionsMenuView('privacy')}
                  >
                    <Ionicons
                      name="key-outline"
                      size={16}
                      color={colors.text}
                    />
                    <Text className="flex-1 font-pp-sans text-[14px] text-text">
                      Privacy &amp; keys
                    </Text>
                    <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
                  </Pressable>
                  {/* Support: the public Telegram group, for everyone (Ameen,
                      2026-09-03, pre-launch). */}
                  <Pressable
                    className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                    onPress={() => { setActionsDropdownOpen(false); Linking.openURL(SUPPORT_TELEGRAM_URL); }}
                    testID="menu-support-telegram"
                  >
                    <Ionicons name="paper-plane-outline" size={16} color={colors.text} />
                    <Text className="flex-1 font-pp-sans text-[14px] text-text">
                      Support on Telegram
                    </Text>
                    <Ionicons name="open-outline" size={14} color={colors.textMuted} />
                  </Pressable>
                  {/* Which world the app talks to. Prod is the default; Staging is the
                      dev ASP, Sepolia and the whitelisted pools. Always shown (Pat,
                      2026-09-08): regular testers need Sepolia without knowing ?env=
                      or ?debug=1 (Artem: "too nerdy for regular testers"), and a tester
                      parked on staging must be able to get back to prod. */}
                  <Pressable
                    className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                    onPress={() => setActionsMenuView('environment')}
                    testID="menu-environment"
                  >
                    <Ionicons
                      name="server-outline"
                      size={16}
                      color={colors.text}
                    />
                    <Text className="flex-1 font-pp-sans text-[14px] text-text">
                      {`Environment: ${appEnvironmentLabel(ACTIVE_APP_ENVIRONMENT)}`}
                    </Text>
                    <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
                  </Pressable>
                  {INTERNAL_TOOLS_ENABLED && (
                  <Pressable
                    className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                    onPress={() => setActionsMenuView('theme')}
                  >
                    <Ionicons
                      name="color-palette-outline"
                      size={16}
                      color={colors.text}
                    />
                    <Text className="flex-1 font-pp-sans text-[14px] text-text">
                      Theme
                    </Text>
                    <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
                  </Pressable>
                  )}
                  {INTERNAL_TOOLS_ENABLED && (
                  <Pressable
                    className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                    onPress={() => setActionsMenuView('pool')}
                  >
                    <Ionicons
                      name="layers-outline"
                      size={16}
                      color={colors.text}
                    />
                    <Text className="flex-1 font-pp-sans text-[14px] text-text">
                      Pool
                    </Text>
                    <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
                  </Pressable>
                  )}
                  {/* Own node for the selected chain (config/custom-rpc.ts).
                      Last of the settings rows, above Sign Out. EVM only: the
                      Sui client is built by dapp-kit from its own config, so
                      the override cannot reach it. WEB only: the setting lives
                      in localStorage and takes effect on a page reload, neither
                      of which a native build has. The label is the "in force"
                      indicator — no custom endpoint, no second state. */}
                  {!activeIsNonEvm && Platform.OS === 'web' && (
                  <Pressable
                    className="flex-row items-center gap-[10px] px-[12px] py-[10px]"
                    onPress={() => { setActionsDropdownOpen(false); openCustomRpcModal(); }}
                    testID="menu-custom-rpc"
                  >
                    <Ionicons
                      name="globe-outline"
                      size={16}
                      color={customRpcInForce ? colors.primary : colors.text}
                    />
                    <Text className={`flex-1 text-[14px] ${customRpcInForce ? 'font-pp-sans-semi-bold text-primary' : 'font-pp-sans text-text'}`}>
                      {customRpcInForce ? 'Custom RPC: on' : 'Use custom RPC'}
                    </Text>
                  </Pressable>
                  )}
                  {/* Tor gets its own row rather than living inside the custom
                      RPC form, because it is not the same decision: it changes
                      how calls travel and works with OUR endpoints, so it needs
                      nothing else set up. Same form underneath, opened with the
                      endpoint fields folded away. Not gated like the custom
                      RPC row: that override is web-only localStorage, while
                      anon-rpc also runs on Android (SecureStore, the app
                      restarts to apply it). Neither reaches the Sui client. */}
                  {!activeIsNonEvm && (Platform.OS === 'web' || TOR_ON_DEVICE) && (
                  <Pressable
                    className="flex-row items-center gap-[10px] px-[12px] py-[10px]"
                    onPress={() => { setActionsDropdownOpen(false); openCustomRpcModal({ torOnly: true }); }}
                    testID="menu-tor"
                  >
                    {/* nw-keep(data-color): glyph color is a theme token into the vector-icon sink */}
                    <Ionicons
                      name="shield-checkmark-outline"
                      size={16}
                      color={TOR_IN_FORCE ? colors.primary : colors.text}
                    />
                    <Text className={`flex-1 text-[14px] ${TOR_IN_FORCE ? 'font-pp-sans-semi-bold text-primary' : 'font-pp-sans text-text'}`}>
                      {TOR_IN_FORCE ? 'anon-rpc: on' : 'Connect with anon-rpc'}
                    </Text>
                  </Pressable>
                  )}
                  <Pressable
                    className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                    onPress={keySession ? () => { setActionsDropdownOpen(false); signOutAccountKey(); mobileAccountKeys.signedOut(); } : handleDisconnect}
                  >
                    <Ionicons
                      name="log-out-outline"
                      size={16}
                      color={colors.text}
                    />
                    <Text className="font-pp-sans text-[14px] text-text">
                      Sign Out
                    </Text>
                  </Pressable>
                  </>
                  )}
                </View>
              </>
            )}
          </View>

          {/* Chain selector — options come from getSupportedChains() (the
              configured supportedChainIds), never a hardcoded list, so a
              build can't offer a chain it has no deployment for. Sui is
              debug-gated (see selectableChains above); with a single visible
              chain the selector is hidden entirely. */}
          {showSessionControls && selectableChains.length > 1 && (
          <View className="relative z-[99999]">
            <Pressable
              className="h-[28px] w-[28px] items-center justify-center rounded-pill bg-background-secondary"
              onPress={() => { setChainSelectorOpen(!chainSelectorOpen); setActionsDropdownOpen(false); }}
              testID="header-chain-selector"
              accessibilityRole="button"
              accessibilityLabel="Select network"
            >
              <ChainLogo chain={activeChain ? chainLogoFor(activeChain) : 'ethereum'} />
            </Pressable>
            {chainSelectorOpen && (
              <>
                <Pressable
                  className="inset-0 z-[9998]"
                    // nw-keep(platform-css): fixed on web to cover the viewport; native keeps legacy positioning
                    style={HEADER_OVERLAY}
                  onPress={() => setChainSelectorOpen(false)}
                />
                <View
                  className="absolute right-0 top-[32px] z-[99999] min-w-[230px] rounded-card border border-border-light bg-menu-background p-[6px]"
                  // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                  style={DROPDOWN_SHADOW}
                >
                  {selectableChains.map((chain) => (
                    <Pressable
                      key={chain.id}
                      className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                      onPress={() => handleSelectChain(chain.id)}
                      testID={`header-chain-option-${chain.id}`}
                    >
                      <ChainLogo chain={chainLogoFor(chain)} />
                      <Text className="font-pp-sans text-[14px] text-text">
                        {chain.displayName}
                      </Text>
                      {activeChainId === chain.id && (
                        <Ionicons
                          name="checkmark"
                          size={14}
                          color={colors.text}
                          // nw-keep(third-party-style-api): ml-auto on a vector-icon glyph (no className path)
                          style={{ marginLeft: 'auto' }}
                        />
                      )}
                    </Pressable>
                  ))}
                </View>
              </>
            )}
          </View>
          )}

          {showSessionControls && <View className="relative z-[99999]">
            <Pressable
              className={`h-[28px] w-[28px] items-center justify-center rounded-pill bg-background-secondary ${syncEverythingBusy ? 'opacity-50' : 'opacity-100'}`}
              onPress={handleSync}
              disabled={syncEverythingBusy}
              accessibilityRole="button"
              accessibilityLabel="Refresh balances and activity"
              testID="header-sync"
            >
              <Ionicons name="sync-outline" size={16} color={colors.text} />
            </Pressable>
          </View>}

          <View className="relative z-[99999]">
            <Pressable
              className="h-[28px] w-[28px] items-center justify-center rounded-pill bg-background-secondary"
              onPress={handleThemeToggle}
            >
              <Ionicons
                name={colorScheme === 'dark' ? 'sunny-outline' : 'moon-outline'}
                size={16}
                color={colors.text}
              />
            </Pressable>
          </View>
        </View>
      </View>

      <AccountKeyExportModal visible={exportKeyOpen} onClose={() => setExportKeyOpen(false)} />
      <ErrorReportsModal visible={errorReportsOpen} onClose={() => setErrorReportsOpen(false)} />
      {/* Mounted only while open: closing unmounts it, so the code, key and QR go with it. */}
      {Platform.OS === 'web' && exportToMobileOpen ? (
        <AccountKeyToMobileModal visible onClose={() => setExportToMobileOpen(false)} />
      ) : null}

    </View>
  );
}
