// V8 holds the ceremony verifier keys served by public/artifacts.
// Verified on Sepolia on 2026-11-19; V9 still holds development keys.
// Shared with the E2E verifier check so CI checks the same pool as the app.
export const SEPOLIA_DEFAULT_POOL = {
  pool: '0x4deceef285a24ca05999870887c895042731d7cb',
  keystore: '0x5b8883a2f8339560d8ebfeaabf93ce4e7056c4ca',
  aspRegistry: '0x836acbf56832fd11492e4a4ba1ba40f6e361df66',
  fromBlock: '10956341',
} as const;
