import { useEffect, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { usePathname } from 'expo-router';
import { useAccount } from 'wagmi';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { usePoolSession } from '@/hooks/use-pool-session';
import { notificationsParamAction } from '@/services/notifications-param';
import { ActivityDrawer } from '@/components/home/activity-drawer';
import { TokenSelectSheet } from '@/components/ui/token-select-sheet';
import { registerTokenSheetHost, type TokenSheetRequest } from '@/services/token-sheet-host';
import { NotificationsSheet } from '@/components/ui/notification-center';
import { PANEL_PARAMS, parsePanelParam } from '@/components/home/explore-panel';
import {
  getUiParam,
  installUiUrlGuard,
  notifyUiUrl,
  retireUiParamEntry,
  subscribeUiUrl,
} from '@/components/ui-url-events';

/** Below this the notification bell opens a sheet rather than a dropdown. */
const NOTIFICATIONS_SHEET_MAX_WIDTH = 768;
/** How long "no session" must hold before ?notifications=1 is dropped. */
const NOTIFICATIONS_STRIP_GRACE_MS = 5_000;

/**
 * Sheets that must exist OUTSIDE any screen, mounted once at the app root.
 *
 * Two reasons they live here rather than where they are triggered:
 *
 *  1. STACKING. The notification sheet used to render inside the header. A
 *     `position: fixed` element is still trapped by an ancestor that creates a
 *     stacking context, so its z-index 100000 lost to the root-level bottom bar
 *     at z-900 and the bar painted over the sheet.
 *  2. REACH. The data drawers used to belong to the home screen, so opening
 *     "My balances" from /portfolio had to navigate home first. Rendered here
 *     they open in place, on whatever page you are on.
 *
 * The home screen still owns the panel on `/` itself — it has the desktop split
 * screen and its own history handling, both already verified — so this skips
 * that route rather than competing with it.
 */
export function GlobalSheets() {
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const [panel, setPanel] = useState<string | null>(null);
  const [notifications, setNotifications] = useState(false);
  // Token sheet published from inside a transformed subtree (the action hub).
  // See services/token-sheet-host.ts: a transformed ancestor becomes the
  // containing block for position:fixed, so the sheet has to be painted here to
  // get a scrim that actually covers the page.
  const [tokenSheet, setTokenSheet] = useState<TokenSheetRequest | null>(null);
  useEffect(() => registerTokenSheetHost(setTokenSheet), []);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    installUiUrlGuard();
    const sync = () => {
      setPanel(getUiParam('panel'));
      setNotifications(getUiParam('notifications') === '1');
    };
    sync();
    // The URL can be written programmatically (bottom bar, bell), which fires no
    // popstate — explicit notifications and the wrapped History writes both
    // land here.
    const unsubscribe = subscribeUiUrl(sync);
    return unsubscribe;
  }, []);

  // The bell only exists for a session, so its sheet does too (DEV-454).
  const { isConnected } = useMultiChainWallet();
  const { status: walletStatus } = useAccount();
  const { identityMode } = usePoolSession();
  const notificationsAction = notificationsParamAction({
    requested: notifications,
    sessionActive: isConnected || identityMode === 'key',
    walletSettling: walletStatus === 'connecting' || walletStatus === 'reconnecting',
  });
  // Strip only once no session has held for a while: only wagmi reports a
  // reconnect in progress, and a Sui or Stellar wallet restores itself
  // asynchronously after mount (review). The sheet stays closed meanwhile.
  useEffect(() => {
    if (notificationsAction !== 'strip') return;
    const timer = setTimeout(() => {
      retireUiParamEntry('notifications');
      notifyUiUrl();
    }, NOTIFICATIONS_STRIP_GRACE_MS);
    return () => clearTimeout(timer);
  }, [notificationsAction]);

  const section = parsePanelParam(panel);
  const onHome = (pathname ?? '/') === '/';
  // Home renders its own panel (split screen on desktop, sheet on mobile).
  const showPanel = !!section && !onHome;

  const closePanel = () => {
    retireUiParamEntry('panel');
    notifyUiUrl('panel-user-action');
    setPanel(null);
  };
  const closeNotifications = () => {
    retireUiParamEntry('notifications');
    notifyUiUrl();
    setNotifications(false);
  };

  return (
    <>
      {showPanel && (
        <ActivityDrawer visible section={section ?? PANEL_PARAMS.balances} onClose={closePanel} />
      )}
      {notificationsAction === 'show' && width <= NOTIFICATIONS_SHEET_MAX_WIDTH && (
        <NotificationsSheet onClose={closeNotifications} />
      )}
      {tokenSheet && (
        // nw-keep(forwarded-style-contract): the conditional spreads below forward
        // OPTIONAL props to the sheet (title, balanceMode, selectedChainId), so
        // an absent value stays absent instead of overriding the sheet's own
        // default with undefined. They carry no styling.
        <TokenSelectSheet
          tokens={tokenSheet.tokens}
          networks={tokenSheet.networks}
          selectedAddress={tokenSheet.selectedAddress}
          {...(tokenSheet.selectedChainId !== undefined ? { selectedChainId: tokenSheet.selectedChainId } : {})}
          activeNetworkId={tokenSheet.activeNetworkId}
          chainId={tokenSheet.chainId}
          isSui={tokenSheet.isSui}
          {...(tokenSheet.title ? { title: tokenSheet.title } : {})}
          {...(tokenSheet.balanceMode !== undefined ? { balanceMode: tokenSheet.balanceMode } : {})}
          {...(tokenSheet.allowCustomSelection !== undefined ? { allowCustomSelection: tokenSheet.allowCustomSelection } : {})}
          {...(tokenSheet.hideZeroBalances !== undefined ? { hideZeroBalances: tokenSheet.hideZeroBalances } : {})}
          onSelectToken={tokenSheet.onSelectToken}
          onSelectNetwork={tokenSheet.onSelectNetwork}
          onClose={tokenSheet.onClose}
        />
      )}
    </>
  );
}
