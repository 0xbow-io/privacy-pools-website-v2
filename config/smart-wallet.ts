import { Platform } from 'react-native';
import { SMART_WALLET_ENABLED } from '@/config/env';

// The seedphrase-free embedded smart-wallet onboarding is mobile-first:
//  - native (iOS/Android): always available (this is the mobile app's wallet);
//  - web: only when EXPO_PUBLIC_ENABLE_SMART_WALLET is set.
// When inactive, ppv2 behaves exactly as before (connect a regular wallet +
// passkey for keys; header nav; no bottom tabs; no onboarding overlay).
export function smartWalletActive(): boolean {
  if (Platform.OS !== 'web') return true;
  return SMART_WALLET_ENABLED;
}
