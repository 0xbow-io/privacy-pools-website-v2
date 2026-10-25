import { useMemo } from 'react';
import { Platform, Pressable, Text, View, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Fonts, FontWeights } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import type { DrawerSection } from '@/components/home/explore-panel';
import { NATIVE_BAR_TABS } from '@/services/native-bar-tabs';
import { TAB_BAR_TRACK_HEIGHT, tabBarBottomOffset } from '@/services/header-nav';

/** The bar's tabs: Shield (home), the three data surfaces, and "More". */
export type MobileNavTab = DrawerSection | 'shield' | 'portfolio' | 'stats' | 'card' | 'more';

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
  portfolio: 'pie-chart',
  mine: 'wallet',
  activity: 'pulse',
  stats: 'compass',
  more: 'ellipsis-horizontal',
};

/**
 * "Explore": the /explore page. It carries the pool directory AND the protocol
 * figures, which is why the separate Explore-pools panel is gone.
 */
const STATS_TAB = { key: 'stats' as const, icon: 'compass-outline' as const, label: 'Explore' };

/**
 * Everything in the bar, in order: Shield, Portfolio, Explore, More (Ameen,
 * QA 2026-10-25). My balances and My activity left the bar: Portfolio holds
 * the positions and, below them, the collapsible "My transactions" feed.
 * "More" carries the remaining page navigation, so on a phone the bottom bar
 * is the whole navigation surface and the top bar can stay clean.
 */
const BAR_TABS: { key: MobileNavTab; icon: keyof typeof Ionicons.glyphMap; activeIcon?: keyof typeof Ionicons.glyphMap; label: string }[] = [
  // Shield first: it IS the home screen (the shield card), so the bar always
  // has a way back to `/` without reaching for the browser.
  { key: 'shield', icon: 'shield-outline', label: 'Shield' },
  { key: 'portfolio', icon: 'pie-chart-outline', label: 'Portfolio' },
  STATS_TAB,
  // Native app only (Card); empty on web. See services/native-bar-tabs.
  ...NATIVE_BAR_TABS,
  // "More" over "Extra": it is the long-standing convention for a tab that
  // holds the overflow of a navigation bar, so it needs no learning.
  { key: 'more', icon: 'ellipsis-horizontal', label: 'More' },
];

/** The bar's tabs. The same set signed in or out: each one is a page. */
export function barTabsFor(_isConnected: boolean) {
  return BAR_TABS;
}

/**
 * The activity door reads "All activity" for a visitor and "My activity" once
 * signed in, because that is what it then shows. One resolver, so the inline
 * doors row and the mobile bar can never disagree.
 */
export function exploreTabLabel(key: MobileNavTab, isConnected: boolean): string {
  if (key === 'activity' && isConnected) return 'My activity';
  if (key === 'stats') return STATS_TAB.label;
  return BAR_TABS.find((t) => t.key === key)?.label ?? EXPLORE_TABS.find((t) => t.key === key)?.label ?? '';
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
 * Mobile bottom navigation: equal-width Pressable slots (it was the jelly
 * tab bar library before), themed from the active design variant's
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

  // `active` can name a tab the bar no longer shows (connected, on
  // /explore/pools via the More menu): no pill rather than a wrong pill.
  const activeIndex = active ? tabs.findIndex((t) => t.key === active) : -1;

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
        {/* What you see is what you tap (Ameen, QA 2026-10-25): the jelly
            pill inflated past its slot and its drag gesture picked the tab,
            so a tap on the pill's visible edge landed on the neighbour. Each
            tab is now an equal-width Pressable and the highlight is drawn
            inside that same Pressable, so the two can never disagree. */}
        <View
          className="flex-row overflow-hidden rounded-[32px] p-[2px]"
          // nw-keep(measured-or-inset): track height shared with the page clearance
          style={{ height: TAB_BAR_TRACK_HEIGHT }}
        >
          <WebGlassBackdrop />
          <View
            pointerEvents="none"
            className="absolute inset-0 rounded-[32px]"
            // nw-keep(data-color): runtime theme surface, translucent on web for the glass
            style={{ backgroundColor: colors.cardBackground, opacity: WEB ? 0.78 : 1 }}
          />
          {tabs.map((tab, index) => {
            const selected = index === activeIndex;
            const label = exploreTabLabel(tab.key, isConnected);
            const color = selected ? colors.buttonPrimaryText : colors.textMuted;
            return (
              <Pressable
                key={tab.key}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected }}
                testID={`explore-tab-${tab.key}`}
                onPress={() => onSelect(tab.key)}
                className="h-full flex-1 basis-0 items-center justify-center overflow-hidden rounded-[30px]"
              >
                {selected ? (
                  <View
                    pointerEvents="none"
                    className="absolute inset-0 rounded-[30px]"
                    // nw-keep(data-color): the variant's primary CTA fill
                    style={{ backgroundColor: colors.buttonPrimary }}
                  />
                ) : null}
                {/* nw-keep(data-color): glyph color is a runtime theme token (vector-icon sink) */}
                <Ionicons
                  name={selected ? tab.activeIcon ?? ACTIVE_ICONS[tab.key as Exclude<MobileNavTab, 'card'>] : tab.icon}
                  size={18}
                  color={color}
                />
                {/* 9.5px BOLD with air above it (Pat, 2026-08-28). */}
                <Text
                  numberOfLines={1}
                  // nw-keep(data-color): label color is a runtime theme token
                  style={{ color, fontFamily: Fonts.sansBold, fontWeight: FontWeights.sansBold, fontSize: 9.5, marginTop: 4 }}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
