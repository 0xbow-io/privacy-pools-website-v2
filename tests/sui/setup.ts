/**
 * Global test setup: provide the EXPO_PUBLIC_* env the config modules require at
 * import time (config/env.ts throws without EXPO_PUBLIC_ASP_URL). These are inert
 * placeholders — no test hits these URLs (the chain boundary is always mocked).
 */
process.env.EXPO_PUBLIC_ASP_URL ??= 'https://asp.test.invalid';
// The Sui tests describe the staging world (Sui is dev-ASP only); see tests/bun-test-preload.ts.
process.env.EXPO_PUBLIC_APP_ENV ??= 'staging';
process.env.EXPO_PUBLIC_TEST_MODE ??= 'true';
process.env.EXPO_PUBLIC_SUI_RPC_URL ??= 'https://fullnode.testnet.sui.io:443';
