// Router root layout for the harness-only NativeWind compatibility gallery.
// Served ONLY when PPV2_NW_GALLERY=1 (see app.config.js) — never a
// production route.
import '../../../global.css';
import { Slot } from 'expo-router';
import { Platform } from 'react-native';

/**
 * GALLERY-02 / F-C probe — startup registration state, decided at MODULE
 * EVALUATION (before any route JSX element is created):
 *
 *   default load            → NO Animated registration anywhere in the app.
 *   ?animReg=1              → the APP's startup registration module
 *                             (components/nativewind-interop.ts — the exact
 *                             module app/_layout.tsx imports first) runs
 *                             here, at startup, before the first JSX element.
 *
 * F-C upgraded this from a gallery-local cssInterop(Animated.View) call to
 * requiring the real app module, so the two-load probe exercises the
 * mechanism the app actually ships (RN Animated.View/Text/ScrollView +
 * Reanimated.View registrations).
 *
 * cssInterop registration is global for elements created AFTER the call (the
 * jsx wrapper consults a global component map at element creation); it does
 * not mutate already-created elements. The two isolated page loads therefore
 * capture both states cleanly: the direct-className specimens in index.tsx
 * and fc.tsx render dropped-vs-applied depending only on this flag.
 */
export function galleryAnimRegistrationRequested(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('animReg') === '1'
  );
}

if (galleryAnimRegistrationRequested()) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../../components/nativewind-interop');
}

export default function GalleryLayout() {
  return <Slot />;
}
