import { useEffect, useRef } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useNativeBottomInset } from '@/hooks/use-native-bottom-inset';
import { SheetDragArea, useSheetDrag } from '@/hooks/use-sheet-drag';

/**
 * THE bottom sheet. Every sheet in the app is this component.
 *
 * It existed three times before — the data drawer, the More drawer and the
 * notification sheet each grew their own copy of the same scrim, slide, drag
 * handle and header. They drifted, and the notification one drifted in a way
 * that mattered: it rendered inside the header's stacking context, so its
 * z-index could not beat the root-level bottom bar and the bar painted over it.
 *
 * MOUNT THIS AT THE ROOT, never inside a header or another positioned
 * container. A `position: fixed` element is still confined by an ancestor that
 * creates a stacking context, so a high z-index here does not save you.
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  headerLeft,
  headerRight,
  /** Fixed share of the window height. Mutually exclusive with maxHeightRatio. */
  heightRatio,
  /** Cap; the sheet is content-sized below it. */
  maxHeightRatio = 0.72,
  /** Kept for call-site compatibility: native always renders in an RN Modal now. */
  nativeModal: _nativeModal,
  testID,
  dragTestID,
  closeTestID,
  bodyContentClassName = 'px-[16px] pb-[28px] pt-[4px]',
  scrollBody = true,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
  heightRatio?: number;
  maxHeightRatio?: number;
  nativeModal?: boolean;
  testID?: string;
  dragTestID?: string;
  closeTestID?: string;
  bodyContentClassName?: string;
  scrollBody?: boolean;
  children: React.ReactNode;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { height } = useWindowDimensions();
  const bottomInset = useNativeBottomInset();
  const slide = useRef(new Animated.Value(0)).current;
  const drag = useSheetDrag({ height, onClose, enabled: visible });
  const { dragY } = drag;

  useEffect(() => {
    if (!visible) return;
    slide.setValue(0);
    Animated.timing(slide, {
      toValue: 1,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [visible, slide]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !visible || typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, onClose]);

  // The drag offset rides ON TOP of the entrance translate, so the two never
  // fight: `slide` owns the entrance, `dragY` owns the finger.
  const translateY = Animated.add(
    slide.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
    dragY,
  );
  const opacity = Animated.multiply(
    slide.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
    dragY.interpolate({
      inputRange: [0, Math.max(1, height * 0.5)],
      outputRange: [1, 0],
      extrapolate: 'clamp',
    }),
  );

  const isWeb = Platform.OS === 'web';
  if (!visible && isWeb) return null;

  const body = (
    <View
      className="flex-1 items-center justify-end"
      // nw-keep(platform-css): web-only fixed full-viewport overlay in the app's own stacking context, so the provider modals (z 999999) still stack above it
      style={isWeb ? (WEB_FIXED_OVERLAY as object) : undefined}
    >
      {/* nw-keep(animated): scrim opacity is Animated-driven */}
      {/* nw-keep(data-color): overlay color is the runtime theme token */}
      <Animated.View className="absolute inset-0" style={{ backgroundColor: colors.overlay, opacity }}>
        <Pressable className="absolute inset-0" onPress={onClose} accessibilityLabel="Close" />
      </Animated.View>

      <Animated.View
        className="w-full overflow-hidden rounded-t-card border border-b-0 border-border bg-background"
        // nw-keep(animated): sheet slide is an Animated translateY
        // nw-keep(measured-or-inset): height / cap is a measured fraction of the window
        style={{
          transform: [{ translateY }],
          ...(heightRatio ? { height: height * heightRatio } : { maxHeight: height * maxHeightRatio }),
          // Native draws edge to edge, so keep the content above the system nav bar.
          paddingBottom: bottomInset,
        }}
        testID={testID}
      >
        <SheetDragArea drag={drag} testID={dragTestID}>
          <View className="flex-row items-center justify-between px-[18px] pb-[8px] pt-[16px]">
            {/* Grab handle — what reads as "sheet" rather than "dialog". */}
            <View className="absolute left-1/2 top-[8px] ml-[-22px] h-[4px] w-[44px] rounded-[2px] bg-border" />
            {headerLeft ?? (
              <Text className="font-pp-sans-semi-bold text-[17px] text-text">{title}</Text>
            )}
            <View className="flex-row items-center gap-[8px]">
              {headerRight}
              <Pressable
                onPress={onClose}
                className="h-[30px] w-[30px] items-center justify-center rounded-inner bg-background-secondary"
                accessibilityRole="button"
                accessibilityLabel="Close"
                testID={closeTestID}
              >
                {/* nw-keep(data-color): close glyph color is the secondary theme token into the vector-icon sink */}
                <Ionicons name="close" size={16} color={colors.textSecondary} />
              </Pressable>
            </View>
          </View>
        </SheetDragArea>

        {scrollBody ? (
          <ScrollView
            className={heightRatio ? 'flex-1' : 'grow-0'}
            contentContainerClassName={bodyContentClassName}
          >
            {children}
          </ScrollView>
        ) : (
          children
        )}
      </Animated.View>
    </View>
  );

  if (isWeb) return body;

  // Native: always a full-screen Modal. Rendered inline, the sheet only got the
  // flex share of wherever it was mounted (half the screen went grey) and the
  // bottom bar painted over it.

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      {body}
    </Modal>
  );
}

// react-native-web escape hatch: a fixed full-viewport overlay in the app's own
// stacking context (NOT an RN Modal portal), so the provider modals' zIndex
// 999999 overlays still stack above it.
const WEB_FIXED_OVERLAY = Platform.OS === 'web'
  ? ({ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000 } as unknown as import('react-native').ViewStyle)
  : null;
