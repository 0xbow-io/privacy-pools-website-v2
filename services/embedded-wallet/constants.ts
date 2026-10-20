// Domain tag mixed into the embedded EOA derivation, keeping it cryptographically
// independent of the privacy-pools keys ppv2 derives from the same passkey PRF.
// Must never change once wallets exist (it's a domain separator, not a secret).
export const EOA_DERIVATION_TAG = 'privacypools-embedded-eoa-v1';
