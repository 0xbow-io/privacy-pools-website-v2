import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';

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
}: {
  width: number;
  height: number;
  radius?: number;
  className?: string;
}) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
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
  }, [pulse]);

  return (
    // nw-keep(measured-or-inset): width/height come from the caller as measured
    // dimensions, and the shimmer opacity is an Animated value.
    <Animated.View
      className={className ?? 'bg-border-light'}
      style={{
        width,
        height,
        borderRadius: radius,
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
      }}
    />
  );
}
