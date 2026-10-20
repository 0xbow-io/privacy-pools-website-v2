import { Modal as RNModal, View, type ModalProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Native: React Native draws every Modal edge to edge on Android, so a bottom
 * sheet inside one ran under the system nav bar and its buttons sat behind the
 * back/home keys. Padding the content by the bottom inset keeps it clear.
 */
export function Modal({ children, ...props }: ModalProps) {
  const { bottom } = useSafeAreaInsets();
  return (
    <RNModal {...props}>
      {/* nw-keep(measured-or-inset): runtime safe-area bottom inset */}
      <View style={{ flex: 1, paddingBottom: bottom }}>{children}</View>
    </RNModal>
  );
}
