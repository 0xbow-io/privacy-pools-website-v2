import React from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal } from '@/components/ui/modal';
import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';

export const REGISTRATION_TITLE = 'Register your wallet';
export const REGISTRATION_BODY =
  'A one-time on-chain setup lets others send you private payments and lets you spend what you receive. You only do this once per wallet.';
export const REGISTRATION_PRIMARY = 'Register now';

/** Shared registration shell; each chain owns its consent and execution. */
export function RegistrationModalFrame({ visible, title, onClose, children }: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { width } = useWindowDimensions();
  const mobile = width <= 540;
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  return (
    <Modal animationType={mobile ? 'slide' : 'fade'} transparent visible={visible} onRequestClose={onClose}>
      <View className={`flex-1 items-center bg-[rgba(0,0,0,0.5)] ${mobile ? 'justify-end p-0' : 'justify-center p-[20px]'}`}>
        <View className={`w-full gap-[14px] border border-border bg-card-background p-[24px] ${mobile ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[26px]' : 'max-w-[460px] rounded-card'}`}>
          {/* nw-keep(data-color): grabber uses the runtime theme token */}
          {mobile && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
          <View className="flex-row items-start justify-between gap-[12px]">
            <View className="flex-1 gap-[6px]">
              <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PRIVACY POOLS V2</Text>
              <Text className="font-pp-bold text-[22px] leading-[26px] text-text">{title}</Text>
            </View>
            <Pressable className="h-[36px] w-[36px] items-center justify-center rounded-control border border-border-light" onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              {/* nw-keep(data-color): close glyph uses the runtime theme token */}
              <Ionicons name="close" size={18} color={colors.text} />
            </Pressable>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}
