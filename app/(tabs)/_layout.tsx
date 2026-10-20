import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';

export default function TabLayout() {
  const { colorScheme } = useTheme();

  return (
    // nw-keep(third-party-style-api): SafeAreaView (react-native-safe-area-context) is not
    // cssInterop-registered, so className is dropped — the flex container + scheme background
    // stay a style prop; the background is a theme token (runtime), never a hex literal.
    // DEV-553: no inset padding on web, the page is never drawn under the system
    // bars (no viewport-fit=cover) and an Android WebView reports them anyway.
    <SafeAreaView edges={Platform.OS === 'web' ? [] : undefined} style={{ flex: 1, backgroundColor: Colors[colorScheme].background }}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: Colors[colorScheme].tint,
          headerShown: false,
          tabBarButton: HapticTab,
          // Hide tab bar - we use custom header navigation
          // nw-keep(navigation-options): expo-router Tabs option object — no className path
          tabBarStyle: { display: 'none' },
        }}>
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
          }}
        />
        <Tabs.Screen
          name="ecosystem"
          options={{
            title: 'Ecosystem',
            tabBarIcon: ({ color }) => <IconSymbol size={28} name="paperplane.fill" color={color} />,
          }}
        />
      </Tabs>
    </SafeAreaView>
  );
}
