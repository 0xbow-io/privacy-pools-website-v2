import { useCallback } from 'react';
import { NATIVE_MOCK_ACTIVE } from '@/constants/native-mock';
import { useToast } from '@/components/toast-provider';

/**
 * Native mock mode shows a pretend account, so no real flow may start from it.
 * Returns a guard: true (and a toast) when the flow must not open. Always
 * false on web and in normal native builds.
 */
export function useNativeMockBlock(): () => boolean {
  const { toast } = useToast();
  return useCallback(() => {
    if (!NATIVE_MOCK_ACTIVE) return false;
    toast({ title: 'Demo mode', description: 'Transactions are off in demo mode.' });
    return true;
  }, [toast]);
}
