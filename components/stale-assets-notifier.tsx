import { useEffect } from 'react';
import { useToast } from '@/components/toast-provider';
import { STALE_ASSETS_TEXT, STALE_ASSETS_TITLE, staleAssetsReported, subscribeStaleAssets } from '@/services/stale-assets';

/**
 * Headless: when the circuit files of this page's version are gone (the app was
 * updated while the tab stayed open), tell the user to reload instead of leaving
 * them with a failed proof. See services/stale-assets.ts.
 */
export function StaleAssetsNotifier() {
  const { toast } = useToast();
  useEffect(() => {
    const show = () => toast({ title: STALE_ASSETS_TITLE, description: STALE_ASSETS_TEXT, variant: 'warning' });
    if (staleAssetsReported()) show();
    return subscribeStaleAssets(show);
  }, [toast]);
  return null;
}
