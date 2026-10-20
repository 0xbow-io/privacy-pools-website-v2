// The smart-wallet passkey unlock is ON for every smart-contract wallet (Pat,
// 2026-10-16: no URL flag any more). EOAs, 7702-delegated ones included, never
// see it and keep the wallet signature. EXPO_PUBLIC_PASSKEY_PREVIEW=0 still
// turns the feature off for a build.

function buildAllowsPasskey(): boolean {
  return !(typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_PASSKEY_PREVIEW === '0');
}

/** The one answer the provider reads: the build allows it (fixed per page load). */
export function smartWalletPasskeyEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return buildAllowsPasskey();
}
