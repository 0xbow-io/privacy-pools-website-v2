import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Warns before the tab closes while a privacy-critical operation is in
 * flight. Some states hold secrets that exist only in memory (an
 * out-of-band transfer link awaiting copy, a payment-request key) or only
 * on this device (an imported note not yet anchored on-chain) — closing
 * the tab in those windows can lose funds permanently.
 *
 * Browsers show their own generic dialog; the message text is a hint at
 * best, but returning it is still required by the spec.
 */
export function useTabCloseGuard(
  active: boolean,
  message = 'An operation is still in progress. Closing this tab now may permanently lose data needed to recover funds.',
) {
  useEffect(() => {
    if (!active || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = message;
      return message;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active, message]);
}
