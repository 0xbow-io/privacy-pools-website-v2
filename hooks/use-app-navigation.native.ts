import { usePathname, useRouter, type Href } from 'expo-router';
import { useCallback } from 'react';
import { shouldNavigate } from '@/services/header-nav';

/**
 * Native top-level navigation (bottom bar, More drawer, header).
 *
 * The web version navigates with `dangerouslySingular`, which removes other
 * copies of a route from the stack. On the Android native stack that left
 * screens behind that React had already dropped: the app thought it was on
 * `/` while an old Activity or Explore page stayed on screen, and taps went to
 * the page underneath (white pages, a dead back button).
 *
 * Plain stack moves instead, so the stack is never deeper than home + one page:
 *  - home: dismiss everything back to the root;
 *  - from home: push the page (back pops home);
 *  - from a page: replace it with the next one.
 */
export function useAppNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (href: string) => {
      const current = pathname || '/';
      if (!shouldNavigate(current, href)) return;
      if (href === '/') {
        if (router.canDismiss()) router.dismissAll();
        else router.replace('/' as Href);
        return;
      }
      if (current === '/') router.push(href as Href);
      else router.replace(href as Href);
    },
    [pathname, router],
  );
}
