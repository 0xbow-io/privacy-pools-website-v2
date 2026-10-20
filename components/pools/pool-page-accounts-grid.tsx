import { useCallback, useState } from 'react';
import { View, Text, Pressable, useWindowDimensions } from 'react-native';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import {
  ArrowRightIcon,
  OverflowMenuIcon,
  DepositArrowIcon,
  WithdrawArrowIcon,
  WEB_FIXED_POSITION,
  useEscapeToClose,
  type PoolAccount,
} from './pool-page-shared';

type Props = {
  poolAccounts: PoolAccount[];
  onDeposit: () => void;
  onWithdraw: () => void;
};

export function PoolPageAccountsGrid({ poolAccounts, onDeposit, onWithdraw }: Props) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  const [openPaMenuId, setOpenPaMenuId] = useState<number | null>(null);
  const showEmptyCard = width >= 600 && poolAccounts.length === 1;

  useEscapeToClose(useCallback(() => setOpenPaMenuId(null), []), openPaMenuId !== null);

  return (
    <>
      <View className="-mt-[1px] justify-center border-t border-l border-r border-b-0 p-[16px] border-border bg-card-background">
        <Text className="text-[16px] leading-[16px] text-text font-pp-bold">
          My Assets
        </Text>
      </View>
      <View className="flex-row flex-wrap overflow-visible border-l border-[#4D4D4D]">
        {poolAccounts.map((acct, i) => (
          <View
            key={i}
            className={`gap-[8px] overflow-visible border-t border-r border-l-0 border-b-0 p-[20px] border-[#4D4D4D] bg-card-background ${width < 600 ? 'w-full' : 'w-1/2'}${openPaMenuId === i ? ' z-[99999]' : ''}`}
          >
            <View className="flex-row items-center gap-[8px] h-[26px] overflow-visible z-[99999]">
              <View className="flex-1 flex-row items-center gap-[8px]">
                <View className="flex-row items-end pr-[6px]">
                  <acct.icon size={20} />
                  <View className="h-[12px] w-[12px] ml-[-6px] overflow-hidden rounded-inner border border-[#FFFFFF] dark:border-card-background">
                    <acct.chainIcon size={12} />
                  </View>
                </View>
                <Text className="text-[16px] leading-[16px] text-text font-pp-semi-bold">
                  {acct.name}
                </Text>
                {/* nw-keep(data-color): text-color token into the SVG icon color prop (non-class sink) */}
                <ArrowRightIcon color={colors.text} />
              </View>
              <View className="relative overflow-visible z-[99999]">
                <Pressable
                  className="p-[2px] rounded-card"
                  onPress={() => setOpenPaMenuId(openPaMenuId === i ? null : i)}
                >
                  {/* nw-keep(data-color): text-color token into the SVG icon color prop (non-class sink) */}
                  <OverflowMenuIcon color={colors.text} />
                </Pressable>
                {openPaMenuId === i && (
                  <>
                    {/* nw-keep(platform-css): web-only position:fixed backdrop (WEB_FIXED_POSITION) — no className path */}
                    <Pressable className="inset-0 z-[9998]" style={WEB_FIXED_POSITION} onPress={() => setOpenPaMenuId(null)} />
                    <View
                      className="absolute top-[28px] right-0 z-[99999] min-w-[165px] rounded-card border border-border-light bg-menu-background p-[6px]"
                      // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                      style={DROPDOWN_SHADOW}
                    >
                      <Pressable className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => { setOpenPaMenuId(null); onDeposit(); }}>
                        {/* nw-keep(data-color): text-color token into the SVG icon color prop (non-class sink) */}
                        <DepositArrowIcon color={colors.text} />
                        <Text className="text-[14px] text-text font-pp-regular">Deposit</Text>
                      </Pressable>
                      <Pressable className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => { setOpenPaMenuId(null); onWithdraw(); }}>
                        {/* nw-keep(data-color): text-color token into the SVG icon color prop (non-class sink) */}
                        <WithdrawArrowIcon color={colors.text} />
                        <Text className="text-[14px] text-text font-pp-regular">Withdraw</Text>
                      </Pressable>
                    </View>
                  </>
                )}
              </View>
            </View>
            <View className="flex-row items-center gap-[12px]">
              <View className="flex-1 gap-[4px]">
                <Text className="text-[12px] leading-[12px] text-text-secondary font-pp-regular">My balance</Text>
                <View className="flex-row items-center gap-[8px]">
                  <Text className="text-[24px] text-text font-pp-bold">
                    {acct.balance}
                  </Text>
                  {/* One Text node: as two siblings inside a gapped row the
                      amount and its suffix rendered with a stray space between
                      them (DEV-397, "25. 0.40" style artefacts). */}
                  <Text className="text-[12px] leading-[12px] text-text-muted font-pp-regular">
                    <Text className="font-pp-bold">{acct.pendingValue}</Text> pending
                  </Text>
                </View>
                <Text className="text-[12px] leading-[12px] text-text-secondary font-pp-regular">
                  {acct.ethBalance}
                </Text>
              </View>
              <View className="items-end justify-end self-stretch">
                <View className="flex-row items-center gap-[4px]">
                  <Text className="text-[12px] leading-[12px] text-text-secondary font-pp-regular">Total:</Text>
                  <Text className="text-[12px] leading-[12px] text-text-secondary font-pp-regular">{acct.total}</Text>
                </View>
              </View>
            </View>
          </View>
        ))}
        {showEmptyCard && (
          <View className="w-1/2 min-h-[172px] justify-center gap-[8px] overflow-visible border-t border-r border-l-0 border-b-0 p-[20px] border-[#4D4D4D] bg-card-background">
            <View className="flex-1 items-center justify-center gap-[8px] rounded-[4px] border border-dashed border-[#D9D9D9] px-[24px]">
              <Text className="text-[14px] leading-[18px] text-center text-text-secondary font-pp-semi-bold">
                Deposit another asset
              </Text>
              <Text className="text-[12px] leading-[18px] text-center font-pp-regular text-[#737373] dark:text-text-muted">
                Deposit more assets to add these to your overview.
              </Text>
              <Pressable
                className="mt-[4px] h-[40px] min-w-[132px] items-center justify-center rounded-[4px] border px-[16px] border-[#B8BBBF] bg-[#000000] dark:bg-[#FFFFFF]"
                onPress={onDeposit}
              >
                <Text className="text-[16px] leading-[16px] font-pp-medium text-[#FFFFFF] dark:text-[#000000]">
                  Deposit
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </>
  );
}

