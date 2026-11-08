import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Text } from 'react-native';

const prefersReducedMotion = (): boolean => Platform.OS === 'web'
  && typeof window !== 'undefined'
  && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The shared loading pulse: an opacity value breathing between `min` and 1.
 * Held still at the midpoint under reduced motion (the web media query, or
 * the native accessibility setting), so a loading state still reads as one
 * without moving.
 */
export function usePulseOpacity(min = 0.35): Animated.AnimatedInterpolation<number> | number {
  const [pulse] = useState(() => new Animated.Value(0));
  const [still, setStill] = useState(prefersReducedMotion);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((reduce) => { if (live) setStill(reduce); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (still) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, still]);

  const animated = useMemo(() => pulse.interpolate({ inputRange: [0, 1], outputRange: [min, 1] }), [pulse, min]);
  return still ? (min + 1) / 2 : animated;
}

/**
 * In-house loading skeleton: a rounded bar pulsing between ~35% and full
 * opacity of the hairline color. Replaces the em-dash placeholder for
 * figures that are still being computed — a shimmer reads as "loading",
 * a dash reads as "no data".
 *
 * RN core Animated only (no reanimated, no third-party skeleton package),
 * so it renders identically on web and native and costs nothing to ship.
 */
export function Skeleton({
  width,
  height,
  radius = 4,
  className,
  testID,
  accessibilityLabel,
}: {
  width: number;
  height: number;
  radius?: number;
  className?: string;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const opacity = usePulseOpacity();

  return (
    // nw-keep(measured-or-inset): width/height come from the caller as measured
    // dimensions, and the shimmer opacity is an Animated value.
    <Animated.View
      className={className ?? 'bg-border-light'}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      style={{ width, height, borderRadius: radius, opacity }}
    />
  );
}

/**
 * A small pulsing pill beside a figure that is known in part and still
 * syncing ("$0.21+ syncing"). A muted tint of the yield colour, no spinner.
 */
export function SyncingBadge({ testID }: { testID?: string }) {
  const opacity = usePulseOpacity(0.5);
  return (
    // nw-keep(animated): the pulse is an Animated opacity value.
    <Animated.View
      className="rounded-pill bg-success-bg px-[6px] py-[2px]"
      accessibilityLabel="Syncing"
      testID={testID}
      style={{ opacity }}
    >
      <Text className="font-pp-medium text-[10px] leading-[12px] text-success">syncing</Text>
    </Animated.View>
  );
}
