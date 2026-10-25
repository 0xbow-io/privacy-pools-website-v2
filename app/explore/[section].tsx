import { useMemo } from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';
import { useTabBarClearance } from '@/hooks/use-tab-bar-clearance';
import { useTheme } from '@/components/theme-provider';
import { PanelHeading, PanelSections, PANEL_PARAMS } from '@/components/home/explore-panel';
import { Header } from '@/components/ui/header';
import { effectiveSafeAreaInset, explorePageUsesAppHeader } from '@/services/header-nav';

/**
 * Full-page stack presentation of a data surface — `/explore/balances`,
 * `/explore/pools`, `/explore/activity`.
 *
 * The mobile bottom bar pushes these ON TOP of `/` (stack style), so the
 * browser/hardware back button pops home naturally — the drawer treatment
 * (`/?panel=…`) stays for desktop and deep links. Content is the exact same
 * `PanelSections` the drawers render; only the shell differs. The bottom bar
 * stays mounted over these pages (they are peers in the bar's navigation),
 * which is why the scroll content reserves useTabBarClearance().
 */
export default function ExploreSectionRoute() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const tabClearance = useTabBarClearance();
  const rawInsets = useSafeAreaInsets();
  // DEV-553: web never pads for a reported system-bar inset (see effectiveSafeAreaInset).
  const insets = { top: effectiveSafeAreaInset(Platform.OS, rawInsets.top), bottom: effectiveSafeAreaInset(Platform.OS, rawInsets.bottom) };
  const { width } = useWindowDimensions();
  // DEV-553: on phone web this page is a peer of Shield in the bottom bar, so
  // it wears the same app header (logo, bell, Actions, chain, sync, theme)
  // rather than its own back button and title, flush with the top edge.
  const appHeader = explorePageUsesAppHeader(Platform.OS, width);
  const params = useLocalSearchParams<{ section?: string | string[] }>();
  const raw = Array.isArray(params.section) ? params.section[0] : params.section;
  const section = raw ? PANEL_PARAMS[raw] ?? null : null;

  const goBack = useMemo(
    () => () => {
      // Pushed from home this pops back to `/`; on a cold deep link there is
      // no stack below, so land on home instead of a dead button.
      if (router.canGoBack()) router.back();
      else router.replace('/');
    },
    [router],
  );

  // `/explore/pools` used to be the pool directory. That page is gone (the
  // directory lives on /explore itself), so the old link lands there rather
  // than bouncing someone to the home page with no explanation.
  if (raw === 'pools') return <Redirect href="/explore" />;
  if (!section) return <Redirect href="/" />;
  // My balances / My activity left the phone bar (Ameen, QA 2026-10-25):
  // Portfolio carries both, so the old phone links land there.
  if (appHeader) return <Redirect href="/portfolio" />;

  if (appHeader) {
    return (
      <View className="flex-1 overflow-hidden bg-background">
        <Header overlay />
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-[16px] pt-[79px]"
          // nw-keep(measured-or-inset): clearance for the floating bottom bar
          contentContainerStyle={{ paddingBottom: Math.max(tabClearance, 24) }}
        >
          <PanelSections section={section} onClose={goBack} />
        </ScrollView>
      </View>
    );
  }

  return (
    <>
      <View
        className="flex-1 bg-background"
        // nw-keep(measured-or-inset): runtime safe-area top inset
        style={{ paddingTop: Math.max(insets.top, Platform.OS === 'web' ? 10 : 0) }}
      >
        <View className="flex-row items-center gap-[10px] px-[16px] pb-[10px] pt-[6px]">
          <Pressable
            onPress={goBack}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Back"
            testID="explore-page-back"
            className="h-[34px] w-[34px] items-center justify-center rounded-pill border border-border-light active:opacity-60"
          >
            {/* nw-keep(data-color): vector-icon sink */}
            <Ionicons name="arrow-back" size={18} color={colors.text} />
          </Pressable>
          <PanelHeading section={section} />
        </View>
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-[16px] pt-[4px]"
          // nw-keep(measured-or-inset): clearance for the floating bottom bar
          contentContainerStyle={{ paddingBottom: Math.max(tabClearance, 24) }}
        >
          <PanelSections section={section} onClose={goBack} />
        </ScrollView>
      </View>
    </>
  );
}
