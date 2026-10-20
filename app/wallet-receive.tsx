import { useCallback, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { useAccount } from 'wagmi';

import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useWalletConnectModal } from '@/components/wallet-connect-modal-provider';

// Receive / fund screen for the embedded smart wallet — address as QR + copy,
// plus the cold-start gas note (a fresh wallet needs a little ETH before its
// first deposit). ppv2 redesign tokens.
export default function WalletReceiveScreen() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  const { address, isConnected } = useAccount();
  const { open: openWalletPicker } = useWalletConnectModal();
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    if (!address) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(address);
      } else {
        await Clipboard.setStringAsync(address);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable — address is selectable below
    }
  }, [address]);

  const qrSize = Math.min(width - 120, 240);

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="grow pb-[96px]">
        <View className="w-full max-w-[560px] gap-[14px] self-center px-[18px] pt-[22px]">
          <Text className="font-pp-sans-bold text-[24px] text-text">Receive</Text>
          <Text className="font-pp-sans text-[13px] leading-[19px] text-text-secondary">
            Send ETH or supported tokens to this address, then shield them into a privacy pool.
          </Text>

          {!isConnected || !address ? (
            <Pressable
              onPress={() => openWalletPicker()}
              // Fill + pressed opacity are class-authored: a `style` FUNCTION on a
              // className'd Pressable is arrayed by css-interop's web runtime and never
              // invoked (RN-Web Pressable only calls a top-level style function), which
              // dropped the button-primary fill on web. bg-* + active: reproduce it.
              className="mt-[12px] items-center rounded-control bg-button-primary py-[16px] active:opacity-[0.85]"
            >
              <Text className="font-pp-sans-semi-bold text-[14px] text-button-primary-text">
                Create or connect a wallet
              </Text>
            </Pressable>
          ) : (
            <>
              <View className="items-center gap-[14px] rounded-inner border border-border bg-card-background p-[18px]">
                <View className="rounded-control bg-[#FFFFFF] p-[14px]">
                  {/* nw-keep(svg-or-canvas): fixed QR module/background colors (theme-independent for scannability; QRCode color props) */}
                  <QRCode value={address} size={qrSize} backgroundColor="#FFFFFF" color="#0b1512" />
                </View>
                <Pressable
                  onPress={copy}
                  // bg/border + pressed opacity are class-authored: a `style` FUNCTION on a
                  // className'd Pressable is arrayed by css-interop's web runtime and never
                  // invoked (RN-Web Pressable only calls a top-level style function), which
                  // dropped the fill + border color on web.
                  className="flex-row items-center gap-[10px] self-stretch rounded-control border border-border bg-background-secondary px-[12px] py-[10px] active:opacity-[0.85]"
                >
                  <Text selectable className="flex-1 font-pp-mono text-[11px] leading-[16px] text-text" numberOfLines={2}>
                    {address}
                  </Text>
                  {/* nw-keep(data-color): copy/check glyph color swaps tint/text-muted tokens (vector-icon color prop) */}
                  <MaterialIcons name={copied ? 'check' : 'content-copy'} size={16} color={copied ? colors.tint : colors.textMuted} />
                </Pressable>
                {copied && <Text className="font-pp-sans-medium text-[10px] tracking-[1px] text-tint">copied</Text>}
              </View>

              <View className="flex-row items-center gap-[10px] rounded-control border border-border bg-background-secondary p-[12px]">
                {/* nw-keep(data-color): gas-station glyph tint token (vector-icon color prop) */}
                <MaterialIcons name="local-gas-station" size={15} color={colors.tint} />
                <Text className="flex-1 font-pp-sans text-[12px] leading-[17px] text-text-secondary">
                  New wallet? You need a little ETH here for gas before your first deposit.
                </Text>
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
