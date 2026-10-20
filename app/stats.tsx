import { Redirect } from 'expo-router';

/**
 * Legacy `/stats` → `/explore`.
 *
 * The page moved to app/explore/index.tsx when the URL was renamed to match
 * the nav label. This redirect is the compatibility shim: shared links, the
 * Vercel preview URL people already have, and any bookmark still resolve
 * instead of hitting the unmatched-route screen.
 */
export default function StatsRedirectRoute() {
  return <Redirect href="/explore" />;
}
