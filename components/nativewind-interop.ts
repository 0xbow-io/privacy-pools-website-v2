/**
 * NativeWind cssInterop STARTUP REGISTRATIONS — the F-C decision on the F-B
 * gallery E1 finding (direct `className` on RN `Animated.View` is silently
 * DROPPED unless `cssInterop` was registered before the element was created;
 * registration is global for elements created AFTER the call).
 *
 * DECISION: option (a), one deterministic startup registration point —
 * this module, imported in app/_layout.tsx immediately after global.css and
 * BEFORE any component import. Module evaluation therefore completes before
 * any app JSX element exists, which is the only ordering the mechanism
 * needs. Chosen over the wrapper pattern (animated node keeps only animated
 * styles, statics on a plain child View) because the wrapper adds a view to
 * every animated subtree — a structural change with real layout/measure
 * risk during the P2/P3 ports and a permanent per-node cost — while
 * registration is NativeWind's documented API for exactly this and changes
 * nothing structurally. Evidence: the two-load gallery probe
 * (scripts/visual/gallery-app/fc.tsx + capture-gallery.ts) loads the SAME
 * page without this module (className dropped) and with it via ?animReg=1
 * (className applies); web-verified, native still blocked by the vendored
 * SDK fs/promises export failure (see nativewind-fc-gates.md).
 *
 * Registered components — the app's actual Animated surface (42×
 * Animated.View, 2× Animated.Text, 3× Animated.ScrollView) plus Reanimated's
 * View, Text, and ScrollView, which are DIFFERENT components each needing
 * their own registration (probed separately in the fc gallery). The repo's
 * reanimated consumers are hello-wave.tsx (Reanimated.Text) and
 * parallax-scroll-view.tsx (Reanimated.ScrollView/View) — both P1 manifest
 * files — while money modals use core RN Animated. No core or Reanimated
 * FlatList/Image/createAnimatedComponent use exists today; register those at
 * their first appearance.
 *
 * With this in place, `nw-keep(animated)` narrows to genuinely animated
 * style properties; static styling on Animated components is class-portable.
 */

import type { ComponentType } from 'react';
import { Animated, Pressable } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { cssInterop } from 'nativewind';

cssInterop(Animated.View, { className: 'style' });
// Cast: tsc chokes on Animated.Text's animated-prop union ("union type too
// complex to represent", TS2590) — the runtime registration only needs the
// component reference and its style prop names, so narrow the generic to
// just those. Behavior is probed, not typed.
type StyleTargets = ComponentType<{ style?: unknown; contentContainerStyle?: unknown }>;
cssInterop(Animated.Text as StyleTargets, { className: 'style' });
// Mirror NativeWind's own ScrollView mapping so the content container stays
// class-addressable on the animated variant too.
cssInterop(Animated.ScrollView as StyleTargets, {
  className: 'style',
  contentContainerClassName: 'contentContainerStyle',
});
/**
 * Animated Pressable — the one createAnimatedComponent in the app. Created here
 * so this module's registration and every consumer share one instance;
 * created at a call site it would be a different component type and its
 * classes would be dropped again.
 */
export const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
cssInterop(AnimatedPressable as StyleTargets, { className: 'style' });

cssInterop(Reanimated.View, { className: 'style' });
cssInterop(Reanimated.Text as StyleTargets, { className: 'style' });
cssInterop(Reanimated.ScrollView as StyleTargets, {
  className: 'style',
  contentContainerClassName: 'contentContainerStyle',
});
