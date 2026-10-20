import Svg, { Path, Defs, LinearGradient, Stop } from 'react-native-svg';

type ChartLineProps = {
  width?: number;
  height?: number;
};

export function ChartLine({ width = 732, height = 133 }: ChartLineProps) {
  return (
    <Svg width={width} height={height} viewBox="0 0 732 132.839" fill="none">
      <Path
        d="M248.624 25.2415H145.56L96.5886 109.421H36.7345L0 25.2415V132.839H732V8.18984H684.267L673.36 0L641.507 25.2787L621.237 0H450.389L430.119 88.4757L398.266 63.1969H270.854L248.624 25.2415Z"
        fill="url(#paint0_linear)"
      />
      {/* nw-keep(svg-or-canvas): gradient stopColor literals are the chart's fixed decorative palette (SVG defs, not theme tokens) */}
      <Defs>
        <LinearGradient
          id="paint0_linear"
          x1="450.584"
          y1="132.839"
          x2="450.584"
          y2="0"
          gradientUnits="userSpaceOnUse"
        >
          <Stop stopColor="#EAEAEA" stopOpacity={0} />
          <Stop offset="1" stopColor="#EAEAEA" stopOpacity={0.4} />
        </LinearGradient>
      </Defs>
    </Svg>
  );
}
