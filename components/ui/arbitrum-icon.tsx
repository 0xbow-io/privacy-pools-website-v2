import { Image } from 'react-native';

/** Full-color icon from https://arbitrum.io/brand-kit (2026-10-22). */
export function ArbitrumIcon({ width = 18, height = 18 }: { width?: number; height?: number }) {
  return (
    <Image source={require('@/assets/images/chains/arbitrum.png')} resizeMode="contain"
      accessibilityIgnoresInvertColors
      // nw-keep(svg-or-canvas): prop-driven dimensions preserve the official artwork.
      style={{ width, height }} />
  );
}
