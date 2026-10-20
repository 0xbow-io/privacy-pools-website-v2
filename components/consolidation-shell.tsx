import { Pressable, View } from 'react-native';
import { Modal } from '@/components/ui/modal';
import { CloseIcon } from '@/components/ui/modal-icons';
import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { modalCardShadow } from '@/components/ui/web-style-shims';
import type { OpShell } from '@/components/op-shell';

/** Same utility-modal dimensions and presentation as Import Notes. */
export function ConsolidationShell({ children, isSheet, onClose }: Pick<Parameters<typeof OpShell>[0], 'children' | 'isSheet' | 'onClose'>) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  return (
    <Modal transparent visible animationType={isSheet ? 'slide' : 'fade'} onRequestClose={onClose}>
      <View className={`flex-1 items-center bg-[rgba(0,0,0,0.48)] ${isSheet ? 'justify-end' : 'justify-center p-[20px]'}`}>
        <View className={`relative w-full items-center gap-[16px] border border-border bg-card-background p-[24px] ${isSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[28px]' : 'max-w-[560px] max-h-[88%] rounded-card'}`}
          // nw-keep(platform-css): modal-card drop shadow (shared, scheme-tinted), as on the Import Notes modal
          style={modalCardShadow(colorScheme)}>
          {isSheet && <View className="absolute top-[10px] self-center w-[44px] h-[4px] rounded-[2px] bg-border" />}
          <Pressable accessibilityRole="button" accessibilityLabel="Close consolidation" onPress={onClose} className="absolute top-[18px] right-[18px] w-[28px] h-[28px] items-center justify-center z-[10]">
            {/* nw-keep(data-color): theme text color passed to the shared SVG close icon. */}
            <CloseIcon color={colors.text} />
          </Pressable>
          {children}
        </View>
      </View>
    </Modal>
  );
}
