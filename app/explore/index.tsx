import { StatsPageContent } from '@/components/stats/stats-page-content';

/**
 * Explore route — `/explore`.
 *
 * The index of the `explore/` directory, so it sits alongside the section
 * pages (`/explore/balances`, `/explore/activity`) that the mobile bar pushes.
 * Was `/stats` until the page grew past protocol figures into the whole
 * "explore the protocol" surface — the nav has always called it Explore, and
 * the URL now says so too. app/stats.tsx stays behind as a redirect so old
 * links keep working.
 *
 * Not inside the `(tabs)` group, matching every other full-page surface:
 * app/portfolio.tsx, app/transactions.tsx, app/payroll/*. The `(tabs)` group
 * holds only the two screens that belong to the (hidden) tab navigator —
 * `index` (home) and `ecosystem`; navigation itself comes from the custom
 * header, not the tab bar.
 */
export default function ExploreRoute() {
  return <StatsPageContent />;
}
