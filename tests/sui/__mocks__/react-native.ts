/**
 * Minimal `react-native` stub for the node test environment.
 *
 * The only RN surface the modules under test touch is `Platform.OS`
 * (services/sui-witness/note-store.ts gates web `localStorage` on it). The real
 * react-native entry is a native module that cannot load under plain node, so we
 * resolve it to this stub via the vitest alias. We report `'web'` so the
 * note-store exercises its real localStorage persistence path (the web target).
 */
export const Platform = { OS: 'web' as const };

export default { Platform };
