import { View, Text, Platform, Linking } from 'react-native';

import { V1_URL, hostOf } from '@/config/site-urls';

export { V1_URL };

/**
 * Small v1 | v2 segmented switch next to the header logo. This site is v2, so
 * v2 is the selected side and v1 is a plain link to the v1 site. No fetch, no
 * request on render.
 */
export function VersionSwitch() {
  const linkProps =
    Platform.OS === 'web'
      ? ({ href: V1_URL, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } as object)
      : { onPress: () => Linking.openURL(V1_URL) };

  return (
    <View
      testID="version-switch"
      accessibilityRole="tablist"
      accessibilityLabel="Privacy Pools version"
      className="ml-[6px] h-[26px] shrink-0 flex-row items-center rounded-[8px] border border-border-light p-[2px]"
    >
      <Text
        accessibilityRole="link"
        accessibilityLabel={`Privacy Pools v1, opens ${hostOf(V1_URL)}`}
        className="h-[20px] rounded-[6px] px-[6px] text-[12px] leading-[20px] text-text-secondary"
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
        className="h-[20px] justify-center rounded-[6px] bg-background-secondary px-[6px]"
      >
        <Text className="font-pp-bold text-[12px] leading-[20px] text-text">v2</Text>
      </View>
    </View>
  );
}
