import type { ReactNode } from 'react';

/**
 * Web: nothing to manage, the context default says `available: false`. The
 * native app resolves mobile-account-keys-provider.native.tsx, so the camera
 * and SecureStore never reach the web bundle.
 */
export function MobileAccountKeysProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
