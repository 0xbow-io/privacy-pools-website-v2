/**
 * Internal-only build tools: the design-variant Theme picker and the
 * Entrypoint/Pool switcher.
 *
 * Both are build-inspection aids, not product. QA flagged them twice in the
 * team run (N-b, N-c: "should be removed entirely, internal testing only").
 *
 * Gated rather than deleted, because the variant switcher is real tooling
 * somebody still needs; and on its OWN flag rather than on STAGING_ENABLED,
 * because the preview QA tests IS a staging build, so a staging gate would have
 * left them exactly where the finding found them. Default OFF: set
 * EXPO_PUBLIC_INTERNAL_TOOLS=true locally to get them back.
 *
 * This lives in its own module, with NO imports, on purpose. The flag has to be
 * readable from config/pool-profile.ts and constants/theme.ts, and config/env.ts
 * already imports pool-profile - so keeping it in env.ts would close an import
 * cycle. Static `process.env.EXPO_PUBLIC_*` dot-access is required for Metro to
 * inline it in the production web export.
 */
export const INTERNAL_TOOLS_ENABLED: boolean =
  process.env.EXPO_PUBLIC_INTERNAL_TOOLS?.toLowerCase() === 'true';
