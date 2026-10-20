// React-Native-Web style escape hatches, in one place.
//
// RN's style types don't include CSS that only exists on the web, so each of
// these needs a local widening type plus a Platform guard — on native the
// property either does nothing or warns. Eleven components had defined their own
// byte-identical copies of the same three constants; this is that code, once.
//
// Native returns an empty object rather than omitting the style, so callers can
// spread unconditionally: `style={[styles.x, WEB_FIXED_POSITION]}`.
import { Platform, type TextStyle, type ViewStyle } from 'react-native';

/** ViewStyle widened with the web-only properties used below. */
export interface WebOnlyViewStyle {
  position?: string;
  backdropFilter?: string;
  WebkitBackdropFilter?: string;
}

/** TextStyle widened with the web-only properties used below. */
export interface WebOnlyTextStyle {
  outlineStyle?: string;
}

/**
 * `position: fixed`, which RN has no equivalent for — full-screen overlays use
 * absoluteFill on native instead, so this is empty there.
 */
export const WEB_FIXED_POSITION: ViewStyle & WebOnlyViewStyle = Platform.OS === 'web'
  ? { position: 'fixed' } as ViewStyle & WebOnlyViewStyle
  : {};

/** The frosted backdrop behind modals. No native equivalent. */
export const WEB_BLUR_BACKDROP: ViewStyle & WebOnlyViewStyle = Platform.OS === 'web'
  ? { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' } as ViewStyle & WebOnlyViewStyle
  : {};

/**
 * The one drop shadow under every dropdown menu and toast, kept light: it
 * separates the surface from the page without darkening it. Web states it as an explicit
 * box-shadow, matching the native longhands, so css-interop never has to
 * synthesize one. The Activity row menu restates the web value in its DOM
 * style (transaction-row-menu.web.tsx).
 *
 * On Android, elevation both orders siblings and draws the shadow; the
 * opacity, offset and radius longhands do not apply there. 16 sits above every
 * other elevated surface in the app (the highest is the Explore tab bar at 12;
 * modals render in their own window) while keeping the shadow modest.
 */
export const DROPDOWN_SHADOW_WEB = '0px 2px 8px rgba(0, 0, 0, 0.06)';
export const DROPDOWN_SHADOW: ViewStyle = Platform.OS === 'web'
  ? ({ boxShadow: DROPDOWN_SHADOW_WEB } as ViewStyle)
  : {
    elevation: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
  };

/**
 * The drop shadow under a modal card, deeper than a menu's because the card sits
 * higher. The tint follows the scheme (#000 dark, #D9D9D9 light). Web states the
 * box-shadow RN-Web 0.21 derives from the native longhands, so css-interop never
 * has to synthesize one.
 */
export function modalCardShadow(colorScheme: 'light' | 'dark'): ViewStyle {
  const dark = colorScheme === 'dark';
  return Platform.OS === 'web'
    ? ({ boxShadow: dark ? '0px 16px 28px rgba(0,0,0,0.18)' : '0px 16px 28px rgba(217,217,217,0.18)' } as ViewStyle)
    : { shadowColor: dark ? '#000000' : '#D9D9D9', shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.18, shadowRadius: 28, elevation: 18 };
}

/** Suppresses the browser's focus ring on text inputs that draw their own. */
export const WEB_NO_OUTLINE: TextStyle & WebOnlyTextStyle = Platform.OS === 'web'
  ? { outlineStyle: 'none' } as TextStyle & WebOnlyTextStyle
  : {};
