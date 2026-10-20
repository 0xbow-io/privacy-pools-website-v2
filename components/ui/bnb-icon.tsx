import Svg, { Path } from 'react-native-svg';

/**
 * BNB Chain mark, the official glyph — taken verbatim from the v1 website's
 * `src/assets/icons/bnb.svg` so both products draw the same logo.
 *
 * Glyph only, no circle: the chip in chain-logo.tsx owns the brand background,
 * which is what lets one mark serve every size the selector renders at. The
 * token icon (BnbMark in token-network-icon.tsx, BnbTokenIcon in
 * pools/pool-page-shared.tsx) is the other half of the pair and draws its own
 * circle, because token icons are used bare.
 */
export function BnbIcon({ width = 18, height = 18, color = '#FFFFFF' }: { width?: number; height?: number; color?: string }) {
  return (
    // nw-keep(svg-or-canvas): the fill below is the caller's color prop feeding a
    // raw <Path>, which has no className path.
    <Svg width={width} height={height} viewBox="0 0 500 500" fill="none">
      <Path
        d="M250 100l75 75-45 45-30-30-30 30-45-45 75-75zm-100 100l45 45-45 45-45-45 45-45zm200 0l45 45-45 45-45-45 45-45zM250 245l45 45-45 45-45-45 45-45zm0 110l75 75-75 75-75-75 30-30 45 45 45-45 30 30-75-75z"
        fill={color}
      />
    </Svg>
  );
}
