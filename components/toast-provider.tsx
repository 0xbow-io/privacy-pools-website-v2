import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, Pressable, Text, View, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useNativeBottomInset } from '@/hooks/use-native-bottom-inset';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';

// Lightweight in-app toast layer for transaction status notifications
// (deposit approved/declined). One fixed stack in the bottom-right, auto-dismiss,
// tap to dismiss early. Theme-tokened, no flags, shared by every route (it
// mounts once in the root layout, above all trees).

export type ToastVariant = 'success' | 'destructive' | 'warning';

export type ToastOptions = {
  title: string;
  description?: string;
  variant?: ToastVariant;
};

type ToastEntry = ToastOptions & { key: number; leaving?: boolean };

type ToastContextType = { toast: (opts: ToastOptions) => void };

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

// A bare confirmation ("Address copied") is read at a glance; a toast with a
// description (a deposit approved or declined), a warning or an error needs
// time to read.
const AUTO_DISMISS_MS = 3000;
const AUTO_DISMISS_READ_MS = 6000;
const ENTER_MS = 400;
const LEAVE_MS = 200;

// position: fixed keeps the stack pinned on web while the page scrolls;
// native falls back to absolute within the root view.
const WEB_FIXED: ViewStyle = Platform.OS === 'web'
  ? ({ position: 'fixed' } as unknown as ViewStyle)
  : { position: 'absolute' };

const prefersReducedMotion = (): boolean => Platform.OS === 'web'
  && typeof window !== 'undefined'
  && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextKey = useRef(1);
  const bottomInset = useNativeBottomInset();

  // Fade out first, then leave the stack.
  const dismiss = useCallback((key: number) => {
    setToasts((prev) => prev.map((t) => (t.key === key ? { ...t, leaving: true } : t)));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.key !== key)), LEAVE_MS);
  }, []);

  const toast = useCallback((opts: ToastOptions) => {
    const key = nextKey.current++;
    // Cap the stack at 3 showing; one already fading out finishes its fade.
    setToasts((prev) => {
      const capped = new Set(prev.filter((t) => !t.leaving).slice(0, -2).map((t) => t.key));
      return [...prev.filter((t) => !capped.has(t.key)), { ...opts, key }];
    });
    const glance = !opts.description && (opts.variant ?? 'success') === 'success';
    setTimeout(() => dismiss(key), glance ? AUTO_DISMISS_MS : AUTO_DISMISS_READ_MS);
  }, [dismiss]);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 && (
        <View
          pointerEvents="box-none"
          className="bottom-[16px] right-[16px] z-[1000000] w-[90%] max-w-[356px] gap-[8px] self-end"
          // nw-keep(platform-css): position fixed on web / absolute on native (RN has no 'fixed'); native also clears the system nav bar
          style={[WEB_FIXED, bottomInset ? { bottom: bottomInset + 16 } : null]}
        >
          {toasts.map((t) => (
            <ToastItem key={t.key} entry={t} colors={colors} onDismiss={() => dismiss(t.key)} />
          ))}
        </View>
      )}
    </ToastContext.Provider>
  );
}

function ToastItem({ entry: t, colors, onDismiss }: { entry: ToastEntry; colors: (typeof Colors)['light']; onDismiss: () => void }) {
  const destructive = t.variant === 'destructive';
  const warning = t.variant === 'warning';
  const accent = destructive ? colors.danger : warning ? colors.warning : colors.success;
  // Rises into place and fades in; leaves by fading and settling down.
  // Reduced motion keeps the fade only.
  const [progress] = useState(() => new Animated.Value(0));
  const [still] = useState(prefersReducedMotion);
  useEffect(() => {
    Animated.timing(progress, {
      toValue: t.leaving ? 0 : 1,
      duration: t.leaving ? LEAVE_MS : ENTER_MS,
      easing: t.leaving ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [progress, t.leaving]);
  const translateY = still ? 0 : progress.interpolate({ inputRange: [0, 1], outputRange: [t.leaving ? 8 : 16, 0] });
  return (
    // Alert semantics live on a NONINTERACTIVE container (the live region);
    // dismissal is a separate, named button so screen-reader users are told
    // the notification is dismissible.
    <Animated.View
      accessibilityRole="alert"
      className="flex-row items-center gap-[10px] rounded-control border border-border-light bg-menu-background px-[16px] py-[14px]"
      // nw-keep(platform-css): drop shadow and the enter/leave motion, not class-expressible
      style={[DROPDOWN_SHADOW, { opacity: progress, transform: [{ translateY }] }]}
    >
      <Ionicons
        name={destructive ? 'alert-circle' : warning ? 'alert-circle-outline' : 'checkmark-circle'}
        size={16}
        // nw-keep(data-color): status accent (danger/warning/success token) into the icon color prop (non-class sink)
        color={accent}
      />
      <View className="flex-1 gap-[2px]">
        <Text className="font-pp-sans-medium text-[13px] leading-[18px] text-text">{t.title}</Text>
        {t.description ? (
          <Text className="font-pp-sans text-[13px] leading-[18px] text-text-secondary">
            {t.description}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss notification"
        hitSlop={8}
      >
        {/* nw-keep(data-color): muted glyph color (theme token) into the icon color prop */}
        <Ionicons name="close" size={14} color={colors.textMuted} />
      </Pressable>
    </Animated.View>
  );
}
