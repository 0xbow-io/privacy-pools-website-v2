import type { NativeBarTab } from './native-bar-tabs';

/** Native app only: the Card tab, placed before "More". */
export const NATIVE_BAR_TABS: NativeBarTab[] = [
  { key: 'card', icon: 'card-outline', activeIcon: 'card', label: 'Card', href: '/card' },
];
