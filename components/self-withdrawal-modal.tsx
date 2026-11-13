import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Modal } from '@/components/ui/modal';
import {
  onSelfWithdrawalEnabledChange,
  readSelfWithdrawalEnabled,
  writeSelfWithdrawalEnabled,
} from '@/services/self-withdrawal-setting';

/** The switch's current value, kept in step with every writer. */
export function useSelfWithdrawalEnabled(): boolean {
  const [enabled, setEnabled] = useState(() => readSelfWithdrawalEnabled());
  useEffect(() => onSelfWithdrawalEnabledChange(setEnabled), []);
  return enabled;
}

/** The warning shown before "Self withdrawal" is switched on. */
export function SelfWithdrawalModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-[rgba(0,0,0,0.5)] p-[20px]">
        <View className="w-full max-w-[420px] gap-[14px] rounded-card border border-border bg-card-background p-[24px]">
          <Text className="font-pp-bold text-[20px] leading-[24px] text-text">Enable self withdrawal</Text>
          <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
            Withdrawing without the relayer sends the transaction from your own wallet.
          </Text>
          <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
            That links the withdrawal to that wallet and can give away your privacy.
          </Text>
          <View className="flex-row justify-end gap-[10px]">
            <Pressable onPress={onClose} className="items-center rounded-control border border-border px-[18px] py-[10px]" testID="self-withdrawal-cancel">
              <Text className="font-pp-semi-bold text-[13px] text-text">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => { writeSelfWithdrawalEnabled(true); onClose(); }}
              className="items-center rounded-control bg-button-primary px-[18px] py-[10px]"
              testID="self-withdrawal-enable"
            >
              <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">Enable</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
