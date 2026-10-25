import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { usePoolSession } from '@/hooks/use-pool-session';
import { ExploreTabBar, type MobileNavTab } from '@/components/home/explore-tab-bar';
import { parsePanelParam } from '@/components/home/explore-panel';
import { MobileMoreDrawer } from '@/components/mobile-more-drawer';
import { getUiParam, installUiUrlGuard, subscribeUiUrl } from '@/components/ui-url-events';

import { useAppNavigation } from '@/hooks/use-app-navigation';
import { showBottomNav } from '@/services/header-nav';
import { redirectPhonePanel } from '@/services/home-navigation';
import { useChainRouter } from '@/hooks/use-chain-router';
import { NATIVE_BAR_TABS } from '@/services/native-bar-tabs';

/**
 * The phone's navigation, mounted once for the whole app.
 *
 * It lives at the root rather than inside the home screen because it replaces
 * the header's hamburger: if it only existed on home, every other mobile page
 * would lose its page links. Data tabs use full-page routes (`/explore/…`);
 * "Shield" returns to the retained home workspace.
 * "More" opens a drawer with the page links and, one level down, the former
 * footer links. The bar stays mounted over the explore pages — they are peers
 * in its navigation, and the active pill follows the route.
 */
export function MobileNav() {
  const { width } = useWindowDimensions();
  const navigateTo = useAppNavigation();
  const pathname = usePathname();
  const { isConnected } = useMultiChainWallet();
  const { identityMode, sessionAddress } = usePoolSession();
  const hasAccount = isConnected || (identityMode === 'key' && !!sessionAddress);
  const router = useRouter();
  const chainRouter = useChainRouter();
  // Non-EVM chain (Sui or Stellar): Portfolio redirects home there.
  const nonEvm = chainRouter.isSui || chainRouter.isStellar;
  const [moreOpen, setMoreOpen] = useState(false);
  const [panel, setPanel] = useState<string | null>(null);
  // On a real touchscreen, one tap on the jelly bar produces the RNGH gesture
  // (drawer opens on touchend) AND the browser's synthesized `click` ~300ms
  // later at the same spot — which by then lands on the freshly-opened
  // drawer's backdrop and closes it again: "nothing happens". Guard both
  // directions: swallow a second toggle AND a close that arrives within the
  // synthesized-click window of the open.
  const lastMoreToggleRef = useRef(0);

  // Track `?panel=` so the bar can step aside while a legacy data sheet is
  // open (deep links / home doors still use the drawer) — the sheet covers
  // the bottom ~78% and would strand the bar behind it. Reading the URL
  // (rather than a prop) is what lets this live outside the home screen.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    installUiUrlGuard();
    // Parsed, not raw: an unrecognised value is NOT an open sheet, so a link
    // like /?panel=bogus can never hide the bar and strand navigation.
    const sync = () => setPanel(parsePanelParam(getUiParam('panel')) ? getUiParam('panel') : null);
    sync();
    return subscribeUiUrl(sync);
  }, []);

  const onSelect = useCallback(
    (tab: MobileNavTab) => {
      if (tab === 'more') {
        const now = Date.now();
        if (now - lastMoreToggleRef.current < 400) return;
        lastMoreToggleRef.current = now;
        setMoreOpen((open) => !open);
        return;
      }
      setMoreOpen(false);

      if (tab === 'shield') {
        // Return to the existing workspace and its remembered panel.
        navigateTo('/');
        return;
      }

      if (tab === 'portfolio') {
        // Sui/Stellar have no Portfolio (it redirects home): balances instead.
        navigateTo(nonEvm ? '/explore/balances' : '/portfolio');
        return;
      }

      if (tab === 'stats') {
        navigateTo('/explore');
        return;
      }

      // Native-only tabs carry their own route (none on web).
      const nativeTab = NATIVE_BAR_TABS.find((t) => t.key === tab);
      if (nativeTab) {
        navigateTo(nativeTab.href);
        return;
      }

      // My balances / My activity are no longer bar tabs: both live on Portfolio.
      navigateTo(nonEvm ? '/explore/balances' : '/portfolio');
    },
    [navigateTo, nonEvm],
  );

  // On a phone the balances and activity sheets are gone from the bar, so a
  // `?panel=balances|activity` deep link lands on Portfolio, which carries
  // both (positions plus the collapsible "My transactions"). redirectPhonePanel
  // drops the panel from the remembered home destination first, and replace
  // (not navigateTo, which would re-remember this URL) drops the entry, so
  // Shield and Back both reach home instead of bouncing here again.
  const bottomNav = showBottomNav(width);
  useEffect(() => {
    if (!bottomNav) return;
    // `panel` is only ever a parsed value (see the sync above).
    const target = redirectPhonePanel(panel as 'balances' | 'activity' | null, {
      nonEvm,
      signedIn: hasAccount,
    });
    if (target) router.replace(target);
  }, [bottomNav, panel, nonEvm, hasAccount, router]);

  if (!bottomNav) return null;

  // The active pill follows the route; the More drawer overrides while open.
  const routeTab: MobileNavTab | null =
    pathname === '/explore'
      ? 'stats'
      : pathname === '/' || pathname === ''
      ? 'shield'
      : pathname === '/portfolio' || (nonEvm && pathname === '/explore/balances')
        ? 'portfolio'
        : NATIVE_BAR_TABS.find((t) => t.href === pathname)?.key ?? null;
  const active: MobileNavTab | null = moreOpen ? 'more' : routeTab;

  // A legacy data sheet is open: hand the bottom of the screen over to it.
  const sheetOpen = !!panel;

  return (
    <>
      {!sheetOpen && (
        <ExploreTabBar active={active} onSelect={onSelect} isConnected={hasAccount} />
      )}
      <MobileMoreDrawer
        visible={moreOpen}
        onClose={() => {
          // The tap that OPENED the drawer must not also close it via its
          // synthesized click on the backdrop.
          if (Date.now() - lastMoreToggleRef.current < 500) return;
          setMoreOpen(false);
        }}
      />
    </>
  );
}
