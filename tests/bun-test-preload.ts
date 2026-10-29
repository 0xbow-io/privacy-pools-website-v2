// bun test preload (bunfig.toml [test].preload).
//
// The unit suite describes the STAGING world: Sepolia, the whitelisted
// staging pools, the dev ASP. That is exactly what the app was before the
// Prod/Staging switch (config/app-environment.ts), so pinning the build
// default here keeps every existing assertion meaningful. The PROD records are
// asserted explicitly through ENVIRONMENTS.prod (services/__tests__/
// environments.test.ts), and the default-is-prod rule through the pure
// resolver (services/__tests__/app-environment.test.ts).
process.env.EXPO_PUBLIC_APP_ENV ??= 'staging';
// The staging suites cover the whitelisted Ethereum, OP and Base pools, which
// plain staging hides (config/staging-mainnet.ts). Run them as staging-mainnet;
// services/__tests__/staging-mainnet.test.ts checks plain staging in a child.
process.env.EXPO_PUBLIC_STAGING_MAINNET ??= 'true';
// An unset vault-deposit pause means "Ethereum and Base paused"
// (config/yield-deposits-paused.ts). The suite describes the open world, so pin
// it off here; the default itself is asserted in yield-deposits-paused.test.ts
// through the pure parser.
process.env.EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED ??= 'false';
