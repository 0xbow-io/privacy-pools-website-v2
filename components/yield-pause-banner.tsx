import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { YIELD_PAUSE_BANNER_TEXT } from '@/config/yield-deposits-paused';

/**
 * Slim notice strip at the top of the app while vault deposits are paused
 * (EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED names a chain). The text is build
 * configuration (EXPO_PUBLIC_YIELD_PAUSE_BANNER_TEXT, see
 * config/yield-deposits-paused.ts), plain text, and nothing here makes a request.
 *
 * The strip sits in the layout flow above the app, never over it, so nothing
 * underneath is covered. On native it takes the status bar inset itself, and
 * the app below sees a top inset of 0 so the gap is not paid twice.
 */
export function YieldPauseBannerFrame({ children, text = YIELD_PAUSE_BANNER_TEXT }: { children: ReactNode; text?: string | null }) {
  const insets = useSafeAreaInsets();
  if (!text) return <>{children}</>;
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
        <Text className="text-center font-pp-sans-medium text-[12px] leading-[16px] text-text">{text}</Text>
      </View>
      <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>
        <View className="flex-1">{children}</View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}
