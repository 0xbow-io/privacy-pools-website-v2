import Svg, { Path, Defs, LinearGradient, Stop } from 'react-native-svg';

type ChartLineActiveProps = {
  width?: number;
  height?: number;
};

// Filled area under the chart (green gradient)
export function ChartLineActiveFill({ width = 732, height = 133 }: ChartLineActiveProps) {
  return (
    <Svg width={width} height={height} viewBox="0 0 732 132.839" fill="none">
      <Path
        d="M253.479 44.2378L233.936 132.839H732V8.18984H684.267L673.36 0L641.507 25.2787L621.237 0H450.389L430.119 88.4757L398.266 63.1969H270.854L253.479 44.2378Z"
        fill="url(#paint0_linear_active)"
      />
      {/* nw-keep(svg-or-canvas): gradient stopColor literals are the chart's fixed accent palette (SVG defs, not theme tokens) */}
      <Defs>
        <LinearGradient
          id="paint0_linear_active"
          x1="450.584"
          y1="132.839"
          x2="450.584"
          y2="0"
          gradientUnits="userSpaceOnUse"
        >
          <Stop stopColor="#00ACC4" stopOpacity={0} />
          <Stop offset="1" stopColor="#00ACC4" stopOpacity={0.4} />
        </LinearGradient>
      </Defs>
    </Svg>
  );
}

// Stroke line of the chart (green)
export function ChartLineActiveStroke({ width = 732, height = 134 }: ChartLineActiveProps) {
  return (
    <Svg width={width} height={height} viewBox="0 0 732 133.971" fill="none">
      {/* nw-keep(svg-or-canvas): fixed accent stroke on the active chart line (SVG paint, not a theme token) */}
      <Path
        d="M0 133.471H233.936L253.479 44.8694L270.854 63.8285H398.266L430.119 89.1073L450.389 0.631611H621.237L641.507 25.9104L673.36 0.631611L684.268 8.82145H732"
        stroke="#00ACC4"
        strokeWidth={1}
      />
    </Svg>
  );
}
