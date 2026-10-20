import Svg, { Path } from 'react-native-svg';

/**
 * Citrea network mark (web3icons `networks/mono/citrea`, https://www.web3icons.io/networks/citrea)
 * — the six-shard glyph, drawn in a single `color` so it sits on Citrea's
 * orange chip like the Ethereum/Sui marks do on theirs.
 */
export function CitreaIcon({ width = 18, height = 18, color = '#FFFFFF' }: { width?: number; height?: number; color?: string }) {
  return (
    // nw-keep(svg-or-canvas): every fill below is the caller's color prop feeding
    // raw <Path> fills, which have no className path.
    <Svg width={width} height={height} viewBox="0 0 24 24" fill="none">
      <Path d="M12.0002 9.9871C11.5864 9.9871 11.1726 9.78064 10.8622 9.36774L7.75879 4H16.1381L13.0347 9.36774C12.8278 9.78064 12.414 9.9871 11.8967 9.9871H12.0002Z" fill={color} />
      <Path d="M14.8966 11.6384C14.4828 11.6384 14.069 11.432 13.7587 11.019C13.5518 10.6061 13.5518 10.1932 13.7587 9.78034L16.8621 4.4126L21.0001 11.6384H14.7932H14.8966Z" fill={color} />
      <Path d="M7.8623 20.0003L10.9658 14.6325C11.1726 14.2196 11.5864 14.0132 12.1037 14.0132C12.6209 14.0132 12.9313 14.2196 13.2416 14.6325L16.3451 20.0003H7.8623Z" fill={color} />
      <Path d="M13.7587 14.3229C13.5518 13.91 13.5518 13.4971 13.7587 13.0842C13.9656 12.6713 14.3794 12.4648 14.8966 12.4648H21.0001L16.8621 19.6906L13.7587 14.3229Z" fill={color} />
      <Path d="M3 11.6384L7.13793 4.4126L10.2414 9.78034C10.4483 10.1932 10.4483 10.6061 10.2414 11.019C10.0345 11.432 9.62069 11.6384 9.10345 11.6384H3Z" fill={color} />
      <Path d="M3 12.4648H9.2069C9.62069 12.4648 10.0345 12.6713 10.3448 13.0842C10.5517 13.4971 10.5517 13.91 10.3448 14.3229L7.24138 19.6906L3.10345 12.4648H3Z" fill={color} />
    </Svg>
  );
}
