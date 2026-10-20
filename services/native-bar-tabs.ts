import type Ionicons from '@expo/vector-icons/Ionicons';

export type NativeBarTab = {
  key: 'card';
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  label: string;
  href: string;
};

/**
 * Bottom-bar tabs that exist only in the native app, each with its route.
 * Web has none; the native list lives in native-bar-tabs.native.ts so neither
 * the tabs nor their routes reach the web bundle.
 */
export const NATIVE_BAR_TABS: NativeBarTab[] = [];
