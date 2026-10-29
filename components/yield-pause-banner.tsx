import type { ReactNode } from 'react';
import { Linking, Text, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { splitBannerAtAave, YIELD_PAUSE_BANNER_LINK_URL, YIELD_PAUSE_BANNER_TEXT } from '@/config/yield-deposits-paused';

/**
 * Slim notice strip at the top of the app about the Aave deposit freeze. On by
 * default (Ethereum and Base), independent of the pause itself. The text is build
 * configuration (EXPO_PUBLIC_YIELD_PAUSE_BANNER_TEXT, see
 * config/yield-deposits-paused.ts), plain text, and nothing here makes a request.
 * The word "Aave" links to Aave's announcement (EXPO_PUBLIC_YIELD_PAUSE_BANNER_LINK_URL,
 * https only, empty means no link); the link only opens when the user taps it.
 *
 * The strip sits in the layout flow above the app, never over it, so nothing
 * underneath is covered. On native it takes the status bar inset itself, and
 * the app below sees a top inset of 0 so the gap is not paid twice.
 */
export function YieldPauseBannerFrame({ children, text = YIELD_PAUSE_BANNER_TEXT, linkUrl = YIELD_PAUSE_BANNER_LINK_URL }: { children: ReactNode; text?: string | null; linkUrl?: string | null }) {
  const insets = useSafeAreaInsets();
  if (!text) return <>{children}</>;
  const parts = splitBannerAtAave(text, linkUrl);
  return (
    <View className="flex-1 bg-background">
      <View
        testID="yield-pause-banner"
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        className="border-b border-border bg-warning-bg px-[16px] py-[6px]"
        // nw-keep(measured-or-inset): the status bar inset is a runtime value, 0 on web
        style={{ paddingTop: insets.top + 6 }}
      >
        <Text className="text-center font-pp-sans-medium text-[12px] leading-[16px] text-text">
          {parts ? (
            <>
              {parts.before}
              <Text
                accessibilityRole="link"
                className="underline"
                onPress={() => { if (linkUrl) void Linking.openURL(linkUrl); }}
              >
                {parts.label}
              </Text>
              {parts.after}
            </>
          ) : text}
        </Text>
      </View>
      <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>
        <View className="flex-1">{children}</View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}
