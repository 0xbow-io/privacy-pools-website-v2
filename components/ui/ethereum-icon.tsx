import Svg, { Polygon, G } from 'react-native-svg';

type EthereumIconProps = {
  width?: number;
  height?: number;
  color?: string;
};

export function EthereumIcon({ width = 16, height = 16, color = '#FFFFFF' }: EthereumIconProps) {
  return (
    <Svg width={width} height={height} viewBox="0 0 784.37 1277.39">
      {/* nw-keep(svg-or-canvas): every Polygon fill below is the caller's color prop with per-facet fillOpacity (Ethereum mark geometry) */}
      <G>
        <Polygon
          fill={color}
          fillOpacity={1}
          fillRule="nonzero"
          points="392.07,0 383.5,29.11 383.5,873.74 392.07,882.29 784.13,650.54"
        />
        <Polygon
          fill={color}
          fillOpacity={0.6}
          fillRule="nonzero"
          points="392.07,0 0,650.54 392.07,882.29 392.07,472.33"
        />
        <Polygon
          fill={color}
          fillOpacity={1}
          fillRule="nonzero"
          points="392.07,956.52 387.24,962.41 387.24,1263.28 392.07,1277.38 784.37,724.89"
        />
        <Polygon
          fill={color}
          fillOpacity={0.6}
          fillRule="nonzero"
          points="392.07,1277.38 392.07,956.52 0,724.89"
        />
        <Polygon
          fill={color}
          fillOpacity={0.8}
          fillRule="nonzero"
          points="392.07,882.29 784.13,650.54 392.07,472.33"
        />
        <Polygon
          fill={color}
          fillOpacity={0.4}
          fillRule="nonzero"
          points="0,650.54 392.07,882.29 392.07,472.33"
        />
      </G>
    </Svg>
  );
}
