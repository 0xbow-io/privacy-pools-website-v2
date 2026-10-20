import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

import { THEME_BOOTSTRAP_SCRIPT } from '../services/theme-bootstrap';
import socialMeta from '../config/social-meta.json';

// Web-only document shell for the Expo Router static export. Without this file
// Expo falls back to the app `slug` ("privacy-pools") as the <title> and emits
// no social meta tags (QA-11). Everything here is server-rendered into the HTML
// head at export time; runtime per-route titles can still override via
// expo-router's <Head>.

// One source with scripts/inject-social-meta.mjs, the step that actually puts
// these tags into the served shell (see the REALITY CHECK below).
const TITLE = socialMeta.title;
const DESCRIPTION = socialMeta.description;
const URL = process.env.EXPO_PUBLIC_APP_ORIGIN?.trim().replace(/\/+$/, '') || socialMeta.url;
const OG_IMAGE = `${URL}/${socialMeta.images[0].file}`;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />

        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />

        {/* Open Graph */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content={TITLE} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:url" content={URL} />
        <meta property="og:image" content={OG_IMAGE} />

        {/* Twitter / X card */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={OG_IMAGE} />

        {/* Disable body scrolling on web so ScrollView children scroll instead. */}
        <ScrollViewStyleReset />

        {/* Pre-paint theme bootstrap (F-C): resolves the same ?theme/?color/
            storage/system precedence as the app (services/theme-precedence.ts,
            fixture-tested against this script) and puts pp-v{N} [+ dark] on
            <html> BEFORE first paint so the generated theme vars are right
            from the first frame; components/theme-provider.tsx reconciles
            after hydration.
            REALITY CHECK (measured, F-C): with web.output "single" expo does
            not render +html.tsx into the served/exported shell AT ALL (the
            live site's <title> is the app slug. This whole file, meta tags
            included, currently ships nowhere). Single output paints nothing
            before the bundle runs and the provider applies the classes
            synchronously in its first render, so no wrong-theme flash is
            possible today; this script becomes load-bearing the day
            web.output switches to "static" (perf-baseline.ts then enforces
            its presence in the exported HTML).
            CSP note: this is an INLINE script. The current vercel.json CSP is
            frame-ancestors-only, which does not restrict it; if a script-src
            directive ever lands, this script needs a hash/nonce (or
            'unsafe-inline') or the pre-paint theming silently dies. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
