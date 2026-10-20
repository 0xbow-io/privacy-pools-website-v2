import { usePathname, useRouter, type Href } from 'expo-router';
import { Platform } from 'react-native';
import { useCallback } from 'react';
import { shouldNavigate } from '@/services/header-nav';
import { getHomeDestination, rememberHomeLocation } from '@/services/home-navigation';
import { notifyUiUrl } from '@/components/ui-url-events';

/** Top-level destinations share one workspace across desktop and mobile. */
export function useAppNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback((href: string) => {
    // The browser URL can lead Expo's hook during rapid consecutive clicks.
    const currentPath = Platform.OS === 'web' ? window.location.pathname : pathname;
    if (!shouldNavigate(currentPath, href)) return;
    if (Platform.OS === 'web') {
      rememberHomeLocation(window.location);
      notifyUiUrl('navigation-user-action');
    }
    const destination = href === '/' && Platform.OS === 'web' ? getHomeDestination() : href;
    router.navigate(destination as Href, { dangerouslySingular: true });
  }, [pathname, router]);
}
