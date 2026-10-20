import React, { useState, useMemo } from 'react';
import { View, LayoutChangeEvent, Text, TouchableOpacity, PanResponder, Platform, useWindowDimensions } from 'react-native';

const WEB_CROSSHAIR_STYLE = Platform.select({ web: { cursor: 'crosshair' }, default: {} }) as Record<string, string>;
import Svg, { Path, Defs, LinearGradient, Stop, Line, Text as SvgText, Circle, G, Rect } from 'react-native-svg';
import { Card } from '@/components/ui/card';
import { Colors, Fonts, FontWeights } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';

// Define the shape of our data
export interface DataPoint {
  date: string;
  value: number;
  timestamp: number;
}

export type TimePeriod = '7D' | '30D' | '3M' | 'Max';

/** Real historical point, one per chain event. timestamp is unix seconds. */
export interface HistoryPoint {
  timestamp: number;
  balance: number;
}

interface PortfolioNetValueProps {
  isConnected: boolean;
  hasData: boolean;
  onConnectWallet?: () => void;
  title?: string;
  currentValue?: number;
  /** If provided, overrides the two-point fallback and drives the chart
   *  off a real step-function history (one point per event). */
  series?: HistoryPoint[];
  /** External control over the selected period. When set with onPeriodChange
   *  the chart delegates period state to the caller so the data source can
   *  refetch. */
  period?: TimePeriod;
  onPeriodChange?: (period: TimePeriod) => void;
}

// Define fixed heights for chart geometry
const CHART_HEIGHT = 180;
const X_AXIS_HEIGHT = 40;
const TOTAL_SVG_HEIGHT = CHART_HEIGHT + X_AXIS_HEIGHT;
const TICK_COUNT = 6;
const Y_AXIS_WIDTH = 50;

function currentValuePoints(value: number): DataPoint[] {
  const now = new Date();
  const todayLabel = `${now.getMonth() + 1}/${now.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayLabel = `${yesterday.getMonth() + 1}/${yesterday.getDate()}`;
  const todayTs = Math.floor(now.getTime() / 1000);
  const yesterdayTs = Math.floor(yesterday.getTime() / 1000);
  // Return two points so the chart can draw a visible line segment
  return [
    { date: yesterdayLabel, value, timestamp: yesterdayTs },
    { date: todayLabel, value, timestamp: todayTs },
  ];
}

function collapseDailyPoints(points: DataPoint[]): DataPoint[] {
  if (points.length <= 1) return points;

  const collapsed: DataPoint[] = [];
  for (const point of points) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.date === point.date) {
      last.value = point.value;
      last.timestamp = point.timestamp;
      continue;
    }
    collapsed.push({ ...point });
  }
  return collapsed;
}

function formatShortDate(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatMonthLabel(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString('en-US', { month: 'short' });
}

function buildXAxisTicks(
  points: DataPoint[],
  period: TimePeriod,
  minTimestamp: number,
  maxTimestamp: number,
  paddingLeft: number,
  availableWidth: number,
  isMobile: boolean,
): Array<{ key: string; x: number; label: string }> {
  if (points.length === 0) return [];

  const range = Math.max(1, maxTimestamp - minTimestamp);
  const toX = (timestamp: number) => paddingLeft + ((timestamp - minTimestamp) / range) * availableWidth;

  if (period === '7D') {
    const stride = isMobile ? 2 : 1;
    return points
      .filter((_, index) => index % stride === 0 || index === points.length - 1)
      .map((point) => ({
        key: `d-${point.timestamp}`,
        x: toX(point.timestamp),
        label: point.date,
      }));
  }

  if (period === '30D') {
    const desiredTicks = isMobile ? 3 : 5;
    const ticks: Array<{ key: string; x: number; label: string }> = [];
    for (let i = 0; i < desiredTicks; i += 1) {
      // desiredTicks is narrowed to `3 | 5`; the literal-vs-literal check
      // for `=== 1` confuses TS but the runtime guard is the desired
      // shape for a future change that might add a 1-tick mode. Widen
      // to plain `number` for the comparison.
      const ratio = (desiredTicks as number) === 1 ? 0 : i / (desiredTicks - 1);
      const timestamp = Math.round(minTimestamp + range * ratio);
      ticks.push({
        key: `w-${i}-${timestamp}`,
        x: toX(timestamp),
        label: formatShortDate(timestamp),
      });
    }
    return ticks;
  }

  const ticks: Array<{ key: string; x: number; label: string }> = [];
  const start = new Date(minTimestamp * 1000);
  const end = new Date(maxTimestamp * 1000);
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);

  while (cursor.getTime() / 1000 <= maxTimestamp) {
    const timestamp = Math.floor(cursor.getTime() / 1000);
    if (timestamp >= minTimestamp) {
      ticks.push({
        key: `m-${timestamp}`,
        x: toX(timestamp),
        label: formatMonthLabel(timestamp),
      });
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const lastMonthLabel = formatMonthLabel(maxTimestamp);
  if (ticks.length === 0 || ticks[ticks.length - 1].label !== lastMonthLabel) {
    ticks.push({
      key: `m-end-${maxTimestamp}`,
      x: toX(maxTimestamp),
      label: lastMonthLabel,
    });
  }

  if (isMobile && ticks.length > 3) {
    return [ticks[0], ticks[Math.floor((ticks.length - 1) / 2)], ticks[ticks.length - 1]];
  }

  return ticks;
}

export function PortfolioNetValue({ isConnected, hasData, onConnectWallet, title, currentValue = 0, series, period, onPeriodChange }: PortfolioNetValueProps) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  const isMobile = width <= 450;

  // State
  const [containerWidth, setContainerWidth] = useState(0);
  const [activePoint, setActivePoint] = useState<{ x: number, y: number, date: string, value: number } | null>(null);
  const [internalPeriod, setInternalPeriod] = useState<TimePeriod>('30D');
  const selectedPeriod = period ?? internalPeriod;
  const setSelectedPeriod = (p: TimePeriod) => { onPeriodChange?.(p); setInternalPeriod(p); };

  const onLayout = (event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  };

  // Prefer a real step-function series when the caller passes one. Fall back
  // to the old two-point "current value" rendering otherwise (matches the
  // previous behaviour so callers that don't pass `series` keep working).
  const periodData = useMemo(() => {
    if (series && series.length > 0) {
      const dailyPoints = series.map((p) => {
        return { date: formatShortDate(p.timestamp), value: p.balance, timestamp: p.timestamp };
      });
      return collapseDailyPoints(dailyPoints);
    }
    return currentValuePoints(hasData ? currentValue : 0);
  }, [series, currentValue, hasData]);

  // Determine which data to show
  const activeData = useMemo(() => {
    if (!isConnected) return periodData;
    if (hasData) return periodData;
    return periodData.map(d => ({ ...d, value: 0 }));
  }, [isConnected, hasData, periodData]);

  // Chart Generation Logic
  const chartData = useMemo(() => {
    if (!containerWidth || containerWidth <= Y_AXIS_WIDTH) {
      return { linePath: '', fillPath: '', points: [], yTicks: [], xTicks: [], paddingLeft: 0 };
    }

    const values = activeData.map(d => d.value);
    const maxY = Math.max(...values) * 1.1;
    const minY = 0;
    const rangeY = maxY - minY || 1;
    const minTimestamp = Math.min(...activeData.map((d) => d.timestamp));
    const maxTimestamp = Math.max(...activeData.map((d) => d.timestamp));
    const rangeX = Math.max(1, maxTimestamp - minTimestamp);

    // INCREASED PADDING: Changed from 10 to 27 to prevent left label cutoff
    const paddingLeft = 27;
    const paddingRight = 10;
    const graphWidth = containerWidth - Y_AXIS_WIDTH;
    const availableWidth = graphWidth - paddingLeft - paddingRight;

    const points = activeData.map((point, index) => {
      const x = activeData.length === 1
        ? paddingLeft + availableWidth / 2
        : paddingLeft + ((point.timestamp - minTimestamp) / rangeX) * availableWidth;
      const normalizedValue = (point.value - minY) / rangeY;
      const y = CHART_HEIGHT - (normalizedValue * CHART_HEIGHT);
      return { x, y, date: point.date, value: point.value, timestamp: point.timestamp };
    });

    const xTicks = buildXAxisTicks(
      activeData,
      selectedPeriod,
      minTimestamp,
      maxTimestamp,
      paddingLeft,
      availableWidth,
      isMobile,
    );

    const yTicks = Array.from({ length: TICK_COUNT }, (_, i) => {
      const value = minY + (rangeY * i) / (TICK_COUNT - 1);
      const normalizedValue = (value - minY) / rangeY;
      const y = CHART_HEIGHT - (normalizedValue * CHART_HEIGHT);
      return { value, y };
    });

    const lineCommand = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(' ');

    const fillCommand = `
      ${lineCommand}
      L ${points[points.length - 1].x} ${CHART_HEIGHT}
      L ${points[0].x} ${CHART_HEIGHT}
      Z
    `;

    return { linePath: lineCommand, fillPath: fillCommand, points, yTicks, xTicks, paddingLeft };
  }, [containerWidth, activeData, selectedPeriod, isMobile]);

  // --- Interaction Handlers ---

  // 1. Shared logic to find the nearest point
  const handleTouch = (x: number) => {
    if (!isConnected || chartData.points.length === 0) return;

    let nearest = chartData.points[0];
    let nearestDistance = Math.abs(x - nearest.x);
    for (const point of chartData.points) {
      const distance = Math.abs(x - point.x);
      if (distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }
    setActivePoint(nearest);
  };

  // 2. PanResponder for Mobile Touch (and Web Click/Drag)
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponderCapture: () => true,

    onPanResponderGrant: (evt) => handleTouch(evt.nativeEvent.locationX),
    onPanResponderMove: (evt) => handleTouch(evt.nativeEvent.locationX),
    onPanResponderRelease: () => setActivePoint(null),
    onPanResponderTerminate: () => setActivePoint(null),
  }), [chartData, isConnected]);

  // 3. Specific Mouse Handler for Web Hover
  const handleMouseMove = (e: { nativeEvent: { offsetX?: number; locationX?: number } }) => {
    // nativeEvent.offsetX is standard for web, locationX is RNW polyfill
    const x = e.nativeEvent.offsetX || e.nativeEvent.locationX || 0;
    handleTouch(x);
  };

  // --- Visuals ---
  const showActiveState = isConnected;
  const chartColor = showActiveState ? '#8ba342' : colors.borderLight;
  const axisLabelColor = colors.textSecondary;
  const inactiveLabelColor = colors.textMuted;
  const gridColor = colors.borderLight;
  const gradientId = showActiveState ? "activeGradient" : "inactiveGradient";

  const tooltipBg = colors.surfaceRaised;
  const tooltipText = colors.text;
  const tooltipBorder = colors.borderLight;

  return (
    <Card noPadding>
      {/* Header */}
      <View className="flex-row items-center justify-between border-b border-b-border p-[16px]">
        <Text className={`font-pp-bold text-[16px] leading-[16px] ${showActiveState ? 'text-text' : 'text-[#cccccc]'}`}>
          {title || 'Portfolio Net Value'}
        </Text>

        <View className="flex-row gap-[4px]">
          {(['7D', '30D', '3M', 'Max'] as TimePeriod[]).map((period) => (
            <TouchableOpacity
              key={period}
              className={`rounded-[4px] border border-border px-[8px] py-[4px] ${showActiveState && selectedPeriod === period ? 'bg-[#eeeeee] dark:bg-[#333333]' : ''}`}
              disabled={!showActiveState}
              onPress={() => setSelectedPeriod(period)}
            >
              <Text className={`font-pp-regular text-[12px] ${showActiveState ? 'text-text' : 'text-[#cccccc]'}`}>
                {period}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Chart Container */}
      <View className="w-full pb-[10px] pt-[16px]" onLayout={onLayout}>
        {/* Empty state text overlay */}
        {!isConnected && (
          <View
            className="absolute inset-0 z-[10] items-center justify-center px-[20px]"
            // nw-keep(measured-or-inset): responsive inset from the width<657 JS breakpoint (Y/X axis gutters)
            style={width < 657 ? { right: Y_AXIS_WIDTH, bottom: X_AXIS_HEIGHT } : undefined}
          >
            <Text className="text-center font-pp-medium text-[16px] leading-[19.2px] text-text">
              Seems like there is no data to show this graph yet
            </Text>
          </View>
        )}
        {containerWidth > 0 && (
          <Svg
            width={containerWidth}
            height={TOTAL_SVG_HEIGHT}
            // nw-keep(svg-or-canvas): SVG root overflow + all child stroke/fill colors are runtime chart
            // values fed to react-native-svg props (no className path on SVG primitives).
            style={{ overflow: 'visible' }}
          >
            <Defs>
              <LinearGradient id="activeGradient" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#8ba342" stopOpacity="0.3" />
                <Stop offset="1" stopColor="#8ba342" stopOpacity="0" />
              </LinearGradient>
              <LinearGradient id="inactiveGradient" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#C8C8C8" stopOpacity="0.2" />
                <Stop offset="1" stopColor="#C8C8C8" stopOpacity="0" />
              </LinearGradient>
            </Defs>

            {/* Grid Lines */}
            <Line x1="0" y1={CHART_HEIGHT} x2={containerWidth} y2={CHART_HEIGHT} stroke={gridColor} strokeWidth="1" />
            {showActiveState && (
               <Line x1="0" y1={CHART_HEIGHT / 2} x2={containerWidth} y2={CHART_HEIGHT / 2} stroke={gridColor} strokeWidth="1" strokeDasharray="5, 5" />
            )}

            {/* Fill */}
            <Path d={chartData.fillPath} fill={`url(#${gradientId})`} />

            {/* Line */}
            <Path d={chartData.linePath} stroke={chartColor} strokeWidth="2" fill="none" />

            {/* --- ACTIVE INTERACTION LAYER (Visuals) --- */}
            {activePoint && showActiveState && (
              <G>
                {/* Dashed Vertical Cursor Line */}
                <Line
                  x1={activePoint.x}
                  y1={0}
                  x2={activePoint.x}
                  y2={CHART_HEIGHT}
                  stroke={gridColor}
                  strokeDasharray="4, 4"
                  strokeWidth="1"
                />

                {/* The Green Dot */}
                <Circle
                  cx={activePoint.x}
                  cy={activePoint.y}
                  r="4"
                  fill={colors.background}
                  stroke={chartColor}
                  strokeWidth="2"
                />

                {/* Tooltip Group */}
                <G
                  x={activePoint.x > containerWidth - 100 ? activePoint.x - 70 : activePoint.x + 10}
                  y={activePoint.y - 50 > 0 ? activePoint.y - 50 : activePoint.y + 10}
                >
                  <Rect
                    width="70"
                    height="35"
                    rx="4"
                    fill={tooltipBg}
                    stroke={tooltipBorder}
                    strokeWidth="1"
                  />
                  <SvgText
                    x="35"
                    y="14"
                    fontSize="10"
                    fontFamily={Fonts.bold}
                    fontWeight={FontWeights.bold}
                    fill={tooltipText}
                    textAnchor="middle"
                  >
                    ${activePoint.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  </SvgText>
                  <SvgText
                    x="35"
                    y="27"
                    fontSize="9"
                    fontFamily={Fonts.regular}
                    fontWeight={FontWeights.regular}
                    fill={colors.textSecondary}
                    textAnchor="middle"
                  >
                    {activePoint.date}
                  </SvgText>
                </G>
              </G>
            )}

            {/* X-Axis Labels */}
            {chartData.xTicks.map((tick) => (
              <SvgText
                key={tick.key}
                x={tick.x}
                y={CHART_HEIGHT + 20}
                fontSize="12"
                fontFamily={Fonts.regular}
                fontWeight={FontWeights.regular}
                fill={showActiveState ? axisLabelColor : inactiveLabelColor}
                textAnchor="middle"
              >
                {tick.label}
              </SvgText>
            ))}

            {/* Y-Axis Labels. Scale decimals to the max tick so sub-1 charts
               don't collapse to all "0" labels. */}
            {(() => {
              const maxTick = chartData.yTicks.reduce((m, t) => Math.max(m, Math.abs(t.value)), 0);
              const digits = maxTick >= 100 ? 0 : maxTick >= 10 ? 1 : maxTick >= 1 ? 2 : 3;
              // Smallest value that won't collapse to zero at this precision.
              const floor = Math.pow(10, -digits);
              return chartData.yTicks.map((tick, index) => {
                let yPos = tick.y + 4;
                if (index === chartData.yTicks.length - 1) yPos = tick.y + 10;
                if (index === 0) yPos = tick.y - 5;
                const absValue = Math.abs(tick.value);
                const label = absValue > 0 && absValue < floor / 2
                  ? `<${floor.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
                  : tick.value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
                return (
                  <SvgText
                    key={`y-tick-${index}`}
                    x={containerWidth - 6}
                    y={yPos}
                    fontSize="12"
                    fontFamily={Fonts.regular}
                    fontWeight={FontWeights.regular}
                    fill={showActiveState ? axisLabelColor : inactiveLabelColor}
                    textAnchor="end"
                  >
                    {label}
                  </SvgText>
                );
              });
            })()}
          </Svg>
        )}

        {/* --- INTERACTION OVERLAY (Invisible View on top) --- */}
        {showActiveState && (
          <View
            className="absolute inset-0"
            // nw-keep(platform-css): web-only crosshair cursor on the interaction overlay
            style={WEB_CROSSHAIR_STYLE}
            {...panResponder.panHandlers}
            {...(Platform.OS === 'web' ? { onMouseMove: handleMouseMove, onMouseLeave: () => setActivePoint(null) } : {})}
          />
        )}
      </View>
    </Card>
  );
}
