import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { formatApyPercent } from '@/services/share-yield';
import { YieldPositionHint } from '@/components/yield/yield-position-hint';

/**
 * YieldBlock (A1/A2) — the Aave-yield opt-out control on the Review Deposit
 * step, rendered directly ABOVE the cost breakdown box. Toggle defaults ON
 * (every deposit goes to the yield pool unless the user opts out; the choice
 * is per-deposit and fixed at deposit time). Flipping it re-totals the cost
 * breakdown in place — the paired <YieldCostRow /> below keeps a constant
 * height in both states so nothing shifts.
 */
export function YieldBlock({
  optIn,
  onToggle,
  apyPercent,
}: {
  optIn: boolean;
  onToggle: (value: boolean) => void;
  /** null = APY unconfigured → the number is omitted (config/yield policy). */
  apyPercent: number | null;
}) {
  return (
    <View
      className="w-full gap-[6px] rounded-control border border-[#B8BBBF] bg-card-background px-[16px] py-[12px] dark:border-border"
      testID="yield-block"
    >
      <View className="w-full flex-row items-center justify-between">
        <View className="flex-row items-center gap-[8px]">
          <Text className="font-pp-medium text-[14px] leading-[20px] text-text">
            Aave yield
          </Text>
          {apyPercent !== null && (
            <Text className="font-pp-regular text-[14px] leading-[20px] text-success">
              {formatApyPercent(apyPercent)}% APY
            </Text>
          )}
          <YieldPositionHint size={13} testID="review-yield-position-hint" />
        </View>
        <Pressable
          onPress={() => onToggle(!optIn)}
          accessibilityRole="switch"
          accessibilityState={{ checked: optIn }}
          accessibilityLabel="Aave yield"
          hitSlop={8}
          testID="yield-toggle"
        >
          <View
            className={`h-[22px] w-[40px] justify-center rounded-control p-[2px] ${
              optIn ? 'bg-success' : 'bg-[#B8BBBF] dark:bg-border'
            }`}
          >
            <View className={`h-[18px] w-[18px] rounded-control bg-[#FFFFFF] ${optIn ? 'self-end' : 'self-start'}`} />
          </View>
        </Pressable>
      </View>
      {/* One terse line either way — constant height, no layout shift. */}
      <Text
        className="font-pp-regular text-[12px] leading-[16px] text-text-muted"
        numberOfLines={1}
        testID="yield-note"
      >
        {optIn
          ? 'Accrues into your balance. Nothing to claim.'
          : 'Per-deposit choice. Can’t switch an existing deposit later.'}
      </Text>
    </View>
  );
}

/**
 * The toggle-driven row inside the cost breakdown box:
 * - ON  → green  "Yield pool · No fee"
 * - OFF → amber  "Non-yield pool fee  +<fee> <symbol>"
 * Single fixed-height row in both states (no layout shift when flipping).
 * The fee value is the Q1 placeholder (see YIELD_OPT_OUT_FEE, default 0).
 */
export function YieldCostRow({
  optIn,
  optOutFee,
  symbol,
}: {
  optIn: boolean;
  optOutFee: number;
  symbol: string;
}) {
  if (optIn) {
    return (
      <View className="min-h-[24px] w-full flex-row items-center justify-between" testID="yield-cost-row">
        <Text className="font-pp-regular text-[16px] leading-[24px] text-success">
          Yield pool
        </Text>
        <Text className="text-right font-pp-regular text-[16px] leading-[24px] text-success">
          No fee
        </Text>
      </View>
    );
  }
  return (
    <View className="min-h-[24px] w-full flex-row items-center justify-between" testID="yield-cost-row">
      <Text className="font-pp-regular text-[16px] leading-[24px] text-warning">
        Non-yield pool fee
      </Text>
      <Text className="text-right font-pp-regular text-[16px] leading-[24px] text-warning">
        +{optOutFee.toFixed(4)} {symbol}
      </Text>
    </View>
  );
}
