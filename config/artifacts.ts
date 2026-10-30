// Where the circuit artifacts (the .wasm and .zkey proving files, 1.2 GB) are
// served from.
//
// Deployed builds set EXPO_PUBLIC_ARTIFACTS_VERSION (scripts/artifacts-version.mjs)
// and read /artifacts/<version>/...: the main deployment proxies that path to the
// artifacts project (vercel.json), so the browser still sees the app's own
// origin, and the version in the URL lets the files be cached forever.
// Local dev and e2e leave it empty and read the flat /artifacts served from public/.
//
// A static `process.env.EXPO_PUBLIC_*` member: Expo only inlines those.
export const ARTIFACTS_VERSION = process.env.EXPO_PUBLIC_ARTIFACTS_VERSION?.trim() ?? '';

/** Path prefix of the artifacts on the app's own origin. */
export const ARTIFACTS_PATH = ARTIFACTS_VERSION ? `/artifacts/${ARTIFACTS_VERSION}` : '/artifacts';
