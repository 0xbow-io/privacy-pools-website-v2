import type { ReactNode } from 'react';

/**
 * Web: the `--pp-*` variables come from global.css, so this is a passthrough.
 * The native version (native-theme-root.native.tsx) applies NativeThemeVars;
 * keeping it in a .native file keeps the vars table out of the web bundle.
 */
export function NativeThemeRoot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
