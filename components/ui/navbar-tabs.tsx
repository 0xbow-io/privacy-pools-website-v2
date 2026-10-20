import { useLayoutEffect, useRef } from 'react';
import { Platform, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { useIsFocused } from 'expo-router';
import { TAB_HIGHLIGHT_MOTION } from '@/constants/motion';

// Headers belong to their routes. A click carries its visual start across
// those instances so the incoming header continues the same animation.
let navigationMotion: { left: number; width: number; viewportWidth: number; href: string; startedAt?: number } | undefined;

export function NavbarTabs({ items, pathname, viewportWidth, dark, onNavigate, onLayout }: {
  items: { label: string; href: string }[];
  pathname: string;
  viewportWidth: number;
  dark: boolean;
  onNavigate: (href: string) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const focused = useIsFocused();
  const rowRef = useRef<View>(null);
  const pillRef = useRef<View>(null);
  const selected = items.find(item => item.href === pathname || (item.href === '/' && !pathname)
    || (item.href !== '/' && pathname.startsWith(item.href)))?.href;
  const layoutKey = items.map(item => item.href).join('|');

  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || !focused) return;
    const row = rowRef.current as unknown as HTMLElement | null;
    const pill = pillRef.current as unknown as HTMLElement | null;
    if (!row || !pill) return;
    const buttons = Array.from(row.querySelectorAll<HTMLElement>('[data-testid^="navbar-item-"]'));
    const button = buttons.find(button => button.dataset.testid === `navbar-item-${selected}`);
    const target = button?.getBoundingClientRect();
    if (!target?.width) { pill.style.opacity = '0'; return; }
    let left = target.left - row.getBoundingClientRect().left;
    let width = target.width;
    Object.assign(pill.style, { left: `${left}px`, width: `${target.width}px`, opacity: '1' });
    const motion = navigationMotion;
    const { duration, cssEasing } = TAB_HIGHLIGHT_MOTION;
    let animation: Animation | undefined;
    let startFrame: number | undefined;
    if (motion && motion.href === selected && motion.viewportWidth === viewportWidth && pill.animate
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Route rendering can leave the document animation clock one frame behind.
      // Hold the starting position until a fresh frame so cold visits do not skip ahead.
      const elapsed = motion.startedAt === undefined ? 0 : performance.now() - motion.startedAt;
      if (elapsed < duration) {
        animation = pill.animate([
          { left: `${left + motion.left - target.left}px`,
            width: `${motion.width}px` },
          { left: `${left}px`, width: `${width}px` },
        ], { duration, easing: cssEasing });
        animation.pause();
        animation.currentTime = elapsed;
        startFrame = requestAnimationFrame(() => {
          startFrame = requestAnimationFrame(now => {
            // Reuse the full timeline across headers, including its easing.
            animation!.startTime = motion.startedAt ??= now;
          });
        });
      }
    }
    const cancelMotion = () => {
      if (startFrame !== undefined) cancelAnimationFrame(startFrame);
      animation?.cancel();
    };
    // Font loading can change label widths after the route commits. Follow
    // that layout directly rather than leaving the highlight on stale metrics.
    const observer = new ResizeObserver(() => {
      const next = button!.getBoundingClientRect();
      const nextLeft = next.left - row.getBoundingClientRect().left;
      if (!next.width || (Math.abs(nextLeft - left) < 0.5 && Math.abs(next.width - width) < 0.5)) return;
      cancelMotion();
      left = nextLeft;
      width = next.width;
      Object.assign(pill.style, { left: `${left}px`, width: `${width}px` });
    });
    observer.observe(row);
    observer.observe(button!);
    return () => {
      cancelMotion();
      observer.disconnect();
    };
  }, [focused, selected, viewportWidth, layoutKey]);

  return (
    <View ref={rowRef} testID="navbar-tabs" accessibilityRole="tablist" accessibilityLabel="Page navigation" onLayout={onLayout}
      className={`relative flex-row items-center gap-[4px] rounded-pill ${items.length ? 'bg-background-secondary p-[4px]' : ''}`}>
      {Platform.OS === 'web' && <View ref={pillRef} testID="navbar-highlight" pointerEvents="none"
        className={`absolute bottom-[4px] left-0 top-[4px] rounded-pill opacity-0 ${dark ? 'bg-[#343434]' : 'bg-card-background'}`} />}
      {items.map(item => {
        const active = item.href === selected;
        return <Pressable key={item.href} testID={`navbar-item-${item.href}`}
          accessibilityRole="tab" accessibilityState={{ selected: active }}
          className={`relative z-[99999] h-[34px] flex-row items-center justify-center gap-[4px] rounded-pill px-[18px] ${
            active ? (Platform.OS === 'web' ? '' : dark ? 'bg-[#343434]' : 'bg-card-background') : 'hover:bg-card-background/50'}`}
          onPress={() => {
            if (Platform.OS === 'web' && !active) {
              const rect = (pillRef.current as unknown as HTMLElement | null)?.getBoundingClientRect();
              navigationMotion = rect?.width ? { left: rect.left, width: rect.width, viewportWidth,
                href: item.href } : undefined;
            }
            onNavigate(item.href);
          }}>
          <Text className={`font-pp-sans-medium text-[14px] ${active ? 'text-text' : 'text-text-secondary'}`}>{item.label}</Text>
        </Pressable>;
      })}
    </View>
  );
}
