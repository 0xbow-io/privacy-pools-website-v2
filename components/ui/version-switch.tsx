import { View, Text, Platform, Linking } from 'react-native';

import { useTheme } from '@/components/theme-provider';
import { V1_URL, hostOf } from '@/config/site-urls';

export { V1_URL };

/**
 * Small v1 | v2 segmented switch next to the header logo. This site is v2, so
 * v2 is the selected side and v1 is a plain link to the v1 site. No fetch, no
 * request on render. Styled as a compact version of the header nav pills
 * (navbar-tabs.tsx): the same track, highlight and label colours.
 */
export function VersionSwitch() {
  const { colorScheme } = useTheme();
  const linkProps =
    Platform.OS === 'web'
      ? ({ href: V1_URL, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } as object)
      : { onPress: () => Linking.openURL(V1_URL) };

  return (
    <View
      testID="version-switch"
      accessibilityRole="tablist"
      accessibilityLabel="Privacy Pools version"
      className="ml-[6px] h-[28px] shrink-0 flex-row items-center gap-[2px] rounded-pill bg-background-secondary p-[3px]"
    >
      <Text
        accessibilityRole="link"
        accessibilityLabel={`Privacy Pools v1, opens ${hostOf(V1_URL)}`}
        className="h-[22px] rounded-pill px-[9px] font-pp-sans-medium text-[12px] leading-[22px] text-text-secondary hover:bg-card-background/50"
        // nw-keep(platform-css): the spread carries only link props (href on web, onPress on native), no style.
        {...linkProps}
      >
        v1
      </Text>
      <View
        accessibilityRole="tab"
        accessibilityState={{ selected: true }}
        accessibilityLabel="Privacy Pools v2, current site"
        aria-selected
        className={`h-[22px] justify-center rounded-pill px-[9px] ${colorScheme === 'dark' ? 'bg-[#343434]' : 'bg-card-background'}`}
      >
        <Text className="font-pp-sans-medium text-[12px] leading-[22px] text-text">v2</Text>
      </View>
    </View>
  );
}
