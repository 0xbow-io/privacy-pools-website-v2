import React, { useState } from 'react';
import { Platform, Pressable, Text, View, type ViewStyle } from 'react-native';

import { Modal } from '@/components/ui/modal';
import type { LinkLeaveCopy } from '@/services/link-leave-guard';

const OVERLAY_POSITION: ViewStyle = Platform.OS === 'web'
  ? ({ position: 'fixed' } as unknown as ViewStyle)
  : { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };

/**
 * "Did you copy the link?" before leaving a screen whose link is the
 * recipient's only way to the money (services/link-leave-guard.ts).
 *
 * Copy link and close copies first and closes only if the copy landed: the
 * caller's onCopy returns whether it did, and a failed copy keeps the dialog
 * up rather than dropping the link it exists to protect.
 */
export function LinkLeaveConfirm({
  visible,
  copy,
  onCopy,
  onLeave,
  onCancel,
  testID = 'link-leave-confirm',
}: {
  visible: boolean;
  copy: LinkLeaveCopy;
  onCopy: () => Promise<boolean>;
  onLeave: () => void;
  onCancel: () => void;
  testID?: string;
}) {
  const [copyFailed, setCopyFailed] = useState(false);
  if (!visible) return null;
  const card = (
      <View
        className="inset-0 z-[1000001] items-center justify-center bg-[rgba(0,0,0,0.45)] p-[16px]"
        // nw-keep(platform-css): fixed on web so it sits over the flow sheets (z 999999), which RN-web's Modal (z 9999) would not
        style={OVERLAY_POSITION}
      >
        <View role="dialog" aria-label={copy.title} testID={testID} className="w-full max-w-[420px] gap-[12px] rounded-card border border-border bg-card-background p-[20px]">
          <Text className="font-pp-semi-bold text-[16px] text-text">{copy.title}</Text>
          <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">{copy.body}</Text>
          {copyFailed ? (
            <Text className="font-pp-regular text-[12px] leading-[17px] text-danger">
              {copy.copyFailed ?? 'Could not copy. Copy the link from the screen, then close.'}
            </Text>
          ) : null}
          <View className="gap-[8px] pt-[4px]">
            <Pressable
              className="items-center justify-center rounded-control bg-button-primary px-[16px] py-[12px]"
              accessibilityRole="button"
              testID={`${testID}-copy`}
              onPress={() => {
                void (async () => {
                  // A throwing copy is a failed copy: the dialog stays up and says so.
                  const ok = await onCopy().catch(() => false);
                  setCopyFailed(!ok);
                  if (ok) onLeave();
                })();
              }}
            >
              <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">{copy.copyLabel ?? 'Copy link and close'}</Text>
            </Pressable>
            <Pressable
              className="items-center justify-center rounded-control border border-border px-[16px] py-[12px]"
              accessibilityRole="button"
              testID={`${testID}-leave`}
              onPress={() => { setCopyFailed(false); onLeave(); }}
            >
              <Text className="font-pp-regular text-[13px] text-text">Leave anyway</Text>
            </Pressable>
            <Pressable
              className="items-center justify-center px-[16px] py-[10px]"
              accessibilityRole="button"
              testID={`${testID}-cancel`}
              onPress={() => { setCopyFailed(false); onCancel(); }}
            >
              <Text className="font-pp-regular text-[13px] text-text-secondary">Cancel</Text>
            </Pressable>
          </View>
        </View>
      </View>
  );
  if (Platform.OS === 'web') return card;
  return (
    <Modal animationType="fade" transparent visible onRequestClose={onCancel}>
      {card}
    </Modal>
  );
}
