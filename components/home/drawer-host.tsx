import { createContext, useContext } from 'react';
import { Platform } from 'react-native';

/**
 * Lets content hosted inside the activity drawer hand off to a
 * provider-rendered modal (deposit, withdraw, …) without stacking: the
 * drawer animates out first, then the action runs. Lives in its own module
 * so the pools components can import it without a cycle through
 * activity-drawer.
 */
export const DrawerHostContext = createContext<{ runAndClose: (action: () => void) => void } | null>(null);

export function useDrawerHost() {
  return useContext(DrawerHostContext);
}

/**
 * Run a modal-opening action from inside a drawer. On web the drawer is a
 * fixed overlay below the provider modals' z-index, so the modal simply opens
 * on top and the drawer stays put behind it. On native the drawer is an RN
 * Modal that would bury the overlay-based modals, so it animates out first.
 */
export function launchFromDrawer(
  host: { runAndClose: (action: () => void) => void } | null,
  action: () => void,
) {
  if (host && Platform.OS !== 'web') host.runAndClose(action);
  else action();
}
