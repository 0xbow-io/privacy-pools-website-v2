import type { ReactNode } from 'react';

// Web: the passkey EOA is native only, so the context keeps its default
// (available: false) and nothing on the web changes.
export function PasskeyAccountProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
