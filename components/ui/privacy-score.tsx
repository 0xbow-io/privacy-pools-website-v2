import { View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

type PrivacyScoreProps = {
  width?: number;
  height?: number;
  /** Score from 0 to 100, where 50 is the midpoint */
  score?: number;
};

export function PrivacyScore({ width = 124, height = 10, score = 70 }: PrivacyScoreProps) {
  // Calculate the position of the green portion
  // Score < 50: green on left side, Score > 50: green on right side
  const halfWidth = width / 2;
  const greenWidth = Math.abs(score - 50) * (halfWidth / 50);
  const isPositive = score >= 50;

  return (
    <View
      className="relative h-[16px] justify-center"
      // nw-keep(svg-or-canvas): prop-driven chart geometry (width prop sizes the score bar)
      style={{ width }}
    >
      <View
        className="flex-row"
        // nw-keep(svg-or-canvas): prop-driven chart geometry (width/height props)
        style={{ width, height }}
      >
        {/* Left half */}
        <View className="relative flex-1 flex-row">
          {!isPositive && (
            <View
              className="absolute right-0 h-[10px] bg-[#00ACC4]"
              // nw-keep(svg-or-canvas): score-derived bar length (runtime value)
              style={{ width: greenWidth }}
            />
          )}
          <View className="h-[10px] flex-1 bg-[#F0F0F0]" />
        </View>
        {/* Right half */}
        <View className="relative flex-1 flex-row">
          {isPositive && (
            <View
              className="h-[10px] bg-[#00ACC4]"
              // nw-keep(svg-or-canvas): score-derived bar length (runtime value)
              style={{ width: greenWidth }}
            />
          )}
          <View className="h-[10px] flex-1 bg-[#F0F0F0]" />
        </View>
      </View>
      {/* Center divider */}
      <View className="absolute left-1/2 top-0 -ml-[1px]">
        <Svg width={2} height={16} viewBox="0 0 2 16">
          {/* nw-keep(svg-or-canvas): fixed divider stroke on the score scale (SVG paint) */}
          <Line
            x1="1"
            y1="0"
            x2="1"
            y2="16"
            stroke="#4D4D4D"
            strokeWidth={1}
          />
        </Svg>
      </View>
    </View>
  );
}
