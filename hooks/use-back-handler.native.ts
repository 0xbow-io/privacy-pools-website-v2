import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

/**
 * While `active`, the hardware back button calls `onBack` and is consumed, so
 * it closes this overlay instead of popping the screen or leaving the app.
 * BackHandler runs the newest listener first, so the overlay opened last
 * closes first. RN Modals handle back through onRequestClose on their own.
 */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!active) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBackRef.current();
      return true;
    });
    return () => sub.remove();
  }, [active]);
}
