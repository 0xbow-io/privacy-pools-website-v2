import { StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Rect, Pattern, Path, Circle } from 'react-native-svg';
import { ActiveDesignVariant, Glow } from '@/constants/theme';
import { VaultBackdropPalette } from '@/constants/theme-data';
import { useTheme } from '@/components/theme-provider';

/**
 * Atmosphere layer behind every screen. Two renderings, switched by the
 * active design variant (`?theme=`):
 *
 * - Electric Blue (variants 2/3): two ambient glows (top-left, bottom-right —
 *   matching the design spec's body::before/after radials) plus a soft violet
 *   accent in light mode, over a whisper-faint 40px grid so the canvas reads
 *   as engineered material.
 * - Warm Vault (variant 1): soft evergreen/amber radial washes plus a sparse
 *   dot lattice so the canvas reads as material, not dead space.
 *
 * Light mode runs the same composition at higher opacities with the bright
 * accent colors — the deep light-mode tints would just read as grey on the
 * white canvas, so the bloom comes from saturation instead of darkness.
 *
 * Pure decoration: pointerEvents none, sits behind content.
 */
export function VaultBackdrop() {
  const { colorScheme } = useTheme();
  const dark = colorScheme === 'dark';

  if (ActiveDesignVariant === 1) {
    const warm = VaultBackdropPalette.warmVault;
    const scheme = dark ? 'dark' : 'light';
    const dotColor = warm.dot[scheme];
    return (
      /* nw-keep(platform-css): StyleSheet.absoluteFill is the full-bleed backdrop
         layer, and the SVG gradient stops below take runtime theme colors */
      /* nw-keep(platform-css): same full-bleed backdrop layer as the variant above */
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
          <Defs>
            <RadialGradient id="vault-evergreen" cx="50%" cy="42%" r="55%">
              <Stop offset="0%" stopColor={warm.evergreenGlow} stopOpacity={warm.evergreenOpacity[scheme]} />
              <Stop offset="100%" stopColor={warm.evergreenGlow} stopOpacity="0" />
            </RadialGradient>
            <RadialGradient id="vault-amber" cx="85%" cy="6%" r="45%">
              <Stop offset="0%" stopColor={warm.amberGlow} stopOpacity={warm.amberOpacity[scheme]} />
              <Stop offset="100%" stopColor={warm.amberGlow} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#vault-evergreen)" />
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#vault-amber)" />
          {/* Dot lattice — sparse, hand-placed rows to stay cheap on native. */}
          {Array.from({ length: 6 }).map((_, row) =>
            Array.from({ length: 10 }).map((__, col) => (
              <Circle
                key={`${row}-${col}`}
                cx={`${4 + col * 10.2}%`}
                cy={`${6 + row * 16}%`}
                r={1.2}
                fill={dotColor}
              />
            )),
          )}
        </Svg>
      </View>
    );
  }

  const electric = VaultBackdropPalette.electric;
  const scheme = dark ? 'dark' : 'light';
  const gridColor = electric.grid[scheme];
  // The bright cyan blooms on both canvases; the deep teal only worked on dark.
  const glow = Glow.dark;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
        <Defs>
          <Pattern id="vault-grid" width={40} height={40} patternUnits="userSpaceOnUse">
            <Path d="M 40 0 L 0 0 0 40" fill="none" stroke={gridColor} strokeWidth={1} />
          </Pattern>
          <RadialGradient id="vault-glow-a" cx="8%" cy="0%" r="55%">
            <Stop offset="0%" stopColor={glow} stopOpacity={electric.glowAOpacity[scheme]} />
            <Stop offset="100%" stopColor={glow} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="vault-glow-b" cx="95%" cy="100%" r="60%">
            <Stop offset="0%" stopColor={glow} stopOpacity={electric.glowBOpacity[scheme]} />
            <Stop offset="100%" stopColor={glow} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="vault-glow-violet" cx="85%" cy="4%" r="45%">
            <Stop offset="0%" stopColor={electric.violet} stopOpacity={electric.violetOpacity} />
            <Stop offset="100%" stopColor={electric.violet} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#vault-grid)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#vault-glow-a)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#vault-glow-b)" />
        {/* Light only: a whisper of the violet secondary for depth — dark
            already gets its depth from the glass surfaces. */}
        {!dark && <Rect x="0" y="0" width="100%" height="100%" fill="url(#vault-glow-violet)" />}
      </Svg>
    </View>
  );
}
