// Public site URLs, env-driven so a domain move is a config change.
// Defaults are the domains after the 2026-10 switch: the v2 app on the apex
// privacypools.com, the v1 site on v1.privacypools.com.
// Plain module (no react-native import) so bun tests can load it.

export const DEFAULT_APP_ORIGIN = 'https://privacypools.com';
export const DEFAULT_V1_URL = 'https://v1.privacypools.com';

function clean(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return (v ? v : fallback).replace(/\/+$/, '');
}

/** Public origin of this app (share links on native, social tags, canonical URL). */
export const APP_ORIGIN = clean(process.env.EXPO_PUBLIC_APP_ORIGIN, DEFAULT_APP_ORIGIN);

/** The v1 site (header v1 switch). */
export const V1_URL = clean(process.env.EXPO_PUBLIC_V1_URL, DEFAULT_V1_URL);

/** The whitepaper is served by the v1 site. */
export const WHITEPAPER_URL = `${V1_URL}/whitepaper.pdf`;

/** Host part of a URL, for copy like "opens v1.privacypools.com". */
export function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '');
}

/**
 * Origins this app was served from before. Links the app shared there (pay
 * links in a Stellar backup) are still its own after the move to the apex.
 */
export const LEGACY_APP_ORIGINS: readonly string[] = ['https://v2.privacypools.com'];
