// Which web build to run. Pure, so it is unit-tested.
//
//   fast: Vercel preview and development deployments (every PR and the dev
//         branch). Build time over everything: no graph optimization, no tree
//         shaking, no minification, no source maps. The bundle is bigger and
//         slower to load, which only QA sees.
//   full: production on Vercel (main) and every local or CI build. What users get.
//
// Anything unknown is "full": a missing VERCEL_ENV can never ship an unoptimized
// production build.
export function buildMode(env) {
  const vercelEnv = env.VERCEL_ENV;
  return vercelEnv === 'preview' || vercelEnv === 'development' ? 'fast' : 'full';
}
