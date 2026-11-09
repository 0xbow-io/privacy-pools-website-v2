// Where the circuit artifacts (the .wasm and .zkey proving files, 1.2 GB) are
// served from.
//
// Deployed builds set EXPO_PUBLIC_ARTIFACTS_VERSION (scripts/artifacts-version.mjs)
// and read `<origin>/artifacts/<version>/...` straight from the artifacts project.
// The version is in the URL so the files are cached forever; a changed circuit is
// a new URL, and a tab still on the old version gets a 404 that asks for a reload
// (services/stale-assets.ts).
//
// The origin is EXPO_PUBLIC_ARTIFACTS_ORIGIN, default config/artifacts-origin.json
// (artifacts.privacypools.com, the privacy-pools-artifacts Vercel project on a
// first-party subdomain). Local dev and e2e leave the version empty and read the
// flat /artifacts that public/ serves on the app's own origin.
//
// Static `process.env.EXPO_PUBLIC_*` members: Expo only inlines those.
import artifactsOrigin from '@/config/artifacts-origin.json';

export const ARTIFACTS_VERSION = process.env.EXPO_PUBLIC_ARTIFACTS_VERSION?.trim() ?? '';
export const ARTIFACTS_ORIGIN = resolveArtifactsOrigin(process.env.EXPO_PUBLIC_ARTIFACTS_ORIGIN);

/** Pure: the env value without trailing slashes, or the default when unset or not https. */
export function resolveArtifactsOrigin(raw: string | undefined): string {
  const value = raw?.trim().replace(/\/+$/, '') ?? '';
  return value.startsWith('https://') ? value : artifactsOrigin.default;
}

/**
 * Pure: the base every circuit path hangs off. Absolute when the build is
 * versioned (deployed), the app's own flat /artifacts otherwise.
 */
export function artifactsBase(version: string, origin: string): string {
  return version ? `${origin}/artifacts/${version}` : '/artifacts';
}

export const ARTIFACTS_BASE = artifactsBase(ARTIFACTS_VERSION, ARTIFACTS_ORIGIN);

/** The base as a fetchable URL: a relative base is resolved against the page's origin. */
export function artifactsBaseUrl(base: string, pageOrigin: string | undefined): string {
  return base.startsWith('http') || !pageOrigin ? base : `${pageOrigin}${base}`;
}
