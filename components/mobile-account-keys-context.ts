import { createContext, useContext } from 'react';

export type MobileAccountKeysView = 'list' | 'import';

export type MobileAccountKeysValue = {
  /** True only in the native app, where keys live in SecureStore. */
  available: boolean;
  /** Saved keys on this device. */
  count: number;
  open: (view?: MobileAccountKeysView) => void;
  /** Call after an explicit Sign Out so the next launch does not sign back in. */
  signedOut: () => void;
};

export const MobileAccountKeysContext = createContext<MobileAccountKeysValue>({
  available: false,
  count: 0,
  open: () => {},
  signedOut: () => {},
});

export function useMobileAccountKeys(): MobileAccountKeysValue {
  return useContext(MobileAccountKeysContext);
}
