/**
 * Native mock mode, OFF by default. A native demo build turns it on with
 * EXPO_PUBLIC_NATIVE_MOCK=true. See native-mock.ts. While it is on, every real
 * transaction flow is blocked (hooks/use-native-mock-block.ts).
 */
export const NATIVE_MOCK_ACTIVE: boolean = process.env.EXPO_PUBLIC_NATIVE_MOCK?.toLowerCase() === 'true';
