import React from 'react';
import { View, Text, Pressable } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/**
 * FullWithdrawalGuard (A3) — trips when the user selects 100% of their
 * balance. Hard warning + acknowledgment checkbox; the withdraw CTA stays
 * disabled until acknowledged. The escape hatch resets the selection to 75%
 * in one tap (the parent owns the amount state and performs the reset).
 */
export function FullWithdrawalGuard({
  acknowledged,
  onAcknowledge,
  onEscape,
}: {
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  onEscape: () => void;
}) {
  return (
    <View
      className="w-full gap-[8px] rounded-control border border-danger bg-danger-bg px-[12px] py-[10px]"
      testID="full-withdrawal-guard"
    >
      <Text className="font-pp-bold text-[13px] leading-[18px] text-danger">
        Full withdrawal
      </Text>
      <Text className="font-pp-regular text-[12px] leading-[17px] text-danger">
        Withdrawing your entire balance in one transaction makes it easier to link your withdrawal to your deposit
      </Text>
      <Pressable
        className="flex-row items-center gap-[8px]"
        onPress={() => onAcknowledge(!acknowledged)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: acknowledged }}
        testID="full-withdrawal-ack"
      >
        <View
          className={`h-[16px] w-[16px] items-center justify-center rounded-[4px] border-[1.5px] border-danger ${
            acknowledged ? 'bg-danger' : 'bg-transparent'
          }`}
        >
          {acknowledged && (
            // nw-keep(svg-or-canvas): fixed white checkmark glyph inside the danger-filled box
            <Svg width={10} height={10} viewBox="0 0 10 10" fill="none">
              <Path d="M1.5 5.5L4 8L8.5 2.5" stroke="#FFFFFF" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          )}
        </View>
        <Text className="flex-1 font-pp-medium text-[12px] leading-[17px] text-text">
          I understand, withdraw everything anyway
        </Text>
      </Pressable>
      <Pressable
        className="self-start rounded-legacy-8 border border-[#B8BBBF] bg-card-background px-[12px] py-[6px] dark:border-border"
        onPress={onEscape}
        testID="full-withdrawal-escape"
      >
        <Text className="font-pp-medium text-[12px] leading-[16px] text-text">
          Withdraw 75% instead
        </Text>
      </Pressable>
    </View>
  );
}
