import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { Modal } from '@/components/ui/modal';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import {
  onErrorReportsEnabledChange,
  readErrorReportsEnabled,
  writeErrorReportsEnabled,
} from '@/services/error-reports-setting';

/** The switch's current value, kept in step with every writer. */
export function useErrorReportsEnabled(): boolean {
  const [enabled, setEnabled] = useState(() => readErrorReportsEnabled());
  useEffect(() => onErrorReportsEnabledChange(setEnabled), []);
  return enabled;
}

/** "Anonymous error reports": what is sent, and the per-device switch. */
export function ErrorReportsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const enabled = useErrorReportsEnabled();

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-[rgba(0,0,0,0.5)] p-[20px]">
        <View className="w-full max-w-[420px] gap-[14px] rounded-card border border-border bg-card-background p-[24px]">
          <Text className="font-pp-bold text-[20px] leading-[24px] text-text">Anonymous error reports</Text>
          <View className="gap-[4px]">
            <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">Sent only when something fails:</Text>
            <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">• which step failed and why</Text>
            <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">• the network and token</Text>
          </View>
          <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
            Never sent: your address, amounts, notes, transactions or IP.
          </Text>
          <View className="flex-row items-center justify-between gap-[12px]">
            <Text className="flex-1 font-pp-medium text-[14px] text-text">Send anonymous error reports</Text>
            {/* nw-keep(data-color): Switch trackColor takes theme tokens, not classes */}
            <Switch
              value={enabled}
              onValueChange={(next) => writeErrorReportsEnabled(next)}
              trackColor={{ false: colors.textMuted, true: colors.text }}
              accessibilityLabel="Send anonymous error reports"
              testID="error-reports-switch"
            />
          </View>
          <View className="flex-row justify-end">
            <Pressable onPress={onClose} className="items-center rounded-control bg-button-primary px-[18px] py-[10px]" testID="error-reports-done">
              <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">Done</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
