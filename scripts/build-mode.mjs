// Which web build to run. Pure, so it is unit-tested.
//
//   fast: Vercel preview and development deployments (every PR and the dev
//         branch). Build time over everything: no graph optimization, no tree
//         shaking, no minification, no source maps. The bundle is bigger and
//         slower to load, which only QA sees.
//   full: production on Vercel (main) and every local or CI build. What users get.
//
// Anything unknown is "full": a missing VERCEL_ENV can never ship an unoptimized
// production build. WEB_BUILD_MODE=fast|full forces a mode (to time the full
// build on a preview, or the fast one locally); any other value is ignored.
export function buildMode(env) {
  if (env.WEB_BUILD_MODE === 'fast' || env.WEB_BUILD_MODE === 'full') return env.WEB_BUILD_MODE;
  const vercelEnv = env.VERCEL_ENV;
  return vercelEnv === 'preview' || vercelEnv === 'development' ? 'fast' : 'full';
}
