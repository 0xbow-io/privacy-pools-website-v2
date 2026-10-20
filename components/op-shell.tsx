import type { ReactNode } from 'react';
import { WEB_FIXED_POSITION, WEB_BLUR_BACKDROP } from '@/components/ui/web-style-shims';
import { Animated, Pressable, View, type ViewStyle } from 'react-native';
import { InlineOpPortal } from '@/components/inline-op-portal';
import { useBackHandler } from '@/hooks/use-back-handler';


/**
 * Presentation switch for the operation flows (withdraw / send / request):
 * the SAME step content renders either as the classic overlay modal (mobile,
 * classic theme, deep links, pool pages) or re-parented into the desktop
 * action hub's inline host (modal-less widget UX). All state stays in the
 * provider; this only decides where the card draws.
 */
export function OpShell({
  inline,
  isSheet,
  isDark,
  sheetAnim,
  onClose,
  cardClassName,
  cardStyle,
  children,
}: {
  inline: boolean;
  isSheet: boolean;
  isDark: boolean;
  sheetAnim: Animated.Value;
  onClose: () => void;
  cardClassName: string;
  cardStyle?: ViewStyle | ViewStyle[];
  children: ReactNode;
}) {
  // Android back closes the sheet (the inline desktop host has no back).
  useBackHandler(!inline, onClose);
  if (inline) {
    return (
      <InlineOpPortal>
        {/* relative: the card children include absolutely-positioned bits
            (close button). gap matches the overlay card rhythm. */}
        <View className="relative w-full grow items-center gap-[16px]">{children}</View>
      </InlineOpPortal>
    );
  }
  return (
    <View
      className={`inset-0 z-[999999] items-center ${isSheet ? 'justify-end' : 'justify-center'}`}
      // nw-keep(platform-css): web-only position:fixed backdrop anchor (empty on native)
      style={WEB_FIXED_POSITION}
    >
      <Pressable
        className={`absolute inset-0 ${isDark ? 'bg-[rgba(0,0,0,0.6)]' : 'bg-[rgba(255,255,255,0.6)]'}`}
        // nw-keep(platform-css): web-only backdrop-filter blur (empty on native)
        style={WEB_BLUR_BACKDROP}
        onPress={onClose}
      />
      {/* nw-keep(animated): open opacity + slide/scale ride the provider's Animated.Value */}
      <Animated.View
        role="dialog"
        className={cardClassName}
        style={[
          cardStyle as ViewStyle,
          {
            opacity: sheetAnim,
            transform: isSheet
              ? [{ translateY: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }) }]
              : [{ scale: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }],
          },
        ]}
      >
        {children}
      </Animated.View>
    </View>
  );
}
