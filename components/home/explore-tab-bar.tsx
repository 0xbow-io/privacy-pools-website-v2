import { useMemo } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JellyTabBarHeadless } from 'react-native-jelly-tabs';
import { Colors, Fonts, FontWeights } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import type { DrawerSection } from '@/components/home/explore-panel';
import { NATIVE_BAR_TABS } from '@/services/native-bar-tabs';
import { tabBarBottomOffset } from '@/services/header-nav';

/** The bar's tabs: Shield (home), the three data surfaces, and "More". */
export type MobileNavTab = DrawerSection | 'shield' | 'stats' | 'card' | 'more';

/** Just the data drawers — used where a DrawerSection is required. */
export const EXPLORE_TABS: {
  key: DrawerSection;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}[] = [
  { key: 'mine', icon: 'wallet-outline', label: 'My balances' },
  { key: 'activity', icon: 'pulse-outline', label: 'All activity' },
];

/** Filled counterparts revealed through the jelly pill mask. */
const ACTIVE_ICONS: Record<Exclude<MobileNavTab, 'card'>, keyof typeof Ionicons.glyphMap> = {
  shield: 'shield',
  mine: 'wallet',
  activity: 'pulse',
  stats: 'compass',
  more: 'ellipsis-horizontal',
};

/**
 * "Explore" — the /explore page. It carries the pool directory AND the protocol
 * figures, which is why the separate Explore-pools panel is gone. Stands in
 * for "My balances" while signed out (see barTabsFor), where a personal
 * balance has nothing to show.
 */
const STATS_TAB = { key: 'stats' as const, icon: 'compass-outline' as const, label: 'Explore' };

/**
 * Everything in the bar, in order. "More" carries the page navigation that
 * used to live in the header's hamburger, so on a phone the bottom bar is the
 * whole navigation surface and the top bar can stay clean.
 */
const BAR_TABS: { key: MobileNavTab; icon: keyof typeof Ionicons.glyphMap; activeIcon?: keyof typeof Ionicons.glyphMap; label: string }[] = [
  // Shield first: it IS the home screen (the shield card), so the bar always
  // has a way back to `/` without reaching for the browser.
  { key: 'shield', icon: 'shield-outline', label: 'Shield' },
  ...EXPLORE_TABS,
  // Native app only (Card); empty on web. See services/native-bar-tabs.
  ...NATIVE_BAR_TABS,
  // "More" over "Extra": it is the long-standing convention for a tab that
  // holds the overflow of a navigation bar, so it needs no learning.
  { key: 'more', icon: 'ellipsis-horizontal', label: 'More' },
];

/**
 * The bar's tabs for a given sign-in state. Signed OUT, "My balances" has
 * nothing to show, so that slot becomes Explore — the protocol surface a
 * visitor can actually read.
 */
export function barTabsFor(isConnected: boolean) {
  return BAR_TABS.map((tab): (typeof BAR_TABS)[number] => (!isConnected && tab.key === 'mine' ? STATS_TAB : tab));
}

/**
 * Space the page must leave at its foot so the last row of content can scroll
 * clear of the floating bar (bar height + its bottom offset).
 */
export const EXPLORE_TAB_BAR_CLEARANCE = 78;

/**
 * The activity door reads "All activity" for a visitor and "My activity" once
 * signed in, because that is what it then shows. One resolver, so the inline
 * doors row and the mobile bar can never disagree.
 */
export function exploreTabLabel(key: MobileNavTab, isConnected: boolean): string {
  if (key === 'activity' && isConnected) return 'My activity';
  if (key === 'stats') return STATS_TAB.label;
  return BAR_TABS.find((t) => t.key === key)?.label ?? '';
}

const WEB = Platform.OS === 'web';

/**
 * The "glass" under the jelly track: a backdrop blur node so the page visibly
 * moves *through* the bar on web (same escape hatch as the modal providers'
 * backdropFilter). Rendered via the library's `backdrop` slot, below the
 * track color layer, whose opacity is lowered to let the blur read. Native
 * keeps a fully opaque track — no expo-blur dependency.
 */
function WebGlassBackdrop() {
  if (!WEB) return null;
  return (
    <View
      // nw-keep(platform-css): web-only backdrop blur under the jelly track
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderRadius: 32,
        backdropFilter: 'blur(22px) saturate(180%)',
        WebkitBackdropFilter: 'blur(22px) saturate(180%)',
      } as unknown as ViewStyle}
      pointerEvents="none"
    />
  );
}

const BAR_SHADOW = {
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.18,
  shadowRadius: 24,
  elevation: 12,
} as const;

/**
 * Mobile bottom navigation for the three exploratory surfaces — the jelly
 * tab bar (react-native-jelly-tabs), themed from the active design variant's
 * tokens: track = card surface, pill = the variant's primary CTA pair,
 * inactive glyphs = muted text. `Colors`/`Fonts` are resolved per variant at
 * module load, so every vault theme styles the bar automatically (Classic
 * simply inherits its plain tokens).
 *
 * The caller unmounts this while a data sheet is open (the sheet covers the
 * bottom ~78% of the screen, so the bar would be stranded behind it). The
 * "More" drawer is shorter and coexists with the bar, so `active` does light
 * up for it.
 */
export function ExploreTabBar({
  active,
  onSelect,
  isConnected = false,
}: {
  active: MobileNavTab | null;
  onSelect: (tab: MobileNavTab) => void;
  isConnected?: boolean;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();
  const bottom = tabBarBottomOffset(Platform.OS, insets.bottom);

  const tabs = useMemo(() => barTabsFor(isConnected), [isConnected]);

  const items = useMemo(
    () =>
      tabs.map((tab) => ({
        key: tab.key,
        label: exploreTabLabel(tab.key, isConnected),
        // 9.5px BOLD, with real air above it (Pat, 2026-08-28: more space
        // between icon and label, slightly larger, bold).
        //
        // The size is the constrained part. The old note read "9px, not 10: at
        // 10 the signed-out bar's longest label ('Explore pools', five tabs
        // sharing 390px) truncates to 'Explore po…'" — and BOLD is wider than
        // medium, so it spends the same budget.
        //
        // Measured in-browser at 390px: the longest label, 'Explore pools',
        // renders 63px at 9.5 bold (60px at the old 9 medium) against a 72px
        // tab — 9px of headroom. Re-measure before raising it; the margin is
        // one step, not two.
        labelStyle: { fontFamily: Fonts.sansBold, fontWeight: FontWeights.sansBold, fontSize: 9.5, marginTop: 4 },
        accessibilityLabel: exploreTabLabel(tab.key, isConnected),
        testID: `explore-tab-${tab.key}`,
        activeIcon: ({ color, size }: { color: string; size: number }) => (
          // nw-keep(data-color): jelly resolves the layer color at runtime (vector-icon sink)
          <Ionicons name={tab.activeIcon ?? ACTIVE_ICONS[tab.key as Exclude<MobileNavTab, 'card'>]} size={size} color={color} />
        ),
        inactiveIcon: ({ color, size }: { color: string; size: number }) => (
          // nw-keep(data-color): jelly resolves the layer color at runtime (vector-icon sink)
          <Ionicons name={tab.icon} size={size} color={color} />
        ),
      })),
    [tabs, isConnected],
  );

  // `active` can name a tab the bar no longer shows (connected, on
  // /explore/pools via the More menu): no pill rather than a wrong pill.
  const activeIndex = active ? tabs.findIndex((t) => t.key === active) : -1;
  const selectedIndex = activeIndex >= 0 ? activeIndex : null;

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="Main navigation"
      className="absolute left-0 right-0 z-[900] items-center px-[14px]"
      // nw-keep(measured-or-inset): runtime safe-area bottom inset
      // nw-keep(platform-css): web-only position:fixed pins the bar to the viewport rather than the scrolled page
      style={[{ bottom }, WEB ? ({ position: 'fixed' } as object) : null]}
      pointerEvents="box-none"
    >
      {/* nw-keep(data-color): ambient shadow tint is the runtime theme token */}
      <View className="w-full max-w-[460px]" style={[BAR_SHADOW, { shadowColor: colors.tint }]}>
        <JellyTabBarHeadless
          items={items}
          maxWidth="100%"
          selectedIndex={selectedIndex}
          // Selection is fully controlled: report the tap, keep the pill where
          // our state says it is (data tabs unmount the bar for their sheet;
          // "More" toggles its drawer).
          onTabPress={({ index }) => {
            onSelect(tabs[index].key);
            return false;
          }}
          colors={{
            surface: colors.cardBackground,
            selectedSurface: colors.buttonPrimary,
            activeContent: colors.buttonPrimaryText,
            inactiveContent: colors.textMuted,
          }}
          opacity={{ surface: WEB ? 0.78 : 1 }}
          backdrop={<WebGlassBackdrop />}
          // Telegram-calibrated, second pass: same density, a touch more
          // height — Telegram's bar is ~15% taller than the first cut, with
          // slightly larger glyphs. Clearance above tracks trackHeight.
          config={{ layout: { iconSize: 18, trackHeight: 48, itemHeight: 44, trackInset: 2 } }}
        />
      </View>
    </View>
  );
}
