import type { PropsWithChildren, ReactElement } from 'react';
import Animated, {
  interpolate,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollOffset,
} from 'react-native-reanimated';

import { ThemedView } from '@/components/themed-view';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useThemeColor } from '@/hooks/use-theme-color';

const HEADER_HEIGHT = 250;

type Props = PropsWithChildren<{
  headerImage: ReactElement;
  headerBackgroundColor: { dark: string; light: string };
}>;

export default function ParallaxScrollView({
  children,
  headerImage,
  headerBackgroundColor,
}: Props) {
  const backgroundColor = useThemeColor({}, 'background');
  const rawColorScheme = useColorScheme();
  const colorScheme: 'light' | 'dark' = rawColorScheme === 'dark' ? 'dark' : 'light';
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useScrollOffset(scrollRef);
  const headerAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateY: interpolate(
            scrollOffset.value,
            [-HEADER_HEIGHT, 0, HEADER_HEIGHT],
            [-HEADER_HEIGHT / 2, 0, HEADER_HEIGHT * 0.75]
          ),
        },
        {
          scale: interpolate(scrollOffset.value, [-HEADER_HEIGHT, 0, HEADER_HEIGHT], [2, 1, 1]),
        },
      ],
    };
  });

  return (
    <Animated.ScrollView
      ref={scrollRef}
      className="flex-1"
      // nw-keep(data-color): scheme-resolved page background from useThemeColor (runtime value, not a class token)
      style={{ backgroundColor }}
      scrollEventThrottle={16}>
      <Animated.View
        className="h-[250px] overflow-hidden"
        style={[
          // nw-keep(data-color): caller-provided per-scheme header background (runtime prop)
          { backgroundColor: headerBackgroundColor[colorScheme] },
          // nw-keep(animated): parallax translateY/scale driven by scroll offset
          headerAnimatedStyle,
        ]}>
        {headerImage}
      </Animated.View>
      <ThemedView className="flex-1 gap-[16px] overflow-hidden p-[32px]">{children}</ThemedView>
    </Animated.ScrollView>
  );
}
