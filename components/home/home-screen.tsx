import { useTabBarClearance } from '@/hooks/use-tab-bar-clearance';
import { LANDING_HERO } from '@/config/landing-hero';
import { LayoutTransition } from './layout-transition';
import { showBottomNav } from '@/services/header-nav';
import { actionHubFitScale, actionHubScaleOffset, actionHubScaledHeight } from '@/services/action-hub-fit';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, ScrollView, Text, View, useWindowDimensions, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { clearHomePanel, rememberHomeLocation } from '@/services/home-navigation';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';

import { usePoolSession } from '@/hooks/use-pool-session';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { usePools } from '@/components/pools-provider';
import { Header } from '@/components/ui/header';
import { Footer } from '@/components/ui/footer';

import { HeroHeading } from '@/components/home/hero-heading';
import { LandingEntranceStyles } from '@/components/home/landing-entrance';
import { ActionHub } from '@/components/home/action-hub';
import { HubErrorBoundary } from '@/components/home/hub-error-boundary';
import { LatestActivity } from '@/components/home/latest-activity';
import { HomePools } from '@/components/home/home-pools';
import { StatBand } from '@/components/home/stat-band';
import { ActivityDrawer } from '@/components/home/activity-drawer';
import { PanelHeading, PanelSections, type DrawerSection } from '@/components/home/explore-panel';
import { EXPLORE_TABS, exploreTabLabel } from '@/components/home/explore-tab-bar';
import { RegistrationStatusCard } from '@/components/home/registration-status-card';
import {
  CENTERED_MAX_WIDTH,
  EMPTY_SELECTION,
  ExplorePanelProvider,
  SPLIT_GAP,
  SPLIT_LEFT_WIDTH,
  SPLIT_MAX_WIDTH,
  SPLIT_MIN_WIDTH,
  type ExplorePanelSurface,
  type PanelSelection,
  type SelectAssetInput,
} from '@/components/home/explore-panel-context';
import { getUiParam, installUiUrlGuard, notifyUiUrl, subscribeUiUrl } from '@/components/ui-url-events';
import { CARD_SHADOW } from '@/components/ui/web-style-shims';

// Keep the editorial content out of the initial transaction bundle.
const FrontPage = lazy(() =>
  import('@/components/home/front-page').then((m) => ({ default: m.FrontPage })),
);

// The drawers live in the URL (`/?panel=…`) so My balances and All activity
// are deep-linkable and the browser back button closes them. `pools` is no
// longer a panel — the pool directory lives on /explore.
const PANEL_TO_SECTION: Record<string, DrawerSection> = {
  balances: 'mine',
  activity: 'activity',
};
const SECTION_TO_PANEL: Record<DrawerSection, string> = {
  mine: 'balances',
  activity: 'activity',
};

// expo-router 55 can collapse same-tab query-param PUSH navigations into
// replaceState on web. Drawer URLs are UI state, so create a real browser
// entry and let popstate drive this component when Platform.OS === 'web'.
const WEB_PANEL_HISTORY_STATE_KEY = '__ppv2HomePanelEntry';

function getWebPanelParam() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
  if (window.location.pathname !== '/') return undefined;
  return getUiParam('panel') ?? undefined;
}

function getHomeUrlWithPanel(panel: string) {
  const url = new URL(window.location.href);
  url.pathname = '/';
  url.searchParams.set('panel', panel);
  return `${url.pathname}${url.search}${url.hash}`;
}

function getHomeUrlWithoutPanel() {
  const url = new URL(window.location.href);
  url.pathname = '/';
  url.searchParams.delete('panel');
  return `${url.pathname}${url.search}${url.hash}`;
}

function createWebPanelHistoryState() {
  // Preserve whatever expo-router stored (notably its entry `id`) so its
  // id-based index bookkeeping stays coherent while our entry is current.
  const base = isObjectHistoryState(window.history.state) ? window.history.state : {};
  return { ...base, [WEB_PANEL_HISTORY_STATE_KEY]: true };
}

function isObjectHistoryState(state: unknown): state is Record<string, unknown> {
  return typeof state === 'object' && state !== null && !Array.isArray(state);
}

function stripWebPanelHistoryState(state: unknown) {
  if (!isObjectHistoryState(state)) return state;
  const next = { ...state };
  delete next[WEB_PANEL_HISTORY_STATE_KEY];
  return next;
}

/**
 * Fade in each new section with a small rise. Reduced motion shows it immediately.
 */
function FadeSwap({ swapKey, className, children }: { swapKey: string; className?: string; children: React.ReactNode }) {
  return (
    <FadeSwapInner key={swapKey} className={className}>
      {children}
    </FadeSwapInner>
  );
}

function FadeSwapInner({ className, children }: { className?: string; children: React.ReactNode }) {
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const reduce =
      Platform.OS === 'web'
      && typeof window !== 'undefined'
      && !!window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      anim.setValue(1);
      return;
    }
    const animation = Animated.timing(anim, {
      toValue: 1,
      duration: 280,
      easing: Easing.bezier(0.32, 0, 0.2, 1),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [anim]);
  return (
    // nw-keep(animated): mount-keyed fade/rise for the focus swap (time-based but one-shot on swap, instant under prefers-reduced-motion)
    <Animated.View
      className={className}
      style={{
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Where the stuck action column parks: clear of the overlay Header, which the
 * scroll container already allows for with its `pt-[95px]` content padding.
 * Sticky offsets are measured from the SCROLL PORT, not from that padding, so
 * this repeats the 95 rather than adding to it.
 */
const STICKY_HUB_TOP = 95;
/** Breathing room below the stuck column before it is judged too tall to pin. */
const STICKY_HUB_BOTTOM_GAP = 24;
// `position: sticky` is not in React Native's ViewStyle. It is real on the web,
// which is the only platform this is applied on: see `stickyHub`.
const STICKY_HUB_STYLE = {
  position: 'sticky',
  top: STICKY_HUB_TOP,
  alignSelf: 'flex-start',
} as unknown as ViewStyle;

export function HomeScreen() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const focused = useIsFocused();
  const { panel } = useLocalSearchParams<{ panel?: string | string[] }>();
  const expoPanelParam = Array.isArray(panel) ? panel[0] : panel;
  const [webPanelParam, setWebPanelParam] = useState<string | undefined>(() => getWebPanelParam() ?? expoPanelParam);
  const panelParam = Platform.OS === 'web' ? webPanelParam : expoPanelParam;
  const drawer: DrawerSection | null = panelParam ? PANEL_TO_SECTION[panelParam] ?? null : null;

  const openDrawer = useCallback(
    (section: DrawerSection) => {
      const nextPanel = SECTION_TO_PANEL[section];

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        // Subscribe to browser Back/Forward even before any modal has opened.
        installUiUrlGuard();
        const nextUrl = getHomeUrlWithPanel(nextPanel);
        const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

        if (currentUrl !== nextUrl) {
          // Back closes a newly opened panel. Switching sections replaces
          // that entry so Back does not walk through every selected section.
          const switching = !!getWebPanelParam();
          if (switching) {
            window.history.replaceState(createWebPanelHistoryState(), '', nextUrl);
          } else {
            window.history.pushState(createWebPanelHistoryState(), '', nextUrl);
          }
          notifyUiUrl('panel-user-action');
        }

        setWebPanelParam(nextPanel);
        return;
      }

      router.push({ pathname: '/', params: { panel: nextPanel } });
    },
    [router],
  );

  const closeDrawer = useCallback(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      // X is a local dismissal, never browser Back: the previous entry may
      // be Explore/Portfolio after returning to a remembered workspace.
      if (!focused || window.location.pathname !== '/') return;
      installUiUrlGuard();
      const url = new URL(getHomeUrlWithoutPanel(), window.location.origin);
      window.history.replaceState(stripWebPanelHistoryState(window.history.state), '', `${url.pathname}${url.search}${url.hash}`);
      notifyUiUrl('panel-user-action');
      rememberHomeLocation(url);
      setWebPanelParam(undefined);
      // Clear Expo's copy too, so the next action-tab update cannot resurrect
      // a panel that arrived through the remembered My Pools destination.
      router.setParams({ panel: undefined, ...Object.fromEntries(url.searchParams) });
      return;
    }

    // Normal flow: pop the pushed history entry so back/forward stay sane.
    // Deep-linked directly (no history): rewrite to the bare home URL.
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, [router, focused]);

  // Native deep links still need an in-app back destination. Web keeps the
  // browser's route history; X closes in place and never needs to rebase it.
  const rebasedRef = useRef(false);
  useEffect(() => {
    if (Platform.OS === 'web' || !focused || rebasedRef.current) return;
    rebasedRef.current = true;
    if (expoPanelParam && !router.canGoBack()) {
      router.replace('/');
      router.push({ pathname: '/', params: { panel: expoPanelParam } });
    }
  }, [expoPanelParam, focused, router]);

  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !focused) return;
    const syncPanelFromLocation = () => {
      // Inactive stack/tab screens stay mounted. Another page's URL must not
      // close their panel or start an exit animation behind the incoming page.
      if (window.location.pathname !== '/') return;
      rememberHomeLocation(window.location);
      setWebPanelParam(getWebPanelParam());
    };
    syncPanelFromLocation();
    return subscribeUiUrl(syncPanelFromLocation);
  }, [focused]);

  // Use the same active wallet state as the app, including Sui. Account-key
  // sessions also enter the working surface without connecting a wallet.
  const { isConnected } = useMultiChainWallet();
  const { sessionAddress } = usePoolSession();
  const hasAccount = isConnected || !!sessionAddress;
  const previousHasAccount = useRef(hasAccount);
  useEffect(() => {
    const disconnected = previousHasAccount.current && !hasAccount;
    previousHasAccount.current = hasAccount;
    // Close an account's open panel on sign-out. Already-disconnected users
    // can still deliberately explore public activity without being redirected.
    if (disconnected) {
      clearHomePanel();
      if (focused && drawer) closeDrawer();
      else setWebPanelParam(undefined);
    }
  }, [hasAccount, drawer, closeDrawer, focused]);
  // Remember the initial visit only for entrance motion; it
  // must never override the current account when deciding what is visible.
  const [landingVisit, setLandingVisit] = useState(() => Platform.OS === 'web' && !hasAccount);
  // The stack keeps Home mounted but hides it with display:none. Browsers
  // restart CSS animations when that ancestor becomes visible again.
  // Retire the entrance before committing a departure, even mid-animation.
  if (landingVisit && !focused) setLandingVisit(false);
  const scrollAccount = useRef(hasAccount);
  useLayoutEffect(() => {
    if (scrollAccount.current === hasAccount) return;
    scrollAccount.current = hasAccount;
    if (Platform.OS !== 'web') return;
    // The story is added/removed in this commit. Smooth scrolling here fights
    // the new page height and leaves the form moving beneath the header.
    scrollViewRef.current?.scrollTo({ y: 0, animated: false });
  }, [hasAccount]);
  const { data } = usePools();
  // Clear legacy onboarding links on engagement. The intro parameter never
  // overrides a connected account's working surface.
  const [introForced, setIntroForced] = useState(
    () => Platform.OS === 'web' && typeof window !== 'undefined'
      && new URL(window.location.href).searchParams.get('intro') === 'true',
  );
  const dismissIntro = useCallback(() => {
    setIntroForced(false);
    // Clear the param in BOTH url layers: raw history (the visible URL) and
    // Expo Router's param state — a later shallow setParams({action}) would
    // otherwise merge the stale `intro` back in and a reload resurrects it.
    // The router rebuild strips raw-history-only params (panel/tx/connect),
    // so carry every OTHER live param through, same as the hub tabs do.
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('intro');
      router.setParams({ intro: undefined, ...Object.fromEntries(url.searchParams) });
      if (new URL(window.location.href).searchParams.get('intro') !== null) {
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } else {
      router.setParams({ intro: undefined });
    }
  }, [router]);
  const [heroHeight, setHeroHeight] = useState(0);
  const [heroAnim] = useState(() => new Animated.Value(hasAccount ? 0 : 1));

  // Panels follow the current URL directly, without delayed mount/exit state.
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const canSplit = Platform.OS === 'web' && viewportWidth >= SPLIT_MIN_WIDTH;
  const splitOpen = canSplit && drawer !== null;
  const splitMounted = splitOpen;
  const panelSection = drawer ?? 'activity';

  // Escape closes the split panel, mirroring the sheet and the modals.
  useEffect(() => {
    if (Platform.OS !== 'web' || !splitOpen || typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [splitOpen, closeDrawer]);

  // Measured width of the data column. The tables inside pick their column
  // count from THIS rather than the window — see explore-panel-context.
  const [panelWidth, setPanelWidth] = useState(0);

  // Two-way selection: picking an asset on the right loads it into the shield
  // widget on the left, and the widget's own token pills write back here so
  // the panel can highlight the matching row.
  const [selection, setSelection] = useState<PanelSelection>(EMPTY_SELECTION);
  const selectAsset = useCallback((next: SelectAssetInput) => {
    setSelection({
      assetSymbol: next.assetSymbol,
      poolId: next.poolId ?? null,
      chainId: next.chainId ?? null,
    });
  }, []);
  const panelSurface: ExplorePanelSurface = splitMounted ? 'split' : drawer ? 'sheet' : 'page';

  // Two doors now — the pool directory moved to /explore, so there is
  // no third door to order. Balances leads for a signed-in account.
  const orderedDoors = useMemo(() => {
    const by = (k: string) => EXPLORE_TABS.find((t) => t.key === k)!;
    return hasAccount ? [by('mine'), by('activity')] : EXPLORE_TABS;
  }, [hasAccount]);

  // Shown on the My balances door, so the number you care about is legible
  // without opening anything. Suppressed at zero: "(\$0)" is worse than nothing,
  // and it reads as broken while the account is still unlocking.
  const myBalanceLabel = useMemo(() => {
    const raw = data.myPoolsStats?.acceptedFundsValue;
    if (!raw) return null;
    const numeric = parseFloat(raw.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(numeric) && numeric > 0 ? raw : null;
  }, [data.myPoolsStats?.acceptedFundsValue]);

  // The bar itself is mounted app-wide (components/mobile-nav.tsx) because it
  // replaces the header hamburger on every route, not just this one. All this
  // screen still needs to know is whether to leave foot room for it — and not
  // to, while a sheet is open, since the bar steps aside for the sheet.
  const tabClearance = useTabBarClearance();
  const showTabBar = showBottomNav(viewportWidth) && drawer === null;

  const containerMaxWidth = splitMounted ? SPLIT_MAX_WIDTH : CENTERED_MAX_WIDTH;
  // One size for the shortcuts whether or not a panel is open, so they do not
  // shrink beside it; a long label truncates rather than scaling down.
  const doorGap = splitMounted ? 8 : 10;
  const doorPadX = 14;
  const doorPadY = 9;
  const doorFont = 14;
  const doorIcon = 15;

  const scrollViewRef = useRef<ScrollView | null>(null);
  const reducedMotion = Platform.OS === 'web' && typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const frontAction = useCallback(
    (tab: 'shield' | 'send' | 'swap' | 'request' | 'withdraw') => {
      const livePanel = Platform.OS === 'web' && typeof window !== 'undefined' ? getUiParam('panel') : null;
      router.setParams(livePanel ? { action: tab, panel: livePanel } : { action: tab });
      scrollViewRef.current?.scrollTo({ y: 0, animated: false });
    },
    [router],
  );
  const scrollToStory = useCallback(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const scroller = scrollViewRef.current?.getScrollableNode?.() as HTMLElement | undefined;
    const act = document.querySelector('[data-testid="front-act-1"]');
    if (!scroller || !act) return;
    const y = act.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scrollViewRef.current?.scrollTo({ y: Math.max(0, y - 24), animated: !reducedMotion });
  }, [reducedMotion]);

  // Typing an amount means the user is ACTING, not browsing: on web the page
  // reduces to the form — the marketing (headline, story, scroll hint) steps
  // aside and so does the resting below-fold (activity, crowd numbers, pools)
  // — then all of it comes back on blur. Driven by the amount input's own
  // focus/blur pair, NOT onEngage, which also fires from button presses that
  // never blur. The blur is debounced a beat so tapping a token pill (input
  // blur -> press) does not flash the swap.
  const [inputFocused, setInputFocused] = useState(false);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // How tall the page must stay while typing, in px: the viewport plus wherever
  // the visitor had scrolled to when they reached for the field. A viewport's
  // worth is NOT enough — the resting landing scrolls for thousands of pixels,
  // the focused one for about a hundred, so any real scroll offset would still
  // be clamped and replayed as a slide. Measured at the moment of focus,
  // because that is the only moment the old height still exists.
  const [focusFloorPx, setFocusFloorPx] = useState(0);
  const onHubInputFocus = useCallback(() => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    if (Platform.OS === 'web') {
      const scroller = scrollViewRef.current?.getScrollableNode?.() as HTMLElement | undefined;
      if (scroller) setFocusFloorPx(scroller.clientHeight + scroller.scrollTop);
    }
    setInputFocused(true);
  }, []);
  const onHubInputBlur = useCallback(() => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    blurTimerRef.current = setTimeout(() => {
      setInputFocused(false);
      setFocusFloorPx(0);
    }, 160);
  }, []);
  useEffect(() => () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
  }, []);
  // Navigating away keeps this route mounted, so a field left focused would
  // hold the page in typing mode until the visitor came back and blurred it.
  useEffect(() => {
    if (focused) return;
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    setInputFocused(false);
    setFocusFloorPx(0);
  }, [focused]);

  // The headline, story and wide layout share one visibility decision. A
  // button press cannot permanently fold only the headline, and a restored
  // session follows the same rules as a wallet connected during this visit.
  const hideHero = hasAccount || splitMounted || inputFocused;
  const marketingSlot = Platform.OS === 'web' && !hideHero;
  const landingHero = marketingSlot;
  const landingWide = landingHero && viewportWidth >= 1024;
  // Typing gets the form and nothing else: a visitor entering an amount is not
  // reading the crowd's numbers or the pool list, and leaving them mounted just
  // moves the form under the caret as the page reflows. They come back on blur
  // with the rest of the page.
  //
  // WEB ONLY, deliberately. On web this reads as a narrowing but it is really a
  // deletion — the resting page shows the story instead of these cards, so with
  // typing excluded too there is no web state left that renders them, and they
  // survive only on native. Native keeps them because it has no story to swap
  // in: hiding them there would leave the widget on bare canvas mid-keystroke.
  const showPoolSummaries = !splitMounted && !marketingSlot && !hasAccount
    && !(Platform.OS === 'web' && inputFocused);
  // The one state this rule is about: the web landing, signed out, no panel,
  // field focused. `inputFocused` on its own is NOT that — it is also true for
  // a signed-in page, an open split panel and every native screen, none of
  // which hide anything on focus and so must keep their own height.
  const focusedLanding = Platform.OS === 'web' && !hasAccount && !splitMounted && inputFocused;

  useEffect(() => {
    if (reducedMotion || Platform.OS === 'web') {
      heroAnim.setValue(hideHero ? 0 : 1);
      return;
    }
    if (hideHero) {
      // Spring into focus mode: the hero folds away while the action card
      // grows to full size with a soft iPhone-style overshoot.
      Animated.spring(heroAnim, {
        toValue: 0,
        tension: 50,
        friction: 10,
        // JS driver: height + margin can't ride the native driver.
        useNativeDriver: false,
      }).start();
    } else {
      Animated.timing(heroAnim, {
        toValue: 1,
        duration: 450,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: false,
      }).start();
    }
  }, [hideHero, heroAnim, reducedMotion]);

  // The vertical space between the widget and the shortcut row: the column's
  // own gap-[12px] plus the row's mt-[12px]. Keep in step with both classes.
  const HUB_DOORS_GAP = 24;
  // --- Action widget fit (services/action-hub-fit.ts) ---
  // On a short desktop viewport the widget scales down so the shortcut row it
  // owns stays on screen. Mobile is excluded: it has the bottom tab bar
  // instead of this row, and a phone page is expected to scroll.
  const hubFrameRef = useRef<View>(null);
  const [hubHeight, setHubHeight] = useState(0);
  const [doorsHeight, setDoorsHeight] = useState(0);
  const [hubTop, setHubTop] = useState(0);
  const hubFitEnabled = Platform.OS === 'web' && !showTabBar;
  useLayoutEffect(() => {
    if (!hubFitEnabled || typeof window === 'undefined') return;
    const node = hubFrameRef.current as unknown as HTMLElement | null;
    if (typeof node?.getBoundingClientRect !== 'function') return;
    // The FRAME carries no transform (the scale sits on its child), so its top
    // edge is still the natural one even while the widget is shrunk. Measuring
    // the scaled node instead would feed the output back into the input.
    setHubTop(Math.max(0, Math.round(node.getBoundingClientRect().top)));
  }, [hubFitEnabled, viewportHeight, viewportWidth, hubHeight, doorsHeight, hasAccount, splitMounted, hideHero]);
  // The scale is solved from the TALLEST height this layout has shown, not the
  // live one.
  //
  // The widget's card carries a CSS `height` transition (action-hub.tsx), and
  // each tab is a different height, so a tab switch animates that height over
  // ~340ms. The wrapper below measures it with onLayout, which on web is a
  // ResizeObserver: it fired on every frame of that animation, re-solved the
  // scale on every frame, and the whole widget zoomed its way through every
  // tab switch while the frame's reserved height chased a moving scale and
  // left a gap under it (Nathaniel + Matthew, QA 2026-09-21). Matthew: it is
  // supposed to change size smoothly when you change tabs.
  //
  // One scale per layout fixes both. A tab switch then changes only the
  // widget's own height, which is the smooth size change that was intended,
  // and the frame below reserves that CURRENT height at the fixed scale, so
  // nothing is reserved for a tab that is not on screen.
  //
  // The peak is what keeps the original guarantee: the tallest tab is the one
  // that has to fit, and every shorter tab fits at the same scale. It resets
  // whenever the layout itself changes, so one tall tab cannot pin the page
  // small for the rest of the session.
  //
  // It is built from the hub's target heights, not from the animated layout.
  // Signing out changes the layout and closes a success panel in the same
  // moment, and an animation frame of that closing panel would otherwise seed
  // the signed-out peak and leave the widget shrunk.
  const hubFitKey = `${hasAccount}:${splitMounted}:${viewportWidth}:${viewportHeight}:${doorsHeight}`;
  const [hubPeak, setHubPeak] = useState<{ key: string; height: number }>({ key: '', height: 0 });
  const onHubTargetHeight = useCallback((height: number) => {
    setHubPeak((previous) => (previous.key === hubFitKey
      ? (height > previous.height ? { key: hubFitKey, height } : previous)
      : { key: hubFitKey, height }));
  }, [hubFitKey]);
  // A peak recorded under a different layout says nothing about this one, so
  // it is ignored rather than carried over, and the live height stands in
  // until the hub reports a target under this layout.
  /**
   * Hold the action column in view while the data panel scrolls.
   *
   * The panel is the long side: a full transaction list runs several viewports,
   * and the column is a fixed 440px sibling in the same ScrollView, so scrolling
   * to a row at the bottom of the table scrolled the shield widget off the top
   * and left its side of the page empty (Mike, 2026-09-22, who read that empty
   * column as space for a new section).
   *
   * Conditions, each load-bearing:
   *   - web only. RNW passes `position: sticky` through to the DOM; native has
   *     no equivalent and ignores it.
   *   - split layout only. Without the panel the column IS the page, so there
   *     is nothing for it to stay in view against.
   *   - it must FIT. Sticky pins the top edge, so a column taller than the
   *     viewport would park its lower half permanently out of reach. Below the
   *     fit it scrolls normally, which keeps every control reachable.
   *
   * `alignSelf: 'flex-start'` matters: the row is `items-start` already, but a
   * stretched child fills the row's height and then has no room to move within
   * its own containing block, which is how sticky silently does nothing.
   */
  // Measured on the COLUMN, not on the hub.
  //
  // This used `hubHeight`, the action widget alone. That was a fair proxy while
  // the column held the hub and the doors row, and it stops being one the moment
  // anything is added below them — which the registration card now is. With the
  // old proxy the guard still says "it fits", sticky engages, and the bottom of
  // the column parks permanently out of reach: exactly the failure the guard
  // exists to prevent, arriving silently because something else grew.
  //
  // Measured rather than summed from its parts, so the next child is accounted
  // for without anyone remembering to add it here.
  const [stickyColumnHeight, setStickyColumnHeight] = useState(0);
  const stickyHub = Platform.OS === 'web'
    && splitMounted
    && stickyColumnHeight > 0
    && stickyColumnHeight + STICKY_HUB_TOP + STICKY_HUB_BOTTOM_GAP <= viewportHeight;
  const hubFitHeight = hubPeak.key === hubFitKey ? hubPeak.height : hubHeight;
  const hubScale = hubFitEnabled
    ? actionHubFitScale({
      viewportHeight,
      hubTop,
      hubHeight: hubFitHeight,
      reservedBelow: doorsHeight + HUB_DOORS_GAP,
    })
    : 1;

  // Account shortcuts remain below the action widget in both page layouts.
  const doorsRow = !showTabBar ? (
    <View
      onLayout={(e) => setDoorsHeight(Math.round(e.nativeEvent.layout.height))}
      // Keep the shortcuts on one line beside an open panel.
      className={`mt-[12px] flex-row justify-center ${splitMounted ? 'flex-nowrap' : 'flex-wrap'}`}
      // nw-keep(measured-or-inset): compact spacing follows the available column width
      style={{ gap: doorGap }}
    >
      {orderedDoors.map((door) => {
        const isActive = drawer === door.key;
        // Keep balance emphasis when connected; panel selection stays distinct.
        const isPrimary = hasAccount && door.key === 'mine' && !splitMounted;
        const shade = isActive
          ? 'bg-card-background border-border-light'
          : 'bg-background-secondary border-transparent';
        return (
          <Pressable
            key={door.key}
            onPress={() => (isActive ? closeDrawer() : openDrawer(door.key))}
            className={`min-w-0 shrink flex-row items-center gap-[6px] border rounded-pill ${shade}`}
            // nw-keep(measured-or-inset): compact padding keeps the shortcuts on one line
            style={{
              paddingHorizontal: doorPadX,
              paddingVertical: doorPadY,
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            testID={`home-door-${door.key}`}
          >
            {/* nw-keep(data-color): primary door-icon glyph color (theme token) into the vector-icon sink */}
            <Ionicons name={door.icon} size={doorIcon} color={colors.primary} />
            <Text
              numberOfLines={1}
              className={`${isPrimary ? 'font-pp-sans-semi-bold' : 'font-pp-sans-medium'} ${isPrimary || isActive ? 'text-primary' : 'text-text-secondary'}`}
              // nw-keep(measured-or-inset): compact label size follows the column width
              style={{ fontSize: doorFont }}
            >
              {exploreTabLabel(door.key, hasAccount)}
              {isPrimary && myBalanceLabel ? ` (${myBalanceLabel})` : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  ) : null;
  const footerNode = Platform.OS === 'web' ? (
    // grow + the Footer's own justify-end park it at the page bottom on a
    // short page (Pat, 2026-08-28); pt keeps the 24px minimum gap.
    <View className="grow pt-[24px] w-full max-w-[960px] mx-auto">
      <Footer />
    </View>
  ) : null;

  return (
    <ExplorePanelProvider
      surface={panelSurface}
      // 0 outside the split screen, so useLayoutWidth() falls back to the
      // window — the sheet and the Classic page both want the full width.
      width={splitMounted ? panelWidth : 0}
      selection={selection}
      selectAsset={selectAsset}
    >
    <View className={`flex-1 bg-background ${landingVisit ? 'landing-entrance' : ''}`}>
      {Platform.OS === 'web' && <LandingEntranceStyles />}
      <Header overlay />
      <ScrollView
        ref={scrollViewRef}
        // nw-keep(platform-css): keep the scroll position stable when the wallet picker changes height.
        style={Platform.OS === 'web' ? ({ overflowAnchor: 'none' } as unknown as ViewStyle) : undefined}
        className="flex-1"
        contentContainerClassName={`grow ${Platform.OS === 'web' ? (showBottomNav(viewportWidth) ? 'pt-[79px]' : 'pt-[95px]') : 'pt-[28px]'} pb-[24px] px-[20px]`}
        // nw-keep(measured-or-inset): extra foot room so content clears the floating mobile tab bar,
        // plus the typing floor — viewport + the offset the visitor was at when
        // they reached for the field, so focus cannot shorten the page past
        // where they already are. Only the web landing needs it; every other
        // focus state keeps all its content and so keeps its own height.
        contentContainerStyle={{
          ...(showTabBar ? { paddingBottom: tabClearance } : null),
          ...(focusedLanding && focusFloorPx > 0 ? { minHeight: focusFloorPx } : null),
        }}
      >
        <Animated.View
          // row-reverse only while split: the widget stays first in DOM order (it
          // is the primary control and must keep that focus/reading order), but
          // paints on the RIGHT with the data panel to its left.
          className={`mx-auto w-full ${landingHero ? 'items-center' : 'items-start'} ${splitMounted ? 'flex-row-reverse' : 'flex-row'}`}
          // nw-keep(measured-or-inset): page geometry follows the viewport and panel state directly.
          // The typing floor is NOT here: it belongs on the scroll container,
          // in px, so the footer's own grow can take the slack instead of this
          // row ending in blank space (see focusFloorPx above).
          style={{ maxWidth: landingWide ? 1120 : containerMaxWidth, minHeight: landingHero ? 'calc(100dvh - 95px)' as unknown as number : undefined, paddingBottom: landingHero ? (showTabBar ? tabClearance + 72 : 88) : undefined }}
        >
        <Animated.View
          className={landingWide ? 'w-full flex-row items-center gap-[64px] py-[32px]' : 'gap-[18px] items-stretch w-full'}
          // A 1px deadband: the card expands and collapses, and a height that
          // re-sets state on every sub-pixel change would re-render the column
          // on each animation frame.
          onLayout={(e) => {
            const next = Math.round(e.nativeEvent.layout.height);
            setStickyColumnHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
          }}
          // nw-keep(measured-or-inset): the panel reserves a fixed-width action column,
          // and the sticky offset is the overlay header's height in px.
          style={splitMounted
            ? { width: SPLIT_LEFT_WIDTH, ...(stickyHub ? STICKY_HUB_STYLE : null) }
            : undefined}
        >
          <Animated.View
            pointerEvents={hideHero ? 'none' : 'auto'}
            aria-hidden={hideHero}
            className={landingWide ? "flex-1 min-w-0" : "overflow-hidden"}
            // nw-keep(animated): heroAnim-driven opacity/height/marginBottom/transform (hero fold spring, JS driver)
            style={{
              opacity: Platform.OS === 'web' ? (hideHero ? 0 : 1) : heroAnim,
              // Collapse to nothing (and swallow the column gap) once measured;
              // before the first layout pass, fall back to a hard 0 when hidden
              // at mount so a connected reload never flashes the hero.
              height: Platform.OS === 'web' ? (hideHero ? 0 : undefined) : landingWide ? undefined : heroHeight > 0
                ? heroAnim.interpolate({ inputRange: [0, 1], outputRange: [0, heroHeight], extrapolate: 'clamp' })
                : hideHero ? 0 : undefined,
              marginBottom: Platform.OS === 'web' ? (hideHero ? -10 : 0) : heroAnim.interpolate({ inputRange: [0, 1], outputRange: [-10, 0], extrapolate: 'clamp' }),
              transform: Platform.OS === 'web' ? [] : [
                { translateY: heroAnim.interpolate({ inputRange: [0, 1], outputRange: [-14, 0], extrapolate: 'clamp' }) },
                { scale: heroAnim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1], extrapolate: 'clamp' }) },
              ],
            }}
          >
            <View
              className={landingWide ? 'gap-[24px] py-[20px]' : 'items-center gap-[14px] pt-[12px] pb-[8px]'}
              onLayout={(e) => setHeroHeight(e.nativeEvent.layout.height)}
            >
              <HeroHeading wide={landingWide} active={focused && !hideHero} />
              <Text className={`landing-entrance-description text-[18px] leading-[28px] max-w-[440px] text-text-secondary font-pp-sans ${landingWide ? '' : 'text-center'}`}>
                {LANDING_HERO.body}
              </Text>

            </View>
          </Animated.View>

          <LayoutTransition testID="home-action-column" layoutKey={`${hasAccount}:${splitMounted}:${inputFocused}`} positionGroup={hasAccount ? "account" : "visitor"} viewportWidth={viewportWidth} className={landingWide ? 'w-[480px]' : 'w-full'}>
            {/* Keep the one-shot entrance separate from subsequent layout fades. */}
            <View className="landing-entrance-widget gap-[12px]">
              {/* The frame reserves the SCALED height, because a transform
                  leaves layout alone: without it the shortcut row would keep
                  its old position and the shrink would buy nothing. */}
              <View
                ref={hubFrameRef}
                // nw-keep(measured-or-inset): height is the measured widget height times the fit scale — no class can express it
                style={{ height: actionHubScaledHeight(hubHeight, hubScale) }}
              >
                <View
                  onLayout={(e) => setHubHeight(Math.round(e.nativeEvent.layout.height))}
                  // nw-keep(measured-or-inset): scale + top-pinning offset are both derived from the measured height
                  style={hubScale < 1 ? {
                    transform: [
                      { translateY: actionHubScaleOffset(hubHeight, hubScale) },
                      { scale: hubScale },
                    ],
                  } : undefined}
                >
                  <HubErrorBoundary>
                    <ActionHub
                      landing={!hasAccount}
                      onEngage={() => {
                        if (introForced) dismissIntro();
                      }}
                      onInputFocus={onHubInputFocus}
                      onInputBlur={onHubInputBlur}
                      onTargetHeight={hubFitEnabled ? onHubTargetHeight : undefined}
                    />
                  </HubErrorBoundary>
                </View>
              </View>
              {doorsRow}
              {/* After the doors, never inside them: doorsRow's measured
                  height feeds the hub's fit-to-viewport scale, so a card
                  expanding in there would shrink the hub. Signed-in only,
                  since registration belongs to an account. */}
              {hasAccount ? <RegistrationStatusCard /> : null}
            </View>
          </LayoutTransition>
          {/* Panels own the full data view; signed-out visitors get compact summaries. */}
          {showPoolSummaries && (
            <FadeSwap swapKey="plain" className="mt-[10px] gap-[10px]">
              <LatestActivity onViewAll={() => openDrawer('activity')} />
              <StatBand />
            </FadeSwap>
          )}

          {/* Minimalist list of the available pools, same quiet style as the
              latest-activity card above. Redundant beside the open panel. */}
          {showPoolSummaries && (
            <FadeSwap swapKey="plain" className="mt-[20px]">
              <HomePools />
            </FadeSwap>
          )}
        </Animated.View>

        {/* The selected panel appears directly in its final position. */}
        {splitMounted && (
          <View
            className="flex-1"
            onLayout={(e) => setPanelWidth(e.nativeEvent.layout.width)}
            // nw-keep(measured-or-inset): fixed gutter between the panel and action column
            style={{ marginRight: SPLIT_GAP }}
          >
            {/* My balances is chromeless (mock): the balance sits on the page,
                and the asset list is the only card. The other sections keep
                the panel card. Their content is a table that needs a
                surface. */}
            <View
              className={
                panelSection === 'mine'
                  ? 'gap-[14px] p-[4px]'
                  : 'gap-[14px] rounded-card border border-border bg-card-background p-[16px]'
              }
              // nw-keep(platform-css): the shared soft card shadow, on the sections drawn as a card
              style={panelSection === 'mine' ? undefined : CARD_SHADOW}
            >
              <View className="flex-row items-start justify-between gap-[12px]">
                {panelSection === 'mine' ? <View className="flex-1" /> : <PanelHeading section={panelSection} />}
                <Pressable
                  onPress={closeDrawer}
                  className="h-[30px] w-[30px] items-center justify-center rounded-inner bg-background-secondary"
                  accessibilityRole="button"
                  accessibilityLabel="Close panel"
                  testID="split-panel-close"
                >
                  {/* nw-keep(data-color): close glyph color is the secondary theme token into the vector-icon sink */}
                  <Ionicons name="close" size={16} color={colors.textSecondary} />
                </Pressable>
              </View>
              <LayoutTransition layoutKey={panelSection} viewportWidth={viewportWidth}>
                <PanelSections section={panelSection} onClose={closeDrawer} />
              </LayoutTransition>
            </View>
          </View>
        )}
        {landingHero && (
          <View className={`absolute left-0 right-0 items-center ${showTabBar ? 'bottom-[84px]' : 'bottom-[24px]'}`}>
            <Pressable onPress={scrollToStory} accessibilityRole="button" className="min-h-[44px] items-center justify-center gap-[6px]" testID="front-scroll-hint">
              <Text className="text-[14px] text-text-secondary font-pp-sans-medium">Scroll to learn more</Text>
              <Ionicons name="arrow-down" size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
        )}
        </Animated.View>

        {/* Footer escapes the narrow action column so its links fit one line
            on desktop. */}
        {!marketingSlot && footerNode}

        {/* Keep the product story below the signed-out form, with room for
            focused inputs and open panels to use the available space. */}
        {marketingSlot && (
          <Suspense fallback={null}>
            <FrontPage
              onAction={frontAction}
              onExplorePools={() => router.push('/explore')}
            />
          </Suspense>
        )}
      </ScrollView>

      {/* Sheet only where there is no room to split. Above SPLIT_MIN_WIDTH the
          same content is the right-hand column instead. */}
      <ActivityDrawer visible={!canSplit && drawer !== null} section={drawer ?? 'activity'} onClose={closeDrawer} />


      {Platform.OS !== 'web' && !showTabBar && (
        <View className="px-[20px] pb-[20px]">
          <Footer />
        </View>
      )}
    </View>
    </ExplorePanelProvider>
  );
}
