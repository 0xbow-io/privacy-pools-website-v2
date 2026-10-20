import Svg, { Path } from 'react-native-svg';

type DashedEllipseProps = {
  width?: number;
  height?: number;
  strokeColor?: string;
  fillColor?: string;
};

export function DashedEllipse({
  width = 430,
  height = 430,
  strokeColor = '#D9D9D9',
  fillColor = 'white',
}: DashedEllipseProps) {
  return (
    <Svg
      width={width}
      height={height}
      viewBox="0 0 430.222 429.557"
      fill="none"
    >
      {/* nw-keep(svg-or-canvas): SVG fill/stroke fed by caller props (decorative ellipse paints, caller-owned defaults) */}
      <Path
        d="M215.111 0.5C333.638 0.500263 429.722 96.4366 429.722 214.778C429.722 333.12 333.638 429.056 215.111 429.057C96.5843 429.057 0.5 333.12 0.5 214.778C0.500025 96.4364 96.5843 0.5 215.111 0.5Z"
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth={1}
      />
    </Svg>
  );
}
