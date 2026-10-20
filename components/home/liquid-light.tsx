import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Circle } from 'react-native-svg';
import { ActiveDesignVariant } from '@/constants/theme';
import { LiquidLightPalettes } from '@/constants/theme-data';
import { useTheme } from '@/components/theme-provider';

/**
 * Liquid light for the signed-out home: three enormous soft-edged color
 * blooms drifting on slow, out-of-phase orbits behind the content — the
 * "something alive is in here" feeling, kept far under the legibility line.
 * Mounts only while visible (plus a fade-out tail), so connected sessions
 * pay zero animation cost.
 */

// Per-design-variant bloom palettes (protagonist / magic / tide) live in the
// pure token source alongside every other variant map.
const PALETTE = LiquidLightPalettes[ActiveDesignVariant] ?? LiquidLightPalettes[3];

// Deterministic-motion test hook (visual-baseline harness, scripts/visual/):
// when the harness seeds `ppv2_freeze_motion=1` the drift loops never start
// (blobs hold their authored start pose) and the fade jumps straight to its
// target, so repeated captures are pixel-stable. Static read at module load,
// same pattern as the variant resolution above; inert in production.
const MOTION_FROZEN =
  Platform.OS === 'web' &&
  typeof window !== 'undefined' &&
  (() => {
    try {
      return window.localStorage.getItem('ppv2_freeze_motion') === '1';
    } catch {
      return false;
    }
  })();

const BLOBS = [
  // Upper left — the protagonist.
  { color: PALETTE[0], size: 680, left: '-12%', top: '-6%', duration: 19000, dx: 90, dy: 60, grow: 1.18 },
  // Right flank — the magic.
  { color: PALETTE[1], size: 560, left: '58%', top: '22%', duration: 27000, dx: -70, dy: 90, grow: 1.24 },
  // Low and slow — the tide.
  { color: PALETTE[2], size: 620, left: '6%', top: '58%', duration: 34000, dx: 80, dy: -70, grow: 1.12 },
] as const;

function Blob({
  id,
  color,
  size,
  opacity,
}: {
  id: string;
  color: string;
  size: number;
  opacity: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor={color} stopOpacity={opacity} />
          <Stop offset="60%" stopColor={color} stopOpacity={opacity * 0.45} />
          <Stop offset="100%" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={50} cy={50} r={50} fill={`url(#${id})`} />
    </Svg>
  );
}

function DriftingBlob({ index }: { index: number }) {
  const { colorScheme } = useTheme();
  const blob = BLOBS[index];
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (MOTION_FROZEN) return; // hold the start pose. See MOTION_FROZEN above
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration: blob.duration,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(t, {
          toValue: 0,
          duration: blob.duration,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [t, blob.duration]);

  // Light mode needs more saturation to bloom on white (same logic as the
  // static backdrop glows).
  const opacity = colorScheme === 'dark' ? 0.1 : 0.16;

  return (
    <Animated.View
      // nw-keep(animated): transform rides Animated.Value interpolations (the translate/scale drift
      // loop); left/top are per-blob layout data — no static className path for this animated node
      style={{
        position: 'absolute',
        left: blob.left,
        top: blob.top,
        transform: [
          { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, blob.dx] }) },
          { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, blob.dy] }) },
          { scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, blob.grow] }) },
        ],
      }}
    >
      <Blob id={`liquid-${index}`} color={blob.color} size={blob.size} opacity={opacity} />
    </Animated.View>
  );
}

export function LiquidLight({ visible }: { visible: boolean }) {
  // Always enter from 0 — the layer mounts lazily after idle, and a slow
  // fade-in is part of the magic (no pop-in).
  const fade = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
    if (MOTION_FROZEN) {
      // Jump to the target opacity so captures see the layer's settled state.
      fade.setValue(visible ? 1 : 0);
      if (!visible) setMounted(false);
      return;
    }
    const anim = Animated.timing(fade, {
      toValue: visible ? 1 : 0,
      duration: 1200,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    anim.start(({ finished }) => {
      // Drop the whole layer (and its drift loops) once faded out.
      if (finished && !visible) setMounted(false);
    });
    return () => anim.stop();
  }, [visible, fade]);

  if (!mounted) return null;

  return (
    // nw-keep(animated): opacity rides the Animated.Value fade; absoluteFill positions the animated layer
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: fade, overflow: 'hidden' }]}>
      {BLOBS.map((_, i) => (
        <DriftingBlob key={i} index={i} />
      ))}
    </Animated.View>
  );
}
