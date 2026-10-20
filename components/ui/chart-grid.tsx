import Svg, { Path } from 'react-native-svg';

type ChartGridProps = {
  width?: number;
  height?: number;
  strokeColor?: string;
};

export function ChartGrid({
  width = 732,
  height = 111,
  strokeColor = '#E6E6E6',
}: ChartGridProps) {
  return (
    <Svg width={width} height={height} viewBox="0 0 732.397 110.547" fill="none">
      {/* nw-keep(svg-or-canvas): SVG stroke fed by the strokeColor prop (chart-grid line color, caller-owned) */}
      <Path
        d="M732.397 8.82145H684.665L673.758 0.631611L641.905 25.9104L621.634 0.631611H450.786L430.516 89.1073L398.663 63.8285H271.251L249.359 25.9104H145.638L97.0617 110.047H37.339L0.45777 26.0982"
        stroke={strokeColor}
      />
    </Svg>
  );
}
